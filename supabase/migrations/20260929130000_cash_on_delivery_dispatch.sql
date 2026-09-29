-- =============================================================================
-- El pedido contra entrega SE PUEDE despachar sin cobrar.
--
-- Visto en QAS (FerroMax, EC-20260929-00003): la tienda tiene encendido «no
-- entregar sin cobrar» y a la vez ofrece «Efectivo contra entrega». El pedido
-- se preparaba y al pulsar «Marcar en camino» salía PAGO_PENDIENTE. No había
-- salida honesta: el dinero de un contra entrega se cobra AL entregar, así que
-- la única forma de moverlo era marcarlo cobrado antes de tenerlo —justo lo que
-- el candado existe para impedir—.
--
-- Mismo criterio que el crédito (20260909090000): la exención es del PEDIDO, por
-- el medio con el que se vendió, no de la cuenta ni de la tienda. Quien elige
-- efectivo contra entrega está diciendo «pago cuando llegue»; quien elige Yape
-- o transferencia sigue frenado hasta que conste el pago.
--
-- Solo cambia `ebim.assert_dispatch_payment` (base 20260914190000); la usan
-- `fulfillment_transition` y `shipment_open`, que no se tocan.
-- =============================================================================

create or replace function ebim.assert_dispatch_payment(p_order public.orders)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_exige_pago boolean;
  v_exento     boolean;
begin
  if p_order.payment_status = 'paid' then
    return;
  end if;

  -- Apagado por defecto: vender a crédito es despachar hoy y cobrar a treinta días.
  select coalesce(ss.require_payment_before_dispatch, false) into v_exige_pago
  from public.store_settings ss where ss.store_id = p_order.store_id;

  if not coalesce(v_exige_pago, false) then
    return;
  end if;

  -- Exentos, y solo por el medio con el que se vendió ESTE pedido:
  --  · crédito de una cuenta con línea viva (20260909090000);
  --  · efectivo contra entrega: se cobra en la puerta, después de salir.
  select exists (
    select 1
    from public.payment_intents i
    join public.payment_methods m on m.id = i.payment_method_id
    left join public.business_accounts a on a.id = p_order.business_account_id
    where i.order_id = p_order.id
      and (
        m.kind = 'cash'
        or (m.kind = 'credit'
            and coalesce(a.credit_limit, 0) > 0
            and a.credit_status <> 'blocked')
      )
  ) into v_exento;

  if not coalesce(v_exento, false) then
    raise exception 'PAGO_PENDIENTE: esta tienda no entrega pedidos sin cobrar'
      using errcode = '22023';
  end if;
end;
$fn$;

revoke execute on function ebim.assert_dispatch_payment(public.orders) from public, anon, authenticated;
grant  execute on function ebim.assert_dispatch_payment(public.orders) to service_role;

comment on function ebim.assert_dispatch_payment(public.orders) is
  'Regla require_payment_before_dispatch: lanza PAGO_PENDIENTE si la tienda no entrega sin cobrar y el pedido no esta pagado, ni vendido a credito con linea viva, ni en efectivo contra entrega. La usan fulfillment_transition y shipment_open.';
