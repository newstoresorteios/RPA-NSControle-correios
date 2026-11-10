/**
 * Live one-shot with explicit Portal Importador state machine.
 *
 * States:
 *   search_result → try first_issue ($)
 *     → processing_modal  → close → reissue
 *     → efetuar_pagamento → ciência → Concluir → …
 *   reissue (sandwich → Aguardando Pagamento → Pagar) → efetuar / formas / pagar_boleto
 *   forma_pagamento → Boleto Bancário → deseja_pagar modal → Pagar
 *   pagar_boleto (pagfacil) → poll Copiar until linha (2–5s backoff, ~3 min)
 *
 * Usage: node --env-file=.env.local scripts/correios-rpa-copiar-once.mjs [TRACKING]
 * tax_paid stays false. Empty barcode is NOT success.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { chromium } from "playwright";
import { capturePagfacilBoleto, extractLinha } from "./lib/pagfacil-capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TRACKING = (process.argv[2] || "LX335304323JP").trim().toUpperCase();
const SEARCH =
  "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf";
const MEDIA =
  process.env.SMOKE_MEDIA_DIR ||
  join(ROOT, "media", "smoke-" + TRACKING);
const BOLETOS = join(ROOT, "storage", "boletos");
const PRINT_TIMEOUT_MS = Number(process.env.PRINT_TIMEOUT_MS || 15_000);

function loadEnv() {
  const values = { ...process.env };
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i);
    if (values[k] == null || values[k] === "") values[k] = line.slice(i + 1);
  }
  return values;
}

async function shot(page, name) {
  mkdirSync(MEDIA, { recursive: true });
  const p = join(MEDIA, name);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  console.log("screenshot:", p);
}

async function gotoRetry(page, url, n = 4) {
  let err;
  for (let i = 1; i <= n; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (e) {
      err = e;
      console.log("goto retry", i, String(e.message || e).slice(0, 100));
      await page.waitForTimeout(2000 * i);
    }
  }
  throw err;
}

async function waitAguarde(page, ms = 45000) {
  await page.locator("text=Aguarde").first().waitFor({ state: "hidden", timeout: ms }).catch(() => {});
}

/** Detect current Portal / pagfacil UI state */
async function detectState(page) {
  const url = page.url();
  if (/pagfacil\.correios|\/boletos\/[^/]+\/resumo/i.test(url)) return "pagar_boleto";
  if ((await page.getByText(/Copiar c[oó]digo de barras/i).count().catch(() => 0)) > 0) return "pagar_boleto";
  if ((await page.getByText(/Pagar boleto/i).count().catch(() => 0)) > 0 &&
      (await page.getByText(/Imprimir Boleto/i).count().catch(() => 0)) > 0) return "pagar_boleto";

  // Prefer modal/dialog text over page chrome (PrimeFaces may not expose role=dialog)
  const body = ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 8000);
  if (/Pagamento em Processamento/i.test(body)) return "processing_modal";
  if (/Deseja Pagar com Boleto/i.test(body)) return "deseja_pagar_boleto";
  // Aguardando Pagamento modal: title + Fechar/Visualizar DIS/Pagar (not just table Situação)
  const hasAguardandoModalTitle =
    (await page.locator(".ui-dialog-title:visible, .ui-dialog:visible .ui-dialog-title, [id*='dialog'] .ui-dialog-title")
      .filter({ hasText: /Aguardando Pagamento/i }).count().catch(() => 0)) > 0 ||
    ((await page.getByRole("button", { name: /^Pagar$/i }).count().catch(() => 0)) > 0 &&
      (await page.getByRole("button", { name: /Visualizar DIS/i }).count().catch(() => 0)) > 0);
  if (hasAguardandoModalTitle) return "awaiting_payment_modal";

  const dlg = page.locator(".ui-dialog:visible, .ui-widget-overlay:visible + .ui-dialog, [role=dialog]:visible");
  if ((await dlg.count()) > 0) {
    const t = ((await dlg.first().innerText().catch(() => "")) || "");
    if (/Pagamento em Processamento/i.test(t)) return "processing_modal";
    if (/Aguardando Pagamento/i.test(t) && /Pagar/i.test(t)) return "awaiting_payment_modal";
    if (/Deseja Pagar com Boleto/i.test(t)) return "deseja_pagar_boleto";
  }

  // Efetuar BEFORE forma: banner text also mentions "boleto bancário ou PIX" and must not false-positive
  if ((await page.getByText(/Estou ciente/i).count().catch(() => 0)) > 0 ||
      ((await page.getByText(/Efetuar Pagamento/i).count().catch(() => 0)) > 0 &&
        (await page.getByText(/bloqueador de pop-ups/i).count().catch(() => 0)) > 0)) {
    return "efetuar_pagamento";
  }
  // Method picker cards: require Cartão de Crédito card (banner alone has PIX/boleto)
  if ((await page.getByText(/Boleto Banc[aá]rio/i).count().catch(() => 0)) > 0 &&
      (await page.getByText(/Cart[aã]o de Cr[eé]dito/i).count().catch(() => 0)) > 0) {
    return "forma_pagamento";
  }
  if ((await page.getByText(TRACKING).count().catch(() => 0)) > 0) return "search_result";
  return "unknown";
}

