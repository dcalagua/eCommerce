-- =============================================================================
-- Recorrido B2B · fases 10 y 11 — planificacion de reparto y evidencia de
-- entrega. Van juntas porque la evidencia es el cierre de la parada, y
-- separarlas dejaria una hoja de ruta que no se puede terminar.
--
-- ## Extienden `fulfillment`, no crean un despacho paralelo
--
-- `fulfillments`, `shipments`, `delivery_windows`, `delivery_zones` y
-- `tracking_events` ya existen y funcionan. Lo que falta es el ESLABON de
-- arriba —quien lleva que, en que vehiculo y en que orden— y el de abajo —la
-- prueba de que llego—. La parada apunta al `fulfillment` que ya existe: si
-- creara su propio despacho habria dos verdades sobre lo que salio del almacen.
--
-- ## Por que `pod_evidence` calca `return_evidence`
--
-- Mismo problema, mismo patron: un archivo en Storage con su ruta en la base,
-- nunca el binario dentro. Y el mismo bucket privado por tenant. Inventar otra
-- forma de guardar una foto obliga a mantener dos politicas de Storage que
-- acabarian discrepando en quien puede leer que.
--
-- ## La decision incomoda: la evidencia NO se edita
--
-- `proof_of_delivery` es append-only por trigger. Una firma que se puede
-- cambiar despues no prueba nada, y en una disputa por mercaderia no entregada
-- lo unico que vale es que el registro sea de la hora en que se hizo. Se corrige
-- con una entrega nueva, no reescribiendo la anterior.
-- =============================================================================

