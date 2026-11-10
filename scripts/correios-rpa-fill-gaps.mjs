/**
 * Fill ctl_orders.import_tax gaps from Portal Importador.
 * 1) Path C (Entregue → Imprimir comprovante) via correios-rpa-entregues.mjs
 * 2) Path A/B (Aguardando Pagamento) via correios-rpa-smoke.mjs for leftovers
 *
 * Usage:
 *   node --env-file=.env.local scripts/correios-rpa-fill-gaps.mjs \
 *     --from storage/sept-gaps/trackings.json \
 *     --dir storage/sept-gaps \
 *     [--limit N] [--skip-path-c] [--skip-path-ab]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  const out = {
    from: join(ROOT, "storage/sept-gaps/trackings.json"),
    dir: join(ROOT, "storage/sept-gaps"),
    limit: null,
    skipPathC: false,
    skipPathAb: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") out.from = resolve(argv[++i]);
    else if (a === "--dir") out.dir = resolve(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--skip-path-c") out.skipPathC = true;
    else if (a === "--skip-path-ab") out.skipPathAb = true;
  }
  return out;
}

function runNode(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, HEADED: env.HEADED || "1" },
    });
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

function parseLastResult(out, tracking) {
  const lines = out.split(/\r?\n/).filter((l) => l.includes("RESULT") && l.includes(tracking));
  const last = lines[lines.length - 1] || "";
  const jsonStart = last.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(last.slice(jsonStart));
  } catch {
    return null;
  }
}

async function stillMissing(sql, trackings) {
  if (!trackings.length) return [];
  const rows = await sql`
    select order_key, upper(trim(tracking_code)) as tracking_code, import_tax, tax_paid
    from ctl_orders
    where upper(trim(tracking_code)) = any(${trackings})
      and import_tax is null
      and sale_amount is not null
  `;
  return rows;
}

const args = parseArgs(process.argv);
const env = loadEnv();
mkdirSync(args.dir, { recursive: true });

const list = JSON.parse(readFileSync(args.from, "utf8"));
let trackings = (list.trackings || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
if (args.limit) trackings = trackings.slice(0, args.limit);

const reportPath = join(args.dir, "fill-report.json");
const pathCProgress = join(args.dir, "path-c-progress.json");
const pathAbProgressPath = join(args.dir, "path-ab-progress.json");
const pathCListPath = join(args.dir, "path-c-input.json");

writeFileSync(pathCListPath, JSON.stringify({ count: trackings.length, trackings }, null, 2));

const report = {
  startedAt: new Date().toISOString(),
  from: args.from,
  inputCount: trackings.length,
  pathC: null,
  pathAb: { attempted: 0, filled: 0, blockers: [] },
  beforeMissing: trackings.length,
  afterMissing: null,
  filled: null,
  blockers: [],
};

const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });

try {
  const before = await stillMissing(sql, trackings);
  report.beforeMissing = before.length;
  console.log("FILL_GAPS_START", { input: trackings.length, stillMissing: before.length });

  if (!args.skipPathC && before.length) {
    console.log("FILL_GAPS_PATH_C", before.length);
    const pathCTrackings = before.map((r) => r.tracking_code);
    writeFileSync(pathCListPath, JSON.stringify({ count: pathCTrackings.length, trackings: pathCTrackings }, null, 2));
    const { code, out } = await runNode(
      [
        "--env-file=.env.local",
        "scripts/correios-rpa-entregues.mjs",
        "--batch",
        "--from",
        pathCListPath,
        "--progress",
        pathCProgress,
      ],
      env,
    );
    report.pathC = {
      exit: code,
      progress: existsSync(pathCProgress) ? JSON.parse(readFileSync(pathCProgress, "utf8")).summary || null : null,
      tail: out.slice(-1500),
    };
  }

  if (!args.skipPathAb) {
    const afterC = await stillMissing(sql, trackings);
    console.log("FILL_GAPS_AFTER_PATH_C_MISSING", afterC.length);

    let abDone = new Set();
    if (existsSync(pathAbProgressPath)) {
      try {
        abDone = new Set(JSON.parse(readFileSync(pathAbProgressPath, "utf8")).done || []);
      } catch {
        /* ignore */
      }
    }

    for (const row of afterC) {
      const tracking = row.tracking_code;
      if (abDone.has(tracking)) continue;
      // Skip Path A/B when Path C already proved the tracking is absent on the portal.
      const pathCResultPath = join(ROOT, "storage/entregues", `${tracking}.json`);
      if (existsSync(pathCResultPath)) {
        try {
          const prev = JSON.parse(readFileSync(pathCResultPath, "utf8"));
          if (String(prev.error || "").includes("not_found_on_portal")) {
            console.log("FILL_GAPS_SKIP_AB_NOT_FOUND", tracking);
            abDone.add(tracking);
            report.blockers.push({
              tracking,
              order_key: row.order_key,
              error: "not_found_on_portal",
            });
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      report.pathAb.attempted += 1;
      console.log("FILL_GAPS_PATH_AB", tracking, "order", row.order_key);
      const { code, out } = await runNode(
        ["--env-file=.env.local", "scripts/correios-rpa-smoke.mjs", tracking],
        env,
      );
      const result = parseLastResult(out, tracking) || { ok: false, error: `exit_${code}` };
      // smoke prints RESULT differently — also check Neon
      const check = await sql`
        select import_tax, tax_paid from ctl_orders
        where upper(trim(tracking_code)) = ${tracking}
        limit 1
      `;
      const filledNow = check[0]?.import_tax != null;
      if (filledNow) {
        report.pathAb.filled += 1;
        abDone.add(tracking);
      } else {
        const blocker = {
          tracking,
          order_key: row.order_key,
          smokeExit: code,
          error: result.error || result.status || "import_tax_still_null",
        };
        report.pathAb.blockers.push(blocker);
        report.blockers.push(blocker);
        // definitive portal misses — don't hammer forever
        if (/not_found|não encontr|nao encontr|Timeout|ERR_CONNECTION/i.test(String(blocker.error))) {
          abDone.add(tracking);
        } else {
          abDone.add(tracking); // one attempt per run; resume can clear done
        }
      }
      writeFileSync(
        pathAbProgressPath,
        JSON.stringify({ updatedAt: new Date().toISOString(), done: [...abDone], report: report.pathAb }, null, 2),
      );
    }
  }

  const after = await stillMissing(sql, trackings);
  report.afterMissing = after.length;
  report.filled = report.beforeMissing - after.length;
  report.finishedAt = new Date().toISOString();
  report.stillMissingSample = after.slice(0, 20);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(
    "FILL_GAPS_DONE",
    JSON.stringify({
      input: trackings.length,
      beforeMissing: report.beforeMissing,
      filled: report.filled,
      afterMissing: report.afterMissing,
      pathAbAttempted: report.pathAb.attempted,
      pathAbFilled: report.pathAb.filled,
      blockers: report.blockers.length,
    }),
  );
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
