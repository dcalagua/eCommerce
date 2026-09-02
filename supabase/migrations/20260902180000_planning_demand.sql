-- =============================================================================
-- Recorrido B2B · fases 14 y 15 — recomendacion de pedido y forecast.
--
-- ## La regla que define esta frontera
--
-- **La sugerencia NO crea pedidos.** Produce una lista que una persona
-- confirma, y de ahi sale un carrito que entra por el pipeline de checkout de
-- siempre. Un sistema que pide por ti es un sistema que se equivoca por ti, y
-- en distribucion eso se paga en devoluciones y en mercaderia vencida.
--
-- ## Por que la sugerencia guarda su MOTIVO
--
-- `reason` no es un adorno: es lo que permite que un preventista defienda la
-- cifra delante del cliente —«te sugiero 12 porque vendiste 11 el mes pasado y
-- te quedan 2»— y lo que permite auditar despues por que el sistema propuso lo
-- que propuso. Una sugerencia sin motivo es un numero que nadie discute y por
-- tanto nadie corrige.
--
-- ## El forecast es una PREVISION, no un dato
--
-- Por eso lleva `generated_at` y `model_code`: sin saber cuando y con que se
-- calculo, una cifra de demanda es indistinguible de una venta real, y alguien
-- acabara sumandola a un informe. `confidence` puede faltar —hay modelos que no
-- la dan— y eso es mejor que inventarse un numero.
-- =============================================================================

do $$ begin
  create type public.suggestion_status as enum ('draft', 'sent', 'accepted', 'discarded');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- La sugerencia de pedido
-- ---------------------------------------------------------------------------
create table if not exists public.order_suggestions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  customer_id     uuid        not null,
  sales_rep_id    uuid,
  status          public.suggestion_status not null default 'draft',
  -- Con que se calculo. Guardarlo permite comparar dos generaciones y retirar
  -- un modelo que sugiere mal sin borrar lo que ya sugirio.
  model_code      text        not null default 'historic_v1',
  generated_at    timestamptz not null default now(),
  -- El pedido que salio de ella, si alguien la confirmo. Es lo que permite
  -- medir si el sugerido sirve de algo.
  order_id        uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint order_suggestions_model_len check (char_length(btrim(model_code)) between 1 and 60),
  constraint order_suggestions_tenant_key unique (id, organization_id, company_id),
  constraint order_suggestions_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint order_suggestions_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint order_suggestions_rep_fk
    foreign key (sales_rep_id, organization_id, company_id)
    references public.sales_reps (id, organization_id, company_id) on delete set null
);

create index if not exists order_suggestions_tenant_idx
  on public.order_suggestions (organization_id, company_id);
create index if not exists order_suggestions_customer_idx
  on public.order_suggestions (customer_id, generated_at desc);

create table if not exists public.order_suggestion_items (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  company_id        uuid        not null,
  suggestion_id     uuid        not null,
  product_id        uuid        not null,
  variant_id        uuid,
  uom_code          text,
  suggested_quantity numeric(14,3) not null,
  -- Lo que sostiene la cifra. Obligatorio: una sugerencia sin motivo es un
  -- numero que nadie discute y por tanto nadie corrige.
  reason            text        not null,
  -- Las cifras con las que se calculo, para que el motivo sea comprobable.
  last_period_quantity numeric(14,3),
  on_hand_quantity     numeric(14,3),
  position          smallint    not null default 0,
  created_at        timestamptz not null default now(),

  constraint order_suggestion_items_quantity_sign check (suggested_quantity > 0),
  constraint order_suggestion_items_reason_len
    check (char_length(btrim(reason)) between 1 and 400),
  constraint order_suggestion_items_suggestion_fk
    foreign key (suggestion_id, organization_id, company_id)
    references public.order_suggestions (id, organization_id, company_id) on delete cascade,
  constraint order_suggestion_items_product_fk
    foreign key (product_id) references public.products (id) on delete cascade,
  constraint order_suggestion_items_variant_fk
    foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  constraint order_suggestion_items_unique
    unique nulls not distinct (suggestion_id, product_id, variant_id, uom_code)
);

create index if not exists order_suggestion_items_tenant_idx
  on public.order_suggestion_items (organization_id, company_id);
create index if not exists order_suggestion_items_suggestion_idx
  on public.order_suggestion_items (suggestion_id, position);

