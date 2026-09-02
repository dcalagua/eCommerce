-- =============================================================================
-- Recorrido B2B · fase 09 — promociones trade.
--
-- ## Lo que NO hace falta, y por que
--
-- El plan de la fase 00 daba por ausentes las mecanicas trade y proponia añadir
-- `volume_tier`, `combo` y `free_goods` al enum. Al mirar la base, el enum ya
-- dice:
--
--     percentage, fixed_amount, volume_tier, x_for_y, bundle
--
-- `volume_tier` esta. `combo` es `bundle` y `free_goods` es `x_for_y` — con
-- otro nombre y la misma semantica. Añadirlos habria dejado dos valores para
-- cada mecanica y, a partir de ahi, dos ramas en `evaluate_promotions` que
-- alguien tendria que mantener sincronizadas. **No se añade ninguno.**
--
-- Y no hay segundo motor: la migracion 130100 lo dejo escrito, añadir un tipo
-- es una rama en `ebim.evaluate_promotions`, no una tabla.
--
-- ## Lo unico que falta de verdad: el presupuesto
--
-- Una mecanica trade sin tope se come el margen del trimestre sin que nadie lo
-- vea hasta que se cierra el mes. Lo que se añade es el presupuesto por campaña
-- y su consumo.
--
-- `consumed_amount` lo mantiene un TRIGGER sobre los canjes, por la misma razon
-- que el saldo de una cuenta por cobrar: si lo escribiera la aplicacion,
-- existiria la ruta que se olvida —una carga masiva, una correccion a mano— y
-- la cifra dejaria de ser cierta sin que nada fallara.
--
-- **El presupuesto NO corta la venta.** Guarda cuanto se lleva gastado y deja
-- que la pantalla avise. Cortar una promocion a mitad de un pedido ya cotizado
-- seria cambiarle el precio al comprador despues de habérselo enseñado, que es
-- peor que pasarse del presupuesto.
-- =============================================================================

create table if not exists public.promotion_budgets (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  promotion_id    uuid        not null,
  -- El tope. A quien se le imputa lo dicen las dos columnas de abajo: nulo en
  -- las dos = presupuesto de la campaña entera.
  customer_id     uuid,
  territory_id    uuid,
  currency        char(3)     not null,
  budget_amount   numeric(14,2) not null,
  -- Lo mantiene el trigger. Nunca se escribe desde fuera.
  consumed_amount numeric(14,2) not null default 0,
  period_start    date,
  period_end      date,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint promotion_budgets_amount_sign check (budget_amount > 0),
  constraint promotion_budgets_consumed_sign check (consumed_amount >= 0),
  constraint promotion_budgets_period_order
    check (period_end is null or period_start is null or period_end >= period_start),
  -- Un tope se imputa a un cliente O a un territorio, nunca a los dos: con los
  -- dos, el mismo canje descontaria de dos bolsas y ninguna de las dos cuadraria.
  constraint promotion_budgets_one_target check (
    customer_id is null or territory_id is null
  ),
  constraint promotion_budgets_unique unique nulls not distinct
    (promotion_id, customer_id, territory_id, period_start, period_end),
  constraint promotion_budgets_promotion_fk
    foreign key (promotion_id, organization_id, company_id)
    references public.promotions (id, organization_id, company_id) on delete cascade,
  constraint promotion_budgets_customer_fk
    foreign key (customer_id, organization_id, company_id)
    references public.customers (id, organization_id, company_id) on delete cascade,
  constraint promotion_budgets_territory_fk
    foreign key (territory_id, organization_id, company_id)
    references public.sales_territories (id, organization_id, company_id) on delete cascade
);

create index if not exists promotion_budgets_tenant_idx
  on public.promotion_budgets (organization_id, company_id);
create index if not exists promotion_budgets_promotion_idx
  on public.promotion_budgets (promotion_id);

-- ---------------------------------------------------------------------------
-- El consumo lo lleva la base.
--
-- Se recalcula entero desde `promotion_redemptions` en vez de sumar el delta:
-- un contador incremental se desincroniza en cuanto alguien borra un canje a
-- mano, y entonces el presupuesto miente en la direccion peligrosa —dice que
-- queda menos del que queda, o mas—.
-- ---------------------------------------------------------------------------
create or replace function ebim.promotion_budget_recount()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_promo uuid := coalesce(new.promotion_id, old.promotion_id);
begin
  update public.promotion_budgets b
     set consumed_amount = coalesce((
           select sum(r.discount_amount)
           from public.promotion_redemptions r
           where r.promotion_id = v_promo
             and (b.period_start is null or r.created_at::date >= b.period_start)
             and (b.period_end   is null or r.created_at::date <= b.period_end)
         ), 0),
         updated_at = now()
   where b.promotion_id = v_promo;

  return null;
end;
$fn$;

drop trigger if exists promotion_redemptions_budget on public.promotion_redemptions;
create trigger promotion_redemptions_budget
  after insert or update or delete on public.promotion_redemptions
  for each row execute function ebim.promotion_budget_recount();

-- ¿Cuanto queda? Una sola definicion, para que la pantalla y el informe no den
-- dos cifras.
create or replace function ebim.promotion_budget_remaining(p_budget uuid)
returns numeric
language sql
stable
set search_path = ''
as $fn$
  -- `::numeric(14,2)` y no a secas: `greatest(x, 0)` con un cero entero devuelve
  -- '0' cuando el presupuesto se agoto y '0.00' cuando queda algo, y un importe
  -- con dos formas hace que el cliente lo formatee mal justo en el caso que
  -- importa. Mismo cuidado que en `ebim.customer_aging`.
  select greatest(b.budget_amount - b.consumed_amount, 0)::numeric(14,2)
  from public.promotion_budgets b
  where b.id = p_budget;
$fn$;

revoke execute on function ebim.promotion_budget_remaining(uuid) from public;
grant  execute on function ebim.promotion_budget_remaining(uuid) to authenticated, service_role;

alter table public.promotion_budgets enable row level security;
alter table public.promotion_budgets force  row level security;

revoke all on public.promotion_budgets from public;
grant select, insert, update, delete on public.promotion_budgets to authenticated;
grant all on public.promotion_budgets to service_role;

drop policy if exists promotion_budgets_select_member on public.promotion_budgets;
create policy promotion_budgets_select_member on public.promotion_budgets
  for select to authenticated
  using (
    ebim.can_access(organization_id, company_id)
    and ebim.has_role(organization_id, company_id,
                      array['owner','admin','catalog']::public.app_role[])
  );

drop policy if exists promotion_budgets_write_admin on public.promotion_budgets;
create policy promotion_budgets_write_admin on public.promotion_budgets
  for all to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'promotions')
  );

comment on table public.promotion_budgets is
  'Tope de una mecanica trade. `consumed_amount` lo recalcula un trigger; el presupuesto avisa, no corta la venta.';
