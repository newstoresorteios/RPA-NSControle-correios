/**
 * Path C — delivered packages: search → Entregue → sandwich → Imprimir comprovante
 * → extract tax/payment → Neon (tax_paid=true when amount clearly present).
 *
 * Usage:
 *   node --env-file=.env.local scripts/correios-rpa-entregues.mjs LW061145525US
 *   node --env-file=.env.local scripts/correios-rpa-entregues.mjs --batch [limit]
 *   node --env-file=.env.local scripts/correios-rpa-entregues.mjs --batch --from storage/entregues/entregues-trackings.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { chromium } from "playwright";
import { extractLinha, parseMoney } from "./lib/pagfacil-capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEARCH =
  "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf";
const MEDIA_ROOT =
  process.env.SMOKE_MEDIA_DIR || join(ROOT, "media");
const STORE_ENTREGUES = join(ROOT, "storage", "entregues");
const BOLETOS = join(ROOT, "storage", "boletos");
const DELAY_MS = Number(process.env.ENTREGUES_DELAY_MS || 2500);
const PRINT_TIMEOUT_MS = Number(process.env.PRINT_TIMEOUT_MS || 20000);

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

function parseArgs(argv) {
  const out = { batch: false, limit: null, trackings: [], listPath: null, progressPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--batch") out.batch = true;
    else if (a === "--from") out.listPath = argv[++i];
    else if (a === "--progress") out.progressPath = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (/^\d+$/.test(a) && out.batch) out.limit = Number(a);
    else if (/^[A-Za-z]{2}\d{9}[A-Za-z]{2}$/.test(a)) out.trackings.push(a.toUpperCase());
  }
  return out;
}

async function shot(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

async function gotoRetry(page, url, n = 5) {
  let err;
  for (let i = 1; i <= n; i++) {
    try {
      // commit is more reliable against Correios resets than domcontentloaded
      await page.goto(url, { waitUntil: "commit", timeout: 60000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
      return;
    } catch (e) {
      err = e;
      const msg = String(e.message || e);
      console.log("goto_retry", i, msg.slice(0, 100));
      const reset = /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT|net::/i.test(msg);
      await page.waitForTimeout(reset ? 10000 * i : 2000 * i);
    }
  }
  throw err;
}

function isRetryableError(err) {
  const m = String(err?.message || err || "");
  return /Timeout|ERR_CONNECTION|net::|Target closed|Session closed|browser has been closed|not visible/i.test(m);
}

function isDefinitiveResult(result) {
  if (result.ok && result.taxPaid) return true;
  if (result.error?.startsWith("not_delivered")) return true;
  if (result.error?.startsWith("not_found_on_portal")) return true;
  if (result.error === "delivered_but_no_amount_extracted") return true;
  if (result.error === "imprimir_comprovante_not_found") return true;
  return false;
}

async function waitAguarde(page, ms = 45000) {
  await page.locator("text=Aguarde").first().waitFor({ state: "hidden", timeout: ms }).catch(() => {});
}

async function dismissOverlays(page) {
  const entendi = page.getByRole("button", { name: /^Entendi$/i });
  if (await entendi.count()) await entendi.click({ force: true }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

async function login(page, env) {
  await gotoRetry(page, "https://cas.correios.com.br/login?service=" + encodeURIComponent(SEARCH));
  await page.locator('input[name="username"], #username, input[type="text"]').first().fill(env.CORREIOS_USER);
  await page.locator('input[name="password"], #password, input[type="password"]').first().fill(env.CORREIOS_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
  if (!page.url().includes("pesquisarRemessaImportador")) await gotoRetry(page, SEARCH);
  await waitAguarde(page, 60000);
  await dismissOverlays(page);
  await waitAguarde(page, 30000);
  await dismissOverlays(page);
}

async function searchTracking(page, tracking, env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await dismissOverlays(page);
      if (!page.url().includes("pesquisarRemessaImportador")) await gotoRetry(page, SEARCH);
      await waitAguarde(page, 30000);
      await dismissOverlays(page);
      const input = page.getByLabel(/c[oó]digo da encomenda/i)
        .or(page.locator('input[type="text"]:visible').first());
      await input.first().click({ force: true });
      await input.first().fill("");
      await input.first().fill(tracking);
      await page.locator('input[type="submit"][value*="Pesquisar" i]:visible, button:visible:has-text("Pesquisar")').first()
        .click({ force: true });
      await waitAguarde(page, 60000);
      await page.waitForTimeout(1000);
      const row = page.locator("table tbody tr").filter({ hasText: tracking }).first();
      if (await row.count() && await row.isVisible().catch(() => false)) return row;
      // empty result table?
      const body = await page.locator("body").innerText().catch(() => "");
      if (/Nenhum registro|Total de Registros:\s*0/i.test(body)) {
        const err = new Error(`not_found_on_portal:${tracking}`);
        err.code = "not_found";
        throw err;
      }
      await row.waitFor({ state: "visible", timeout: 15000 });
      return row;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      console.log("search_retry", tracking, attempt, msg.slice(0, 100));
      if (e.code === "not_found") throw e;
      const reset = /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT|net::/i.test(msg);
      if (reset) {
        console.log("search_backoff_reset 30s");
        await page.waitForTimeout(30000);
        // don't nest more goto storms — bubble up for main-loop session recover
        throw e;
      }
      if (attempt === 2 && env) {
        console.log("re-login after search failures");
        await login(page, env).catch(() => {});
      } else {
        await page.waitForTimeout(2000 * attempt);
      }
    }
  }
  throw lastErr;
}

function situationFromRowText(text) {
  const t = String(text || "");
  if (/Entregue ao Destinat[aá]rio/i.test(t)) return "delivered";
  // Paid on portal but amount may be missing in Neon — same comprovante flow as delivered
  if (/Pagamento Confirmado/i.test(t)) return "payment_confirmed";
  if (/Aguardando Pagamento/i.test(t)) return "awaiting_payment";
  if (/Pagamento em Processamento/i.test(t)) return "processing";
  if (/Documento vinculado/i.test(t)) return "documento_vinculado";
  if (/Fiscaliza[cç][aã]o|Aguardando an[aá]lise|Devolu/i.test(t)) return "customs_or_return";
  return "other";
}

function parseBrDecimal(text) {
  const m = String(text || "").match(/(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, "").replace(",", ".")).toFixed(2);
}

function looksLikeBoletoLinha(digits) {
  if (!digits || digits.length < 47) return false;
  // Brazilian boleto linha usually starts with known bank/carteira prefixes; reject CPF/DIR mashups
  return /^(237|341|033|001|104|748|422|077|756|041|389)/.test(digits);
}

async function extractFromComprovante(pageOrPopup, context) {
  const bodyText = await pageOrPopup.locator("body").innerText().catch(() => "");
  let amount = parseMoney(bodyText); // R$ …
  let linha = null;

  // Structured table parse (Path C comprovante: Imposto / ICMS / Taxas / Total without R$)
  const fields = await pageOrPopup.evaluate(() => {
    const texts = [...document.querySelectorAll("td, th, p, span, label, li")]
      .map((el) => (el.innerText || "").trim())
      .filter(Boolean)
      .slice(0, 200);
    const rows = [...document.querySelectorAll("table tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map((c) => (c.innerText || "").trim()),
    );
    const html = document.documentElement.innerHTML.slice(0, 50000);
    return { texts, rows, html, href: location.href };
  }).catch(() => ({ texts: [], rows: [], html: "", href: "" }));

  const breakdown = { imposto: null, icms: null, taxasCorreios: null, total: null };
  for (const cells of fields.rows || []) {
    const label = (cells[0] || "").toLowerCase();
    const val = parseBrDecimal(cells.slice(1).join(" ") || cells[0]);
    if (!val) continue;
    if (/imposto sobre importa/i.test(label)) breakdown.imposto = val;
    else if (/^icms$/i.test(label)) breakdown.icms = val;
    else if (/taxas correios/i.test(label)) breakdown.taxasCorreios = val;
    else if (/^total$/i.test(label)) breakdown.total = val;
  }
  // Fallback: adjacent text nodes "Total" then "240,07"
  if (!breakdown.total) {
    for (let i = 0; i < fields.texts.length - 1; i++) {
      if (/^Total$/i.test(fields.texts[i].trim())) {
        const v = parseBrDecimal(fields.texts[i + 1]);
        if (v) breakdown.total = v;
      }
      if (/Imposto sobre Importa/i.test(fields.texts[i])) breakdown.imposto = breakdown.imposto || parseBrDecimal(fields.texts[i + 1]);
      if (/^ICMS$/i.test(fields.texts[i].trim())) breakdown.icms = breakdown.icms || parseBrDecimal(fields.texts[i + 1]);
      if (/Taxas Correios/i.test(fields.texts[i])) breakdown.taxasCorreios = breakdown.taxasCorreios || parseBrDecimal(fields.texts[i + 1]);
    }
  }
  // Regex on body: Total\n240,07 or Total 240,07
  if (!breakdown.total) {
    const m = bodyText.match(/Total\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i);
    if (m) breakdown.total = parseBrDecimal(m[1]);
  }

  amount = breakdown.total || amount;

  // Linha digitável only if it looks like a real boleto (comprovante often has none)
  const candidate = extractLinha(bodyText);
  if (candidate && looksLikeBoletoLinha(candidate)) linha = candidate;

  let pdfBuf = null;
  let pdfUrl = null;

  // If current page is already PDF
  if (/\.pdf(\?|$)/i.test(pageOrPopup.url()) || /application\/pdf/i.test(await pageOrPopup.evaluate(() => document.contentType || "").catch(() => ""))) {
    try {
      const resp = await context.request.get(pageOrPopup.url());
      const body = Buffer.from(await resp.body());
      if (body.slice(0, 4).toString() === "%PDF") {
        pdfBuf = body;
        pdfUrl = pageOrPopup.url();
      }
    } catch {
      /* ignore */
    }
  }

  // Look for download/print links
  if (!pdfBuf) {
    const pdfLink = pageOrPopup.locator('a[href*=".pdf"], a[href*="comprovante"], a[href*="boleto"]').first();
    if (await pdfLink.count()) {
      const href = await pdfLink.getAttribute("href").catch(() => null);
      if (href) {
        try {
          const abs = new URL(href, pageOrPopup.url()).toString();
          const resp = await context.request.get(abs);
          const body = Buffer.from(await resp.body());
          if (body.slice(0, 4).toString() === "%PDF") {
            pdfBuf = body;
            pdfUrl = abs;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (pdfBuf && !linha) {
    linha = extractLinha(pdfBuf.toString("latin1"));
  }

  return {
    amount,
    linha,
    breakdown,
    pdfBuf,
    pdfUrl,
    bodySnippet: bodyText.slice(0, 2000),
    finalUrl: pageOrPopup.url(),
    textsSample: fields.texts.slice(0, 40),
    paidHint: /pagamento foi realizado com sucesso|Comprovante de Pagamento|Data do Pagamento/i.test(bodyText),
  };
}

/**
 * Path C for one tracking.
 */
async function processDelivered(page, context, tracking, mediaDir, env) {
  const result = {
    tracking,
    path: "path_C_delivered_comprovante",
    situation: null,
    amount: null,
    linha: null,
    pdfPath: null,
    paymentStatus: null,
    taxPaid: false,
    ok: false,
    error: null,
    raw: {},
  };

  try {
    const row = await searchTracking(page, tracking, env);
    await shot(page, mediaDir, "01-result.png");
    const rowText = await row.innerText();
    result.situation = situationFromRowText(rowText);
    result.raw.rowText = rowText.slice(0, 300);
    console.log(tracking, "situation", result.situation);

    const comprovanteSituations = new Set(["delivered", "payment_confirmed"]);
    if (!comprovanteSituations.has(result.situation)) {
      result.error = `not_delivered:${result.situation}`;
      result.paymentStatus = result.situation === "awaiting_payment" ? "awaiting_payment" : "no_action";
      await shot(page, mediaDir, "99-not-delivered.png");
      return result;
    }

    const icons = row.locator("td").first().locator("a:visible, button:visible, span.ui-button:visible");
    const n = await icons.count();
    console.log(tracking, "icons", n);
    // sandwich (0) opens Entregue / comprovante modal (also works for Pagamento Confirmado)
    await icons.nth(0).click({ force: true });
    await page.waitForTimeout(1200);
    await waitAguarde(page, 20000);

    // Wait for entregue/comprovante modal
    const modalTitle = page.getByText(/Encomenda Entregue|Comprovante|Pagamento Confirmado/i).first();
    await modalTitle.waitFor({ timeout: 15000 }).catch(() => {});
    await shot(page, mediaDir, "02-modal-entregue.png");

    if (!(await page.getByText(/Encomenda Entregue|Comprovante/i).count()) &&
        !(await page.getByRole("button", { name: /Imprimir comprovante/i }).count())) {
      // try eye icon as fallback
      if (n >= 2) {
        await page.getByRole("button", { name: /^Fechar$/i }).click({ force: true }).catch(() => {});
        await icons.nth(1).click({ force: true });
        await page.waitForTimeout(1200);
        await shot(page, mediaDir, "02b-modal-eye.png");
      }
    }

    const popupPromise = context.waitForEvent("page", { timeout: PRINT_TIMEOUT_MS }).catch(() => null);
    const downloadPromise = page.waitForEvent("download", { timeout: PRINT_TIMEOUT_MS }).catch(() => null);
    const imprimir = page.getByRole("button", { name: /Imprimir comprovante/i })
      .or(page.locator('button:has-text("Imprimir comprovante"), a:has-text("Imprimir comprovante")'))
      .first();
    if (!(await imprimir.count())) {
      result.error = "imprimir_comprovante_not_found";
      await shot(page, mediaDir, "99-no-imprimir.png");
      await page.getByRole("button", { name: /^Fechar$/i }).click({ force: true }).catch(() => {});
      return result;
    }
    await imprimir.click({ force: true });
    console.log(tracking, "clicked Imprimir comprovante");

    const [popup, download] = await Promise.all([popupPromise, downloadPromise]);
    await page.waitForTimeout(1000);
    await shot(page, mediaDir, "03-after-imprimir.png");

    let extracted = null;
    if (download) {
      const dlPath = join(mediaDir, `${tracking}-comprovante.pdf`);
      await download.saveAs(dlPath).catch(() => {});
      try {
        const buf = readFileSync(dlPath);
        extracted = {
          amount: null,
          linha: extractLinha(buf.toString("latin1")),
          pdfBuf: buf.slice(0, 4).toString() === "%PDF" ? buf : null,
          pdfUrl: download.url(),
          bodySnippet: "",
          finalUrl: download.url(),
          textsSample: [],
        };
        // Also try parse money from latin1
        extracted.amount = parseMoney(buf.toString("latin1"));
      } catch (e) {
        result.error = "download_read_fail:" + String(e.message || e).slice(0, 80);
      }
    } else if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      for (let i = 0; i < 20 && /^about:blank/i.test(popup.url()); i++) await popup.waitForTimeout(400);
      await shot(popup, mediaDir, "04-comprovante-popup.png");
      extracted = await extractFromComprovante(popup, context);
      await popup.close().catch(() => {});
    } else {
      // Same-tab navigation?
      if (/comprovante|boleto|pagfacil|pdf/i.test(page.url()) || (await page.getByText(/comprovante|valor|tributo/i).count())) {
        extracted = await extractFromComprovante(page, context);
        await shot(page, mediaDir, "04-comprovante-same.png");
      } else {
        result.error = "no_popup_no_download_after_imprimir";
      }
    }

    if (extracted) {
      result.amount = extracted.amount;
      result.linha = extracted.linha;
      result.raw.breakdown = extracted.breakdown;
      result.raw.paidHint = extracted.paidHint;
      result.raw.comprovante = {
        url: extracted.finalUrl,
        pdfUrl: extracted.pdfUrl,
        snippet: extracted.bodySnippet,
        textsSample: extracted.textsSample,
      };
      if (extracted.pdfBuf && extracted.pdfBuf.length > 100) {
        mkdirSync(BOLETOS, { recursive: true });
        const pdfPath = `storage/boletos/${tracking}-comprovante.pdf`;
        writeFileSync(join(ROOT, pdfPath), extracted.pdfBuf);
        result.pdfPath = pdfPath;
        result.raw.pdfSha = createHash("sha256").update(extracted.pdfBuf).digest("hex");
      }
    }

    // Close modal if still open
    await page.getByRole("button", { name: /^Fechar$/i }).click({ force: true }).catch(() => {});

    // Accounting: clearly paid/delivered WITH amount → tax_paid=true
    if (result.amount && Number(result.amount) > 0 && (extracted?.paidHint || comprovanteSituations.has(result.situation))) {
      result.paymentStatus = "paid";
      result.taxPaid = true;
      result.ok = true;
    } else if (result.amount && Number(result.amount) > 0) {
      result.paymentStatus = "paid";
      result.taxPaid = true;
      result.ok = true;
    } else if (!result.error) {
      result.paymentStatus = "paid";
      result.taxPaid = false;
      result.ok = false;
      result.error = result.error || "delivered_but_no_amount_extracted";
    }

    return result;
  } catch (err) {
    result.error = String(err?.message || err).slice(0, 300);
    await shot(page, mediaDir, "99-fail.png").catch(() => {});
    return result;
  }
}

async function persistResult(sql, result) {
  const tracking = result.tracking;
  const amount = result.amount;
  const linha = result.linha || null;
  const status = result.paymentStatus || "error";

  const orders = await sql`select id, tax_paid, import_tax from ctl_orders where upper(trim(tracking_code)) = ${tracking} limit 1`;
  const orderId = orders[0]?.id || null;

  // Ensure tax row exists
  let tax = (await sql`select id from ctl_correios_taxas where tracking_code = ${tracking} limit 1`)[0];
  if (!tax) {
    tax = (await sql`
      insert into ctl_correios_taxas (order_id, tracking_code, tax_amount, payment_status, linha_digitavel, pdf_path, raw_payload)
      values (${orderId}, ${tracking}, ${amount}, ${status}, ${linha}, ${result.pdfPath}, ${sql.json({ path_C: result })})
      returning id
    `)[0];
  } else {
    // Path C: overwrite amount/status; linha only if real boleto digits (else clear bogus mash)
    await sql`
      update ctl_correios_taxas set
        order_id = coalesce(order_id, ${orderId}),
        tax_amount = coalesce(${amount}::numeric, tax_amount),
        payment_status = ${status},
        linha_digitavel = ${linha},
        pdf_path = coalesce(${result.pdfPath}, pdf_path),
        raw_payload = coalesce(raw_payload,'{}'::jsonb) || ${sql.json({ path_C: {
          path: result.path,
          situation: result.situation,
          amount: result.amount,
          breakdown: result.raw?.breakdown || null,
          taxPaid: result.taxPaid,
          error: result.error,
          comprovanteUrl: result.raw?.comprovante?.url || null,
        }})},
        last_scraped_at = now(),
        updated_at = now()
      where tracking_code = ${tracking}
    `;
  }

  if (tax && linha) {
    const existing = await sql`select id from ctl_correios_boletos where linha_digitavel = ${linha} limit 1`;
    if (!existing[0]) {
      await sql`
        insert into ctl_correios_boletos (tax_id, order_id, tracking_code, linha_digitavel, amount, pdf_path, pdf_sha256)
        values (${tax.id}, ${orderId}, ${tracking}, ${linha}, ${amount}::numeric, ${result.pdfPath}, ${result.raw.pdfSha || null})
      `;
    }
  }

  if (orderId) {
    const note = `path_C ${tracking}: status=${status} amount=${amount || "null"} tax_paid=${result.taxPaid} err=${result.error || "none"}`;
    if (result.taxPaid && amount) {
      await sql`
        update ctl_orders set
          tax_identified_at = coalesce(tax_identified_at, now()),
          import_tax = ${amount}::numeric,
          tax_paid = true,
          notes_robot = left(coalesce(notes_robot,'') || E'\n' || ${note}, 2000)
        where id = ${orderId}
      `;
    } else {
      await sql`
        update ctl_orders set
          tax_identified_at = coalesce(tax_identified_at, now()),
          import_tax = coalesce(${amount}::numeric, import_tax),
          notes_robot = left(coalesce(notes_robot,'') || E'\n' || ${note}, 2000)
        where id = ${orderId}
      `;
      // do not force tax_paid true without amount
    }
  }

  return { orderId, taxId: tax?.id || null };
}

const args = parseArgs(process.argv);
const env = loadEnv();
mkdirSync(STORE_ENTREGUES, { recursive: true });
mkdirSync(BOLETOS, { recursive: true });

let trackings = [...args.trackings];
const progressPath = args.progressPath
  ? resolve(args.progressPath)
  : join(STORE_ENTREGUES, "batch-progress.json");
mkdirSync(dirname(progressPath), { recursive: true });
const doneSet = new Set();
const neonPaidPath = join(STORE_ENTREGUES, "neon-already-paid.json");
const isolateProgress = Boolean(args.progressPath);
if (existsSync(progressPath)) {
  try {
    const prev = JSON.parse(readFileSync(progressPath, "utf8"));
    for (const t of prev.done || []) doneSet.add(t);
  } catch {
    /* ignore */
  }
}
// Only merge Neon already-paid skip into the default Entregues progress file.
if (!isolateProgress && existsSync(neonPaidPath)) {
  try {
    const paid = JSON.parse(readFileSync(neonPaidPath, "utf8"));
    for (const t of paid.trackings || []) doneSet.add(t);
  } catch {
    /* ignore */
  }
}

const listPath = args.listPath || join(STORE_ENTREGUES, "entregues-trackings.json");
let listTotal = trackings.length;
if (args.batch || !trackings.length) {
  if (!existsSync(listPath)) {
    console.error("LIST_MISSING — run parse-entregues-xlsx.mjs first:", listPath);
    process.exit(1);
  }
  const list = JSON.parse(readFileSync(listPath, "utf8"));
  listTotal = (list.trackings || []).length;
  trackings = (list.trackings || []).filter((t) => !doneSet.has(t));
  if (args.limit) trackings = trackings.slice(0, args.limit);
}
if (!trackings.length && !args.batch) {
  trackings = ["LW061145525US"];
}

console.log("ENTREGUES_RUN", {
  listTotal,
  remaining: trackings.length,
  alreadyDone: doneSet.size,
  sample: trackings.slice(0, 5),
  delayMs: DELAY_MS,
});

async function launchBrowser() {
  // Prefer installed Chrome on Windows — bundled Chromium often hits ERR_CONNECTION_RESET to Correios
  const opts = {
    headless: process.env.HEADED === "0",
    args: ["--disable-popup-blocking", "--disable-http2"],
  };
  try {
    return await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    return await chromium.launch(opts);
  }
}

let browser = await launchBrowser();
let context = await browser.newContext({
  acceptDownloads: true,
  locale: "pt-BR",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  permissions: ["clipboard-read", "clipboard-write"],
});
let page = await context.newPage();
const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });

const summary = {
  listTotal,
  remainingAtStart: trackings.length,
  skippedAlreadyDone: doneSet.size,
  ok: 0,
  paid: 0,
  noAmount: 0,
  notDelivered: 0,
  notFound: 0,
  flakes: 0,
  errors: 0,
  samples: [],
};

async function waitPortalUp(maxWaitMs = 30 * 60 * 1000) {
  const started = Date.now();
  let n = 0;
  while (Date.now() - started < maxWaitMs) {
    n += 1;
    try {
      const resp = await fetch("https://portalimportador.correios.com.br/", {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      });
      console.log("portal_up", { attempt: n, status: resp.status });
      return true;
    } catch (e) {
      const wait = Math.min(120000, 20000 + n * 5000);
      console.log("portal_down_wait", { attempt: n, wait_ms: wait, err: String(e.message || e).slice(0, 80) });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return false;
}

async function ensureSession() {
  for (let i = 1; i <= 8; i++) {
    const up = await waitPortalUp(10 * 60 * 1000);
    if (!up) console.log("portal still down — trying login anyway", i);
    try {
      await login(page, env);
      return;
    } catch (e) {
      console.log("login_retry", i, String(e.message || e).slice(0, 120));
      await page.waitForTimeout(Math.min(120000, 10000 * i));
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      browser = await launchBrowser();
      context = await browser.newContext({
        acceptDownloads: true,
        locale: "pt-BR",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      page = await context.newPage();
    }
  }
  throw new Error("login failed after retries");
}

function bumpSummary(result) {
  if (result.ok && result.taxPaid) {
    summary.ok += 1;
    summary.paid += 1;
  } else if (result.error?.startsWith("not_delivered")) summary.notDelivered += 1;
  else if (result.error?.startsWith("not_found_on_portal")) summary.notFound += 1;
  else if (result.error === "delivered_but_no_amount_extracted") summary.noAmount += 1;
  else if (isRetryableError({ message: result.error })) summary.flakes += 1;
  else summary.errors += 1;
}

function writeProgress(extra = {}) {
  const payload = {
    updatedAt: new Date().toISOString(),
    doneCount: doneSet.size,
    listTotal,
    remaining: Math.max(0, listTotal - doneSet.size),
    summary,
    done: [...doneSet],
    ...extra,
  };
  // keep last compact (avoid nesting huge done twice)
  writeFileSync(progressPath, JSON.stringify(payload));
  writeFileSync(join(STORE_ENTREGUES, "batch-summary.json"), JSON.stringify({
    ...summary,
    doneCount: doneSet.size,
    remaining: Math.max(0, listTotal - doneSet.size),
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

try {
  await ensureSession();
  await shot(page, join(MEDIA_ROOT, "smoke-entregues"), "00-logged-in.png");

  for (let i = 0; i < trackings.length; i++) {
    const tracking = trackings[i];
    const mediaDir = join(MEDIA_ROOT, `smoke-${tracking}`);
    const remaining = trackings.length - i;
    console.log(`[${i + 1}/${trackings.length}] remaining≈${remaining} done=${doneSet.size}/${listTotal}`, tracking);

    let result;
    try {
      result = await processDelivered(page, context, tracking, mediaDir, env);
    } catch (e) {
      result = {
        tracking,
        path: "path_C_delivered_comprovante",
        ok: false,
        taxPaid: false,
        amount: null,
        linha: null,
        paymentStatus: null,
        error: String(e?.message || e).slice(0, 300),
      };
      if (isRetryableError(e)) {
        console.log("session_recover after", tracking);
        try {
          await ensureSession();
        } catch (loginErr) {
          console.log("FATAL_LOGIN", loginErr);
          writeProgress({ last: result, fatal: String(loginErr?.message || loginErr) });
          throw loginErr;
        }
      }
    }

    try {
      result.db = await persistResult(sql, result);
    } catch (e) {
      result.error = (result.error ? result.error + "; " : "") + "db:" + String(e.message || e).slice(0, 120);
    }

    writeFileSync(join(mediaDir, "path-c-result.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(STORE_ENTREGUES, `${tracking}.json`), JSON.stringify(result, null, 2));

    bumpSummary(result);
    if (isDefinitiveResult(result)) {
      doneSet.add(tracking);
    } else {
      // flake: leave out of doneSet so a later resume retries
      console.log("flake_will_retry", tracking, result.error);
    }

    writeProgress({ last: { tracking, amount: result.amount, taxPaid: result.taxPaid, error: result.error } });

    if (summary.samples.length < 20 && result.taxPaid) {
      summary.samples.push({
        tracking,
        amount: result.amount,
        taxPaid: result.taxPaid,
        status: result.paymentStatus,
      });
    }

    console.log("RESULT", tracking, JSON.stringify({
      ok: result.ok,
      amount: result.amount,
      taxPaid: result.taxPaid,
      status: result.paymentStatus,
      error: result.error,
      definitive: isDefinitiveResult(result),
    }));

    if ((i + 1) % 5 === 0 || i === trackings.length - 1) {
      console.log("PROGRESS", JSON.stringify({
        processedThisRun: i + 1,
        doneTotal: doneSet.size,
        listTotal,
        remaining: Math.max(0, listTotal - doneSet.size),
        paid: summary.paid,
        notDelivered: summary.notDelivered,
        notFound: summary.notFound,
        flakes: summary.flakes,
        noAmount: summary.noAmount,
        errors: summary.errors,
      }));
    }

    // After connection-reset flakes, cool down + try fresh session (non-fatal if login still fails)
    if (result.error && /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|net::/i.test(result.error)) {
      console.log("cooldown_after_reset 60s + re-login");
      await page.waitForTimeout(60000);
      try {
        await ensureSession();
      } catch (loginErr) {
        console.log("login_after_reset_failed_continue", String(loginErr?.message || loginErr).slice(0, 120));
        // leave flake unmarked; until-done runner will retry later
        await page.waitForTimeout(30000);
      }
    }

    if (i < trackings.length - 1) await page.waitForTimeout(DELAY_MS);
  }
} finally {
  writeProgress({ finishedRun: true });
  writeFileSync(join(MEDIA_ROOT, "smoke-entregues", "batch-summary.json"), JSON.stringify({
    ...summary,
    doneCount: doneSet.size,
    remaining: Math.max(0, listTotal - doneSet.size),
  }, null, 2));
  console.log("SUMMARY", JSON.stringify({
    ...summary,
    doneCount: doneSet.size,
    remaining: Math.max(0, listTotal - doneSet.size),
  }, null, 2));
  await sql.end({ timeout: 5 }).catch(() => {});
  await browser.close().catch(() => {});
}

// Exit 0 if we made progress or finished; 2 only if nothing paid and remaining work had zero definitive
if (summary.paid === 0 && summary.ok === 0 && doneSet.size === 0) process.exitCode = 2;
