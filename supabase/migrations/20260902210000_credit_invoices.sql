-- =============================================================================
-- Recorrido B2B · fase 07 — facturacion.
--
-- ## El puerto ya estaba escrito, y decia lo que faltaba
--
-- `src/domain/ports/invoicing.ts` declara `InvoiceRequest` con `taxRate` y
-- `taxAmount` POR LINEA, y deja anotado que `order_items` no los guardaba: un
-- carrito con dos tipos impositivos no podia reconstruir su comprobante. Esa
-- precondicion **ya esta resuelta** —la migracion 110100 añadio `tax_rate`,
-- `tax_amount`, `tax_inclusive` y `tax_category_code` a `order_items`, y
-- `create_order` los escribe linea a linea—, asi que `invoice_items` se llena
-- COPIANDO del pedido, sin recalcular nada desde la configuracion actual.
--
-- Recalcular seria el error caro: el IGV de una factura es el del dia de la
-- venta, no el de hoy. Una tasa que cambia en enero no puede reescribir una
-- factura de diciembre.
--
-- ## La linea anterior a esa migracion
--
-- `tax_rate` puede venir NULL en pedidos viejos. Eso NO es cero: es «no
-- facturable por falta de dato fiscal». Un CHECK lo impone en `invoice_items`,
-- porque tratar el hueco como cero emitiria un comprobante con menos impuesto
-- del debido, y eso lo paga el comercio.
--
-- ## La emision no vive aqui
--
-- Sale por el outbox de integraciones que ya existe, no por un cliente HTTP
-- nuevo: `integration_outbox` ya da idempotencia, reintento con espera, cola
-- muerta y disyuntor. Esta migracion guarda el documento y su estado.
-- =============================================================================

do $$ begin
  create type public.invoice_status as enum
    ('pending', 'issued', 'accepted', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.invoices (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  -- Serie fiscal del tenant: es CONFIGURACION, nunca una constante del codigo.
  series          text        not null,
  -- Lo asigna la autoridad o el emisor autorizado, asi que puede faltar hasta
  -- que conteste.
  number          text,
  status          public.invoice_status not null default 'pending',
  currency        char(3)     not null,
  issued_at       timestamptz not null default now(),
  customer_name   text        not null,
  customer_tax_id text,
  net_total       numeric(14,2) not null,
  tax_total       numeric(14,2) not null,
  gross_total     numeric(14,2) not null,
  -- Referencia al documento firmado: ruta o URL, segun el proveedor.
  document_ref    text,
  provider_code   text,
  reject_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint invoices_series_len check (char_length(btrim(series)) between 1 and 20),
  constraint invoices_totals_sign
    check (net_total >= 0 and tax_total >= 0 and gross_total >= 0),
  -- Los totales cuadran. Es la comprobacion mas barata contra un comprobante
  -- que la autoridad va a rechazar.
  constraint invoices_totals_add_up check (gross_total = net_total + tax_total),
  -- Un rechazo lleva motivo: sin el, nadie sabe que corregir para reemitir.
  constraint invoices_reject_needs_reason
    check (status <> 'rejected' or (reject_reason is not null and btrim(reject_reason) <> '')),
  constraint invoices_tenant_key unique (id, organization_id, company_id),
  constraint invoices_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint invoices_order_fk
    foreign key (order_id) references public.orders (id) on delete restrict
);

alter table public.invoices drop constraint if exists invoices_number_unique;

-- Numero unico dentro de su serie, SOLO cuando ya lo tiene.
--
-- Un indice parcial y no una restriccion `nulls not distinct`: con esa, dos
-- comprobantes esperando el numero de la autoridad —los dos con `number` nulo—
-- chocaban entre si, y estar pendiente es el estado normal de una factura recien
-- creada. Aqui el NULL vuelve a ser «todavia no se sabe», que es lo que es.
create unique index if not exists invoices_number_unique
  on public.invoices (organization_id, company_id, series, number)
  where number is not null;

create index if not exists invoices_tenant_idx on public.invoices (organization_id, company_id);
create index if not exists invoices_order_idx on public.invoices (order_id);

create table if not exists public.invoice_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  invoice_id      uuid        not null,
  description     text        not null,
  quantity        numeric(14,3) not null,
  unit_price      numeric(14,2) not null,
  net_amount      numeric(14,2) not null,
  -- Copiados del pedido, NO recalculados: el IGV de una factura es el del dia
  -- de la venta. Una tasa que cambia en enero no reescribe una de diciembre.
  tax_rate        numeric(6,4) not null,
  tax_amount      numeric(14,2) not null,
  position        smallint    not null default 0,
  created_at      timestamptz not null default now(),

  constraint invoice_items_quantity_sign check (quantity > 0),
  constraint invoice_items_amounts_sign
    check (unit_price >= 0 and net_amount >= 0 and tax_amount >= 0),
  -- Cero es una tasa VALIDA —lo dice el puerto— pero un NULL no lo es: en una
  -- linea sin dato fiscal, tratar el hueco como cero emitiria un comprobante
  -- con menos impuesto del debido, y eso lo paga el comercio. Por eso la
  -- columna es NOT NULL y quien copia tiene que decidir explicitamente.
  constraint invoice_items_rate_range check (tax_rate >= 0 and tax_rate <= 1),
  constraint invoice_items_invoice_fk
    foreign key (invoice_id, organization_id, company_id)
    references public.invoices (id, organization_id, company_id) on delete cascade
);

