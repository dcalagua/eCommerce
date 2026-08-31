-- =============================================================================
-- Portal del comprador: sus pedidos, su estado de cuenta y sus cupones.
--
-- La vitrina ya sabe vender. Lo que le faltaba es lo de DESPUES de vender, que
-- en B2B es la mitad del trabajo: una botica no entra a mirar el catalogo, entra
-- a ver que debe, que le llego y con que puede pagar menos.
--
-- ## Una sola puerta por pregunta, y todas DEFINER
--
-- El comprador no es miembro del tenant: su JWT solo trae `sub`. No puede haber
-- policies que le abran `orders` ni `coupons`, porque no hay nada en su token
-- con lo que acotar. Lo que hay es un VINCULO en `business_account_users`, y de
-- ese vinculo cuelga todo: cada funcion arranca resolviendo «que cuentas son
-- suyas» y no acepta que se las nombre desde fuera. Es el mismo patron de
-- `my_business_accounts` y `my_business_orders`, que ya existian.
--
-- Ninguna acepta un `business_account_id` por parametro A PROPOSITO: en cuanto
-- el cliente puede nombrar la cuenta, la autorizacion pasa a depender de que el
-- servidor no se equivoque comprobandolo.
--
-- ## Que se anade a `business_accounts`
--
-- La linea de credito y el plazo de pago, que son lo minimo para que un estado
-- de cuenta signifique algo. No se inventa una tabla de facturas: el documento
-- que esta app conoce es el PEDIDO, y su deuda es la de los pedidos no pagados.
-- El dia que exista facturacion de verdad, el estado de cuenta leera de ahi y
-- esta funcion cambia por dentro sin tocar la pantalla.
-- =============================================================================

alter table public.business_accounts
  add column if not exists credit_limit       numeric(14, 2),
  add column if not exists payment_terms_days integer not null default 0;

comment on column public.business_accounts.credit_limit is
  'Linea de credito aprobada. NULL = la cuenta compra al contado, que no es lo mismo que tener limite cero.';
comment on column public.business_accounts.payment_terms_days is
  'Dias de plazo desde la fecha del pedido. 0 = contado.';

alter table public.business_accounts
  drop constraint if exists business_accounts_credit_limit_positive;
alter table public.business_accounts
  add constraint business_accounts_credit_limit_positive
  check (credit_limit is null or credit_limit >= 0);

alter table public.business_accounts
  drop constraint if exists business_accounts_terms_range;
alter table public.business_accounts
  add constraint business_accounts_terms_range
  check (payment_terms_days between 0 and 365);

