-- =============================================================================
-- Recorrido B2B · fase 03 — territorios, rutas y la secuencia de visita.
--
-- ## Por que NO se reutiliza `delivery_zones`
--
-- Existe y tiene pais, regiones y prefijos postales, asi que la tentacion es
-- obvia. Y seria un error: `delivery_zones` es LOGISTICA —por donde pasa el
-- camion— y el territorio es COMERCIAL —de quien es la cartera—. Atarlos
-- significa que cambiar el recorrido de un reparto mueve clientes de dueño, y
-- por tanto mueve comisiones. Se llaman `sales_territories` precisamente para
-- que nadie los confunda al leer una consulta.
--
-- ## Las tres reglas que se hacen cumplir
--
-- **La jerarquia territorial no admite ciclos**, igual que la de vendedores y
-- por lo mismo: un recorrido recursivo sobre un ciclo no da un dato malo, se
-- cuelga.
--
-- **Un cliente aparece una vez en cada ruta.** Dos paradas para el mismo
-- cliente en el mismo recorrido no es un caso de negocio, es un duplicado que
-- convierte «cuantas visitas toca hoy» en una cifra inflada.
--
-- **La secuencia es unica dentro de la ruta.** Sin eso, «orden de visita» deja
-- de tener orden y el reparto del dia depende de como Postgres devuelva las
-- filas.
-- =============================================================================