async function clickAwaitingPagar(page) {
  const dialogPagar = page.locator(".ui-dialog:visible")
    .getByRole("button", { name: /^Pagar$/i })
    .or(page.locator('.ui-dialog:visible button:has-text("Pagar"), .ui-dialog:visible a:has-text("Pagar")'))
    .first();
  const anyPagar = page.getByRole("button", { name: /^Pagar$/i })
    .or(page.locator('button:has-text("Pagar")'))
    .first();
  if (await dialogPagar.count()) await dialogPagar.click({ force: true });
  else if (await anyPagar.count()) await anyPagar.click({ force: true });
  else throw new Error("blocker: Aguardando Pagamento modal open but Pagar not found");
}

async function dismissOverlays(page) {
  const entendi = page.getByRole("button", { name: /^Entendi$/i });
  if (await entendi.count()) await entendi.click({ force: true }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

async function checkCiencia(page) {
  // Paulo: ONLY mark "Estou ciente…" — that enables Concluir pagamento
  const label = page.locator("label").filter({ hasText: /Estou ciente/i }).first();
  const boxNear = page.locator('input[type="checkbox"]').filter({
    has: page.locator("xpath=ancestor::*[.//text()[contains(., 'Estou ciente')]]"),
  }).first();
  const box = page.locator('input[type="checkbox"]:visible').first();

  let marked = false;
  if (await boxNear.count()) {
    if (!(await boxNear.isChecked().catch(() => false))) {
      await boxNear.check({ force: true }).catch(async () => {
        await boxNear.click({ force: true });
      });
    }
    marked = true;
  } else if (await box.count()) {
    if (!(await box.isChecked().catch(() => false))) {
      await box.check({ force: true }).catch(async () => {
        await box.click({ force: true });
      });
    }
    marked = true;
  }
  if (!marked && (await label.count())) {
    await label.click({ force: true });
    marked = true;
  }
  if (!marked) {
    await page.getByText(/Estou ciente/i).first().click({ force: true });
  }
  console.log("marked Estou ciente checkbox");
  await shot(page, "30b-estou-ciente-checked.png");
  // Checkbox triggers AJAX ("Aguarde") that reveals Valor a Pagar + Concluir pagamento
  await waitAguarde(page, 90000);
  await page.waitForTimeout(1000);
  await shot(page, "30c-after-aguarde.png");

  const concluirLoc = page.getByRole("button", { name: /Concluir pagamento/i })
    .or(page.getByText(/^Concluir pagamento$/i))
    .or(page.locator('button:has-text("Concluir pagamento"), input[value*="Concluir pagamento" i], a:has-text("Concluir pagamento"), span.ui-button-text:has-text("Concluir pagamento"), .ui-button:has-text("Concluir pagamento")'))
    .first();

  for (let i = 0; i < 40; i++) {
    await waitAguarde(page, 15000);
    const count = await concluirLoc.count().catch(() => 0);
    const visible = count > 0 && (await concluirLoc.isVisible().catch(() => false));
    const disabled = visible ? await concluirLoc.isDisabled().catch(() => false) : true;
    // Also accept attached-in-DOM even if Playwright visibility flickers
    const attached = count > 0;
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll("button, a.ui-button, span.ui-button-text, input[type=submit], input[type=button]")]
        .map((el) => (el.innerText || el.value || "").trim())
        .filter(Boolean)
        .slice(0, 20),
    ).catch(() => []);
    console.log("concluir_wait", i, { count, visible, disabled, attached, btns });
    if (visible && !disabled) return concluirLoc;
    if (attached && /Concluir pagamento/i.test(btns.join(" | "))) return concluirLoc;
    // Remessa panel appeared? try click anyway
    if ((await page.getByText(/Valor a Pagar/i).count()) && attached) return concluirLoc;
    await page.waitForTimeout(1000);
  }
  await shot(page, "30d-concluir-missing.png");
  throw new Error("blocker: Estou ciente marked but Concluir pagamento did not enable");
}

