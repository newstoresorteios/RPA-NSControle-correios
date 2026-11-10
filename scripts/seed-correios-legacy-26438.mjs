/**
 * Seed/link legacy paid customs tax for Pedido 26438.
 * Does not print secrets. Safe to re-run (idempotent upserts).
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

function envFile() {
  const values = {};
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

const ORDER_KEY = "26438";
const AMOUNT = "294.36";
const LINHA = "23793129256900670050959015810803716200000029436";
const NOTE = "legado portal importador: boleto pago importado pelo RPA seed";

const env = envFile();
const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL ausente");
const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

try {
  const tables = await sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_name like 'ctl_correios%'
    order by 1
  `;
  console.log(
    "tables:",
    tables.map((row) => row.table_name).join(", ") || "(none)",
  );

  const orders = await sql`
    select id, order_key, label, flow, tracking_code, import_tax, tax_paid, tax_identified_at
    from ctl_orders
    where order_key = ${ORDER_KEY}
       or label = ${ORDER_KEY}
       or order_key like ${"%" + ORDER_KEY + "%"}
       or coalesce(label, '') like ${"%" + ORDER_KEY + "%"}
    order by updated_at desc nulls last
    limit 20
  `;
  console.log("matching_orders:", orders.length);
  for (const order of orders) {
    console.log(
      JSON.stringify({
        id: order.id,
        order_key: order.order_key,
        label: order.label,
        flow: order.flow,
        tracking_code: order.tracking_code,
        import_tax: order.import_tax,
        tax_paid: order.tax_paid,
      }),
    );
  }

  if (!orders.length) {
    console.log("SEED_SKIP: pedido 26438 not found in ctl_orders");
    process.exitCode = 2;
  } else {
    const order = orders.find((row) => row.order_key === ORDER_KEY) || orders[0];
    const tracking =
      (order.tracking_code && String(order.tracking_code).trim()) ||
      `LEGACY-${ORDER_KEY}`;

    await sql`
      update ctl_orders
      set
        import_tax = coalesce(import_tax, ${AMOUNT}::numeric),
        tax_paid = true,
        tax_identified_at = coalesce(tax_identified_at, now()),
        notes_robot = case
          when notes_robot is null or notes_robot = '' then ${NOTE}
          when notes_robot like ${"%" + NOTE + "%"} then notes_robot
          else notes_robot || E'\n' || ${NOTE}
        end
      where id = ${order.id}
    `;

    const taxRows = await sql`
      insert into ctl_correios_taxas (
        order_id, tracking_code, tax_amount, payment_status,
        linha_digitavel, raw_payload, last_scraped_at
      ) values (
        ${order.id},
        ${tracking},
        ${AMOUNT}::numeric,
        'paid',
        ${LINHA},
        ${sql.json({
          source: "legacy_seed",
          order_key: ORDER_KEY,
          amount: AMOUNT,
          linha_digitavel: LINHA,
        })},
        now()
      )
      on conflict (tracking_code) do update set
        order_id = coalesce(ctl_correios_taxas.order_id, excluded.order_id),
        tax_amount = coalesce(ctl_correios_taxas.tax_amount, excluded.tax_amount),
        payment_status = 'paid',
        linha_digitavel = coalesce(ctl_correios_taxas.linha_digitavel, excluded.linha_digitavel),
        raw_payload = coalesce(ctl_correios_taxas.raw_payload, '{}'::jsonb) || excluded.raw_payload,
        last_scraped_at = now(),
        updated_at = now()
      returning id, order_id, tracking_code, tax_amount, payment_status, linha_digitavel
    `;

    const tax = taxRows[0];
    const boletoRows = await sql`
      insert into ctl_correios_boletos (
        tax_id, order_id, tracking_code, linha_digitavel, amount, pdf_path
      ) values (
        ${tax.id},
        ${order.id},
        ${tracking},
        ${LINHA},
        ${AMOUNT}::numeric,
        null
      )
      on conflict (linha_digitavel) where linha_digitavel is not null do update set
        order_id = coalesce(ctl_correios_boletos.order_id, excluded.order_id),
        amount = coalesce(ctl_correios_boletos.amount, excluded.amount)
      returning id, tax_id, order_id, linha_digitavel, amount
    `;

    // Partial unique indexes are not usable with plain ON CONFLICT in all PG versions
    // without matching inference — handle duplicate manually if insert raced.
    console.log("tax:", JSON.stringify(tax));
    console.log("boleto:", JSON.stringify(boletoRows[0] ?? null));
    console.log("SEED_OK order_id=" + order.id + " tracking=" + tracking);
  }
} finally {
  await sql.end({ timeout: 5 });
}
