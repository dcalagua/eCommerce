-- =============================================================================
-- P08-SaaS · 5/7 — Los COMANDOS de transicion: mover un pedido es una orden,
--                  no un UPDATE
--
-- ## Por que un comando y no una policy mas
--
-- Un `UPDATE orders SET payment_status = ...` bajo RLS deja pasar cualquier
-- salto que el trigger no prohiba explicitamente, y —lo importante— deja pasar
-- que el motivo, el hecho de dominio y la marca de tiempo dependan de que el
-- llamante se acuerde de escribirlos. Un comando junta las cuatro cosas en una
-- sola operacion atomica y hace imposible la mitad:
--
--   autorizacion  +  maquina de estados  +  linea de tiempo  +  hecho de dominio
--
-- Por eso los tres ejes nuevos NO tienen GRANT de escritura (migracion 110000):
-- no es que se recomiende usar el comando, es que no hay otra puerta.
--
-- `orders.status` conserva su UPDATE directo porque asi nacio en P02 y hay
-- codigo vivo que depende de ello —la Edge Function `update-order-status`, sus
-- tests y la policy `orders_update_orders_role`—. Ese camino sigue pasando por
-- su trigger de maquina de estados, por el de sincronizacion de ejes y por la
-- linea de tiempo, asi que no es un agujero: es la misma garantia por otro
-- camino. Lo que el comando añade sobre `status` es el motivo y el hecho de
-- dominio, y por eso el backoffice nuevo lo usa tambien para ese eje.
--
-- ## Autorizacion DENTRO, tenant derivado de la FILA
--
-- Ni un solo `organization_id` en la firma. El tenant sale del pedido, y el
-- pedido lo ata su FK compuesta contra `stores`. No hay forma de pedir una
-- transicion sobre un pedido ajeno: la comprobacion de rol se hace sobre el
-- tenant de ESE pedido, no sobre el que diga quien llama.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.order_command_actor — quien pide esto, y si puede
--
-- Una sola funcion para no repetir la comprobacion en cada comando y, sobre
-- todo, para que no se puedan separar: el dia que una se relaje, se relajan
-- todas o ninguna.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_order_operator(p_order public.orders)
returns void
language plpgsql
stable
set search_path = ''
as $fn$
begin
  -- Regla de suite: el super admin no es actor de negocio de un tenant. Aqui y
  -- no solo en el borde, porque un guard que vive unicamente en la Edge
  -- Function se salta llamando a la funcion por PostgREST.
  if ebim.is_suite_super_admin() then
    raise exception 'OPERADOR_NO_ES_ACTOR: el super admin de suite no opera pedidos de un tenant'
      using errcode = '42501';
  end if;

  if not ebim.has_role(
       p_order.organization_id, p_order.company_id,
       array['owner','admin','orders']::public.app_role[])
  then
    raise exception 'SIN_PERMISO: hace falta rol de pedidos sobre este tenant'
      using errcode = '42501';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.order_transition — el comando