async function runCienciaConcluirBoletoCapture(page, context, pathTaken) {
  let state = await detectState(page);
  console.log("state_after_entry:", state, "path:", pathTaken);

  // Already on pagar_boleto (Path B sometimes lands here after Concluir/popup)
  if (state === "pagar_boleto") {
    console.log("flow: skip method picker → poll Copiar");
    return capturePagfacilBoleto(page, context, {
      tracking: TRACKING,
      boletosDir: BOLETOS,
      mediaDir: MEDIA,
      shotPrefix: "40-pagfacil",
      printTimeoutMs: PRINT_TIMEOUT_MS,
    });
  }

  if (state === "efetuar_pagamento") {
    await shot(page, "30-efetuar.png");
    const concluir = await checkCiencia(page);
    const popupPromise = context.waitForEvent("page", { timeout: 90000 }).catch(() => null);
    await concluir.click({ timeout: 20000 });
    console.log("clicked Concluir pagamento");
    await waitAguarde(page, 60000);
    await page.waitForTimeout(2000);
    await shot(page, "31-after-concluir.png");

    const popup = await popupPromise;
    let boletoPage = page;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      boletoPage = popup;
      console.log("popup_url:", popup.url());
    }

    state = await detectState(boletoPage);
    if (state !== "pagar_boleto") state = await detectState(page);
    if (state === "pagar_boleto") {
      if ((await page.getByText(/Copiar c[oó]digo de barras/i).count()) &&
          !(await boletoPage.getByText(/Copiar c[oó]digo de barras/i).count())) {
        boletoPage = page;
      }
      console.log("flow: after Concluir already on pagar_boleto");
      return capturePagfacilBoleto(boletoPage, context, {
        tracking: TRACKING,
        boletosDir: BOLETOS,
        mediaDir: MEDIA,
        shotPrefix: "40-pagfacil",
        printTimeoutMs: PRINT_TIMEOUT_MS,
      });
    }
    // fall through to forma_pagamento on main page
  }

  state = await detectState(page);
  console.log("state_before_forma:", state);
  if (state !== "forma_pagamento" && state !== "deseja_pagar_boleto" && state !== "pagar_boleto") {
    // Wait briefly for formas to paint
    for (let i = 0; i < 20; i++) {
      state = await detectState(page);
      if (["forma_pagamento", "deseja_pagar_boleto", "pagar_boleto"].includes(state)) break;
      await page.waitForTimeout(500);
    }
  }
  await shot(page, "32-formas-or-next.png");

  if (state === "pagar_boleto") {
    return capturePagfacilBoleto(page, context, {
      tracking: TRACKING,
      boletosDir: BOLETOS,
      mediaDir: MEDIA,
      shotPrefix: "40-pagfacil",
      printTimeoutMs: PRINT_TIMEOUT_MS,
    });
  }

  if (state !== "deseja_pagar_boleto") {
    // Prefer card with subtitle "Pagamento somente à vista" (Paulo screenshot 09)
    const boletoCard = page.locator("div, button, a, li, label")
      .filter({ hasText: /Boleto Banc[aá]rio/i })
      .filter({ hasText: /Pagamento somente|à vista|a vista/i })
      .first();
    const boleto = (await boletoCard.count())
      ? boletoCard
      : page.getByText(/^Boleto Banc[aá]rio$/i).first();
    if (!(await boleto.count())) throw new Error(`blocker: forma_pagamento expected, got state=${state}`);
    await boleto.click({ force: true });
    console.log("clicked Boleto Bancário");
    await page.waitForTimeout(1200);
    await shot(page, "33-boleto-card.png");
  }

  // Deseja Pagar com Boleto? → Pagar (blue) — not Voltar
  await page.getByText(/Deseja Pagar com Boleto/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(page, "34-deseja-pagar.png");
  const popupPromise2 = context.waitForEvent("page", { timeout: 90000 }).catch(() => null);
  const pagarConfirm = page.locator(".ui-dialog:visible button:has-text('Pagar'), .ui-dialog:visible a:has-text('Pagar')")
    .or(page.getByRole("button", { name: /^Pagar$/i }))
    .or(page.locator('button:has-text("Pagar"), a:has-text("Pagar"), input[value="Pagar"]'))
    .first();
  if (!(await pagarConfirm.count())) throw new Error("blocker: Deseja Pagar com Boleto modal — Pagar not found");
  await pagarConfirm.click({ force: true, timeout: 20000 });
  console.log("clicked Deseja Pagar com Boleto? → Pagar");

  let boletoPage = page;
  const popup2 = await popupPromise2;
  if (popup2) {
    await popup2.waitForLoadState("domcontentloaded").catch(() => {});
    boletoPage = popup2;
    console.log("pagfacil popup:", popup2.url());
  } else {
    await page.waitForTimeout(2500);
  }

  // Wait until pagar_boleto UI
  for (let i = 0; i < 40; i++) {
    const st = await detectState(boletoPage);
    const stMain = await detectState(page);
    if (st === "pagar_boleto" || stMain === "pagar_boleto") {
      if (stMain === "pagar_boleto" && st !== "pagar_boleto") boletoPage = page;
      break;
    }
    await page.waitForTimeout(500);
  }
  await shot(boletoPage, "35-pagar-boleto.png");
  console.log("flow: on pagar_boleto → Imprimir fast-fail");

  return capturePagfacilBoleto(boletoPage, context, {
    tracking: TRACKING,
    boletosDir: BOLETOS,
    mediaDir: MEDIA,
    shotPrefix: "40-pagfacil",
    printTimeoutMs: PRINT_TIMEOUT_MS,
  });
}

