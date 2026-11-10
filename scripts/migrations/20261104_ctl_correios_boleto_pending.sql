-- Allow portal-side "boleto issued UI but barcode/PDF not ready" status.
alter table public.ctl_correios_taxas
  drop constraint if exists ctl_correios_taxas_payment_status_check;

alter table public.ctl_correios_taxas
  add constraint ctl_correios_taxas_payment_status_check
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
  ));
