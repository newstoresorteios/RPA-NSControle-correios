/**
 * Recover linha digitável + PDF from pagfacil boleto page.
 * Usage: node --env-file=.env.local scripts/correios-rpa-recover-boleto.mjs [BOLETO_URL] [TRACKING]
 * Does not set tax_paid=true.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { chromium } from "playwright";
import { capturePagfacilBoleto } from "./lib/pagfacil-capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TRACKING = (process.argv[3] || "LX335304323JP").trim().toUpperCase();
const BOLETO_URL =
  process.argv[2] ||
  "https://pagfacil.correios.com.br/boletos/8b4fc77e-b75f-4316-8149-bb43c896dadd/resumo";
const MEDIA =
  process.env.SMOKE_MEDIA_DIR ||
  join(ROOT, "media", "smoke-" + TRACKING);
const BOLETOS_DIR = join(ROOT, "storage", "boletos");
const SEARCH_URL =
  "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf";

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

async function main() {
  const env = loadEnv();
  mkdirSync(MEDIA, { recursive: true });
  mkdirSync(BOLETOS_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false, args: ["--disable-popup-blocking"] });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: "pt-BR",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();

  await page.goto("https://cas.correios.com.br/login?service=" + encodeURIComponent(SEARCH_URL), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.locator('input[name="username"], #username, input[type="text"]').first().fill(env.CORREIOS_USER);
  await page.locator('input[name="password"], #password, input[type="password"]').first().fill(env.CORREIOS_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForTimeout(2500);
  const entendi = page.getByRole("button", { name: /^Entendi$/i });
  if (await entendi.count()) await entendi.click({ force: true }).catch(() => {});

  await page.goto(BOLETO_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  const captured = await capturePagfacilBoleto(page, context, {
    tracking: TRACKING,
    boletosDir: BOLETOS_DIR,
    mediaDir: MEDIA,
    shotPrefix: "12-recover",
  });

  const amount = captured.amount || "85.45";
  const linha = captured.linha;
  const pdfPath = captured.pdfPath;
  const pdfSha = captured.pdfSha;
  const portal = captured.portalOrderId;
  const dueDate = captured.dueDate || "2026-11-09";

  const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });
  try {
    const orders = await sql`select id from ctl_orders where upper(trim(tracking_code)) = ${TRACKING} limit 1`;
    const orderId = orders[0]?.id || null;
    const tax = (
      await sql`
      update ctl_correios_taxas set
        order_id = coalesce(order_id, ${orderId}),
        portal_order_id = coalesce(${portal}, portal_order_id),
        tax_amount = ${amount}::numeric,
        payment_status = 'boleto_generated',
        due_date = ${dueDate}::date,
        linha_digitavel = coalesce(${linha}, linha_digitavel),
        pdf_path = coalesce(${pdfPath}, pdf_path),
        raw_payload = coalesce(raw_payload, '{}'::jsonb) || ${sql.json({
          recover: true,
          boletoUrl: BOLETO_URL,
          urlBoleto: captured.urlBoleto,
          pagamentoId: captured.pagamentoId,
          finalUrl: captured.finalUrl,
        })},
        last_scraped_at = now(),
        updated_at = now()
      where tracking_code = ${TRACKING}
      returning id, tax_amount, payment_status, linha_digitavel, pdf_path, portal_order_id, due_date
    `
    )[0];

    let boleto = null;
    if (tax && (linha || pdfPath)) {
      const existing = linha
        ? await sql`select id from ctl_correios_boletos where linha_digitavel = ${linha} limit 1`
        : await sql`select id from ctl_correios_boletos where tax_id = ${tax.id} limit 1`;
      if (existing[0]) {
        boleto = (
          await sql`
          update ctl_correios_boletos set
            linha_digitavel = coalesce(${linha}, linha_digitavel),
            amount = ${amount}::numeric,
            due_date = ${dueDate}::date,
            pdf_path = coalesce(${pdfPath}, pdf_path),
            pdf_sha256 = coalesce(${pdfSha}, pdf_sha256),
            downloaded_at = now()
          where id = ${existing[0].id}
          returning id, linha_digitavel, amount, pdf_path
        `
        )[0];
      } else {
        boleto = (
          await sql`
          insert into ctl_correios_boletos (
            tax_id, order_id, tracking_code, linha_digitavel, amount, due_date, pdf_path, pdf_sha256
          ) values (
            ${tax.id}, ${orderId}, ${TRACKING}, ${linha}, ${amount}::numeric, ${dueDate}::date, ${pdfPath}, ${pdfSha}
          )
          returning id, linha_digitavel, amount, pdf_path
        `
        )[0];
      }
    }

    if (orderId) {
      await sql`
        update ctl_orders set
          tax_identified_at = coalesce(tax_identified_at, now()),
          import_tax = ${amount}::numeric,
          notes_robot = left(coalesce(notes_robot,'') || E'\n' || ${`smoke recover ${TRACKING}: boleto_generated valor=${amount} linha=${linha ? "yes" : "no"} pdf=${pdfPath ? "yes" : "no"}`}, 2000)
        where id = ${orderId}
      `;
    }

    const out = { amount, linha, pdfPath, portal, dueDate, tax, boleto, tax_paid: false };
    writeFileSync(join(MEDIA, "recover-result.json"), JSON.stringify(out, null, 2));
    console.log("RECOVER_OK", JSON.stringify(out));
  } finally {
    await sql.end({ timeout: 5 });
    await browser.close();
  }
}

main().catch((err) => {
  console.error("RECOVER_FAIL", err);
  process.exit(1);
});
