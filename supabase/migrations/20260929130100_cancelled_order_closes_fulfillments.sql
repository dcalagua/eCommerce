-- =============================================================================
-- Un pedido cancelado no se prepara ni se despacha.
--
-- Visto en QAS (FerroMax, EC-20260929-00010 y -00012): tras «Cancelar pedido»
-- las entregas seguían en la cola de Entregas como «Por preparar», con
-- «Asignar» activo, y nada en la base impedía llevarlas hasta «Entregada». La
-- -00012 estaba además COBRADA: el almacén podía mandar mercancía de un pedido
-- que el comercio ya había dado por anulado, y el dinero pendiente de devolver.
--
-- Dos piezas, porque son dos caminos distintos:
--
--  1. Al cancelar, se anulan las entregas que aún no salieron (pendiente,
--     asignada, preparando, empacada, lista, con incidencia). Es un trigger
--     sobre `orders` y no un paso de `order_transition`, porque un pedido
--     también se cancela al rechazar una aprobación B2B o desde un ERP, y los
--     tres caminos tienen que acabar igual.
--     La que ya va EN CAMINO no se toca: el paquete está fuera y anularla en
--     el registro no lo trae de vuelta. Esa la cierra quien opera (entregada,
--     incidencia o anulada) y para eso sigue abierta.
--
--  2. Una entrega de un pedido cancelado no avanza. Trigger sobre
--     `fulfillments`, que alcanza a `fulfillment_transition`,
--     `fulfillment_assign` y a cualquier UPDATE directo. Deja anular y marcar
--     incidencia —cierran—, y deja terminar la que ya iba en camino.
--
-- Al final, las entregas abiertas de pedidos YA cancelados se anulan con la
-- misma regla, para que la cola no arrastre las de antes de esta migración.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · Cancelar el pedido anula lo que no salió
-- ---------------------------------------------------------------------------
create or replace function ebim.cancel_open_fulfillments(p_order public.orders)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ful   record;
  v_count integer := 0;
begin
  for v_ful in
    select f.id, f.state::text as state
    from public.fulfillments f
    where f.order_id = p_order.id
      and f.state in ('pending', 'allocated', 'picking', 'packed', 'ready', 'failed')
    order by f.sequence
    for update
  loop
    update public.fulfillments
       set state = 'cancelled'::public.fulfillment_state,
           cancel_reason = 'Pedido cancelado'
     where id = v_ful.id;

    perform ebim.log_order_fact(
      p_order, 'fulfillment.state_changed', 'Pedido cancelado',
      jsonb_build_object('fulfillment_id', v_ful.id, 'from', v_ful.state, 'to', 'cancelled'),
      'system');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

revoke execute on function ebim.cancel_open_fulfillments(public.orders) from public, anon, authenticated;
grant  execute on function ebim.cancel_open_fulfillments(public.orders) to service_role;

create or replace function ebim.orders_cancel_closes_fulfillments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform ebim.cancel_open_fulfillments(new);
  return null;
end;
$fn$;

revoke execute on function ebim.orders_cancel_closes_fulfillments() from public, anon, authenticated;

drop trigger if exists orders_cancel_closes_fulfillments on public.orders;
create trigger orders_cancel_closes_fulfillments
  after update of status on public.orders
  for each row
  when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function ebim.orders_cancel_closes_fulfillments();

-- ---------------------------------------------------------------------------
-- 2 · La entrega de un pedido cancelado no avanza
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_fulfillment_order_alive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.state is not distinct from old.state
     or new.state in ('cancelled', 'failed')
     -- Ya iba en camino al cancelar: se deja registrar cómo terminó.
     or old.state = 'in_transit'
  then
    return new;
  end if;

  if exists (
    select 1 from public.orders o
    where o.id = new.order_id and o.status = 'cancelled'
  ) then
    raise exception 'PEDIDO_CANCELADO: la entrega de un pedido cancelado no se prepara ni se despacha'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

revoke execute on function ebim.assert_fulfillment_order_alive() from public, anon, authenticated;

drop trigger if exists fulfillments_order_alive on public.fulfillments;
create trigger fulfillments_order_alive
  before update of state on public.fulfillments
  for each row execute function ebim.assert_fulfillment_order_alive();

-- ---------------------------------------------------------------------------
-- 3 · Las de antes: pedidos ya cancelados con entregas abiertas
-- ---------------------------------------------------------------------------
do $$
declare
  v_order public.orders;
begin
  for v_order in
    select o.* from public.orders o
    where o.status = 'cancelled'
      and exists (
        select 1 from public.fulfillments f
        where f.order_id = o.id
          and f.state in ('pending', 'allocated', 'picking', 'packed', 'ready', 'failed'))
  loop
    perform ebim.cancel_open_fulfillments(v_order);
  end loop;
end;
$$;
