import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("=");
  const k = line.slice(0, i);
  if (env[k] == null || env[k] === "") env[k] = line.slice(i + 1);
}
const list = JSON.parse(readFileSync(join(ROOT, "storage/entregues/entregues-trackings.json"), "utf8"));
const trackings = list.trackings || [];
const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });
try {
  const paidOrders = await sql`
    select upper(trim(tracking_code)) as tracking
    from ctl_orders
    where tax_paid = true
      and tracking_code is not null
      and upper(trim(tracking_code)) = any(${trackings})
  `;
  const paidTaxas = await sql`
    select tracking_code as tracking
    from ctl_correios_taxas
    where payment_status = 'paid'
      and tax_amount is not null
      and tracking_code = any(${trackings})
  `;
  const set = new Set([
    ...paidOrders.map((r) => r.tracking),
    ...paidTaxas.map((r) => r.tracking),
  ]);
  mkdirSync(join(ROOT, "storage/entregues"), { recursive: true });
  const out = { count: set.size, trackings: [...set] };
  writeFileSync(join(ROOT, "storage/entregues/neon-already-paid.json"), JSON.stringify(out, null, 2));
  console.log("NEON_ALREADY_PAID", out.count);
} finally {
  await sql.end({ timeout: 5 });
}
