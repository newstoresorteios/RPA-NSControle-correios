/**
 * Apply one SQL file from scripts/migrations against Neon via DATABASE_URL.
 * Usage: node --env-file=.env.local scripts/apply-migration.mjs scripts/migrations/FILE.sql
 * Prefer DATABASE_URL_UNPOOLED when set (DDL against Neon pooler can stall).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/apply-migration.mjs <path.sql>");
  process.exit(1);
}

function fromEnvFile() {
  try {
    const values = {};
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      values[line.slice(0, index)] = line.slice(index + 1);
    }
    return values;
  } catch {
    return {};
  }
}

const fileEnv = fromEnvFile();
const url =
  process.env.DATABASE_URL_UNPOOLED ||
  fileEnv.DATABASE_URL_UNPOOLED ||
  process.env.DATABASE_URL ||
  fileEnv.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL ausente");
  process.exit(1);
}

const host = new URL(url).hostname;
const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
const path = resolve(file);
const body = readFileSync(path, "utf8");

try {
  await sql.unsafe(body);
  console.log(`OK applied ${path} on host=${host}`);
} finally {
  await sql.end({ timeout: 5 });
}
