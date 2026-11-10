# Plano técnico — RPA taxas alfandegárias Correios

## 1. Objetivo e restrições

**Objetivo:** Robô que autentica no **Portal Importador**, pesquisa por rastreio, gera **Boleto Bancário** da taxa alfandegária e persiste no **Neon Postgres do NSControle** (mesma base do painel — sem DB separado do RPA).

**Escopo (fechado com Paulo):**
- Portal Importador (não Meu Correios genérico; não API Rastro CWS)
- Auth: `CORREIOS_USER` / `CORREIOS_PASSWORD` — sem 2FA; senha só em env
- Pagamento no portal: **somente Boleto Bancário**
- Store of record: Neon NSControle (`ctl_correios_*` + updates em `ctl_orders`)
- PDFs: `storage/boletos/` sob este reposit�rio (`RPA-NSControle-correios`)
- Agenda: 1h; fase 1 local → Render

**Fora de escopo:** 2FA, pagamento automático do boleto, cartão/PIX, UI nova, multi-conta.

---

## 2. Portal Importador — URL e fluxo

**URL:** `https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf`  
Screenshots: `media/portal-screens/` (incl. `06-modal-pagar.png`, `07-sandwich-highlight.png`)

1. Login (`CORREIOS_USER` / `CORREIOS_PASSWORD`)
2. Pesquisar código de rastreio (situação **Aguardando Pagamento**)
3. **Path A ou B** (abaixo) → Efetuar Pagamento
4. Checkbox **“Estou ciente…”** + ler Valor a Pagar → **Concluir pagamento**
5. Escolher sempre **Boleto Bancário** (nunca cartão/PIX) → confirmar **Pagar**
6. pagfacil: clicar **Copiar código de barras** (clipboard) + **Imprimir Boleto** se disponível
7. Upsert Neon; `tax_paid` só quando pago (boleto gerado ≠ pago)

### Path A — primeira emissão (boleto ainda não gerado)
Ícones na coluna Ação: sandwich | olho | **$**  
`search → $ → ciência → Concluir → Boleto Bancário → pagfacil → Copiar código → PDF`

### Path B — reentrada (já emitido / em processamento)
`search → sandwich (1º ícone) → modal “Aguardando Pagamento” → Pagar → Boleto → pagfacil → Copiar → PDF`  
Usar quando Path A mostra **Pagamento em Processamento**, barcode vazio, ou boleto já emitido.  
Se pagfacil vier com `data-codigo` vazio e Imprimir sem PDF (~15s) → status Neon `boleto_pending` (portal ainda não emitiu o boleto). **Não** marcar `tax_paid`.

### Path C — encomenda já entregue (comprovante)
Screenshots: `media/portal-screens/14-entregue-resultado.png`, `15-imprimir-comprovante.png`  
Ícones na entrega: sandwich | olho (sem `$`)

`search → Situação “Entregue ao Destinatário” → sandwich → modal “Encomenda Entregue” → Imprimir comprovante → extrair valor/linha/PDF → Neon`

- Script: `scripts/correios-rpa-entregues.mjs` (+ parse `scripts/parse-entregues-xlsx.mjs`)
- Entrada planilha: aba **Entregues** (`Rastreamento`), ex. `[NS] Acompanhamento de Pedidos (4).xlsx`
- Contabilidade: se valor (ou linha/PDF) claro → `ctl_correios_taxas.payment_status='paid'` e `ctl_orders.tax_paid=true` + `import_tax`
- Sem valor extraído: não forçar `tax_paid=true`

### Detecção no smoke (`scripts/correios-rpa-smoke.mjs`)
1. Tentar **Path A** (`$`)
2. Se modal **Pagamento em Processamento** → fechar e **Path B**
3. Se chegar ao pagfacil sem linha/PDF → `boleto_pending` / Path B retry depois
4. Se situação **Entregue ao Destinatário** → **Path C** (`correios-rpa-entregues.mjs`)

