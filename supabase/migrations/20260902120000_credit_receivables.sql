-- =============================================================================
-- Recorrido B2B · fase 04 — credito y cobranza.
--
-- ## Que falta de verdad
--
-- `business_accounts` ya guarda la LINEA (`credit_limit`, `payment_terms_days`)
-- y el portal ya enseña un estado de cuenta. Lo que no existe es el DOCUMENTO
-- por cobrar con su vencimiento y su saldo, que es lo que convierte «te fio
-- 10.000» en «me debes 3.200, y 800 estan vencidos desde hace 12 dias».
--
-- ## Las tres decisiones
--
-- **El saldo es una columna, no una resta al vuelo.** Podria calcularse
-- sumando aplicaciones cada vez. Se guarda porque la antiguedad de saldos se
-- consulta en cada pantalla de cobranza y sobre miles de documentos; y se
-- mantiene con un TRIGGER, no desde la aplicacion, para que no exista la
-- version del saldo que alguien olvido actualizar.
--
-- **La aplicacion recibo -> documento es N:M.** Un cobro puede pagar tres
-- facturas y una factura puede cobrarse en tres partes. Modelarlo como una FK
-- simple obliga a partir recibos, que es exactamente lo que descuadra una
-- conciliacion.
--
-- **Nunca se cobra mas de lo que se debe.** El trigger lo rechaza. Sin esa
-- barandilla el saldo se vuelve negativo y a partir de ahi la antiguedad, el
-- credito disponible y el bloqueo por mora mienten los tres a la vez.
--
-- El bloqueo por mora NO va aqui: se implementara como un gancho del pipeline
-- de checkout, que ya tiene puertos, y nunca como un `if` dentro de
-- `create_order`.
-- =============================================================================

-- Idempotente: la migracion tiene que poder reaplicarse tal cual.
do $$ begin
  create type public.ar_document_kind as enum ('invoice', 'debit_note', 'credit_note');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.credit_status as enum ('ok', 'watch', 'blocked');
exception when duplicate_object then null; end $$;

alter table public.business_accounts
  add column if not exists credit_status public.credit_status not null default 'ok';

comment on column public.business_accounts.credit_status is
  'Semaforo de credito. `blocked` lo lee el gancho de checkout; esta tabla no despacha nada.';

-- ---------------------------------------------------------------------------
-- El documento por cobrar
-- ---------------------------------------------------------------------------
create table if not exists public.ar_documents (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  customer_id         uuid        not null,
  business_account_id uuid,
  -- Hoy nace del pedido. Cuando exista facturacion nacera de la factura, y por
  -- eso los dos son opcionales: el documento es la deuda, no su origen.
  order_id            uuid,
  kind                public.ar_document_kind not null default 'invoice',
  document_number     text        not null,
  currency            char(3)     not null,
  issued_at           date        not null default current_date,
  due_at              date        not null,
  amount              numeric(14,2) not null,
  -- Lo que queda por cobrar. Lo mantiene el trigger de abajo.
  balance             numeric(14,2) not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint ar_documents_number_len check (char_length(btrim(document_number)) between 1 and 60),
  constraint ar_documents_amount_sign check (amount > 0),
  -- El saldo vive entre cero y el importe. Fuera de ahi, todo lo que se calcule
  -- con el —antiguedad, disponible, mora— es falso.
  constraint ar_documents_balance_range check (balance >= 0 and balance <= amount),
  constraint ar_documents_due_after_issue check (due_at >= issued_at),
  constraint ar_documents_number_unique unique (organization_id, company_id, document_number),
  constraint ar_documents_tenant_key unique (id, organization_id, company_id),
  constraint ar_documents_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete restrict,
  constraint ar_documents_account_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete set null
);

create index if not exists ar_documents_tenant_idx
  on public.ar_documents (organization_id, company_id);
-- El indice de la cobranza: quien debe, y desde cuando.
create index if not exists ar_documents_open_idx
  on public.ar_documents (customer_id, due_at)
  where balance > 0;

