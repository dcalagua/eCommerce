-- =============================================================================
-- Recorrido B2B · fase 01 — maestro comercial.
--
-- ## Extiende `customers`, no crea un maestro aparte
--
-- La tentacion es hacer una tabla «clientes comerciales». Seria un duplicado:
-- `customers` ya guarda razon social, documento fiscal, contactos, direcciones
-- y segmento. Lo que falta es la clasificacion COMERCIAL del punto de venta —de
-- que giro es, cuanto vale, cada cuanto se visita y donde esta— y eso son
-- columnas, no una entidad nueva. Un maestro paralelo obligaria a decidir cual
-- de los dos manda cada vez que los dos digan algo.
--
-- ## Por que `customer_business_types` es una tabla y no un enum
--
-- El giro es vocabulario DEL TENANT: una distribuidora de farmacia y una de
-- ferreteria no comparten lista, y añadir un valor no puede exigir una
-- migracion. Mismo patron que `customer_segments`, que ya resolvio esto.
--
-- ## La geoposicion sin PostGIS
--
-- Dos numeros. Sirven para pintar el punto en un mapa y para ordenar una ruta
-- por cercania, que es todo lo que hace falta aqui. Una extension de sistema es
-- una dependencia que hay que mantener en cada entorno.
-- =============================================================================

do $$ begin
  create type public.customer_tier as enum ('a', 'b', 'c');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.visit_frequency as enum ('weekly', 'biweekly', 'monthly', 'on_demand');
exception when duplicate_object then null; end $$;

create table if not exists public.customer_business_types (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint customer_business_types_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint customer_business_types_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint customer_business_types_code_unique unique (organization_id, company_id, code),
  constraint customer_business_types_tenant_key unique (id, organization_id, company_id)
);

create index if not exists customer_business_types_tenant_idx
  on public.customer_business_types (organization_id, company_id);

alter table public.customers
  add column if not exists business_type_id uuid,
  add column if not exists tier             public.customer_tier,
  add column if not exists visit_frequency  public.visit_frequency,
  add column if not exists geo_lat          numeric(9,6),
  add column if not exists geo_lng          numeric(9,6);

do $$ begin
  alter table public.customers
    add constraint customers_business_type_fk
    foreign key (business_type_id, organization_id, company_id)
    references public.customer_business_types (id, organization_id, company_id)
    on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.customers
    add constraint customers_geo_range check (
      (geo_lat is null or geo_lat between -90 and 90)
      and (geo_lng is null or geo_lng between -180 and 180)
    );
exception when duplicate_object then null; end $$;

-- La coordenada va entera o no va: media coordenada no ubica nada y es la clase
-- de dato que alguien acaba pintando en el (0,0) del Golfo de Guinea.
do $$ begin
  alter table public.customers
    add constraint customers_geo_pair check (
      (geo_lat is null) = (geo_lng is null)
    );
exception when duplicate_object then null; end $$;

create index if not exists customers_business_type_idx
  on public.customers (business_type_id) where business_type_id is not null;

alter table public.customer_business_types enable row level security;
alter table public.customer_business_types force  row level security;

revoke all on public.customer_business_types from public;
grant select, insert, update, delete on public.customer_business_types to authenticated;
grant all on public.customer_business_types to service_role;

drop policy if exists customer_business_types_select_member on public.customer_business_types;
create policy customer_business_types_select_member on public.customer_business_types
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- Sin comprobar la capacidad `customers`: es BASELINE, o sea, siempre concedida.
-- Nombrarla en una policy no protege nada y ademas hace creer que hay un
-- entitlement detras — `capability-enforcement.test.ts` lo marca en rojo, y con
-- razon: una comprobacion que siempre da verdadero es una comprobacion que
-- alguien un dia lee como si decidiera algo.
drop policy if exists customer_business_types_write_admin on public.customer_business_types;
create policy customer_business_types_write_admin on public.customer_business_types
  for all to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

comment on table public.customer_business_types is
  'Giro del punto de venta. Vocabulario DEL TENANT, como customer_segments: anadir uno no es una migracion.';
comment on column public.customers.tier is
  'Clasificacion de valor A/B/C. Es comercial y no de precio: el precio lo decide `segment_id`.';
