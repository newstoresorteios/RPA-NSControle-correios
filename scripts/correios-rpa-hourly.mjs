/**
 * Bounded hourly Path A/B queue runner.
 * Pulls pending trackings from Neon ctl_orders, runs smoke for each.
 *
 * Usage:
 *   node --env-file=.env.local scripts/correios-rpa-hourly.mjs [--limit N]
 *
 * Env:
 *   HOURLY_LIMIT (default 12) — max trackings per run (~5 min each → fits 60m job)
 *   HEADED=0 for CI/headless
 *
 * Queue (Path A/B):
 *   tracking_code present, tax_paid = false, and either no ctl_correios_taxas row
 *   or payment_status in pending / awaiting_payment / boleto_pending / error.
 * Skips paid / not_found / no_action / overdue.
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LIMIT = 12;

function loadEnv() {
  const values = { ...process.env };
  try {
    for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const k = line.slice(0, i);
      if (values[k] == null || values[k] === "") values[k] = line.slice(i + 1);
    }
  } catch {
    /* ignore */
  }
  return values;
}

function parseArgs(argv) {
  let limit = Number(process.env.HOURLY_LIMIT || DEFAULT_LIMIT);
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit") limit = Number(argv[++i]);
  }
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  return { limit: Math.min(Math.floor(limit), 40) };
}

function runSmoke(tracking, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ["--env-file=.env.local", "scripts/correios-rpa-smoke.mjs", tracking],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env, HEADED: env.HEADED ?? process.env.HEADED ?? "0" },
      },
    );
    let out = "";
    child.stdout.on("data", (b) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      out += s;
      process.stderr.write(s);
    });
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, out }));
  });
}

function parseSmokeOutcome(out, tracking) {
  const okLine = [...out.split(/\r?\n/)].reverse().find((l) => l.startsWith("SMOKE_OK"));
  if (okLine) {
    const jsonStart = okLine.indexOf("{");
    try {
      return { ok: true, ...(jsonStart >= 0 ? JSON.parse(okLine.slice(jsonStart)) : { tracking }) };
    } catch {
      return { ok: true, tracking };
    }
  }
  const failLine = [...out.split(/\r?\n/)].reverse().find((l) => l.startsWith("SMOKE_FAIL"));
  if (failLine) {
    return { ok: false, tracking, error: failLine.replace(/^SMOKE_FAIL\s*/, "").trim() || "smoke_fail" };
  }
  return null;
}

const args = parseArgs(process.argv);
const env = loadEnv();
const dbUrl = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL ausente");
if (!env.CORREIOS_USER || !env.CORREIOS_PASSWORD) {
  throw new Error("CORREIOS_USER / CORREIOS_PASSWORD ausentes");
}

const mediaDir = join(ROOT, "media", "hourly-" + new Date().toISOString().slice(0, 13).replace(/:/g, ""));
mkdirSync(mediaDir, { recursive: true });
env.SMOKE_MEDIA_DIR = env.SMOKE_MEDIA_DIR || mediaDir;
env.HEADED = env.HEADED ?? "0";

const sql = postgres(dbUrl, { ssl: "require", max: 1, prepare: false });

const report = {
  startedAt: new Date().toISOString(),
  limit: args.limit,
  scrapeRunId: null,
  queue: [],
  results: [],
  summary: { seen: 0, ok: 0, failed: 0, skippedEmpty: false },
};