-- ---------------------------------------------------------------------------
-- El cobro y su aplicacion
-- ---------------------------------------------------------------------------
create table if not exists public.ar_receipts (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  customer_id     uuid        not null,
  receipt_number  text        not null,
  currency        char(3)     not null,
  received_at     date        not null default current_date,
  amount          numeric(14,2) not null,
  method          text,
  reference       text,
  notes           text,
  created_at      timestamptz not null default now(),

  constraint ar_receipts_amount_sign check (amount > 0),
  constraint ar_receipts_number_len check (char_length(btrim(receipt_number)) between 1 and 60),
  constraint ar_receipts_number_unique unique (organization_id, company_id, receipt_number),
  constraint ar_receipts_tenant_key unique (id, organization_id, company_id),
  constraint ar_receipts_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete restrict
);

create index if not exists ar_receipts_tenant_idx
  on public.ar_receipts (organization_id, company_id);

create table if not exists public.ar_applications (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  receipt_id      uuid        not null,
  document_id     uuid        not null,
  amount          numeric(14,2) not null,
  created_at      timestamptz not null default now(),

  constraint ar_applications_amount_sign check (amount > 0),
  constraint ar_applications_receipt_fk
    foreign key (receipt_id, organization_id, company_id)
    references public.ar_receipts (id, organization_id, company_id) on delete cascade,
  constraint ar_applications_document_fk
    foreign key (document_id, organization_id, company_id)
    references public.ar_documents (id, organization_id, company_id) on delete restrict,
  -- Un recibo aplica una sola vez a cada documento: dos filas para el mismo par
  -- serian dos verdades sobre cuanto pago ese cobro de esa factura.
  constraint ar_applications_unique unique (receipt_id, document_id)
);

create index if not exists ar_applications_tenant_idx
  on public.ar_applications (organization_id, company_id);
create index if not exists ar_applications_document_idx
  on public.ar_applications (document_id);

-- ---------------------------------------------------------------------------
-- El saldo lo mantiene la BASE, no la aplicacion.
--
-- Si lo escribiera quien inserta la aplicacion, existiria la ruta que se olvida
-- de hacerlo —una carga masiva, una correccion a mano, un segundo cliente— y el
-- saldo dejaria de ser cierto sin que nada fallara.
-- ---------------------------------------------------------------------------
create or replace function ebim.ar_apply_balance()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_doc     public.ar_documents%rowtype;
  v_aplicado numeric(14,2);
begin
  select * into v_doc from public.ar_documents d
   where d.id = coalesce(new.document_id, old.document_id)
   for update;

  select coalesce(sum(a.amount), 0) into v_aplicado
    from public.ar_applications a
   where a.document_id = v_doc.id;

  if v_aplicado > v_doc.amount then
    raise exception 'COBRO_EXCEDE_DEUDA: aplicado % sobre un documento de %',
      v_aplicado, v_doc.amount using errcode = '22023';
  end if;

  update public.ar_documents
     set balance = v_doc.amount - v_aplicado,
         updated_at = now()
   where id = v_doc.id;

  return null;
end;
$fn$;

drop trigger if exists ar_applications_balance on public.ar_applications;
create trigger ar_applications_balance
  after insert or update or delete on public.ar_applications
  for each row execute function ebim.ar_apply_balance();

-- Un documento nace con el saldo completo.
create or replace function ebim.ar_document_defaults()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' and new.balance is null then
    new.balance := new.amount;
  end if;
  return new;
end;
$fn$;

drop trigger if exists ar_documents_defaults on public.ar_documents;
create trigger ar_documents_defaults
  before insert on public.ar_documents
  for each row execute function ebim.ar_document_defaults();

-- ---------------------------------------------------------------------------
-- RLS: default deny. El credito es dinero de terceros — no lo ve el vendedor
-- por defecto, lo ve quien responde por el cobro.
-- ---------------------------------------------------------------------------
alter table public.ar_documents    enable row level security;
alter table public.ar_documents    force  row level security;
alter table public.ar_receipts     enable row level security;
alter table public.ar_receipts     force  row level security;
alter table public.ar_applications enable row level security;
alter table public.ar_applications force  row level security;