do $$ begin
  create type public.delivery_plan_status as enum ('draft', 'dispatched', 'closed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.pod_outcome as enum ('delivered', 'partial', 'refused', 'not_found');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- El vehiculo
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_vehicles (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  plate           text,
  description     text,
  -- Capacidad, para que la planificacion pueda avisar de un exceso. Nulo =
  -- no declarada; el planificador no inventa un tope.
  capacity_kg     numeric(12,2),
  capacity_m3     numeric(12,3),
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint delivery_vehicles_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint delivery_vehicles_capacity_sign
    check ((capacity_kg is null or capacity_kg > 0) and (capacity_m3 is null or capacity_m3 > 0)),
  constraint delivery_vehicles_code_unique unique (organization_id, company_id, code),
  constraint delivery_vehicles_tenant_key unique (id, organization_id, company_id)
);

create index if not exists delivery_vehicles_tenant_idx
  on public.delivery_vehicles (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- La hoja de ruta del dia
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_plans (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  vehicle_id      uuid,
  code            text        not null,
  plan_date       date        not null,
  status          public.delivery_plan_status not null default 'draft',
  driver_name     text,
  dispatched_at   timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint delivery_plans_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint delivery_plans_code_unique unique (organization_id, company_id, code),
  constraint delivery_plans_tenant_key unique (id, organization_id, company_id),
  constraint delivery_plans_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint delivery_plans_vehicle_fk
    foreign key (vehicle_id, organization_id, company_id)
    references public.delivery_vehicles (id, organization_id, company_id) on delete set null
);

create index if not exists delivery_plans_tenant_idx
  on public.delivery_plans (organization_id, company_id);
create index if not exists delivery_plans_date_idx
  on public.delivery_plans (plan_date, status);

create table if not exists public.delivery_plan_stops (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  plan_id         uuid        not null,
  -- El despacho que YA existe. La parada no crea uno nuevo: si lo hiciera
  -- habria dos verdades sobre lo que salio del almacen.
  fulfillment_id  uuid        not null,
  sequence        smallint    not null,
  eta             timestamptz,
  created_at      timestamptz not null default now(),

  constraint delivery_plan_stops_sequence_range check (sequence between 1 and 999),
  constraint delivery_plan_stops_plan_fk
    foreign key (plan_id, organization_id, company_id)
    references public.delivery_plans (id, organization_id, company_id) on delete cascade,
  constraint delivery_plan_stops_fulfillment_fk
    foreign key (fulfillment_id) references public.fulfillments (id) on delete cascade,
  -- Un despacho va en UNA hoja de ruta: en dos, el camion sale dos veces con la
  -- misma mercaderia y una de las dos entregas no existe.
  constraint delivery_plan_stops_fulfillment_unique unique (fulfillment_id),
  -- Y el orden es un orden.
  constraint delivery_plan_stops_sequence_unique unique (plan_id, sequence),
  -- La clave que permite la FK compuesta desde `proof_of_delivery`: sin ella
  -- Postgres rechaza la referencia por no haber unicidad que la sostenga.
  constraint delivery_plan_stops_tenant_key unique (id, organization_id, company_id)
);

create index if not exists delivery_plan_stops_tenant_idx
  on public.delivery_plan_stops (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- La evidencia de entrega
-- ---------------------------------------------------------------------------
create table if not exists public.proof_of_delivery (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  fulfillment_id  uuid        not null,
  stop_id         uuid,
  outcome         public.pod_outcome not null,
  received_by     text,
  document_id     text,
  -- Sin PostGIS, igual que el resto del repositorio: dos numeros bastan para
  -- decir donde se firmo, y una extension mas es una dependencia mas.
  geo_lat         numeric(9,6),
  geo_lng         numeric(9,6),
  -- Motivo obligatorio cuando NO se entrego: un rechazo sin motivo es una
  -- entrega fallida que nadie puede reclamar ni corregir.
  reason          text,
  -- `created_at` y no `recorded_at`: la tabla es append-only, asi que la hora en
  -- que se escribio la fila ES la hora en que se firmo. Dos columnas para el
  -- mismo instante son dos versiones que algun dia discreparan, y ademas
  -- `schema-invariants` exige `created_at` en toda tabla de negocio para que la
  -- auditoria pueda recorrerlas todas igual.
  created_at      timestamptz not null default now(),
  recorded_by     uuid,

  constraint proof_of_delivery_reason_when_failed check (
    outcome = 'delivered' or (reason is not null and char_length(btrim(reason)) > 0)
  ),
  constraint proof_of_delivery_geo_range check (
    (geo_lat is null or geo_lat between -90 and 90)
    and (geo_lng is null or geo_lng between -180 and 180)
  ),
  constraint proof_of_delivery_tenant_key unique (id, organization_id, company_id),
  constraint proof_of_delivery_fulfillment_fk
    foreign key (fulfillment_id) references public.fulfillments (id) on delete cascade,
  constraint proof_of_delivery_stop_fk
    foreign key (stop_id, organization_id, company_id)
    references public.delivery_plan_stops (id, organization_id, company_id) on delete set null
);

-- Reaplicable en los dos sentidos: en una base nueva la columna ya nace como
-- `created_at` por el CREATE de arriba, y en la que recibio la primera version
-- de esta migracion se llama `recorded_at` y hay que renombrarla. El bloque
-- traga el error de «no existe» para que ambos caminos terminen igual.
do $$ begin
  alter table public.proof_of_delivery rename column recorded_at to created_at;
exception when undefined_column then null; end $$;

create index if not exists proof_of_delivery_tenant_idx
  on public.proof_of_delivery (organization_id, company_id);
create index if not exists proof_of_delivery_fulfillment_idx
  on public.proof_of_delivery (fulfillment_id);

create table if not exists public.pod_evidence (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  pod_id          uuid        not null,
  -- La RUTA en el bucket privado, nunca el binario. Mismo patron que
  -- `return_evidence` y que las fotos de producto.
  storage_path    text        not null,
  content_type    text,
  caption         text,
  created_at      timestamptz not null default now(),

  constraint pod_evidence_path_len check (char_length(storage_path) between 1 and 400),
  constraint pod_evidence_pod_fk
    foreign key (pod_id, organization_id, company_id)
    references public.proof_of_delivery (id, organization_id, company_id) on delete cascade
);

create index if not exists pod_evidence_tenant_idx
  on public.pod_evidence (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- La evidencia no se reescribe.
--
-- Una firma que se puede cambiar despues no prueba nada. En una disputa por
-- mercaderia no entregada, lo unico que vale es que el registro sea de la hora
-- en que se hizo. Se corrige con una entrega nueva.
-- ---------------------------------------------------------------------------
create or replace function ebim.pod_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'EVIDENCIA_INMUTABLE: una prueba de entrega no se edita ni se borra'
    using errcode = '22023';
end;
$fn$;

drop trigger if exists proof_of_delivery_immutable on public.proof_of_delivery;
create trigger proof_of_delivery_immutable
  before update or delete on public.proof_of_delivery
  for each row execute function ebim.pod_is_immutable();

-- ---------------------------------------------------------------------------
-- RLS: default deny.
-- ---------------------------------------------------------------------------
alter table public.delivery_vehicles   enable row level security;
alter table public.delivery_vehicles   force  row level security;
alter table public.delivery_plans      enable row level security;
alter table public.delivery_plans      force  row level security;
alter table public.delivery_plan_stops enable row level security;
alter table public.delivery_plan_stops force  row level security;
alter table public.proof_of_delivery   enable row level security;
alter table public.proof_of_delivery   force  row level security;
alter table public.pod_evidence        enable row level security;
alter table public.pod_evidence        force  row level security;

revoke all on public.delivery_vehicles, public.delivery_plans, public.delivery_plan_stops,
              public.proof_of_delivery, public.pod_evidence from public;
grant select, insert, update, delete
  on public.delivery_vehicles, public.delivery_plans, public.delivery_plan_stops
  to authenticated;
-- La evidencia solo se INSERTA. El trigger ya lo impone; el grant lo dice
-- tambien, para que ni siquiera se intente.
grant select, insert on public.proof_of_delivery, public.pod_evidence to authenticated;
grant all on public.delivery_vehicles, public.delivery_plans, public.delivery_plan_stops,
             public.proof_of_delivery, public.pod_evidence to service_role;

drop policy if exists delivery_vehicles_select_member on public.delivery_vehicles;
create policy delivery_vehicles_select_member on public.delivery_vehicles
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists delivery_vehicles_write_ops on public.delivery_vehicles;
create policy delivery_vehicles_write_ops on public.delivery_vehicles
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  );

drop policy if exists delivery_plans_select_member on public.delivery_plans;
create policy delivery_plans_select_member on public.delivery_plans
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists delivery_plans_write_ops on public.delivery_plans;
create policy delivery_plans_write_ops on public.delivery_plans
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  );

drop policy if exists delivery_plan_stops_select_member on public.delivery_plan_stops;
create policy delivery_plan_stops_select_member on public.delivery_plan_stops
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists delivery_plan_stops_write_ops on public.delivery_plan_stops;
create policy delivery_plan_stops_write_ops on public.delivery_plan_stops
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  );

drop policy if exists proof_of_delivery_select_member on public.proof_of_delivery;
create policy proof_of_delivery_select_member on public.proof_of_delivery
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- Registrar la entrega la hace tambien el reparto: `orders` y el vendedor de
-- campo, que es quien esta delante del cliente.
drop policy if exists proof_of_delivery_insert_ops on public.proof_of_delivery;
create policy proof_of_delivery_insert_ops on public.proof_of_delivery
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders','sales_rep']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  );

drop policy if exists pod_evidence_select_member on public.pod_evidence;
create policy pod_evidence_select_member on public.pod_evidence
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists pod_evidence_insert_ops on public.pod_evidence;
create policy pod_evidence_insert_ops on public.pod_evidence
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders','sales_rep']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'fulfillment.routing')
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('fulfillment.routing', 'fulfillment', false, 'ecommerce.fulfillment.routing', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on table public.delivery_plan_stops is
  'La parada apunta al fulfillment que YA existe. Un despacho va en una sola hoja de ruta.';
comment on table public.proof_of_delivery is
  'Append-only por trigger: una firma que se puede cambiar despues no prueba nada.';
