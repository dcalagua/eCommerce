-- =============================================================================
-- Recorrido B2B · fase 05 — pedido B2B avanzado.
--
-- ## Lo que NO se construye, y por que
--
-- La capacidad `orders.advanced` estaba DECLARADA y deliberadamente vacia desde
-- 20260828110600: esa migracion creo la fila en `app_capabilities` y ni una
-- tabla, con la justificacion escrita. Lo que si dejo puestos son los enganches
-- que esta fase reutiliza en vez de reinventar:
--
--   · **El motor de aprobacion ya existe** — `approval_rules`,
--     `purchase_approval` y `order_approval_decide`. Aqui no se escribe otro:
--     lo que faltaba es la BANDEJA del aprobador, y eso es pantalla.
--   · **La idempotencia por fila ya existe** — `checkout_intents`. No hace
--     falta una tabla de lotes de importacion.
--   · **La referencia externa ya existe** — `order_external_refs`, que con
--     `ref_type = 'import_batch'` cubre el origen de una carga masiva.
--
-- Queda una sola cosa de verdad ausente: **la programacion con estado** y la
-- plantilla que la alimenta.
--
-- ## Las dos decisiones
--
-- **La plantilla no lleva precio.** Guarda QUE y CUANTO, nunca a cuanto. El
-- precio lo resuelve `ebim.resolve_prices` el dia que el pedido nace; una
-- plantilla con precio dentro es un precio de hace seis meses esperando a que
-- alguien lo cobre.
--
-- **La programacion no crea pedidos por su cuenta.** Guarda cuando toca y deja
-- constancia de la ultima vez que se ejecuto. Quien crea el pedido sigue siendo
-- el pipeline de checkout, con sus once etapas y su idempotencia: un segundo
-- camino de creacion de pedidos seria un segundo sitio donde el stock se
-- reserva mal.
-- =============================================================================

do $$ begin
  create type public.order_schedule_status as enum ('active', 'paused', 'finished');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- La plantilla: que se pide habitualmente
-- ---------------------------------------------------------------------------
create table if not exists public.order_templates (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  company_id          uuid        not null,
  store_id            uuid        not null,
  customer_id         uuid        not null,
  business_account_id uuid,
  code                text        not null,
  name                text        not null,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint order_templates_code_fmt check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$'),
  constraint order_templates_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint order_templates_code_unique unique (organization_id, company_id, code),
  constraint order_templates_tenant_key unique (id, organization_id, company_id),
  constraint order_templates_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint order_templates_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint order_templates_account_fk
    foreign key (business_account_id, organization_id, company_id)
    references public.business_accounts (id, organization_id, company_id) on delete set null
);

create index if not exists order_templates_tenant_idx
  on public.order_templates (organization_id, company_id);
create index if not exists order_templates_customer_idx
  on public.order_templates (customer_id);

create table if not exists public.order_template_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  template_id     uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  uom_code        text,
  quantity        numeric(14,3) not null,
  position        smallint    not null default 0,
  created_at      timestamptz not null default now(),

  constraint order_template_items_quantity_sign check (quantity > 0),
  constraint order_template_items_template_fk
    foreign key (template_id, organization_id, company_id)
    references public.order_templates (id, organization_id, company_id) on delete cascade,
  constraint order_template_items_product_fk
    foreign key (product_id) references public.products (id) on delete cascade,
  constraint order_template_items_variant_fk
    foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  -- `nulls not distinct`, como en cotizaciones y en pricing: sin el, el caso
  -- normal —producto simple— se repetiria sin limite.
  constraint order_template_items_unique
    unique nulls not distinct (template_id, product_id, variant_id, uom_code)
);

create index if not exists order_template_items_tenant_idx
  on public.order_template_items (organization_id, company_id);
create index if not exists order_template_items_template_idx
  on public.order_template_items (template_id, position);

-- ---------------------------------------------------------------------------
-- La programacion: cuando toca
-- ---------------------------------------------------------------------------
create table if not exists public.order_schedules (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  template_id     uuid        not null,
  status          public.order_schedule_status not null default 'active',
  -- Cada cuantos dias. Se guarda el intervalo y no una expresion tipo cron
  -- porque el caso real de distribucion es «cada 7 dias» o «cada 15», y una
  -- expresion cron es un lenguaje entero que nadie de comercial va a escribir.
  interval_days   smallint    not null,
  next_run_on     date        not null,
  last_run_at     timestamptz,
  ends_on         date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint order_schedules_interval_range check (interval_days between 1 and 365),
  -- Solo mientras esta VIVA. Al terminar, la fecha siguiente pasa del limite
  -- por definicion —es justo lo que la da por terminada—, asi que un CHECK sin
  -- esa salvedad impediria cerrarla: la primera version rechazaba el propio
  -- `advance` que marca `finished`.
  constraint order_schedules_ends_after_next
    check (ends_on is null or status <> 'active' or ends_on >= next_run_on),
  constraint order_schedules_template_fk
    foreign key (template_id, organization_id, company_id)
    references public.order_templates (id, organization_id, company_id) on delete cascade,
  constraint order_schedules_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  -- Una programacion viva por plantilla: dos calendarios para la misma
  -- plantilla duplicarian el pedido sin que nadie lo pidiera dos veces.
  constraint order_schedules_template_unique unique (template_id)
);

