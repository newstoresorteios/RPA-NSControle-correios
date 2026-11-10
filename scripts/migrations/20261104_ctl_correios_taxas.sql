-- Correios Portal Importador: taxas alfandegárias e boletos.
-- Linked to ctl_orders (pedido). There is no separate inbound "envio" table;
-- tracking_code lives on ctl_orders. Idempotent / additive only.

create table if not exists public.ctl_correios_scrape_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed')),
  items_seen integer not null default 0,
  items_upserted integer not null default 0,
  boletos_saved integer not null default 0,
  error_summary text,
  created_at timestamptz not null default now()
);

create table if not exists public.ctl_correios_taxas (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.ctl_orders (id) on delete set null,
  tracking_code text not null,
  portal_order_id text,
  tax_amount numeric(14,2),
  payment_status text not null default 'pending'
    check (payment_status in (
      'pending',
      'awaiting_payment',
      'boleto_pending',
      'boleto_generated',
      'paid',
      'overdue',
      'not_found',
      'no_action',
      'error'
    )),
  due_date date,
  linha_digitavel text,
  pdf_path text,
  raw_payload jsonb,
  scrape_run_id uuid references public.ctl_correios_scrape_runs (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_scraped_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ctl_correios_taxas_tracking_uidx unique (tracking_code)
);

create unique index if not exists ctl_correios_taxas_portal_order_uidx
  on public.ctl_correios_taxas (portal_order_id)
  where portal_order_id is not null;

create unique index if not exists ctl_correios_taxas_linha_uidx
  on public.ctl_correios_taxas (linha_digitavel)
  where linha_digitavel is not null;

create index if not exists ctl_correios_taxas_order_idx
  on public.ctl_correios_taxas (order_id)
  where order_id is not null;

create index if not exists ctl_correios_taxas_status_idx
  on public.ctl_correios_taxas (payment_status);

drop trigger if exists ctl_correios_taxas_touch on public.ctl_correios_taxas;
create trigger ctl_correios_taxas_touch
before update on public.ctl_correios_taxas
for each row execute function public.ctl_touch_updated_at();

create table if not exists public.ctl_correios_boletos (
  id uuid primary key default gen_random_uuid(),
  tax_id uuid not null references public.ctl_correios_taxas (id) on delete cascade,
  order_id uuid references public.ctl_orders (id) on delete set null,
  tracking_code text not null,
  linha_digitavel text,
  barcode text,
  amount numeric(14,2),
  due_date date,
  pdf_path text,
  pdf_sha256 text,
  downloaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists ctl_correios_boletos_linha_uidx
  on public.ctl_correios_boletos (linha_digitavel)
  where linha_digitavel is not null;

create unique index if not exists ctl_correios_boletos_sha_uidx
  on public.ctl_correios_boletos (tax_id, pdf_sha256)
  where pdf_sha256 is not null;

create index if not exists ctl_correios_boletos_tax_idx
  on public.ctl_correios_boletos (tax_id);

create index if not exists ctl_correios_boletos_order_idx
  on public.ctl_correios_boletos (order_id)
  where order_id is not null;
