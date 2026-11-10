# RPA-NSControle-correios

Standalone Playwright RPA for the Correios **Portal Importador**: login → search by tracking → Path A/B (boleto) or Path C (entregues comprovante) → upsert into the **NSControle Neon** tables `ctl_correios_*` (and related `ctl_orders` fields).

Migrated from `NSControle` feature branches (`cursor/correios-tax-tables-*`, `cursor/boleto-pending-fastfail-*`, `cursor/sept-alfandega-gap-*`).

## Setup

```bash
cp .env.example .env.local
# fill DATABASE_URL / DATABASE_URL_UNPOOLED / CORREIOS_USER / CORREIOS_PASSWORD
npm install
```

Node 20+. Playwright Chromium is installed via `postinstall` (or run `npx playwright install chromium`).

Never commit `.env` / `.env.local` or real credentials.

## Paths (Portal)

| Path | When | Script |
|------|------|--------|
| **A** | First boleto issue (`$` icon) | `correios-rpa-smoke.mjs` |
| **B** | Re-entry / already processing (sandwich → Pagar) | same smoke (auto-fallback) |
| **C** | Already delivered (Imprimir comprovante) | `correios-rpa-entregues.mjs` |

Details: [docs/plano-rpa-correios.md](docs/plano-rpa-correios.md).

## Common commands

```bash
# Path A/B smoke for one tracking
npm run smoke -- LX335304323JP

# Path C single / batch
npm run entregues -- LW061145525US
npm run entregues -- --batch --from storage/entregues/entregues-trackings.json

# Resume Entregues batch until done
npm run entregues:batch

# September alfândega gaps (Path C then A/B)
npm run fill-gaps -- --from storage/sept-gaps/trackings.json --dir storage/sept-gaps

# Helpers
npm run copiar-once -- <TRACKING>
npm run imprimir-once -- <TRACKING> [pagamentoId]
npm run recover -- <BOLETO_URL> [TRACKING]
npm run parse-entregues -- "C:\\path\\to\\planilha.xlsx"
npm run neon-paid

# Migrations (against Neon)
npm run migrate -- scripts/migrations/20261104_ctl_correios_taxas.sql
npm run migrate:boleto-pending
```

Artifacts land under `media/` (screenshots/results) and `storage/boletos/` (PDFs). Override screenshots with `SMOKE_MEDIA_DIR`.

## Layout

```
scripts/                  RPA entrypoints + helpers
scripts/lib/              pagfacil capture / PDF parse
scripts/migrations/       ctl_correios_* SQL
storage/boletos|entregues|sept-gaps/
media/                    smoke screenshots / JSON results
docs/                     Path A/B/C plan + project context
```

## Security

- Portal password and Neon URLs: env only
- Do not confuse with CWS Rastro (`CORREIOS_USUARIO` / `CORREIOS_SENHA` / `CORREIOS_CARTAO`) used by NSControle tracking sync — those are out of scope here