-- La migracion es reaplicable: si el CHECK viejo existe, se sustituye.
alter table public.order_schedules
  drop constraint if exists order_schedules_ends_after_next;
alter table public.order_schedules
  add constraint order_schedules_ends_after_next
  check (ends_on is null or status <> 'active' or ends_on >= next_run_on);

create index if not exists order_schedules_tenant_idx
  on public.order_schedules (organization_id, company_id);
-- El indice del planificador: que toca hoy.
create index if not exists order_schedules_due_idx
  on public.order_schedules (next_run_on)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- ebim.order_schedule_advance — mover la fecha, y nada mas.
--
-- No crea el pedido. Lo dice el nombre y lo dice esta nota: quien crea pedidos
-- es el pipeline de checkout, con sus once etapas, su reserva de stock y su
-- idempotencia. Un segundo camino de creacion seria un segundo sitio donde el
-- stock se reserva mal.
-- ---------------------------------------------------------------------------
create or replace function ebim.order_schedule_advance(p_schedule uuid)
returns date
language plpgsql
set search_path = ''
as $fn$
declare
  v_row  public.order_schedules%rowtype;
  v_next date;
begin
  select * into v_row from public.order_schedules s where s.id = p_schedule for update;
  if not found then
    raise exception 'PROGRAMACION_NO_ENCONTRADA: no hay ninguna con ese id'
      using errcode = '22023';
  end if;

  if v_row.status <> 'active' then
    raise exception 'PROGRAMACION_INACTIVA: esa programacion esta en %', v_row.status
      using errcode = '22023';
  end if;

  -- Desde HOY y no desde la fecha prevista: si el planificador estuvo caido una
  -- semana, avanzar desde lo previsto dispararia siete pedidos de golpe al
  -- volver. Se pierde una entrega, no se duplican seis.
  v_next := greatest(v_row.next_run_on, current_date) + v_row.interval_days;

  update public.order_schedules
     set next_run_on = v_next,
         last_run_at = now(),
         status = case when v_row.ends_on is not null and v_next > v_row.ends_on
                       then 'finished' else v_row.status end,
         updated_at = now()
   where id = p_schedule;

  return v_next;
end;
$fn$;

revoke execute on function ebim.order_schedule_advance(uuid) from public;
grant  execute on function ebim.order_schedule_advance(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: default deny.
-- ---------------------------------------------------------------------------
alter table public.order_templates      enable row level security;
alter table public.order_templates      force  row level security;
alter table public.order_template_items enable row level security;
alter table public.order_template_items force  row level security;
alter table public.order_schedules      enable row level security;
alter table public.order_schedules      force  row level security;

revoke all on public.order_templates, public.order_template_items, public.order_schedules
  from public;
grant select, insert, update, delete
  on public.order_templates, public.order_template_items, public.order_schedules
  to authenticated;
grant all on public.order_templates, public.order_template_items, public.order_schedules
  to service_role;

drop policy if exists order_templates_select_member on public.order_templates;
create policy order_templates_select_member on public.order_templates
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders','sales_rep']::public.app_role[])
  );

drop policy if exists order_templates_write_orders on public.order_templates;
create policy order_templates_write_orders on public.order_templates
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'orders.advanced')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'orders.advanced')
  );

drop policy if exists order_template_items_select_member on public.order_template_items;
create policy order_template_items_select_member on public.order_template_items
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders','sales_rep']::public.app_role[])
  );

drop policy if exists order_template_items_write_orders on public.order_template_items;
create policy order_template_items_write_orders on public.order_template_items
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'orders.advanced')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'orders.advanced')
  );

drop policy if exists order_schedules_select_member on public.order_schedules;
create policy order_schedules_select_member on public.order_schedules
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders','sales_rep']::public.app_role[])
  );

drop policy if exists order_schedules_write_orders on public.order_schedules;
create policy order_schedules_write_orders on public.order_schedules
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'orders.advanced')
  )
  with check (
    ebim.has_role(organization_id, company_id,
                  array['owner','admin','orders']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'orders.advanced')
  );

-- La capacidad deja de estar `declared`: ya tiene esquema detras.
update public.app_capabilities
   set state = 'implemented'
 where code = 'orders.advanced';

comment on table public.order_templates is
  'Plantilla de pedido recurrente. Guarda QUE y CUANTO, nunca a cuanto: el precio lo resuelve el motor el dia que el pedido nace.';
comment on function ebim.order_schedule_advance(uuid) is
  'Mueve la fecha y deja constancia. NO crea pedidos: eso es del pipeline de checkout.';
