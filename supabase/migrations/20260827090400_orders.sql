-- =============================================================================
-- P02 · 05/08 — `orders` y `order_items`.
-- Un pedido NO se inserta desde el navegador: lo crea `create-order` (Edge
-- Function) recalculando precios contra la base. Por eso no hay policy de
-- INSERT para `anon` ni para `authenticated`.
-- =============================================================================

create type public.order_status as enum (
  'pending', 'paid', 'fulfilled', 'cancelled', 'refunded'
);

create table public.orders (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  company_id       uuid        not null,
  store_id         uuid        not null,
  order_number     text        not null,
  status           public.order_status not null default 'pending',
  customer_email   text        not null,
  customer_name    text,
  customer_phone   text,
  currency         char(3)     not null,
  subtotal         numeric(14,2) not null default 0,
  tax_total        numeric(14,2) not null default 0,
  shipping_total   numeric(14,2) not null default 0,
  discount_total   numeric(14,2) not null default 0,
  grand_total      numeric(14,2) not null default 0,
  shipping_address jsonb       not null default '{}'::jsonb,
  notes            text,
  placed_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint orders_email_fmt      check (position('@' in customer_email) > 1),
  constraint orders_currency_fmt   check (currency ~ '^[A-Z]{3}$'),
  constraint orders_amounts_signs  check (
    subtotal >= 0 and tax_total >= 0 and shipping_total >= 0
    and discount_total >= 0 and grand_total >= 0
  ),
  -- El total no es un campo libre: tiene que cuadrar con sus componentes.
  constraint orders_total_consistent check (
    grand_total = subtotal + tax_total + shipping_total - discount_total
  ),
  constraint orders_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict,
  constraint orders_store_key  unique (id, store_id),
  constraint orders_tenant_key unique (id, organization_id, company_id)
);
create unique index orders_number_key   on public.orders (store_id, order_number);
create index orders_tenant_idx          on public.orders (organization_id, company_id);
create index orders_store_status_idx    on public.orders (store_id, status, placed_at desc);
create index orders_customer_email_idx  on public.orders (store_id, lower(customer_email));

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- order_items — snapshot del producto en el momento de la compra. Si mañana
-- cambia el precio o se borra el producto, el pedido sigue diciendo la verdad.
-- `line_total` es GENERATED: no se puede mandar un total de línea inventado.
-- ---------------------------------------------------------------------------
create table public.order_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  order_id        uuid        not null,
  product_id      uuid,
  sku             text        not null,
  name            text        not null,
  unit_price      numeric(14,2) not null,
  quantity        integer     not null,
  line_total      numeric(14,2) generated always as (round(unit_price * quantity, 2)) stored,
  created_at      timestamptz not null default now(),
  constraint order_items_price_positive check (unit_price >= 0),
  constraint order_items_qty_positive   check (quantity > 0 and quantity <= 100000),
  constraint order_items_order_fk foreign key (order_id, store_id)
    references public.orders (id, store_id) on delete cascade,
  constraint order_items_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete set null,
  constraint order_items_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete restrict
);
create index order_items_order_idx   on public.order_items (order_id);
create index order_items_tenant_idx  on public.order_items (organization_id, company_id);
create index order_items_product_idx on public.order_items (product_id) where product_id is not null;

-- ---------------------------------------------------------------------------
-- Máquina de estados. Un pedido entregado no vuelve a "pendiente".
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_order_transition()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_allowed public.order_status[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'pending'   then array['paid','cancelled']::public.order_status[]
    when 'paid'      then array['fulfilled','refunded','cancelled']::public.order_status[]
    when 'fulfilled' then array['refunded']::public.order_status[]
    else array[]::public.order_status[]
  end;

  if not (new.status = any (v_allowed)) then
    raise exception 'ORDER_TRANSICION_INVALIDA: % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger orders_assert_transition
  before update of status on public.orders
  for each row execute function ebim.assert_order_transition();

-- Los importes de un pedido los fija el servidor al crearlo; el backoffice
-- gestiona estado y notas, no el dinero.
create or replace function ebim.assert_order_amounts_immutable()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (new.subtotal, new.tax_total, new.shipping_total, new.discount_total,
      new.grand_total, new.currency, new.store_id, new.organization_id, new.company_id)
     is distinct from
     (old.subtotal, old.tax_total, old.shipping_total, old.discount_total,
      old.grand_total, old.currency, old.store_id, old.organization_id, old.company_id)
  then
    raise exception 'ORDER_IMPORTES_INMUTABLES: los totales y el tenant de un pedido no se editan'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

create trigger orders_assert_amounts_immutable
  before update on public.orders
  for each row execute function ebim.assert_order_amounts_immutable();

-- ---------------------------------------------------------------------------
-- RLS · pedidos. Escritura de estado: owner/admin/orders.
-- Sin policy de INSERT: el alta pasa obligatoriamente por `create-order`.
-- Sin policy para `anon`: un comprador no lista los pedidos de una tienda.
-- ---------------------------------------------------------------------------
alter table public.orders      enable row level security;
alter table public.orders      force  row level security;
alter table public.order_items enable row level security;
alter table public.order_items force  row level security;

revoke all on public.orders      from public, anon, authenticated;
revoke all on public.order_items from public, anon, authenticated;

grant select on public.orders      to authenticated;
grant select on public.order_items to authenticated;
grant update (status, notes, customer_name, customer_phone, shipping_address)
  on public.orders to authenticated;

grant all on public.orders, public.order_items to service_role;

create policy orders_select_member on public.orders
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy orders_update_orders_role on public.orders
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin','orders']::public.app_role[]));

create policy order_items_select_member on public.order_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

comment on column public.order_items.line_total is
  'GENERATED: unit_price * quantity. No se acepta un total de linea enviado por el cliente.';
comment on table public.orders is
  'Alta exclusiva via Edge Function create-order (precios y totales recalculados server-side).';