--
-- `p_axis` es texto y no un enum de columnas porque nombra un EJE del dominio,
-- no una columna: la pantalla habla de «estado del pago», no de
-- `orders.payment_status`. Los tres valores validos se comprueban aqui.
-- ---------------------------------------------------------------------------
create or replace function public.order_transition(
  p_order_id uuid,
  p_axis     text,
  p_to       text,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order  public.orders%rowtype;
  v_after  public.orders%rowtype;
  v_axis   text := lower(btrim(coalesce(p_axis, '')));
  v_to     text := lower(btrim(coalesce(p_to, '')));
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  v_from   text;
  v_event  uuid;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_order_operator(v_order);

  if v_axis not in ('order_status', 'payment_status', 'fulfillment_status') then
    raise exception 'EJE_NO_VALIDO: "%" no es un eje de estado del pedido', p_axis
      using errcode = '22023';
  end if;

  -- El destino se comprueba contra las etiquetas del enum ANTES de convertirlo.
  -- Sin esto, un valor inventado sale como `invalid input value for enum`, que
  -- es un 22P02 sin codigo de dominio y que la pantalla no sabe traducir.
  if not exists (
    select 1
    from unnest(case v_axis
      when 'order_status'   then enum_range(null::public.order_status)::text[]
      when 'payment_status' then enum_range(null::public.payment_status)::text[]
      else enum_range(null::public.fulfillment_status)::text[]
    end) as label
    where label = v_to
  ) then
    raise exception 'ESTADO_NO_VALIDO: "%" no es un estado de %', p_to, v_axis
      using errcode = '22023';
  end if;

  -- El motivo y el origen viajan por ajustes LOCALES de transaccion. Los lee el
  -- trigger de la linea de tiempo, que es el unico escritor de `order_events`.
  perform set_config('ebim.order_event_reason', coalesce(v_reason, ''), true);
  perform set_config('ebim.order_event_source', 'backoffice', true);

  if v_axis = 'order_status' then
    v_from := v_order.status::text;
    if v_to = v_from then
      raise exception 'TRANSICION_SIN_CAMBIO: el pedido ya esta en "%"', v_to
        using errcode = '22023';
    end if;
    update public.orders set status = v_to::public.order_status where id = v_order.id;

  elsif v_axis = 'payment_status' then
    v_from := v_order.payment_status::text;
    if v_to = v_from then
      raise exception 'TRANSICION_SIN_CAMBIO: el pago ya esta en "%"', v_to
        using errcode = '22023';
    end if;
    update public.orders set payment_status = v_to::public.payment_status where id = v_order.id;

  else
    v_from := v_order.fulfillment_status::text;
    if v_to = v_from then
      raise exception 'TRANSICION_SIN_CAMBIO: la entrega ya esta en "%"', v_to
        using errcode = '22023';
    end if;
    update public.orders set fulfillment_status = v_to::public.fulfillment_status
     where id = v_order.id;
  end if;

  select * into v_after from public.orders o where o.id = v_order.id;

  -- El hecho de dominio se ancla al evento que el trigger acaba de escribir: la
  -- clave de deduplicacion es su id, asi que no hace falta inventar una y no
  -- puede colisionar con la de otro cambio al mismo valor.
  select e.id into v_event
  from public.order_events e
  where e.order_id = v_order.id
    and e.axis = v_axis::public.order_event_axis
    and e.to_value = v_to
  order by e.created_at desc, e.id desc
  limit 1;

  perform ebim.publish_event(
    v_after.organization_id, v_after.company_id, v_after.store_id,
    case v_axis
      when 'order_status'       then 'order.status_changed'
      when 'payment_status'     then 'order.payment_status_changed'
      else 'order.fulfillment_status_changed'
    end,
    'order', v_after.id,
    jsonb_strip_nulls(jsonb_build_object(
      'order_id',           v_after.id,
      'order_number',       v_after.order_number,
      'axis',               v_axis,
      'from',               v_from,
      'to',                 v_to,
      'reason',             v_reason,
      'status',             v_after.status,
      'payment_status',     v_after.payment_status,
      'fulfillment_status', v_after.fulfillment_status,
      'currency',           v_after.currency,
      'grand_total',        v_after.grand_total::text,
      'customer_email',     v_after.customer_email)),
    'order.transition:' || coalesce(v_event::text, v_after.id::text || ':' || v_axis || ':' || v_to));

  return jsonb_build_object(
    'order_id',           v_after.id,
    'order_number',       v_after.order_number,
    'axis',               v_axis,
    'from',               v_from,
    'to',                 v_to,
    'status',             v_after.status,
    'payment_status',     v_after.payment_status,
    'fulfillment_status', v_after.fulfillment_status,
    'approval_status',    v_after.approval_status,
    'updated_at',         v_after.updated_at);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.order_approval_decide — la aprobacion B2B, sin contaminar B2C
--
-- Un pedido B2C nace `not_required` y esta funcion se niega a tocarlo: no hay
-- «aprobar» que hacer sobre una compra que nadie tenia que autorizar, y
-- permitirlo convertiria un estado terminal en una puerta trasera para
-- congelar cualquier pedido.
--
-- **Dos autorizaciones distintas para el mismo acto**, igual que
-- `public.purchase_approval` en P05:
--
--  · el APROBADOR de la cuenta —`admin` o `approver` en `business_account_users`—,
--    que no es miembro del tenant y no tiene ni una policy sobre `orders`;
--  · el personal del comercio con rol de pedidos, que responde por la cuenta.
--
-- Rechazar CANCELA el pedido. La alternativa —dejarlo rechazado y vivo— crea un
-- pedido que nadie va a servir y que sigue contando en los indicadores.
--
-- Lo que esta funcion NO hace: devolver la existencia al almacen. Cancelar sin
-- reponer es el comportamiento que ya tenia `status = 'cancelled'` desde P02 y
-- cambiarlo aqui seria decidir la politica de devoluciones de pasada. Es trabajo
-- de P12 (fulfillment y devoluciones) y esta anotado en el ADR.
-- ---------------------------------------------------------------------------
create or replace function public.order_approval_decide(
  p_order_id uuid,
  p_approve  boolean,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order   public.orders%rowtype;
  v_after   public.orders%rowtype;
  v_role    public.business_role;
  v_reason  text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  v_to      public.order_approval_status;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  if v_order.approval_status <> 'pending' then
    raise exception 'APROBACION_NO_APLICA: el pedido % no espera autorizacion', v_order.order_number
      using errcode = '22023';
  end if;

  if ebim.is_suite_super_admin() then
    raise exception 'OPERADOR_NO_ES_ACTOR: el super admin de suite no autoriza compras de un tenant'
      using errcode = '42501';
  end if;

  -- El vinculo con la cuenta lo resuelve el SERVIDOR sobre `ebim.user_id()`;
  -- ningun id de cuenta entra por parametro (regla de P05).
  v_role := case
    when v_order.business_account_id is null then null
    else ebim.business_role_of(v_order.business_account_id)
  end;

  -- `coalesce` sobre el texto y no `v_role in (...)` a secas: sin vinculo con
  -- la cuenta `v_role` es NULL, `NULL in (...)` es NULL y `not NULL` es NULL,
  -- asi que la condicion entera se evaluaria a NULL y el `if` NO saltaria. Es
  -- la forma en que la logica ternaria de SQL convierte un guard en un adorno.
  if not (coalesce(v_role::text, '') in ('admin', 'approver'))
     and not ebim.has_role(
           v_order.organization_id, v_order.company_id,
           array['owner','admin','orders']::public.app_role[])
  then
    raise exception 'SIN_PERMISO: hace falta ser aprobador de la cuenta o personal de pedidos'
      using errcode = '42501';
  end if;

  -- Rechazar sin decir por que deja al comprador sin nada que corregir.
  if not coalesce(p_approve, false) and v_reason is null then
    raise exception 'MOTIVO_REQUERIDO: rechazar una compra exige un motivo'
      using errcode = '22023';
  end if;

  v_to := case when coalesce(p_approve, false) then 'approved' else 'rejected' end;

  perform set_config('ebim.order_event_reason', coalesce(v_reason, ''), true);
  perform set_config('ebim.order_event_source',
    case when v_role is null then 'backoffice' else 'storefront' end, true);

  if v_to = 'approved' then
    update public.orders
       set approval_status = 'approved',
           approval_decided_at = now(),
           approval_decided_by = ebim.user_id(),
           approval_decided_email = left(ebim.email(), 320),
           approval_reason = v_reason
     where id = v_order.id;
  else
    -- Rechazo y cancelacion en la MISMA sentencia: el trigger de ejes deja
    -- pasar `cancelled` aunque la aprobacion siga pendiente, y asi no existe el
    -- instante en el que el pedido esta rechazado pero todavia vivo.
    update public.orders
       set approval_status = 'rejected',
           approval_decided_at = now(),
           approval_decided_by = ebim.user_id(),
           approval_decided_email = left(ebim.email(), 320),
           approval_reason = v_reason,
           status = 'cancelled'
     where id = v_order.id;
  end if;

  select * into v_after from public.orders o where o.id = v_order.id;

  perform ebim.publish_event(
    v_after.organization_id, v_after.company_id, v_after.store_id,
    'order.approval_decided', 'order', v_after.id,
    jsonb_strip_nulls(jsonb_build_object(
      'order_id',            v_after.id,
      'order_number',        v_after.order_number,
      'approval_status',     v_after.approval_status,
      'business_account_id', v_after.business_account_id,
      'decided_by',          v_after.approval_decided_by,
      'reason',              v_reason,
      'status',              v_after.status,
      'grand_total',         v_after.grand_total::text,
      'currency',            v_after.currency,
      'customer_email',      v_after.customer_email)),
    'order.approval_decided:' || v_after.id::text);

  return jsonb_build_object(
    'order_id',        v_after.id,
    'order_number',    v_after.order_number,
    'approval_status', v_after.approval_status,
    'status',          v_after.status,
    'decided_at',      v_after.approval_decided_at);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.my_business_orders — la mitad que le faltaba al aprobador
--
-- El aprobador de una cuenta B2B **no es miembro del tenant**: `can_access` es
-- falso para el y PostgREST no le devuelve ni una fila de `orders`. Sin esta
-- funcion podria decidir sobre un pedido que no puede ver, que es una funcion
-- de autorizacion sin pantalla posible.
--
-- **Sin parametro de cuenta**, exactamente igual que `my_business_accounts()` en
-- P05: no hay id que el navegador pueda declarar. Y devuelve una proyeccion
-- SEGURA —ni uuids de tenant, ni notas internas, ni etiquetas, ni el token de
-- acceso del comprador—: quien aprueba necesita saber que se compro y cuanto
-- cuesta, no la operativa interna del comercio.
-- ---------------------------------------------------------------------------
create or replace function public.my_business_orders(
  p_only_pending boolean default false,
  p_limit        integer default 50
)
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

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.placed_at desc), '[]'::jsonb)
    into v_rows
  from (
    select o.id                 as order_id,
           o.order_number,
           o.status,
           o.payment_status,
           o.fulfillment_status,
           o.approval_status,
           o.currency,
           o.grand_total::text  as grand_total,
           o.placed_at,
           a.name               as account_name,
           u.role::text         as my_role,
           -- Solo quien puede decidir ve el boton; el resto lee la cola.
           (u.role in ('admin', 'approver')) as can_decide
    from public.orders o
    join public.business_accounts a on a.id = o.business_account_id
    join public.business_account_users u
      on u.business_account_id = a.id
     and u.user_id = ebim.user_id()
     and u.status  = 'active'
    where a.is_active
      and (not coalesce(p_only_pending, false) or o.approval_status = 'pending')
    order by o.placed_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t;

  return v_rows;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- GRANTs. `authenticated` a secas en las tres: la autorizacion no la da el
-- GRANT, la da el cuerpo de la funcion (patron de P05 y P06). `anon` no llama
-- a ninguna: un comprador sin sesion no mueve pedidos ni aprueba compras.
-- ---------------------------------------------------------------------------
revoke execute on function ebim.assert_order_operator(public.orders)
  from public, anon, authenticated;

revoke execute on function public.order_transition(uuid, text, text, text)
  from public, anon;
revoke execute on function public.order_approval_decide(uuid, boolean, text)
  from public, anon;
revoke execute on function public.my_business_orders(boolean, integer)
  from public, anon;

grant execute on function public.order_transition(uuid, text, text, text)
  to authenticated, service_role;
grant execute on function public.order_approval_decide(uuid, boolean, text)
  to authenticated, service_role;
grant execute on function public.my_business_orders(boolean, integer)
  to authenticated, service_role;

comment on function public.order_transition(uuid, text, text, text) is
  'Comando de transicion. Autorizacion + maquina de estados + linea de tiempo + hecho de dominio en una sola operacion. El tenant sale de la fila del pedido, nunca de la firma.';
comment on function public.order_approval_decide(uuid, boolean, text) is
  'Decide una compra B2B pendiente. Autoriza al aprobador de la cuenta (vinculo resuelto por el servidor) o al personal de pedidos. Se niega sobre un pedido not_required: B2C no entra al circuito.';
comment on function public.my_business_orders(boolean, integer) is
  'Pedidos de las cuentas B2B del que pregunta. SIN id de cuenta por parametro (patron de my_business_accounts) y con proyeccion segura: sin uuids de tenant ni operativa interna.';
