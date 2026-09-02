-- =============================================================================
-- Recorrido B2B · fase 02 (2 de 2) — fuerza de ventas: vendedor y cartera.
--
-- Es la fase que desbloquea otras cinco: territorios, rutas, visitas, metas y
-- comisiones cuelgan todas de que exista un vendedor y una asignacion
-- cliente -> vendedor. Construirlas antes obligaria a inventar un dueño para
-- cada dato y a rehacerlas despues.
--
-- ## Las decisiones que no son evidentes
--
-- **`user_id` es opcional.** Un vendedor existe en el maestro antes de tener
-- acceso a la aplicacion, y muchos nunca lo tendran —el jefe de ventas da de
-- alta la cartera de un preventista que solo usa papel—. Exigirlo convertiria
-- el alta comercial en un alta de usuario.
--
-- **Sin FK a `auth.users`.** Mismo patron que `business_account_users`: se
-- guarda el `sub` del JWT. `auth` es de Supabase y una FK contra su tabla ata
-- el modelo de negocio al proveedor de identidad.
--
-- **La jerarquia no admite ciclos.** `manager_id` apunta a la misma tabla y un
-- trigger lo vigila, igual que `categories_tree_guard`: sin el, «A reporta a B
-- que reporta a A» cuelga cualquier recorrido de la jerarquia, y ese bucle no
-- se descubre al guardarlo sino el dia que alguien calcula comisiones.
--
-- **La cartera tiene un titular.** `is_primary` con indice unico parcial: un
-- cliente puede ser atendido por varios, pero solo UNO responde por el. Sin esa
-- regla, «el vendedor de este cliente» es una pregunta con dos respuestas y la
-- comision se paga dos veces.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sales_reps
-- ---------------------------------------------------------------------------
create table if not exists public.sales_reps (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  -- El `sub` del JWT cuando el vendedor usa la aplicacion. NULL = existe en el
  -- maestro pero todavia no entra.
  user_id         uuid,
  employee_code   text        not null,
  full_name       text        not null,
  email           text,
  phone           text,
  manager_id      uuid,
  status          public.member_status not null default 'active',
  hired_at        date,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sales_reps_code_fmt check (employee_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint sales_reps_name_len check (char_length(btrim(full_name)) between 1 and 160),
  constraint sales_reps_email_fmt check (email is null or position('@' in email) > 1),
  -- Contrato §13: `@ebim.pe` no es actor de negocio de un tenant.
  constraint sales_reps_not_suite
    check (email is null or position('@ebim.pe' in lower(email)) = 0),
  constraint sales_reps_code_unique unique (organization_id, company_id, employee_code),
  -- La clave que permite FK compuestas con tenant desde las tablas que cuelgan.
  constraint sales_reps_tenant_key unique (id, organization_id, company_id),
  constraint sales_reps_manager_fk
    foreign key (manager_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete set null
);

create index if not exists sales_reps_tenant_idx
  on public.sales_reps (organization_id, company_id);
create index if not exists sales_reps_manager_idx on public.sales_reps (manager_id);
-- Un vendedor por persona y por tenant: dos filas para el mismo `user_id`
-- convertirian «que cartera veo» en una pregunta con dos respuestas.
create unique index if not exists sales_reps_user_unique
  on public.sales_reps (organization_id, company_id, user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- La jerarquia no admite ciclos.
-- ---------------------------------------------------------------------------
create or replace function ebim.sales_rep_tree_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_actual uuid := new.manager_id;
  v_saltos int := 0;
begin
  if new.manager_id is null then return new; end if;

  if new.manager_id = new.id then
    raise exception 'VENDEDOR_CICLO: un vendedor no puede reportarse a si mismo'
      using errcode = '22023';
  end if;

  -- Se sube por la cadena buscando la propia fila. El tope de saltos no es
  -- decoracion: si alguien logro meter un ciclo por otra via, este bucle seria
  -- infinito dentro de una transaccion.
  while v_actual is not null and v_saltos < 64 loop
    if v_actual = new.id then
      raise exception 'VENDEDOR_CICLO: esa jefatura cierra un circulo'
        using errcode = '22023';
    end if;
    select s.manager_id into v_actual from public.sales_reps s where s.id = v_actual;
    v_saltos := v_saltos + 1;
  end loop;

  return new;
end;
$fn$;

drop trigger if exists sales_reps_tree_guard on public.sales_reps;
create trigger sales_reps_tree_guard
  before insert or update of manager_id on public.sales_reps
  for each row execute function ebim.sales_rep_tree_guard();

-- ---------------------------------------------------------------------------
-- sales_rep_customers — la cartera
-- ---------------------------------------------------------------------------
create table if not exists public.sales_rep_customers (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  sales_rep_id    uuid        not null,
  customer_id     uuid        not null,
  -- El titular de la cuenta. Varios pueden atenderla; uno responde por ella.
  is_primary      boolean     not null default true,
  assigned_at     date        not null default current_date,
  created_at      timestamptz not null default now(),

  constraint sales_rep_customers_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete cascade,
  constraint sales_rep_customers_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint sales_rep_customers_unique unique (sales_rep_id, customer_id)
);

create index if not exists sales_rep_customers_tenant_idx
  on public.sales_rep_customers (organization_id, company_id);
create index if not exists sales_rep_customers_customer_idx
  on public.sales_rep_customers (customer_id);
-- Un solo titular por cliente. Es lo que impide que la comision se pague dos
-- veces por la misma venta.
create unique index if not exists sales_rep_customers_primary_unique
  on public.sales_rep_customers (customer_id)
  where is_primary;

-- ---------------------------------------------------------------------------
-- ebim.sales_rep_of — el vendedor que es el que llama, si lo es.
--
-- `SECURITY DEFINER` porque las policies de abajo necesitan mirar `sales_reps`
-- para decidir si dejan ver `sales_reps`, y eso desde una policy es recursion.
-- La autorizacion va DENTRO: solo responde por el usuario de la sesion, nunca
-- por otro, asi que no hay nada que forzar desde fuera.
-- ---------------------------------------------------------------------------
create or replace function ebim.sales_rep_of(p_org uuid, p_company uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.id
  from public.sales_reps s
  where s.organization_id = p_org
    and s.company_id = p_company
    and s.user_id = ebim.user_id()
    and s.status = 'active'
  limit 1;
$fn$;

revoke execute on function ebim.sales_rep_of(uuid, uuid) from public;
grant  execute on function ebim.sales_rep_of(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: default deny, y el vendedor solo se ve a si mismo y a su cartera.
-- ---------------------------------------------------------------------------
alter table public.sales_reps            enable row level security;
alter table public.sales_reps            force  row level security;
alter table public.sales_rep_customers   enable row level security;
alter table public.sales_rep_customers   force  row level security;

-- Lectura: la administracion ve la fuerza entera; el vendedor, su propia ficha
-- y la de quienes le reportan. Un preventista no tiene por que conocer la
-- nomina comercial completa del tenant.
create policy sales_reps_select_member on public.sales_reps
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or id = ebim.sales_rep_of(organization_id, company_id)
      or manager_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

create policy sales_reps_insert_admin on public.sales_reps
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  );

create policy sales_reps_update_admin on public.sales_reps
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  );

create policy sales_reps_delete_admin on public.sales_reps
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  );

-- La cartera: el vendedor ve la SUYA. Es la regla que hace que `sales.operate`
-- no sea un permiso sobre toda la base de clientes.
create policy sales_rep_customers_select_member on public.sales_rep_customers
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

create policy sales_rep_customers_insert_admin on public.sales_rep_customers
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  );

create policy sales_rep_customers_update_admin on public.sales_rep_customers
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  );