-- ---------------------------------------------------------------------------
-- my_account_statement — que debo, desde cuando y cuanto me queda de linea.
--
-- Devuelve UNA entrada por cuenta del comprador (una persona puede comprar para
-- dos empresas) con:
--   · la linea de credito y lo consumido,
--   · los documentos pendientes con su vencimiento y sus dias de atraso,
--   · lo comprado y lo pagado en los ultimos doce meses.
--
-- «Consumido» son los pedidos que NO estan pagados y NO estan anulados. Un
-- pedido reembolsado tampoco cuenta: la mercancia volvio y el dinero tambien.
-- ---------------------------------------------------------------------------
create or replace function public.my_account_statement()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_rows jsonb;
begin
  if ebim.user_id() is null then
    raise exception 'NO_AUTENTICADO: hace falta sesion' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.account_name), '[]'::jsonb)
    into v_rows
  from (
    select a.id                        as account_id,
           a.name                      as account_name,
           a.code                      as account_code,
           a.credit_limit::text        as credit_limit,
           a.payment_terms_days        as payment_terms_days,
           coalesce(deuda.pendiente, 0)::text as balance_due,
           case
             when a.credit_limit is null then null
             else greatest(a.credit_limit - coalesce(deuda.pendiente, 0), 0)::text
           end                         as credit_available,
           coalesce(deuda.vencido, 0)::text   as overdue_amount,
           coalesce(deuda.documentos, '[]'::jsonb) as documents,
           coalesce(anual.comprado, 0)::text  as purchased_12m,
           coalesce(anual.pagado, 0)::text    as paid_12m,
           coalesce(deuda.moneda, anual.moneda) as currency
    from public.business_accounts a
    join public.business_account_users u
      on u.business_account_id = a.id
     and u.user_id = ebim.user_id()
     and u.status  = 'active'
    -- Deuda viva y sus documentos.
    left join lateral (
      select sum(o.grand_total)                                    as pendiente,
             sum(o.grand_total) filter (
               where (o.placed_at + make_interval(days => a.payment_terms_days)) < now()
             )                                                     as vencido,
             min(o.currency)                                       as moneda,
             jsonb_agg(jsonb_build_object(
               'order_id',    o.id,
               'order_number', o.order_number,
               'placed_at',   o.placed_at,
               'due_at',      o.placed_at + make_interval(days => a.payment_terms_days),
               'days_overdue', greatest(
                  extract(day from now() - (o.placed_at + make_interval(days => a.payment_terms_days)))::int, 0),
               'total',       o.grand_total::text,
               'currency',    o.currency,
               'status',      o.status,
               'payment_status', o.payment_status
             ) order by o.placed_at)                               as documentos
        from public.orders o
       where o.business_account_id = a.id
         and o.payment_status not in ('paid', 'refunded', 'voided')
         and o.status <> 'cancelled'
    ) deuda on true
    -- Movimiento del ultimo ano, que es lo que da contexto a la deuda.
    left join lateral (
      select sum(o.grand_total)                                        as comprado,
             sum(o.grand_total) filter (where o.payment_status = 'paid') as pagado,
             min(o.currency)                                           as moneda
        from public.orders o
       where o.business_account_id = a.id
         and o.status <> 'cancelled'
         and o.placed_at > now() - interval '12 months'
    ) anual on true
    where a.is_active
  ) t;

  return v_rows;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- my_coupons — los cupones que ESTE comprador puede usar hoy.
--
-- Lo que NO hace es enumerar los cupones de la tienda. Un cupon es una llave: la
-- lista completa de llaves activas no se le da a nadie, ni con sesion. Aqui solo
-- salen los que le apuntan —audiencia `all` de la tienda, o dirigida a su cuenta
-- o a su cliente— y ademas siguen vigentes y le quedan usos.
--
-- `remaining_uses` es null cuando no hay tope por cliente: null es «sin limite»,
-- y ponerlo a un numero grande seria mentir con precision.
-- ---------------------------------------------------------------------------
create or replace function public.my_coupons(p_store_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_rows jsonb;
begin
  if ebim.user_id() is null then
    raise exception 'NO_AUTENTICADO: hace falta sesion' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.valid_to nulls last, t.code), '[]'::jsonb)
    into v_rows
  from (
    select distinct on (c.id)
           c.code,
           p.name                as promotion_name,
           p.description         as promotion_description,
           p.kind::text          as kind,
           p.value_percent::text as value_percent,
           p.value_amount::text  as value_amount,
           p.min_subtotal::text  as min_subtotal,
           c.valid_to,
           case
             when c.usage_limit_per_customer is null then null
             else greatest(
               c.usage_limit_per_customer - (
                 select count(*) from public.promotion_redemptions r
                  where r.coupon_id = c.id
                    and (r.business_account_id = a.id
                         or r.customer_id = a.customer_id)
               ), 0)
           end                   as remaining_uses
      from public.coupons c
      join public.promotions p on p.id = c.promotion_id
      join public.business_account_users u
        on u.user_id = ebim.user_id() and u.status = 'active'
      join public.business_accounts a
        on a.id = u.business_account_id and a.is_active
      left join public.promotion_audiences aud on aud.promotion_id = p.id
     where c.store_id = p_store_id
       and c.is_active
       and p.status = 'active'
       and (c.valid_from is null or c.valid_from <= now())
       and (c.valid_to   is null or c.valid_to   >= now())
       and (p.valid_from is null or p.valid_from <= now())
       and (p.valid_to   is null or p.valid_to   >= now())
       and (c.usage_limit is null or c.usage_count < c.usage_limit)
       -- Sin audiencias declaradas, la promocion es de la tienda entera.
       and (
         not exists (select 1 from public.promotion_audiences x where x.promotion_id = p.id)
         or aud.audience_kind = 'all'
         or (aud.audience_kind = 'business_account' and aud.business_account_id = a.id)
         or (aud.audience_kind = 'customer' and aud.customer_id = a.customer_id)
       )
  ) t;

  return v_rows;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- my_business_order_detail — un pedido suyo, sin token.
