-- =============================================================================
-- Recorrido B2B · fases 12 y 13 — visitas, metas y comisiones.
--
-- Cierran el dominio `sales`. Las tres cuelgan del vendedor y de la ruta que ya
-- existen: sin la fase 02 no habria a quien atribuir una visita ni a quien
-- pagarle una comision.
--
-- ## Las decisiones que evitan un pleito
--
-- **La visita registra lo que PASO, no lo que se planeo.** `planned_at` y
-- `checked_in_at` son columnas distintas a proposito: la primera es la agenda y
-- la segunda es el hecho. Machacar una con otra borraria la unica prueba de que
-- la visita no se hizo cuando tocaba.
--
-- **La liquidacion de comision es INMUTABLE una vez pagada.** Es dinero de
-- terceros: recalcular una liquidacion cerrada porque cambio una regla es
-- exactamente como se pierde la confianza de una fuerza de ventas. Se corrige
-- con un ajuste en el periodo siguiente, que es como lo hace cualquier nomina.
--
-- **La meta se guarda en la unidad en que se mide.** Importe o unidades, con un
-- CHECK que obliga a decir cual: «vendiste 1.200» no significa nada si no se
-- sabe si son soles o cajas.
-- =============================================================================

do $$ begin
  create type public.visit_outcome as enum
    ('planned', 'completed', 'no_order', 'closed', 'rescheduled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.goal_metric as enum ('amount', 'units', 'orders', 'coverage');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.commission_status as enum ('draft', 'approved', 'paid');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- La visita
-- ---------------------------------------------------------------------------
create table if not exists public.sales_visits (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  sales_rep_id    uuid        not null,
  customer_id     uuid        not null,
  route_id        uuid,
  -- La AGENDA.
  planned_at      timestamptz,
  -- El HECHO. Machacar la agenda con esto borraria la unica prueba de que la
  -- visita no se hizo cuando tocaba.
  checked_in_at   timestamptz,
  checked_out_at  timestamptz,
  outcome         public.visit_outcome not null default 'planned',
  -- El pedido que salio de la visita, si salio alguno. Es lo que permite
  -- responder «cuantas visitas terminan en venta» sin inventarse la relacion.
  order_id        uuid,
  geo_lat         numeric(9,6),
  geo_lng         numeric(9,6),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sales_visits_out_after_in
    check (checked_out_at is null or checked_in_at is null or checked_out_at >= checked_in_at),
  constraint sales_visits_geo_range check (
    (geo_lat is null or geo_lat between -90 and 90)
    and (geo_lng is null or geo_lng between -180 and 180)
  ),
  -- Una visita completada tuvo que empezar: sin entrada no hay visita, hay un
  -- parte de trabajo escrito desde la oficina.
  constraint sales_visits_completed_needs_checkin
    check (outcome <> 'completed' or checked_in_at is not null),
  constraint sales_visits_tenant_key unique (id, organization_id, company_id),
  constraint sales_visits_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete cascade,
  constraint sales_visits_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint sales_visits_route_fk
    foreign key (route_id, organization_id, company_id)
    references public.sales_routes (id, organization_id, company_id) on delete set null
);

create index if not exists sales_visits_tenant_idx
  on public.sales_visits (organization_id, company_id);
create index if not exists sales_visits_rep_idx
  on public.sales_visits (sales_rep_id, planned_at);
create index if not exists sales_visits_customer_idx on public.sales_visits (customer_id);

create table if not exists public.sales_visit_tasks (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  visit_id        uuid        not null,
  label           text        not null,
  is_done         boolean     not null default false,
  position        smallint    not null default 0,
  created_at      timestamptz not null default now(),

  constraint sales_visit_tasks_label_len check (char_length(btrim(label)) between 1 and 160),
  constraint sales_visit_tasks_visit_fk
    foreign key (visit_id, organization_id, company_id)
    references public.sales_visits (id, organization_id, company_id) on delete cascade
);

create index if not exists sales_visit_tasks_tenant_idx
  on public.sales_visit_tasks (organization_id, company_id);
create index if not exists sales_visit_tasks_visit_idx
  on public.sales_visit_tasks (visit_id, position);

-- ---------------------------------------------------------------------------
-- La meta
-- ---------------------------------------------------------------------------
create table if not exists public.sales_goals (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  sales_rep_id    uuid,
  territory_id    uuid,
  metric          public.goal_metric not null,
  -- Moneda obligatoria cuando la meta es un importe: «vendiste 1.200» no
  -- significa nada si no se sabe si son soles o cajas.
  currency        char(3),
  period_start    date        not null,
  period_end      date        not null,
  target_value    numeric(14,2) not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sales_goals_target_sign check (target_value > 0),
  constraint sales_goals_period_order check (period_end >= period_start),
  constraint sales_goals_currency_when_amount
    check ((metric = 'amount') = (currency is not null)),
  -- La meta es de alguien: de un vendedor o de un territorio, nunca de nadie ni
  -- de los dos a la vez —eso haria que la misma venta cumpliera dos metas y
  -- pagara dos comisiones.
  constraint sales_goals_one_owner check (
    (sales_rep_id is not null and territory_id is null)
    or (sales_rep_id is null and territory_id is not null)
  ),
  constraint sales_goals_unique unique nulls not distinct
    (sales_rep_id, territory_id, metric, period_start, period_end),
  constraint sales_goals_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete cascade,
  constraint sales_goals_territory_fk
    foreign key (territory_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete cascade
);

create index if not exists sales_goals_tenant_idx
  on public.sales_goals (organization_id, company_id);
create index if not exists sales_goals_period_idx
  on public.sales_goals (period_start, period_end);

-- ---------------------------------------------------------------------------
-- La comision
-- ---------------------------------------------------------------------------
create table if not exists public.commission_rules (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  code            text        not null,
  name            text        not null,
  -- Porcentaje sobre la base. Se guarda como tasa y no como porcentaje entero
  -- para no arrastrar la division por cien a cada consulta.
  rate            numeric(6,4) not null,
  -- Solo se paga a partir de este cumplimiento (0.8 = 80 % de la meta). Nulo =
  -- se paga desde el primer sol.
  min_attainment  numeric(6,4),
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint commission_rules_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint commission_rules_rate_range check (rate > 0 and rate <= 1),
  constraint commission_rules_attainment_range
    check (min_attainment is null or (min_attainment > 0 and min_attainment <= 5)),
  constraint commission_rules_code_unique unique (organization_id, company_id, code),
  constraint commission_rules_tenant_key unique (id, organization_id, company_id)
);

create index if not exists commission_rules_tenant_idx
  on public.commission_rules (organization_id, company_id);

create table if not exists public.commission_statements (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  sales_rep_id    uuid        not null,
  rule_id         uuid,
  period_start    date        not null,
  period_end      date        not null,
  currency        char(3)     not null,
  base_amount     numeric(14,2) not null default 0,
  rate            numeric(6,4) not null,
  amount          numeric(14,2) not null default 0,
  status          public.commission_status not null default 'draft',
  approved_at     timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint commission_statements_period_order check (period_end >= period_start),
  constraint commission_statements_amounts_sign
    check (base_amount >= 0 and amount >= 0 and rate > 0),
  -- Un vendedor, un periodo, una liquidacion. Dos serian dos pagos por el mismo
  -- trabajo.
  constraint commission_statements_unique
    unique (sales_rep_id, period_start, period_end),
  constraint commission_statements_tenant_key unique (id, organization_id, company_id),
  constraint commission_statements_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete restrict,
  constraint commission_statements_rule_fk
    foreign key (rule_id, organization_id, company_id)
    references public.commission_rules (id, organization_id, company_id) on delete set null
);

create index if not exists commission_statements_tenant_idx
  on public.commission_statements (organization_id, company_id);
create index if not exists commission_statements_rep_idx
  on public.commission_statements (sales_rep_id, period_start);

-- ---------------------------------------------------------------------------
-- Una liquidacion pagada no se toca.
--
-- Es dinero de terceros. Recalcular una liquidacion cerrada porque cambio una
-- regla es exactamente como se pierde la confianza de una fuerza de ventas: se
-- corrige con un ajuste en el periodo siguiente, como cualquier nomina.
-- ---------------------------------------------------------------------------
create or replace function ebim.commission_statement_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    if old.status = 'paid' then
      raise exception 'LIQUIDACION_PAGADA: una liquidacion pagada no se borra'
        using errcode = '22023';
    end if;
    return old;
  end if;

  if old.status = 'paid' then
    raise exception 'LIQUIDACION_PAGADA: se corrige con un ajuste del periodo siguiente'
      using errcode = '22023';
  end if;

  -- Aprobada: se puede pagar, no reabrir ni recalcular.
  if old.status = 'approved' and new.status = 'draft' then
    raise exception 'LIQUIDACION_APROBADA: no vuelve a borrador'
      using errcode = '22023';
  end if;
  if old.status = 'approved'
     and (new.base_amount, new.rate, new.amount) is distinct from
         (old.base_amount, old.rate, old.amount) then
    raise exception 'LIQUIDACION_APROBADA: los importes ya no se recalculan'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

drop trigger if exists commission_statements_guard on public.commission_statements;
create trigger commission_statements_guard
  before update or delete on public.commission_statements
  for each row execute function ebim.commission_statement_guard();

-- ---------------------------------------------------------------------------
-- RLS: default deny.
-- ---------------------------------------------------------------------------
alter table public.sales_visits           enable row level security;
alter table public.sales_visits           force  row level security;
alter table public.sales_visit_tasks      enable row level security;
alter table public.sales_visit_tasks      force  row level security;
alter table public.sales_goals            enable row level security;
alter table public.sales_goals            force  row level security;
alter table public.commission_rules       enable row level security;
alter table public.commission_rules       force  row level security;
alter table public.commission_statements  enable row level security;
alter table public.commission_statements  force  row level security;

revoke all on public.sales_visits, public.sales_visit_tasks, public.sales_goals,
              public.commission_rules, public.commission_statements from public;
grant select, insert, update, delete
  on public.sales_visits, public.sales_visit_tasks, public.sales_goals,
     public.commission_rules, public.commission_statements to authenticated;
grant all on public.sales_visits, public.sales_visit_tasks, public.sales_goals,
             public.commission_rules, public.commission_statements to service_role;

-- La visita es del vendedor: la ve y la escribe el que la hace.
drop policy if exists sales_visits_select_member on public.sales_visits;
create policy sales_visits_select_member on public.sales_visits
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists sales_visits_write_field on public.sales_visits;
create policy sales_visits_write_field on public.sales_visits
  for all to authenticated
  using (
    ebim.has_capability(organization_id, company_id, 'sales.territory')
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  )
  with check (
    ebim.has_capability(organization_id, company_id, 'sales.territory')
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists sales_visit_tasks_select_member on public.sales_visit_tasks;
create policy sales_visit_tasks_select_member on public.sales_visit_tasks
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and exists (select 1 from public.sales_visits v where v.id = visit_id)
  );

drop policy if exists sales_visit_tasks_write_field on public.sales_visit_tasks;
create policy sales_visit_tasks_write_field on public.sales_visit_tasks
  for all to authenticated
  using (
    ebim.has_capability(organization_id, company_id, 'sales.territory')
    and exists (
      select 1 from public.sales_visits v
      where v.id = visit_id
        and (
          ebim.has_role(v.organization_id, v.company_id,
                        array['owner','admin']::public.app_role[])
          or v.sales_rep_id = ebim.sales_rep_of(v.organization_id, v.company_id)
        )
    )
  )
  with check (
    ebim.has_capability(organization_id, company_id, 'sales.territory')
    and exists (
      select 1 from public.sales_visits v
      where v.id = visit_id
        and (
          ebim.has_role(v.organization_id, v.company_id,
                        array['owner','admin']::public.app_role[])
          or v.sales_rep_id = ebim.sales_rep_of(v.organization_id, v.company_id)
        )
    )
  );

-- La meta la ve su dueño; la escribe la administracion.
drop policy if exists sales_goals_select_member on public.sales_goals;
create policy sales_goals_select_member on public.sales_goals
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists sales_goals_write_admin on public.sales_goals;
create policy sales_goals_write_admin on public.sales_goals
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.performance')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.performance')
  );

-- La comision es dinero de terceros: solo la administracion. Ni siquiera el
-- vendedor la escribe, y su propia liquidacion la ve pero no la toca.
drop policy if exists commission_rules_select_admin on public.commission_rules;
create policy commission_rules_select_admin on public.commission_rules
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
  );

drop policy if exists commission_rules_write_admin on public.commission_rules;
create policy commission_rules_write_admin on public.commission_rules
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.performance')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.performance')
  );

drop policy if exists commission_statements_select_member on public.commission_statements;
create policy commission_statements_select_member on public.commission_statements
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists commission_statements_write_admin on public.commission_statements;
create policy commission_statements_write_admin on public.commission_statements
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.performance')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'sales.performance')
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('sales.performance', 'sales', false, 'ecommerce.sales.performance', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on table public.sales_visits is
  'La agenda (`planned_at`) y el hecho (`checked_in_at`) son columnas distintas: machacar una borra la prueba.';
comment on table public.commission_statements is
  'Pagada = inmutable. Se corrige con un ajuste del periodo siguiente, como cualquier nomina.';