-- ---------------------------------------------------------------------------
-- El forecast
-- ---------------------------------------------------------------------------
create table if not exists public.demand_forecasts (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  variant_id      uuid,
  territory_id    uuid,
  period_start    date        not null,
  period_end      date        not null,
  forecast_quantity numeric(14,3) not null,
  -- Puede faltar: hay modelos que no la dan, y eso es mejor que inventarla.
  confidence      numeric(5,4),
  model_code      text        not null default 'naive_v1',
  generated_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  constraint demand_forecasts_quantity_sign check (forecast_quantity >= 0),
  constraint demand_forecasts_period_order check (period_end >= period_start),
  constraint demand_forecasts_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint demand_forecasts_model_len check (char_length(btrim(model_code)) between 1 and 60),
  -- Una prevision por producto, periodo, territorio y MODELO. El modelo entra
  -- en la clave a proposito: comparar dos modelos sobre el mismo periodo es el
  -- caso de uso, no un error.
  constraint demand_forecasts_unique unique nulls not distinct
    (store_id, product_id, variant_id, territory_id, period_start, period_end, model_code),
  constraint demand_forecasts_store_fk
    foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint demand_forecasts_product_fk
    foreign key (product_id) references public.products (id) on delete cascade,
  constraint demand_forecasts_variant_fk
    foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  constraint demand_forecasts_territory_fk
    foreign key (territory_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete cascade
);

create index if not exists demand_forecasts_tenant_idx
  on public.demand_forecasts (organization_id, company_id);
create index if not exists demand_forecasts_period_idx
  on public.demand_forecasts (store_id, period_start, period_end);

-- ---------------------------------------------------------------------------
-- ebim.suggest_order — el sugerido, con su motivo.
--
-- Mira lo que ese cliente compro en los ultimos `p_days` dias y propone lo
-- mismo. Es deliberadamente simple: un modelo que nadie entiende es un modelo
-- que el preventista no defiende delante del cliente, y entonces no se usa.
--
-- Devuelve FILAS, no crea nada. Quien decide es la persona.
-- ---------------------------------------------------------------------------
create or replace function ebim.suggest_order(
  p_store    uuid,
  p_customer uuid,
  p_days     int default 30
)
returns table (
  product_id      uuid,
  variant_id      uuid,
  suggested_quantity numeric,
  last_period_quantity numeric,
  reason          text
)
language sql
stable
set search_path = ''
as $fn$
  select i.product_id,
         i.variant_id,
         sum(i.quantity)::numeric as suggested_quantity,
         sum(i.quantity)::numeric as last_period_quantity,
         'Compro ' || sum(i.quantity)::text || ' en los ultimos ' || p_days::text || ' dias'
  from public.orders o
  join public.order_items i on i.order_id = o.id
  -- El pedido NO guarda `customer_id`: llega al cliente por la cuenta B2B, que
  -- es justo el caso para el que existe un sugerido. Un pedido de vitrina
  -- anonima no tiene historial atribuible a nadie, y por eso queda fuera.
  join public.business_accounts ba on ba.id = o.business_account_id
  where o.store_id = p_store
    and ba.customer_id = p_customer
    and o.created_at >= now() - (p_days || ' days')::interval
    and o.status <> 'cancelled'
  group by i.product_id, i.variant_id
  having sum(i.quantity) > 0
  order by sum(i.quantity) desc;
$fn$;

revoke execute on function ebim.suggest_order(uuid, uuid, int) from public;
grant  execute on function ebim.suggest_order(uuid, uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: default deny.
-- ---------------------------------------------------------------------------
alter table public.order_suggestions      enable row level security;
alter table public.order_suggestions      force  row level security;
alter table public.order_suggestion_items enable row level security;
alter table public.order_suggestion_items force  row level security;
alter table public.demand_forecasts       enable row level security;
alter table public.demand_forecasts       force  row level security;

revoke all on public.order_suggestions, public.order_suggestion_items,
              public.demand_forecasts from public;
grant select, insert, update, delete
  on public.order_suggestions, public.order_suggestion_items, public.demand_forecasts
  to authenticated;
grant all on public.order_suggestions, public.order_suggestion_items,
             public.demand_forecasts to service_role;

drop policy if exists order_suggestions_select_member on public.order_suggestions;
create policy order_suggestions_select_member on public.order_suggestions
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and (
      ebim.has_role(organization_id, company_id,
                    array['owner','admin','orders']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists order_suggestions_write_field on public.order_suggestions;
create policy order_suggestions_write_field on public.order_suggestions
  for all to authenticated
  using (
    ebim.has_capability(organization_id, company_id, 'planning.demand')
    and (
      ebim.has_role(organization_id, company_id,
                    array['owner','admin','orders']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  )
  with check (
    ebim.has_capability(organization_id, company_id, 'planning.demand')
    and (
      ebim.has_role(organization_id, company_id,
                    array['owner','admin','orders']::public.app_role[])
      or sales_rep_id = ebim.sales_rep_of(organization_id, company_id)
    )
  );

drop policy if exists order_suggestion_items_select_member on public.order_suggestion_items;
create policy order_suggestion_items_select_member on public.order_suggestion_items
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and exists (select 1 from public.order_suggestions s where s.id = suggestion_id)
  );

drop policy if exists order_suggestion_items_write_field on public.order_suggestion_items;
create policy order_suggestion_items_write_field on public.order_suggestion_items
  for all to authenticated
  using (
    ebim.has_capability(organization_id, company_id, 'planning.demand')
    and exists (
      select 1 from public.order_suggestions s
      where s.id = suggestion_id
        and (
          ebim.has_role(s.organization_id, s.company_id,
                        array['owner','admin','orders']::public.app_role[])
          or s.sales_rep_id = ebim.sales_rep_of(s.organization_id, s.company_id)
        )
    )
  )
  with check (
    ebim.has_capability(organization_id, company_id, 'planning.demand')
    and exists (
      select 1 from public.order_suggestions s
      where s.id = suggestion_id
        and (
          ebim.has_role(s.organization_id, s.company_id,
                        array['owner','admin','orders']::public.app_role[])
          or s.sales_rep_id = ebim.sales_rep_of(s.organization_id, s.company_id)
        )
    )
  );

drop policy if exists demand_forecasts_select_member on public.demand_forecasts;
create policy demand_forecasts_select_member on public.demand_forecasts
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','orders']::public.app_role[])
  );

drop policy if exists demand_forecasts_write_admin on public.demand_forecasts;
create policy demand_forecasts_write_admin on public.demand_forecasts
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'planning.demand')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'planning.demand')
  );

insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
values ('planning.demand', 'planning', false, 'ecommerce.planning.demand', 'implemented')
on conflict (code) do update
  set boundary = excluded.boundary,
      entitlement_code = excluded.entitlement_code,
      state = excluded.state;

comment on function ebim.suggest_order(uuid, uuid, int) is
  'Devuelve FILAS con su motivo. No crea pedidos: quien decide es la persona.';
comment on table public.demand_forecasts is
  'Prevision, no dato. `model_code` y `generated_at` obligatorios para que nadie la sume a un informe de ventas.';