--
-- La pagina de seguimiento publica pide `order_by_token` porque su visitante
-- puede no tener sesion. Quien entra por su cuenta ya se identifico: pedirle
-- ademas el token del correo seria mandarle a buscar el correo para ver lo que
-- ya es suyo.
-- ---------------------------------------------------------------------------
create or replace function public.my_business_order_detail(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
  v_items jsonb;
begin
  if ebim.user_id() is null then
    raise exception 'NO_AUTENTICADO: hace falta sesion' using errcode = '42501';
  end if;

  select o.* into v_order
  from public.orders o
  join public.business_accounts a on a.id = o.business_account_id and a.is_active
  join public.business_account_users u
    on u.business_account_id = a.id
   and u.user_id = ebim.user_id()
   and u.status  = 'active'
  where o.id = p_order_id;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido tuyo con ese id'
      using errcode = '22023';
  end if;

  -- `name` y `sku` son la FOTO del producto en el momento del pedido, no una
  -- lectura de `products`: si el comercio renombra el articulo manana, el
  -- pedido tiene que seguir diciendo lo que se compro.
  select coalesce(jsonb_agg(jsonb_build_object(
           'name',          i.name,
           'sku',           i.sku,
           'variant_label', i.variant_label,
           'quantity',      i.quantity,
           'unit_price',    i.unit_price::text,
           'total',         i.line_total::text
         ) order by i.created_at), '[]'::jsonb)
    into v_items
  from public.order_items i
  where i.order_id = v_order.id;

  return jsonb_build_object(
    'order_id',       v_order.id,
    'order_number',   v_order.order_number,
    'status',         v_order.status,
    'payment_status', v_order.payment_status,
    'fulfillment_status', v_order.fulfillment_status,
    'placed_at',      v_order.placed_at,
    'currency',       v_order.currency,
    'subtotal',       v_order.subtotal::text,
    'discount_total', v_order.discount_total::text,
    'tax_total',      v_order.tax_total::text,
    'shipping_total', v_order.shipping_total::text,
    'grand_total',    v_order.grand_total::text,
    'items',          v_items
  );
end;
$fn$;

revoke execute on function public.my_account_statement()          from public, anon;
revoke execute on function public.my_coupons(uuid)                from public, anon;
revoke execute on function public.my_business_order_detail(uuid)  from public, anon;

grant execute on function public.my_account_statement()         to authenticated;
grant execute on function public.my_coupons(uuid)               to authenticated;
grant execute on function public.my_business_order_detail(uuid) to authenticated;

comment on function public.my_account_statement() is
  'Estado de cuenta del comprador: linea, deuda, vencido y documentos. DEFINER; las cuentas salen del vinculo, nunca de un parametro.';
comment on function public.my_coupons(uuid) is
  'Cupones que ESTE comprador puede usar. No enumera los cupones de la tienda: un cupon es una llave.';
comment on function public.my_business_order_detail(uuid) is
  'Un pedido de su cuenta, sin exigir el token del correo: quien entra por su cuenta ya se identifico.';