create policy sales_rep_customers_delete_admin on public.sales_rep_customers
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.force')
  );

comment on table public.sales_reps is
  'Fuerza de ventas del tenant. user_id opcional: existe en el maestro antes de tener acceso.';
comment on table public.sales_rep_customers is
  'Cartera: que clientes atiende cada vendedor. Un solo titular por cliente (indice parcial).';

-- ---------------------------------------------------------------------------
-- La capacidad. `declared` -> `implemented` cuando la fase cierre con pantalla.
--
-- Regla de degradacion del repositorio, sin excepcion: sin la capacidad el
-- tenant SIGUE vendiendo como antes. Nada de esto es prerrequisito del
-- checkout existente.
-- ---------------------------------------------------------------------------
insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('sales.force', 'sales', false, 'ecommerce.sales.force', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;
-- Los GRANT que faltaban: la RLS filtra FILAS, pero el rol necesita ademas el
-- privilegio de TABLA. Sin esto la policy nunca llega a evaluarse y el error es
-- «permission denied», que ademas confunde: parece un fallo de policy y es de
-- privilegio.
revoke all on public.sales_reps          from public;
revoke all on public.sales_rep_customers from public;
grant select, insert, update, delete on public.sales_reps          to authenticated;
grant select, insert, update, delete on public.sales_rep_customers to authenticated;
grant all on public.sales_reps, public.sales_rep_customers to service_role;
