-- =============================================================================
-- Recorrido B2B · fase 06 — cotizaciones.
--
-- ## La confusion que hay que evitar antes de escribir una linea
--
-- «Cotizacion» significa DOS cosas en este repositorio y no son la misma:
--
--   · `ebim.build_quote` / `price_quote` — el motor que calcula cuanto cuesta
--     un carrito AHORA. Es la unica autoridad de precio desde P04.
--   · una cotizacion COMERCIAL — un documento con vigencia, estado y firma que
--     el vendedor manda al cliente y que despues se convierte en pedido.
--
-- Esta migracion crea la segunda y NO duplica la primera. `quote_items` guarda
-- el precio que el motor devolvio, con su fecha; si esta tabla calculara por su
-- cuenta habria dos verdades sobre el precio y discreparian el dia que alguien
-- toque una lista.
--
-- ## Por que `quote_items` tiene la forma de `order_items`
--
-- Para que convertir una cotizacion en pedido sea copiar, no traducir. Cada
-- traduccion entre dos formas parecidas es un sitio donde se pierde el IGV de
-- una linea, y eso no se nota hasta que alguien cuadra la factura.
--
-- ## El estado
--
-- `draft -> sent -> accepted | rejected | expired`. Una cotizacion aceptada o
-- vencida NO se puede editar: es un documento que el cliente ya vio, y cambiarlo
-- por detras es exactamente lo que destruye la confianza en un precio dado.
-- =============================================================================

do $$ begin
  create type public.quote_status as enum ('draft', 'sent', 'accepted', 'rejected', 'expired');
exception when duplicate_object then null; end $$;

create table if not exists public.quotes (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  store_id            uuid        not null,
  customer_id         uuid        not null,
  business_account_id uuid,
  -- Quien la hizo. Opcional: una cotizacion puede salir del backoffice sin que
  -- haya un vendedor de campo detras.
  sales_rep_id        uuid,
  quote_number        text        not null,
  status              public.quote_status not null default 'draft',
  currency            char(3)     not null,
  issued_at           date        not null default current_date,
  valid_until         date        not null,
  -- Totales, tal y como los devolvio el motor el dia que se cotizo.
  subtotal            numeric(14,2) not null default 0,
  tax_total           numeric(14,2) not null default 0,
  grand_total         numeric(14,2) not null default 0,
  -- El pedido que nacio de ella, si se acepto. Es la trazabilidad que permite
  -- responder «de donde salio este pedido».
  order_id            uuid,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint quotes_number_len check (char_length(btrim(quote_number)) between 1 and 60),
  constraint quotes_valid_after_issue check (valid_until >= issued_at),
  constraint quotes_totals_sign check (subtotal >= 0 and tax_total >= 0 and grand_total >= 0),
  constraint quotes_number_unique unique (organization_id, company_id, quote_number),
  constraint quotes_tenant_key unique (id, organization_id, company_id),
  constraint quotes_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete restrict,
  constraint quotes_account_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete set null,
  constraint quotes_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete set null,
  constraint quotes_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index if not exists quotes_tenant_idx on public.quotes (organization_id, company_id);
create index if not exists quotes_customer_idx on public.quotes (customer_id, status);
create index if not exists quotes_rep_idx on public.quotes (sales_rep_id);

-- ---------------------------------------------------------------------------
-- Las lineas. Misma forma que `order_items`, con el impuesto POR LINEA: es lo
-- que permite convertir sin recalcular y lo que P07 (facturacion) necesitara.
-- ---------------------------------------------------------------------------
create table if not exists public.quote_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  quote_id        uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  uom_code        text,
  quantity        numeric(14,3) not null,
  unit_price      numeric(14,2) not null,
  tax_rate        numeric(6,4),
  tax_amount      numeric(14,2),
  line_total      numeric(14,2) not null,
  position        smallint    not null default 0,
  created_at      timestamptz not null default now(),

  constraint quote_items_quantity_sign check (quantity > 0),
  constraint quote_items_price_sign check (unit_price >= 0),
  constraint quote_items_total_sign check (line_total >= 0),
  constraint quote_items_quote_fk
    foreign key (quote_id, organization_id, company_id)
    references public.quotes (id, organization_id, company_id) on delete cascade,
  constraint quote_items_product_fk
    foreign key (product_id) references public.products (id) on delete restrict,
  constraint quote_items_variant_fk
    foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete restrict,
  -- Un producto (o su variante) aparece UNA vez: dos lineas del mismo item son
  -- una cantidad partida por error, y al convertir se cobrarian las dos.
  --
  -- `nulls not distinct` NO es un detalle: sin el, SQL considera distintos dos
  -- NULL, y el caso normal —un producto simple, sin variante ni unidad— se
  -- podria repetir tantas veces como se quisiera. La restriccion existiria y no
  -- serviria para el 90 % de las lineas.
  constraint quote_items_unique
    unique nulls not distinct (quote_id, product_id, variant_id, uom_code)
);

