-- =============================================================================
-- Recorrido B2B · fase 08 — surtidos.
--
-- ## Que es un surtido, y por que no basta con lo que ya hay
--
-- «Que puede comprar este cliente» hoy se responde a medias: `product_channels`
-- limita por canal y `price_list_assignments` decide el precio por segmento o
-- por cliente. Lo que falta es la lista EXPLICITA: la bodega de esquina no ve
-- el catalogo institucional, y el mayorista no ve la presentacion de una
-- unidad. En distribucion eso no es una preferencia, es la diferencia entre un
-- pedido correcto y un reclamo.
--
-- ## Se calca `price_list_assignments`, y no es pereza
--
-- Resuelve EXACTAMENTE el mismo problema —«que aplica a quien, con
-- precedencia»— y su forma ya esta probada: `scope` con un CHECK que obliga a
-- que solo la columna de ese ambito venga llena, y `unique nulls not distinct`
-- para que la misma asignacion no entre mil veces. Inventar otra forma para el
-- mismo problema obliga a quien lea el codigo a aprender dos.
--
-- ## La precedencia, escrita una vez
--
-- customer > segment > territory > channel > store.
--
-- De lo particular a lo general, igual que en pricing. Si dos surtidos aplican,
-- gana el mas especifico; si empatan, gana el de `priority` mayor y despues el
-- mas reciente. `ebim.assortment_for_customer` es el UNICO sitio donde esa
-- regla vive: tres pantallas calculandola por su cuenta acabarian enseñando
-- tres catalogos distintos al mismo cliente.
-- =============================================================================

do $$ begin
  create type public.assortment_scope as enum
    ('store', 'channel', 'territory', 'segment', 'customer');
exception when duplicate_object then null; end $$;

create table if not exists public.assortments (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  name            text        not null,
  -- `false` = lista NEGRA: lo que hay dentro es justo lo que NO se ofrece. Un
  -- distribuidor suele necesitar las dos: «solo estos 200» para el canal
  -- moderno y «todo menos estos 5» para el tradicional.
  is_allow_list   boolean     not null default true,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint assortments_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint assortments_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint assortments_code_unique unique (organization_id, company_id, code),
  constraint assortments_tenant_key unique (id, organization_id, company_id),
  constraint assortments_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index if not exists assortments_tenant_idx
  on public.assortments (organization_id, company_id);

create table if not exists public.assortment_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  assortment_id   uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  created_at      timestamptz not null default now(),

  constraint assortment_items_assortment_fk
    foreign key (assortment_id, organization_id, company_id)
    references public.assortments (id, organization_id, company_id) on delete cascade,
  constraint assortment_items_product_fk
    foreign key (product_id) references public.products (id) on delete cascade,
  constraint assortment_items_variant_fk
    foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  -- Mismo `nulls not distinct` que en pricing: sin el, un producto sin variante
  -- entraria tantas veces como se quisiera.
  constraint assortment_items_unique
    unique nulls not distinct (assortment_id, product_id, variant_id)
);

create index if not exists assortment_items_tenant_idx
  on public.assortment_items (organization_id, company_id);
create index if not exists assortment_items_assortment_idx
  on public.assortment_items (assortment_id);