revoke all on public.ar_documents, public.ar_receipts, public.ar_applications from public;
grant select, insert, update, delete
  on public.ar_documents, public.ar_receipts, public.ar_applications to authenticated;
grant all on public.ar_documents, public.ar_receipts, public.ar_applications to service_role;

drop policy if exists ar_documents_select_member on public.ar_documents;
create policy ar_documents_select_member on public.ar_documents
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

drop policy if exists ar_documents_write_admin on public.ar_documents;
create policy ar_documents_write_admin on public.ar_documents
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'credit.management')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'credit.management')
  );

drop policy if exists ar_receipts_select_member on public.ar_receipts;
create policy ar_receipts_select_member on public.ar_receipts
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

-- Registrar un cobro lo puede hacer tambien el rol `orders`: es la operacion
-- diaria de caja, no un cambio de politica de credito.
drop policy if exists ar_receipts_write_collector on public.ar_receipts;
create policy ar_receipts_write_collector on public.ar_receipts
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'credit.management')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'credit.management')
  );

drop policy if exists ar_applications_select_member on public.ar_applications;
create policy ar_applications_select_member on public.ar_applications
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

drop policy if exists ar_applications_write_collector on public.ar_applications;
create policy ar_applications_write_collector on public.ar_applications
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'credit.management')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'credit.management')
  );

-- ---------------------------------------------------------------------------
-- ebim.customer_aging — la antiguedad de saldos, en un solo viaje.
--
-- Todo importe sale como texto con DOS decimales, incluido el cero: sin el
-- `::numeric(14,2)` intermedio, un cliente sin deuda recibia '0' y uno con
-- deuda '0.00' para el mismo tramo, y el que formatea al otro lado no puede
-- saber cual de las dos le va a llegar.
--
-- Los tramos son los del oficio (corriente, 1-30, 31-60, 61-90, +90). Se
-- calculan aqui y no en la pantalla porque son la misma pregunta para la
-- cobranza, el estado de cuenta y el bloqueo por mora: tres sitios calculando
-- «cuanto esta vencido» acabarian dando tres cifras.
-- ---------------------------------------------------------------------------
create or replace function ebim.customer_aging(p_customer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'currency',    max(d.currency),
    'total',       coalesce(sum(d.balance), 0)::numeric(14,2)::text,
    'current',     coalesce(sum(d.balance) filter (where d.due_at >= current_date), 0)::numeric(14,2)::text,
    'due_1_30',    coalesce(sum(d.balance) filter (
                     where current_date - d.due_at between 1 and 30), 0)::numeric(14,2)::text,
    'due_31_60',   coalesce(sum(d.balance) filter (
                     where current_date - d.due_at between 31 and 60), 0)::numeric(14,2)::text,
    'due_61_90',   coalesce(sum(d.balance) filter (
                     where current_date - d.due_at between 61 and 90), 0)::numeric(14,2)::text,
    'due_over_90', coalesce(sum(d.balance) filter (
                     where current_date - d.due_at > 90), 0)::numeric(14,2)::text,
    'overdue',     coalesce(sum(d.balance) filter (where d.due_at < current_date), 0)::numeric(14,2)::text)
  from public.ar_documents d
  where d.customer_id = p_customer
    and d.balance > 0;
$fn$;

revoke execute on function ebim.customer_aging(uuid) from public;
grant  execute on function ebim.customer_aging(uuid) to authenticated, service_role;

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('credit.management', 'credit', false, 'ecommerce.credit.management', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on table public.ar_documents is
  'Documento por cobrar. `balance` lo mantiene un trigger: no existe la version que alguien olvido actualizar.';
comment on table public.ar_applications is
  'Aplicacion recibo -> documento, N:M. Un cobro paga varias facturas y una factura se cobra en partes.';