create index if not exists quote_items_tenant_idx
  on public.quote_items (organization_id, company_id);
create index if not exists quote_items_quote_idx on public.quote_items (quote_id, position);

-- ---------------------------------------------------------------------------
-- Un documento que el cliente ya vio no se edita por detras.
--
-- El estado `sent` todavia admite correcciones —el vendedor se equivoco y
-- reenvia—, pero `accepted`, `rejected` y `expired` estan cerrados: cambiar el
-- precio de una cotizacion que el cliente acepto es lo que destruye la
-- confianza en un precio dado.
-- ---------------------------------------------------------------------------
create or replace function ebim.quote_is_editable(p_quote uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce(
    (select q.status in ('draft', 'sent') from public.quotes q where q.id = p_quote),
    false);
$fn$;

create or replace function ebim.quote_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_quote uuid := coalesce(new.quote_id, old.quote_id);
begin
  if not ebim.quote_is_editable(v_quote) then
    raise exception 'COTIZACION_CERRADA: esa cotizacion ya no admite cambios'
      using errcode = '22023';
  end if;
  return coalesce(new, old);
end;
$fn$;

drop trigger if exists quote_items_guard on public.quote_items;
create trigger quote_items_guard
  before insert or update or delete on public.quote_items
  for each row execute function ebim.quote_items_guard();

-- El estado avanza, no retrocede. `draft` puede ir a cualquier sitio; de
-- `accepted` no se vuelve.
create or replace function ebim.quote_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if old.status = new.status then return new; end if;

  if old.status in ('accepted', 'rejected', 'expired') then
    raise exception 'COTIZACION_CERRADA: de % no se sale', old.status
      using errcode = '22023';
  end if;

  if old.status = 'sent' and new.status = 'draft' then
    raise exception 'COTIZACION_CERRADA: una cotizacion enviada no vuelve a borrador'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

drop trigger if exists quotes_status_guard on public.quotes;
create trigger quotes_status_guard
  before update of status on public.quotes
  for each row execute function ebim.quote_status_guard();

-- ---------------------------------------------------------------------------
-- RLS: default deny. El vendedor ve las cotizaciones de SU cartera.
-- ---------------------------------------------------------------------------
alter table public.quotes      enable row level security;
alter table public.quotes      force  row level security;
alter table public.quote_items enable row level security;
alter table public.quote_items force  row level security;

revoke all on public.quotes, public.quote_items from public;
grant select, insert, update, delete on public.quotes, public.quote_items to authenticated;
grant all on public.quotes, public.quote_items to service_role;

drop policy if exists quotes_select_member on public.quotes;
create policy quotes_select_member on public.quotes
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id,
                    array['owner','admin','orders']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists quotes_write_seller on public.quotes;
create policy quotes_write_seller on public.quotes
  for all to authenticated
  using (
    ebim.has_capability(organization_id, company_id, 'trade.quotes')
    and (
      ebim.has_role(organization_id, company_id,
                    array['owner','admin','orders']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  )
  with check (
    ebim.has_capability(organization_id, company_id, 'trade.quotes')
    and (
      ebim.has_role(organization_id, company_id,
                    array['owner','admin','orders']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists quote_items_select_member on public.quote_items;
create policy quote_items_select_member on public.quote_items
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and exists (select 1 from public.quotes q where q.id = quote_id)
  );

-- La linea exige lo MISMO que su cotizacion: rol de venta o ser el vendedor de
-- esa cotizacion. Comprobar solo la capacidad y la existencia del padre dejaba
-- escribir a cualquier miembro del tenant —un `viewer` incluido—, que es
-- exactamente el hallazgo esupplier-030 que `security-baseline` vigila: una
-- policy `for all` sin rol es una policy que no autoriza.
drop policy if exists quote_items_write_seller on public.quote_items;
create policy quote_items_write_seller on public.quote_items
  for all to authenticated
  using (
    ebim.has_capability(organization_id, company_id, 'trade.quotes')
    and exists (
      select 1 from public.quotes q
      where q.id = quote_id
        and (
          ebim.has_role(q.organization_id, q.company_id,
                        array['owner','admin','orders']::public.app_role[])
          or q.sales_rep_id = ebim.sales_rep_of(q.organization_id, q.company_id)
        )
    )
  )
  with check (
    ebim.has_capability(organization_id, company_id, 'trade.quotes')
    and exists (
      select 1 from public.quotes q
      where q.id = quote_id
        and (
          ebim.has_role(q.organization_id, q.company_id,
                        array['owner','admin','orders']::public.app_role[])
          or q.sales_rep_id = ebim.sales_rep_of(q.organization_id, q.company_id)
        )
    )
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('trade.quotes', 'trade', false, 'ecommerce.trade.quotes', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on table public.quotes is
  'Cotizacion COMERCIAL, distinta de ebim.build_quote (motor de precio). Guarda lo que el motor devolvio.';
comment on table public.quote_items is
  'Misma forma que order_items, con impuesto por linea: convertir a pedido es copiar, no traducir.';
