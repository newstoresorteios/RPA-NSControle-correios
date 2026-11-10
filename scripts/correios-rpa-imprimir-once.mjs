/**
 * Fast path: login → open pagfacil resumo → Imprimir Boleto → extract linha → Neon.
 * Usage:
 *   node --env-file=.env.local scripts/correios-rpa-imprimir-once.mjs LX335304323JP [pagamentoId]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { chromium } from "playwright";
import { capturePagfacilBoleto } from "./lib/pagfacil-capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TRACKING = (process.argv[2] || "LX335304323JP").trim().toUpperCase();
const PAGAMENTO_ID = (process.argv[3] || "34611f13-db71-4140-a3ef-4996aed57ff7").trim();
const SEARCH =
  "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf";
const MEDIA =
  process.env.SMOKE_MEDIA_DIR ||
  join(ROOT, "media", "smoke-" + TRACKING);
const BOLETOS = join(ROOT, "storage", "boletos");
const RESUMO = `https://pagfacil.correios.com.br/boletos/${PAGAMENTO_ID}/resumo`;

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
      await page.waitForTimeout(1500 * i);
    }
  }
  throw err;
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

try {
  // Login via CAS (pagfacil shares Correios SSO)
  await gotoRetry(page, "https://cas.correios.com.br/login?service=" + encodeURIComponent(SEARCH));
  await page.locator('input[name="username"], #username, input[type="text"]').first().fill(env.CORREIOS_USER);
  await page.locator('input[name="password"], #password, input[type="password"]').first().fill(env.CORREIOS_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  console.log("opening", RESUMO);
  await gotoRetry(page, RESUMO);
  await page.waitForTimeout(1500);
  // CAS may bounce — retry resumo once
  if (!/pagfacil|boletos/i.test(page.url())) {
    await gotoRetry(page, RESUMO);
    await page.waitForTimeout(1500);
  }
  await shot(page, "50-resumo-direct.png");
  console.log("url:", page.url());

  const captured = await capturePagfacilBoleto(page, context, {
    tracking: TRACKING,
    boletosDir: BOLETOS,
    mediaDir: MEDIA,
    shotPrefix: "51-imprimir",
    preferPrint: true,
    fieldWaitMs: Number(process.env.FIELD_WAIT_MS || 120000),
  });

  console.log("CAPTURE", JSON.stringify({
    amount: captured.amount,
    linha: captured.linha,
    pdfPath: captured.pdfPath,
    portal: captured.portalOrderId,
    via: captured.captureVia,
    pagamentoId: captured.pagamentoId,
  }));

  if (!captured.linha) {
    writeFileSync(join(MEDIA, "imprimir-once-result.json"), JSON.stringify({
      blocker: `no_linha via=${captured.captureVia} pagamentoId=${PAGAMENTO_ID}`,
      captured,
      tax_paid: false,
    }, null, 2));
    console.log("IMPRIMIR_TIMEOUT", captured.captureVia);
    process.exitCode = 2;
  } else {
    const amount = captured.amount || "85.45";
    const linha = captured.linha;
    const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, {
      ssl: "require", max: 1, prepare: false,
    });
    try {
      const orders = await sql`select id from ctl_orders where upper(trim(tracking_code)) = ${TRACKING} limit 1`;
      const orderId = orders[0]?.id || null;
      const tax = (await sql`
        update ctl_correios_taxas set
          order_id = coalesce(order_id, ${orderId}),
          portal_order_id = coalesce(${captured.portalOrderId}, portal_order_id),
          tax_amount = ${amount}::numeric,
          payment_status = 'boleto_generated',
          due_date = coalesce(${captured.dueDate}::date, due_date),
          linha_digitavel = ${linha},
          pdf_path = coalesce(${captured.pdfPath}, pdf_path),
          raw_payload = coalesce(raw_payload,'{}'::jsonb) || ${sql.json({
            path: "imprimir_fast",
            captureVia: captured.captureVia,
            pagamentoId: captured.pagamentoId || PAGAMENTO_ID,
            finalUrl: captured.finalUrl,
          })},
          last_scraped_at = now(),
          updated_at = now()
        where tracking_code = ${TRACKING}
        returning id, tax_amount, payment_status, linha_digitavel, pdf_path, portal_order_id
      `)[0];

      let boleto = null;
      if (tax) {
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
        await sql`
          update ctl_orders set
            tax_identified_at = coalesce(tax_identified_at, now()),
            import_tax = ${amount}::numeric,
            notes_robot = left(coalesce(notes_robot,'') || E'\n' || ${`imprimir-once ${TRACKING} via=${captured.captureVia} linha=${linha}`}, 2000)
          where id = ${orderId}
        `;
      }
      const out = { amount, linha, pdfPath: captured.pdfPath, captureVia: captured.captureVia, tax, boleto, tax_paid: false };
      writeFileSync(join(MEDIA, "imprimir-once-result.json"), JSON.stringify(out, null, 2));
      console.log("IMPRIMIR_OK", JSON.stringify(out));
      console.log("LINHA_DIGITAVEL", linha);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
} catch (err) {
  console.error("IMPRIMIR_FAIL", err);
  await shot(page, "99-imprimir-fail.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