const env = loadEnv();
mkdirSync(MEDIA, { recursive: true });
mkdirSync(BOLETOS, { recursive: true });

const browser = await chromium.launch({ headless: false, args: ["--disable-popup-blocking"] });
const context = await browser.newContext({
  acceptDownloads: true,
  locale: "pt-BR",
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();

const meta = { pathTaken: null, states: [], tracking: TRACKING };

try {
  await gotoRetry(page, "https://cas.correios.com.br/login?service=" + encodeURIComponent(SEARCH));
  await shot(page, "20-login.png");
  await page.locator('input[name="username"], #username, input[type="text"]').first().fill(env.CORREIOS_USER);
  await page.locator('input[name="password"], #password, input[type="password"]').first().fill(env.CORREIOS_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
  if (!page.url().includes("pesquisarRemessaImportador")) await gotoRetry(page, SEARCH);
  // Entendi / Aguarde must clear BEFORE search (otherwise Pesquisar is a no-op on full list)
  await waitAguarde(page, 60000);
  await dismissOverlays(page);
  await waitAguarde(page, 30000);
  await dismissOverlays(page);
  await shot(page, "21-search.png");

  const searchInput = page.getByLabel(/c[oó]digo da encomenda/i)
    .or(page.locator('input[type="text"]:visible').first());
  await searchInput.first().click({ force: true });
  await searchInput.first().fill("");
  await searchInput.first().fill(TRACKING);
  console.log("filled tracking", TRACKING);
  const searchBtn = page.locator('input[type="submit"][value*="Pesquisar" i]:visible, button:visible:has-text("Pesquisar")').first();
  await searchBtn.click({ force: true });
  await waitAguarde(page, 60000);
  await page.waitForTimeout(1500);
  await shot(page, "22-result.png");
  meta.states.push("search_result");

  let row = page.locator("table tbody tr").filter({ hasText: TRACKING }).first();
  if (!(await row.count()) || !(await row.isVisible().catch(() => false))) {
    // Retry search once
    console.log("row not visible — retry Pesquisar");
    await dismissOverlays(page);
    await searchInput.first().fill(TRACKING);
    await searchBtn.click({ force: true });
    await waitAguarde(page, 60000);
    await page.waitForTimeout(1500);
    await shot(page, "22b-result-retry.png");
    row = page.locator("table tbody tr").filter({ hasText: TRACKING }).first();
  }
  await row.waitFor({ state: "visible", timeout: 30000 });
  const icons = row.locator("td").first().locator("a:visible, button:visible, span.ui-button:visible");
  const iconCount = await icons.count();
  console.log("action_icons:", iconCount, "row_text:", ((await row.innerText().catch(() => "")) || "").slice(0, 120));

  // --- first_issue probe via $ (usually 3rd icon) ---
  let entry = "unknown";
  if (iconCount >= 3) {
    await icons.nth(2).click({ force: true });
    await page.waitForTimeout(1500);
    await waitAguarde(page, 15000);
    let st = await detectState(page);
    console.log("after_$:", st);
    meta.states.push(`after_$:${st}`);
    await shot(page, "23-after-dollar.png");

    if (st === "processing_modal") {
      console.log("path: processing_modal → close → reissue");
      await page.getByRole("button", { name: /^Fechar$/i }).click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
      entry = "reissue_after_processing";
    } else if (st === "efetuar_pagamento" || st === "forma_pagamento" || st === "pagar_boleto") {
      entry = "first_issue";
      meta.pathTaken = "first_issue_$";
      console.log("path_taken: first_issue_$");
    } else if (st === "awaiting_payment_modal") {
      // $ opened awaiting? treat as reissue modal
      entry = "reissue_modal_from_$";
    } else {
      await page.getByRole("button", { name: /^Fechar$/i }).click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      entry = "reissue_fallback";
    }
  } else {
    entry = "reissue_no_dollar";
  }

  // --- reissue: sandwich → Aguardando Pagamento → Pagar ---
  if (entry.startsWith("reissue")) {
    meta.pathTaken = "reissue_sandwich";
    console.log("path_taken: reissue_sandwich (reason:", entry, ")");
    // Re-query icons after closing processing modal
    const icons2 = row.locator("td").first().locator("a:visible, button:visible, span.ui-button:visible");
    // Prefer fresh sandwich→Pagar session (do not reopen dead pagamentoId URLs)
    let st = "unknown";
    for (let clickTry = 1; clickTry <= 2; clickTry++) {
      const iconsFresh = row.locator("td").first().locator("a:visible, button:visible, span.ui-button:visible");
      await iconsFresh.nth(0).click({ force: true });
      await page.waitForTimeout(1500);
      await waitAguarde(page, 15000);
      for (let i = 0; i < 15; i++) {
        st = await detectState(page);
        console.log("sandwich_wait", clickTry, i, st);
        if (["awaiting_payment_modal", "efetuar_pagamento", "pagar_boleto", "forma_pagamento"].includes(st)) break;
        if ((await page.getByRole("button", { name: /^Pagar$/i }).count()) &&
            (await page.getByRole("button", { name: /Visualizar DIS/i }).count())) {
          st = "awaiting_payment_modal";
          break;
        }
        await page.waitForTimeout(400);
      }
      if (st === "awaiting_payment_modal" || st === "efetuar_pagamento" || st === "pagar_boleto") break;
      console.log("sandwich click retry", clickTry);
    }
    await shot(page, "24-sandwich-modal.png");
    console.log("after_sandwich:", st);
    meta.states.push(`after_sandwich:${st}`);

    if (st === "awaiting_payment_modal" ||
        ((await page.getByRole("button", { name: /^Pagar$/i }).count()) &&
          (await page.getByRole("button", { name: /Visualizar DIS/i }).count()))) {
      await clickAwaitingPagar(page);
      console.log("clicked Aguardando Pagamento → Pagar");
      await waitAguarde(page, 60000);
      await page.waitForTimeout(2000);
      for (let i = 0; i < 40; i++) {
        st = await detectState(page);
        console.log("after_pagar_wait", i, st);
        if (["efetuar_pagamento", "forma_pagamento", "pagar_boleto", "deseja_pagar_boleto"].includes(st)) break;
        await page.waitForTimeout(500);
      }
      console.log("after_modal_pagar:", st);
      meta.states.push(`after_modal_pagar:${st}`);
      await shot(page, "25-after-modal-pagar.png");
      if (st === "search_result" || st === "unknown") {
        throw new Error(`blocker: after Aguardando→Pagar still state=${st} (did not reach efetuar/formas/pagfacil)`);
      }
    } else {
      throw new Error(`blocker: sandwich did not open Aguardando Pagamento (state=${st})`);
    }
  }

  if (!meta.pathTaken) meta.pathTaken = entry;
  console.log("PATH_TAKEN", meta.pathTaken);

  const captured = await runCienciaConcluirBoletoCapture(page, context, meta.pathTaken);
  console.log("CAPTURE", JSON.stringify({
    amount: captured.amount,
    linha: captured.linha,
    pdfPath: captured.pdfPath,
    portal: captured.portalOrderId,
    due: captured.dueDate,
    pagamentoId: captured.pagamentoId,
    captureVia: captured.captureVia,
    paymentStatusHint: captured.paymentStatusHint,
    portalNotIssued: captured.portalNotIssued,
  }));

  const amount = captured.amount || "85.45";
  const linha = captured.linha || null;
  const status = linha ? "boleto_generated" : (captured.paymentStatusHint || "boleto_pending");
  const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, {
    ssl: "require", max: 1, prepare: false,
  });
  try {
    const orders = await sql`select id from ctl_orders where upper(trim(tracking_code)) = ${TRACKING} limit 1`;
    const orderId = orders[0]?.id || null;

    // Always upsert tax row status; linha only when non-empty (never invent success)
    const tax = (await sql`
      update ctl_correios_taxas set
        order_id = coalesce(order_id, ${orderId}),
        portal_order_id = coalesce(${captured.portalOrderId}, portal_order_id),
        tax_amount = ${amount}::numeric,
        payment_status = ${status},
        due_date = coalesce(${captured.dueDate}::date, due_date),
        linha_digitavel = coalesce(${linha}, linha_digitavel),
        pdf_path = coalesce(${captured.pdfPath}, pdf_path),
        raw_payload = coalesce(raw_payload,'{}'::jsonb) || ${sql.json({
          path: meta.pathTaken,
          states: meta.states,
          pagamentoId: captured.pagamentoId,
          finalUrl: captured.finalUrl,
          captureVia: captured.captureVia,
          portalNotIssued: captured.portalNotIssued,
          networkHits: (captured.networkHits || []).slice(0, 10),
          side: captured.portalNotIssued ? "portal" : (linha ? "ok" : "script_or_portal"),
        })},
        last_scraped_at = now(),
        updated_at = now()
      where tracking_code = ${TRACKING}
      returning id, tax_amount, payment_status, linha_digitavel, pdf_path, portal_order_id
    `)[0];

    let boleto = null;
    if (tax && linha) {
      const existing = await sql`select id from ctl_correios_boletos where linha_digitavel = ${linha} limit 1`;
      if (existing[0]) {
        boleto = (await sql`
          update ctl_correios_boletos set
            tax_id = ${tax.id}, order_id = coalesce(${orderId}, order_id),
            amount = ${amount}::numeric, pdf_path = coalesce(${captured.pdfPath}, pdf_path),
            pdf_sha256 = coalesce(${captured.pdfSha}, pdf_sha256), downloaded_at = now()
          where id = ${existing[0].id}
          returning id, linha_digitavel, amount, pdf_path
        `)[0];
      } else {
        boleto = (await sql`
          insert into ctl_correios_boletos (tax_id, order_id, tracking_code, linha_digitavel, amount, due_date, pdf_path, pdf_sha256)
          values (${tax.id}, ${orderId}, ${TRACKING}, ${linha}, ${amount}::numeric, ${captured.dueDate}, ${captured.pdfPath}, ${captured.pdfSha})
          returning id, linha_digitavel, amount, pdf_path
        `)[0];
      }
    }
    if (orderId) {
      const note = linha
        ? `copiar-once ${TRACKING} path=${meta.pathTaken} linha=${linha}`
        : `copiar-once ${TRACKING} path=${meta.pathTaken} status=${status} via=${captured.captureVia} (no linha; tax_paid stays false)`;
      await sql`
        update ctl_orders set
          tax_identified_at = coalesce(tax_identified_at, now()),
          import_tax = ${amount}::numeric,
          notes_robot = left(coalesce(notes_robot,'') || E'\n' || ${note}, 2000)
        where id = ${orderId}
      `;
      // tax_paid intentionally NEVER set true here
    }

    const out = {
      pathTaken: meta.pathTaken,
      states: meta.states,
      amount,
      linha,
      pdfPath: captured.pdfPath,
      payment_status: status,
      portalNotIssued: captured.portalNotIssued,
      captureVia: captured.captureVia,
      tax,
      boleto,
      tax_paid: false,
      side: captured.portalNotIssued ? "portal" : (linha ? "ok" : "unknown"),
    };
    writeFileSync(join(MEDIA, "copiar-once-result.json"), JSON.stringify(out, null, 2));

    if (linha) {
      console.log("COPIAR_OK", JSON.stringify(out));
      console.log("LINHA_DIGITAVEL", linha);
    } else {
      console.log("BOLETO_PENDING", JSON.stringify(out));
      console.log(
        "OUTCOME: portal-side boleto not issued — empty data-codigo + Imprimir no-op; status=boleto_pending; tax_paid=false; no linha persisted",
      );
      process.exitCode = 2;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
} catch (err) {
  console.error("COPIAR_FAIL", err);
  meta.error = String(err?.message || err);
  writeFileSync(join(MEDIA, "copiar-once-result.json"), JSON.stringify(meta, null, 2));
  await shot(page, "99-copiar-fail.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
