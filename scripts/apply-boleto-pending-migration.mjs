import { readFileSync } from "node:fs";
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
const sql = postgres(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });
try {
  const ddl = readFileSync(join(ROOT, "scripts/migrations/20261104_ctl_correios_boleto_pending.sql"), "utf8");
  await sql.unsafe(ddl);
  const rows = await sql`
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.ctl_correios_taxas'::regclass and contype = 'c'
  `;
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