create table if not exists public.assortment_assignments (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  assortment_id   uuid        not null,
  scope           public.assortment_scope not null,
  channel_id      uuid,
  territory_id    uuid,
  segment_id      uuid,
  customer_id     uuid,
  -- Desempate dentro del mismo ambito. La precedencia entre ambitos NO se toca
  -- con esto: un surtido de canal con prioridad 99 sigue perdiendo contra uno
  -- de cliente.
  priority        smallint    not null default 0,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Solo la columna del ambito viene llena. Sin este CHECK una fila podria
  -- decir «ambito canal» y traer ademas un cliente, y entonces «a quien aplica»
  -- tendria dos respuestas.
  constraint assortment_assignments_scope_target check (
    (scope = 'store'     and channel_id is null and territory_id is null
                         and segment_id is null and customer_id is null) or
    (scope = 'channel'   and channel_id is not null and territory_id is null
                         and segment_id is null and customer_id is null) or
    (scope = 'territory' and territory_id is not null and channel_id is null
                         and segment_id is null and customer_id is null) or
    (scope = 'segment'   and segment_id is not null and channel_id is null
                         and territory_id is null and customer_id is null) or
    (scope = 'customer'  and customer_id is not null and channel_id is null
                         and territory_id is null and segment_id is null)
  ),
  constraint assortment_assignments_assortment_fk
    foreign key (assortment_id, organization_id, company_id)
    references public.assortments (id, organization_id, company_id) on delete cascade,
  constraint assortment_assignments_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint assortment_assignments_channel_fk
    foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete cascade,
  constraint assortment_assignments_territory_fk
    foreign key (territory_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete cascade,
  constraint assortment_assignments_segment_fk
    foreign key (segment_id, organization_id, company_id)
    references public.customer_segments (id, organization_id, company_id) on delete cascade,
  constraint assortment_assignments_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint assortment_assignments_unique unique nulls not distinct
    (assortment_id, scope, channel_id, territory_id, segment_id, customer_id)
);

create index if not exists assortment_assignments_tenant_idx
  on public.assortment_assignments (organization_id, company_id);
create index if not exists assortment_assignments_customer_idx
  on public.assortment_assignments (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- ebim.assortment_for_customer — la precedencia, en UN solo sitio.
--
-- Devuelve el surtido que aplica, o NULL si el comercio no ha configurado
-- ninguno — y ese NULL significa «todo el catalogo», que es como se comportaba
-- la tienda antes de esta fase. La degradacion es la regla del repositorio: sin
-- surtido configurado, se vende igual que siempre.
-- ---------------------------------------------------------------------------
create or replace function ebim.assortment_for_customer(
  p_store    uuid,
  p_customer uuid,
  p_channel  uuid default null
)
returns uuid
language sql
stable
set search_path = ''
as $fn$
  select a.assortment_id
  from public.assortment_assignments a
  join public.assortments s
    on s.id = a.assortment_id and s.is_active
  left join public.customers c on c.id = p_customer
  left join public.sales_rep_customers rc on rc.customer_id = p_customer
  left join public.sales_rep_territories rt on rt.sales_rep_id = rc.sales_rep_id
  where a.store_id = p_store
    and a.is_active
    and (
      (a.scope = 'customer'  and a.customer_id = p_customer) or
      (a.scope = 'segment'   and a.segment_id = c.segment_id) or
      (a.scope = 'territory' and a.territory_id = rt.territory_id) or
      (a.scope = 'channel'   and a.channel_id = p_channel) or
      (a.scope = 'store')
    )
  -- De lo particular a lo general, igual que en pricing. El `case` es la unica
  -- definicion de la precedencia que existe en el sistema.
  order by case a.scope
             when 'customer'  then 1
             when 'segment'   then 2
             when 'territory' then 3
             when 'channel'   then 4
             else 5
           end,
           a.priority desc,
           a.created_at desc
  limit 1;
$fn$;

-- ¿Este producto se le puede ofrecer a este cliente?
create or replace function ebim.product_in_assortment(
  p_store    uuid,
  p_customer uuid,
  p_product  uuid,
  p_channel  uuid default null
)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  with elegido as (
    select ebim.assortment_for_customer(p_store, p_customer, p_channel) as id
  ),
  surtido as (
    select s.is_allow_list
    from public.assortments s join elegido e on e.id = s.id
  )
  select case
    -- Sin surtido configurado se ofrece todo: es como vendia la tienda antes.
    when not exists (select 1 from surtido) then true
    when (select is_allow_list from surtido) then exists (
      select 1 from public.assortment_items i, elegido e
      where i.assortment_id = e.id and i.product_id = p_product)
    else not exists (
      select 1 from public.assortment_items i, elegido e
      where i.assortment_id = e.id and i.product_id = p_product)
  end;
$fn$;

revoke execute on function ebim.assortment_for_customer(uuid, uuid, uuid) from public;
revoke execute on function ebim.product_in_assortment(uuid, uuid, uuid, uuid) from public;
grant  execute on function ebim.assortment_for_customer(uuid, uuid, uuid)
  to authenticated, service_role;
grant  execute on function ebim.product_in_assortment(uuid, uuid, uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: default deny.
-- ---------------------------------------------------------------------------
alter table public.assortments            enable row level security;
alter table public.assortments            force  row level security;
alter table public.assortment_items       enable row level security;
alter table public.assortment_items       force  row level security;
alter table public.assortment_assignments enable row level security;
alter table public.assortment_assignments force  row level security;

revoke all on public.assortments, public.assortment_items, public.assortment_assignments
  from public;
grant select, insert, update, delete
  on public.assortments, public.assortment_items, public.assortment_assignments
  to authenticated;
grant all on public.assortments, public.assortment_items, public.assortment_assignments
  to service_role;

drop policy if exists assortments_select_member on public.assortments;
create policy assortments_select_member on public.assortments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists assortments_write_catalog on public.assortments;
create policy assortments_write_catalog on public.assortments
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'trade.assortments')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'trade.assortments')
  );

drop policy if exists assortment_items_select_member on public.assortment_items;
create policy assortment_items_select_member on public.assortment_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists assortment_items_write_catalog on public.assortment_items;
create policy assortment_items_write_catalog on public.assortment_items
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'trade.assortments')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'trade.assortments')
  );

drop policy if exists assortment_assignments_select_member on public.assortment_assignments;
create policy assortment_assignments_select_member on public.assortment_assignments
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists assortment_assignments_write_catalog on public.assortment_assignments;
create policy assortment_assignments_write_catalog on public.assortment_assignments
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'trade.assortments')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','catalog']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'trade.assortments')
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('trade.assortments', 'trade', false, 'ecommerce.trade.assortments', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on function ebim.assortment_for_customer(uuid, uuid, uuid) is
  'La precedencia customer > segment > territory > channel > store, en UN solo sitio. NULL = todo el catalogo.';
