import XLSX from "xlsx";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xlsxPath = process.argv[2];
const outDir = process.argv[3] || join(ROOT, "storage", "entregues");

if (!xlsxPath) {
  console.error("Usage: node scripts/parse-entregues-xlsx.mjs <path-to-xlsx> [outDir]");
  process.exit(1);
}

if (!existsSync(xlsxPath)) {
  console.error("XLSX_MISSING", xlsxPath);
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
console.log("sheets", wb.SheetNames);

function scoreSheet(name, rows) {
  let s = 0;
  if (/entreg/i.test(name)) s += 10;
  if (rows.length) {
    const cols = Object.keys(rows[0] || {}).map((c) => String(c).toLowerCase());
    if (cols.some((c) => /rastreio|tracking|encomenda|objeto/.test(c))) s += 5;
    if (cols.some((c) => /situa|status|entreg/.test(c))) s += 2;
  }
  return s;
}

let best = null;
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: false });
  const sc = scoreSheet(name, rows);
  console.log("sheet", name, "rows", rows.length, "score", sc, "cols", rows[0] ? Object.keys(rows[0]) : []);
  if (!best || sc > best.score) best = { name, rows, score: sc };
}

if (!best || best.score < 5) {
  // fallback: sheet with most tracking-like values
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: false });
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    const trackCol = cols.find((c) => /rastreio|tracking|encomenda|objeto|código|codigo/i.test(c)) || cols[0];
    const tracks = rows.map((r) => String(r[trackCol] || "").trim().toUpperCase()).filter((t) => /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(t));
    if (tracks.length && (!best || tracks.length > (best.tracks?.length || 0))) {
      best = { name, rows, score: 1, trackCol, tracks };
    }
  }
}

const rows = best.rows;
const cols = rows[0] ? Object.keys(rows[0]) : [];
const trackCol =
  cols.find((c) => /rastreio|tracking|encomenda|objeto|código|codigo/i.test(c)) ||
  cols.find((c) => rows.some((r) => /^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(String(r[c] || "").trim()))) ||
  cols[0];
const statusCol = cols.find((c) => /situa|status|entreg/i.test(c)) || null;
const pedidoCol = cols.find((c) => /pedido|order/i.test(c)) || null;

const items = [];
const seen = new Set();
for (const r of rows) {
  const tracking = String(r[trackCol] || "").trim().toUpperCase();
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(tracking)) continue;
  if (seen.has(tracking)) continue;
  seen.add(tracking);
  items.push({
    tracking,
    status: statusCol ? r[statusCol] : null,
    pedido: pedidoCol ? r[pedidoCol] : null,
    raw: r,
  });
}

mkdirSync(outDir, { recursive: true });
const out = {
  xlsxPath,
  sheet: best.name,
  trackCol,
  statusCol,
  pedidoCol,
  count: items.length,
  trackings: items.map((i) => i.tracking),
  items: items.map(({ tracking, status, pedido }) => ({ tracking, status, pedido })),
};
writeFileSync(join(outDir, "entregues-trackings.json"), JSON.stringify(out, null, 2));
console.log("PARSED", JSON.stringify({ sheet: out.sheet, trackCol, statusCol, count: out.count, sample: out.trackings.slice(0, 15) }, null, 2));