create table if not exists public.sales_territories (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  parent_id       uuid,
  code            text        not null,
  name            text        not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sales_territories_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint sales_territories_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint sales_territories_code_unique unique (organization_id, company_id, code),
  constraint sales_territories_tenant_key unique (id, organization_id, company_id),
  constraint sales_territories_parent_fk
    foreign key (parent_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete set null
);

create index if not exists sales_territories_tenant_idx
  on public.sales_territories (organization_id, company_id);
create index if not exists sales_territories_parent_idx
  on public.sales_territories (parent_id);

-- La jerarquia territorial, sin ciclos. Mismo guardian que el de vendedores.
create or replace function ebim.sales_territory_tree_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_actual uuid := new.parent_id;
  v_saltos int := 0;
begin
  if new.parent_id is null then return new; end if;

  if new.parent_id = new.id then
    raise exception 'TERRITORIO_CICLO: un territorio no cuelga de si mismo'
      using errcode = '22023';
  end if;

  while v_actual is not null and v_saltos < 64 loop
    if v_actual = new.id then
      raise exception 'TERRITORIO_CICLO: esa jerarquia cierra un circulo'
        using errcode = '22023';
    end if;
    select t.parent_id into v_actual from public.sales_territories t where t.id = v_actual;
    v_saltos := v_saltos + 1;
  end loop;

  return new;
end;
$fn$;

drop trigger if exists sales_territories_tree_guard on public.sales_territories;
create trigger sales_territories_tree_guard
  before insert or update of parent_id on public.sales_territories
  for each row execute function ebim.sales_territory_tree_guard();

-- ---------------------------------------------------------------------------
-- Que vendedor cubre que territorio
-- ---------------------------------------------------------------------------
create table if not exists public.sales_rep_territories (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  sales_rep_id    uuid        not null,
  territory_id    uuid        not null,
  created_at      timestamptz not null default now(),

  constraint sales_rep_territories_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete cascade,
  constraint sales_rep_territories_territory_fk
    foreign key (territory_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete cascade,
  constraint sales_rep_territories_unique unique (sales_rep_id, territory_id)
);

create index if not exists sales_rep_territories_tenant_idx
  on public.sales_rep_territories (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- La ruta: que dia recorre quien, y en que orden
-- ---------------------------------------------------------------------------
create table if not exists public.sales_routes (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  sales_rep_id    uuid        not null,
  territory_id    uuid,
  code            text        not null,
  name            text        not null,
  -- 0 = domingo, como `extract(dow)`. Se guarda el numero y no el nombre para
  -- que la comparacion con una fecha sea directa y no dependa del idioma.
  weekday         smallint    not null,
  -- Cada cuantas semanas se repite. 1 = todas.
  frequency_weeks smallint    not null default 1,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sales_routes_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint sales_routes_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint sales_routes_weekday_range check (weekday between 0 and 6),
  constraint sales_routes_frequency_range check (frequency_weeks between 1 and 8),
  constraint sales_routes_code_unique unique (organization_id, company_id, code),
  constraint sales_routes_tenant_key unique (id, organization_id, company_id),
  constraint sales_routes_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete cascade,
  constraint sales_routes_territory_fk
    foreign key (territory_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete set null
);

create index if not exists sales_routes_tenant_idx
  on public.sales_routes (organization_id, company_id);
create index if not exists sales_routes_rep_idx on public.sales_routes (sales_rep_id, weekday);

create table if not exists public.sales_route_stops (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  route_id        uuid        not null,
  customer_id     uuid        not null,
  sequence        smallint    not null,
  created_at      timestamptz not null default now(),

  constraint sales_route_stops_sequence_range check (sequence between 1 and 999),
  constraint sales_route_stops_route_fk
    foreign key (route_id, organization_id, company_id)
    references public.sales_routes (id, organization_id, company_id) on delete cascade,
  constraint sales_route_stops_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  -- Un cliente, una parada por ruta: dos paradas del mismo cliente inflan
  -- «cuantas visitas toca hoy».
  constraint sales_route_stops_customer_unique unique (route_id, customer_id),
  -- Y el orden es un orden: sin esto el recorrido del dia depende de como
  -- Postgres devuelva las filas.
  constraint sales_route_stops_sequence_unique unique (route_id, sequence)
);

create index if not exists sales_route_stops_tenant_idx
  on public.sales_route_stops (organization_id, company_id);

-- ---------------------------------------------------------------------------
-- RLS: default deny. Mismo criterio que la cartera — el vendedor ve LO SUYO.
-- ---------------------------------------------------------------------------
-- Explicito y no en un bucle con `execute format`: `schema-invariants.test.ts`
-- comprueba con un grep que la migracion que CREA una tabla activa su RLS en el
-- mismo archivo, y hace bien — una activacion generada en tiempo de ejecucion
-- no se puede auditar leyendo el diff.

alter table public.sales_territories enable row level security;
alter table public.sales_territories force  row level security;
revoke all on public.sales_territories from public;
grant select, insert, update, delete on public.sales_territories to authenticated;
grant all on public.sales_territories to service_role;

drop policy if exists sales_territories_insert_admin on public.sales_territories;
create policy sales_territories_insert_admin on public.sales_territories
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_territories_update_admin on public.sales_territories;
create policy sales_territories_update_admin on public.sales_territories
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_territories_delete_admin on public.sales_territories;
create policy sales_territories_delete_admin on public.sales_territories
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

alter table public.sales_rep_territories enable row level security;
alter table public.sales_rep_territories force  row level security;
revoke all on public.sales_rep_territories from public;
grant select, insert, update, delete on public.sales_rep_territories to authenticated;
grant all on public.sales_rep_territories to service_role;

drop policy if exists sales_rep_territories_insert_admin on public.sales_rep_territories;
create policy sales_rep_territories_insert_admin on public.sales_rep_territories
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_rep_territories_update_admin on public.sales_rep_territories;
create policy sales_rep_territories_update_admin on public.sales_rep_territories
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_rep_territories_delete_admin on public.sales_rep_territories;
create policy sales_rep_territories_delete_admin on public.sales_rep_territories
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

alter table public.sales_routes enable row level security;
alter table public.sales_routes force  row level security;
revoke all on public.sales_routes from public;
grant select, insert, update, delete on public.sales_routes to authenticated;
grant all on public.sales_routes to service_role;

drop policy if exists sales_routes_insert_admin on public.sales_routes;
create policy sales_routes_insert_admin on public.sales_routes
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_routes_update_admin on public.sales_routes;
create policy sales_routes_update_admin on public.sales_routes
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_routes_delete_admin on public.sales_routes;
create policy sales_routes_delete_admin on public.sales_routes
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

alter table public.sales_route_stops enable row level security;
alter table public.sales_route_stops force  row level security;
revoke all on public.sales_route_stops from public;
grant select, insert, update, delete on public.sales_route_stops to authenticated;
grant all on public.sales_route_stops to service_role;

drop policy if exists sales_route_stops_insert_admin on public.sales_route_stops;
create policy sales_route_stops_insert_admin on public.sales_route_stops
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_route_stops_update_admin on public.sales_route_stops;
create policy sales_route_stops_update_admin on public.sales_route_stops
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

drop policy if exists sales_route_stops_delete_admin on public.sales_route_stops;
create policy sales_route_stops_delete_admin on public.sales_route_stops
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.territory')
  );

-- El territorio en si lo puede leer cualquier miembro: es vocabulario del
-- tenant, como una categoria. Lo que se acota es a QUIEN se le asigna.
drop policy if exists sales_territories_select_member on public.sales_territories;
create policy sales_territories_select_member on public.sales_territories
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

drop policy if exists sales_rep_territories_select_member on public.sales_rep_territories;
create policy sales_rep_territories_select_member on public.sales_rep_territories
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

-- La ruta es la agenda de una persona. Un preventista ve la suya, no la de sus
-- compañeros: saber por donde pasa otro no es parte de su trabajo.
drop policy if exists sales_routes_select_member on public.sales_routes;
create policy sales_routes_select_member on public.sales_routes
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists sales_route_stops_select_member on public.sales_route_stops;
create policy sales_route_stops_select_member on public.sales_route_stops
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or exists (
        select 1 from public.sales_routes r
        where r.id = route_id
          and r.sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
      )
    )
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('sales.territory', 'sales', false, 'ecommerce.sales.territory', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on table public.sales_territories is
  'Territorio COMERCIAL, distinto de delivery_zones (logistica). Jerarquia sin ciclos por trigger.';
comment on table public.sales_route_stops is
  'Secuencia de visita. Un cliente por ruta y un orden por posicion: las dos son unicas.';