try {
  const [run] = await sql`
    insert into ctl_correios_scrape_runs (status, items_seen)
    values ('running', 0)
    returning id
  `;
  report.scrapeRunId = run.id;

  const rows = await sql`
    select
      o.order_key,
      upper(trim(o.tracking_code)) as tracking_code,
      t.payment_status
    from ctl_orders o
    left join ctl_correios_taxas t
      on upper(trim(t.tracking_code)) = upper(trim(o.tracking_code))
    where o.tracking_code is not null
      and length(trim(o.tracking_code)) >= 8
      and coalesce(o.tax_paid, false) = false
      and (
        t.id is null
        or t.payment_status in ('pending', 'awaiting_payment', 'boleto_pending', 'error')
      )
    order by
      case t.payment_status
        when 'boleto_pending' then 0
        when 'awaiting_payment' then 1
        when 'pending' then 2
        when 'error' then 3
        else 4
      end,
      o.tax_identified_at nulls first,
      o.created_at desc nulls last
    limit ${args.limit}
  `;

  report.queue = rows.map((r) => ({
    order_key: r.order_key,
    tracking: r.tracking_code,
    payment_status: r.payment_status || null,
  }));
  report.summary.seen = rows.length;

  console.log(
    "HOURLY_START",
    JSON.stringify({
      scrapeRunId: report.scrapeRunId,
      limit: args.limit,
      queued: rows.length,
      headed: env.HEADED,
    }),
  );

  if (!rows.length) {
    report.summary.skippedEmpty = true;
    await sql`
      update ctl_correios_scrape_runs
      set finished_at = now(), status = 'success', items_seen = 0, items_upserted = 0,
          error_summary = 'queue_empty'
      where id = ${report.scrapeRunId}
    `;
    console.log("HOURLY_DONE", JSON.stringify(report.summary));
    process.exit(0);
  }

  let upserted = 0;
  let boletos = 0;

  for (const row of rows) {
    const tracking = row.tracking_code;
    console.log("HOURLY_ITEM", tracking, "order", row.order_key, "status", row.payment_status || "none");
    const { code, out } = await runSmoke(tracking, env);
    const parsed = parseSmokeOutcome(out, tracking) || { ok: false, error: `exit_${code}` };
    const neon = await sql`
      select t.payment_status, t.linha_digitavel, t.pdf_path, o.import_tax
      from ctl_orders o
      left join ctl_correios_taxas t
        on upper(trim(t.tracking_code)) = upper(trim(o.tracking_code))
      where upper(trim(o.tracking_code)) = ${tracking}
      limit 1
    `;
    const rowN = neon[0];
    const ok =
      code === 0 &&
      (parsed.ok === true ||
        rowN?.import_tax != null ||
        ["boleto_generated", "boleto_pending", "awaiting_payment", "paid"].includes(rowN?.payment_status));
    if (ok) {
      report.summary.ok += 1;
      upserted += 1;
      if (parsed.linha || parsed.pdfPath || rowN?.linha_digitavel || rowN?.pdf_path) boletos += 1;
    } else {
      report.summary.failed += 1;
    }
    report.results.push({
      tracking,
      order_key: row.order_key,
      exit: code,
      ok,
      paymentStatus: parsed.paymentStatus || rowN?.payment_status || null,
      error: ok ? null : parsed.error || "smoke_or_neon_miss",
    });
  }

  const status =
    report.summary.failed === 0 ? "success" : report.summary.ok > 0 ? "partial" : "failed";
  const errorSummary = report.results
    .filter((r) => !r.ok)
    .slice(0, 8)
    .map((r) => `${r.tracking}:${r.error || "fail"}`)
    .join("; ")
    .slice(0, 500);

  await sql`
    update ctl_correios_scrape_runs
    set finished_at = now(),
        status = ${status},
        items_seen = ${report.summary.seen},
        items_upserted = ${upserted},
        boletos_saved = ${boletos},
        error_summary = ${errorSummary || null}
    where id = ${report.scrapeRunId}
  `;

  report.finishedAt = new Date().toISOString();
  report.status = status;
  const outPath = join(mediaDir, "hourly-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("HOURLY_REPORT", outPath);
  console.log("HOURLY_DONE", JSON.stringify({ ...report.summary, status, scrapeRunId: report.scrapeRunId }));

  if (status === "failed") process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("HOURLY_FATAL", msg);
  if (report.scrapeRunId) {
    await sql`
      update ctl_correios_scrape_runs
      set finished_at = now(), status = 'failed', error_summary = ${msg.slice(0, 500)}
      where id = ${report.scrapeRunId}
    `.catch(() => {});
  }
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
