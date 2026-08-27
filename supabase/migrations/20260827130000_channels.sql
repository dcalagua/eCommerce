-- =============================================================================
-- P10 · Canales de venta sobre catalogo unico (M1)
-- 20/20 — Hasta aqui el modelo asumia una tienda, un publico y un precio. El
--         RFP de Alicorp pide tres canales —B2C minorista, B2B comercial e
--         Interno de colaboradores— con catalogos, precios y reglas distintas
--         pero **un solo maestro de productos** (§4.1.2 «Catalogo unico de
--         productos», «Maestro unico de clientes»).
--
-- Decision de modelado: el canal NO es una tienda. Modelar cada canal como una
-- `store` habria salido casi gratis —reusa RLS, branding y resolucion por
-- slug— pero obliga a triplicar los 3.086 SKUs, que es exactamente lo que el
-- pliego prohibe. El canal es una DIMENSION sobre el catalogo de la tienda:
--   · `channels`          — el canal, con su tipo y sus reglas
--   · `product_channels`  — que productos se ven en que canal
--   · `orders.channel_id` — por donde entro cada pedido
--
-- Compatibilidad: las tiendas existentes reciben un canal `b2c` por defecto y
-- los pedidos existentes se reasignan a el, de modo que la vitrina publica y el
-- backoffice siguen funcionando sin tocar una linea.
-- =============================================================================

create type public.channel_kind as enum ('b2c', 'b2b', 'internal');

create table public.channels (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  name            text        not null,
  kind            public.channel_kind not null,
  -- El canal por el que entra el comprador anonimo de la vitrina publica.
  -- `create_order` lo elige cuando nadie declara canal.
  is_default      boolean     not null default false,
  -- B2B e Interno exigen sesion; B2C no. Es una regla del canal, no de la
  -- pantalla: la vitrina publica solo puede ver canales sin sesion.
  requires_auth   boolean     not null default false,
  is_active       boolean     not null default true,
  settings        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint channels_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint channels_name_len check (char_length(btrim(name)) between 1 and 120),
  -- Un canal publico que exige sesion es una contradiccion, y un canal cerrado
  -- que no la exige es una fuga: se impide en la base.
  constraint channels_auth_matches_kind check (
    (kind = 'b2c' and not requires_auth) or (kind <> 'b2c' and requires_auth)
  ),
  constraint channels_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint channels_code_unique  unique (store_id, code),
  constraint channels_store_key    unique (id, store_id),
  constraint channels_tenant_key   unique (id, organization_id, company_id)
);

create index channels_tenant on public.channels (organization_id, company_id);

-- Un solo canal por defecto por tienda: si hubiera dos, `create_order` tendria
-- que elegir y el importe del pedido dependeria del orden de las filas.
create unique index channels_one_default
  on public.channels (store_id)
  where is_default;

-- ---------------------------------------------------------------------------
-- product_channels — visibilidad del catalogo unico por canal.
-- La ausencia de fila significa "no se vende en ese canal". Es lo que permite
-- que el canal interno tenga un catalogo restringido (§4.4.2) sin duplicar un
-- solo producto.
-- ---------------------------------------------------------------------------
create table public.product_channels (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  channel_id      uuid        not null,
  created_at      timestamptz not null default now(),
  constraint product_channels_unique unique (product_id, channel_id),
  constraint product_channels_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_channels_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete cascade
);

create index product_channels_tenant  on public.product_channels (organization_id, company_id);
create index product_channels_channel on public.product_channels (channel_id);

-- ---------------------------------------------------------------------------
-- Pedidos: por donde entro cada uno
-- ---------------------------------------------------------------------------
alter table public.orders add column channel_id uuid;

-- Backfill en la misma migracion: primero un canal b2c por tienda existente,
-- luego los pedidos que ya existen. Sin esto, el NOT NULL de abajo no pasa.
insert into public.channels
  (organization_id, company_id, store_id, code, name, kind, is_default, requires_auth)
select s.organization_id, s.company_id, s.id, 'b2c', 'Tienda pública', 'b2c', true, false
from public.stores s
on conflict (store_id, code) do nothing;