Não confundir com `correios-sync.ts` (CWS Rastro: `CORREIOS_USUARIO` / `CORREIOS_SENHA` / `CORREIOS_CARTAO`).

---

## 3. Fonte de entrada

**Canônico:** `ctl_orders` no Neon  
| Planilha | Coluna DB | Uso |
|----------|-----------|-----|
| Produto (= rastreio) | `tracking_code` | Input portal |
| Taxa Paga | `tax_paid` | Skip se pago (regra) |
| Observações Robô | `notes_robot` | Status RPA |
| ID Pedido | `order_key` / `label` | FK link |
| valor | `import_tax` | Contabilidade |

**Entregues (Path C):** aba `Entregues` da planilha NS — coluna `Rastreamento` (~2800 códigos). Parse → `storage/entregues/entregues-trackings.json`.

Fila Path A/B: `tracking_code is not null and tax_paid = false` (refinar com situação alfândega / `tax_identified_at`).  
Fila Path C: lista Entregues / pedidos com situação entregue e taxa a reconciliar.

---

## 4. Neon — tabelas Correios (aplicadas)

Migration: `scripts/migrations/20261104_ctl_correios_taxas.sql`  
Apply: `node --env-file=.env.local scripts/apply-migration.mjs scripts/migrations/20261104_ctl_correios_taxas.sql`

| Tabela | Papel | FK |
|--------|-------|-----|
| `ctl_correios_scrape_runs` | Métricas da run horária | — |
| `ctl_correios_taxas` | 1 linha / rastreio (valor, status, linha, pdf_path, raw_payload) | `order_id` → `ctl_orders.id`; UNIQUE `tracking_code` |
| `ctl_correios_boletos` | PDFs / linha digitável | `tax_id` → taxas; `order_id` → orders |

Não há tabela de “envio” inbound separada: rastreio fica em `ctl_orders.tracking_code`. `ctl_integration_shipments` é Europa outbound — **não** usar.

### Contabilidade no pedido
Ao upsert da taxa:
1. `tax_identified_at = coalesce(..., now())`
2. `import_tax = tax_amount` (alimenta `gain_amount`)
3. `tax_paid` só `true` quando pago (boleto gerado ≠ pago)
4. `notes_robot` com resumo da ação

### Legado pago (seed)
Pedido **26438** (`order_key`), tracking `NN495256804BR`, R$ 294,36, linha `23793129256900670050959015810803716200000029436` — seed script `scripts/seed-correios-legacy-26438.mjs` (já linkado no Neon).

### PDF
`storage/boletos/{tracking}.pdf` (relativo � raiz deste repo) → path relativo em `pdf_path`.  
`ctl_supplier_invoices` (Pagamentos) é invoice de fornecedor EUR — **não** reutilizar.

---

## 5. Stack

| Camada | Escolha |
|--------|---------|
| Runtime | Node + Playwright |
| Banco | Neon NSControle (`DATABASE_URL` / `DATABASE_URL_UNPOOLED`) |
| Segredos | `.env.local` gitignored |
| Deploy | Render Cron/Worker |

Sem Postgres paralelo do RPA.

---

## 6. Job horário + idempotência

1. Insert `ctl_correios_scrape_runs` (`running`)
2. Selecionar rastreios em `ctl_orders`
3. Login Portal → fluxo §2
4. Upsert `ctl_correios_taxas` por `tracking_code` (ou `portal_order_id`)
5. Insert boleto se nova `linha_digitavel` / `pdf_sha256`
6. Sync campos do pedido
7. Fechar run

---

## 7. Segurança

- Senha Correios e connection string **nunca** em docs, plano, commits
- Username só como `CORREIOS_USER` em exemplos
- `.env*` gitignored (`!.env.example` vazio)

---

## 8. Próximos passos de build

1. Playwright `scrape:once` com selectors do portal
2. Pasta `storage/boletos/` + gitignore PDFs
3. Cron 1h local → Render