create index if not exists invoice_items_tenant_idx
  on public.invoice_items (organization_id, company_id);
create index if not exists invoice_items_invoice_idx
  on public.invoice_items (invoice_id, position);

create table if not exists public.invoice_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  invoice_id      uuid        not null,
  status          public.invoice_status not null,
  detail          text,
  created_at      timestamptz not null default now(),

  constraint invoice_events_invoice_fk
    foreign key (invoice_id, organization_id, company_id)
    references public.invoices (id, organization_id, company_id) on delete cascade
);

create index if not exists invoice_events_tenant_idx
  on public.invoice_events (organization_id, company_id);
create index if not exists invoice_events_invoice_idx
  on public.invoice_events (invoice_id, created_at);

-- ---------------------------------------------------------------------------
-- Un comprobante aceptado no se reescribe.
--
-- Es un documento fiscal: una vez que la autoridad lo acepto, corregirlo es
-- emitir una nota, no editar la factura. Permitir el UPDATE seria dejar que el
-- sistema contradiga a la autoridad.
-- ---------------------------------------------------------------------------
create or replace function ebim.invoice_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    if old.status in ('accepted', 'issued') then
      raise exception 'COMPROBANTE_EMITIDO: un comprobante emitido no se borra'
        using errcode = '22023';
    end if;
    return old;
  end if;

  if old.status = 'accepted' and new.status <> 'cancelled' then
    raise exception 'COMPROBANTE_ACEPTADO: se corrige con una nota, no editandolo'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

drop trigger if exists invoices_guard on public.invoices;
create trigger invoices_guard
  before update or delete on public.invoices
  for each row execute function ebim.invoice_guard();

-- Las lineas de un comprobante ya emitido tampoco.
create or replace function ebim.invoice_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_status public.invoice_status;
begin
  select i.status into v_status
  from public.invoices i
  where i.id = coalesce(new.invoice_id, old.invoice_id);

  if v_status is not null and v_status <> 'pending' then
    raise exception 'COMPROBANTE_EMITIDO: sus lineas ya no se tocan'
      using errcode = '22023';
  end if;

  return coalesce(new, old);
end;
$fn$;

drop trigger if exists invoice_items_guard on public.invoice_items;
create trigger invoice_items_guard
  before insert or update or delete on public.invoice_items
  for each row execute function ebim.invoice_items_guard();

-- ---------------------------------------------------------------------------
-- RLS: default deny. Emitir es una accion regulada.
-- ---------------------------------------------------------------------------
alter table public.invoices       enable row level security;
alter table public.invoices       force  row level security;
alter table public.invoice_items  enable row level security;
alter table public.invoice_items  force  row level security;
alter table public.invoice_events enable row level security;
alter table public.invoice_events force  row level security;

revoke all on public.invoices, public.invoice_items, public.invoice_events from public;
grant select, insert, update, delete on public.invoices, public.invoice_items to authenticated;
-- La bitacora del comprobante solo se lee y se anade.
grant select, insert on public.invoice_events to authenticated;
grant all on public.invoices, public.invoice_items, public.invoice_events to service_role;

drop policy if exists invoices_select_member on public.invoices;
create policy invoices_select_member on public.invoices
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

drop policy if exists invoices_write_admin on public.invoices;
create policy invoices_write_admin on public.invoices
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'invoicing')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'invoicing')
  );

drop policy if exists invoice_items_select_member on public.invoice_items;
create policy invoice_items_select_member on public.invoice_items
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

drop policy if exists invoice_items_write_admin on public.invoice_items;
create policy invoice_items_write_admin on public.invoice_items
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'invoicing')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'invoicing')
  );

drop policy if exists invoice_events_select_member on public.invoice_events;
create policy invoice_events_select_member on public.invoice_events
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

drop policy if exists invoice_events_insert_admin on public.invoice_events;
create policy invoice_events_insert_admin on public.invoice_events
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'invoicing')
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('invoicing', 'credit', false, 'ecommerce.invoicing', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on table public.invoice_items is
  'Se llena COPIANDO de order_items. Recalcular seria aplicar el IGV de hoy a una venta de ayer.';
comment on table public.invoices is
  'Aceptada = inmutable: se corrige con una nota, no editandola.';