update public.orders o
   set channel_id = c.id
  from public.channels c
 where c.store_id = o.store_id
   and c.is_default
   and o.channel_id is null;

alter table public.orders alter column channel_id set not null;

alter table public.orders
  add constraint orders_channel_fk foreign key (channel_id, store_id)
  references public.channels (id, store_id) on delete restrict;

create index orders_channel on public.orders (channel_id);

-- ---------------------------------------------------------------------------
-- RLS — default deny, igual que el resto
-- ---------------------------------------------------------------------------
alter table public.channels         enable row level security;
alter table public.channels         force  row level security;
alter table public.product_channels enable row level security;
alter table public.product_channels force  row level security;

revoke all on public.channels         from public, anon, authenticated;
revoke all on public.product_channels from public, anon, authenticated;

grant select, insert, update, delete on public.channels         to authenticated;
grant select, insert, update, delete on public.product_channels to authenticated;
grant all on public.channels, public.product_channels to service_role;

-- El comprador anonimo necesita saber que canal publico tiene la tienda para
-- pintar el catalogo. Solo columnas publicables: `settings` no sale.
grant select (id, store_id, code, name, kind, is_default, is_active, requires_auth)
  on public.channels to anon;
grant select (product_id, channel_id, store_id) on public.product_channels to anon;

create policy channels_select_member on public.channels
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy channels_insert_admin on public.channels
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy channels_update_admin on public.channels
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy channels_delete_admin on public.channels
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

-- Anonimo: solo canales ACTIVOS, que NO exijan sesion, de tiendas ACTIVAS.
-- Un canal B2B o interno nunca es visible sin sesion aunque se conozca su uuid.
create policy channels_select_public on public.channels
  for select to anon
  using (
    is_active
    and not requires_auth
    and exists (
      select 1 from public.stores s
      where s.id = channels.store_id and s.status = 'active'
    )
  );

create policy product_channels_select_member on public.product_channels
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy product_channels_insert_catalog on public.product_channels
  for insert to authenticated
  with check (ebim.has_role(organization_id, company_id,
    array['owner','admin','catalog']::public.app_role[]));

create policy product_channels_delete_catalog on public.product_channels
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id,
    array['owner','admin','catalog']::public.app_role[]));

-- Anonimo: la visibilidad solo se lee para canales que el anonimo ya puede ver.
create policy product_channels_select_public on public.product_channels
  for select to anon
  using (
    exists (
      select 1
      from public.channels c
      join public.stores s on s.id = c.store_id
      where c.id = product_channels.channel_id
        and c.is_active
        and not c.requires_auth
        and s.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- Toda tienda nace con su canal publico.
--
-- El backfill de arriba solo alcanza a las tiendas que ya existian: sin este
-- trigger, cualquier tienda creada despues —incluida cada alta por
-- `bootstrap_tenant`— se quedaria sin canal por defecto y su checkout moriria
-- con CANAL_NO_DISPONIBLE. Va en trigger y no en la funcion de alta para que
-- valga para TODOS los caminos que crean tiendas, presentes y futuros.
-- ---------------------------------------------------------------------------
create or replace function ebim.ensure_default_channel()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  insert into public.channels
    (organization_id, company_id, store_id, code, name, kind, is_default, requires_auth)
  values (new.organization_id, new.company_id, new.id,
          'b2c', 'Tienda pública', 'b2c', true, false)
  on conflict (store_id, code) do nothing;
  return new;
end;
$fn$;

create trigger stores_default_channel
  after insert on public.stores
  for each row execute function ebim.ensure_default_channel();

create trigger channels_updated_at before update on public.channels
  for each row execute function ebim.set_updated_at();

comment on table public.channels is
  'Canal de venta (B2C/B2B/Interno) sobre el catalogo unico de la tienda. No es una tienda: no duplica productos.';
comment on column public.channels.requires_auth is
  'B2B e Interno exigen sesion. La policy de anon lo usa como puerta: un canal cerrado no es visible sin sesion.';
comment on table public.product_channels is
  'Visibilidad del catalogo por canal. Sin fila = no se vende en ese canal (catalogo restringido del canal interno).';
comment on column public.orders.channel_id is
  'Canal por el que entro el pedido. Lo decide el servidor en create_order, nunca el payload.';
