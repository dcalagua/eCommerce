-- =============================================================================
-- P12-SaaS · 4/7 — Los COMANDOS del despacho: planificar, asignar, mover,
--                  enviar e ingerir seguimiento
--
-- ## Por que comandos y no policies de UPDATE
--
-- Es la misma decision que P08 tomo con los ejes del pedido y P09 con el
-- dinero, y por la misma razon: mover una entrega son CUATRO cosas que tienen
-- que pasar juntas o no pasar,
--
--   autorizacion + maquina de estados + linea de tiempo + espejo en el pedido
--
-- y un GRANT de UPDATE permite exactamente la mitad. Por eso `fulfillments`,
-- `shipments` y `tracking_events` no tienen GRANT de escritura para
-- `authenticated` (migracion 150100): no es que se recomiende usar el comando,
-- es que no hay otra puerta.
--
-- ## Autorizacion DENTRO, tenant derivado de la FILA
--
-- Ni un solo `organization_id` en ninguna firma. El tenant sale del pedido o de
-- la entrega, y esa fila la ata su FK compuesta contra `stores`. No hay forma
-- de pedir una transicion sobre una entrega ajena. Se reusa
-- `ebim.assert_order_operator` (P08) tal cual: despachar es operar el pedido, y
-- tener dos comprobaciones de rol para la misma cosa significa que un dia una
-- de las dos se relajara sola.
--
-- ## El espejo, no la fuente
--
-- `orders.fulfillment_status` se DERIVA de las cantidades entregadas. No es
-- donde vive la verdad —la verdad son las filas de `fulfillment_items`— y por
-- eso solo lo escribe `ebim.fulfillment_sync_order`, que ademas solo AVANZA:
-- un pedido que ya estaba «parcialmente entregado» no puede volver a «sin
-- entregar» porque se anulo una entrega, o el relato del pedido mentiria.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0 · ebim.log_order_fact — un hecho de logistica en la linea de tiempo del
--     pedido.
--
-- La linea de tiempo de P08 tiene un solo escritor: el trigger sobre `orders`.
-- Sigue siendo cierto para todo lo que ES un cambio de `orders`. Lo que aqui se
-- añade son hechos que NO se pueden deducir de esa fila —«se creo la entrega
-- 2», «salio con la guia X»— y que la operacion necesita ver en el MISMO hilo,
-- porque la pregunta real nunca es «¿que le paso al pedido?» sino «¿que paso,
-- en orden?».
--
-- El actor sale del JWT y nunca de un parametro; sin sesion queda NULL, que es
-- la verdad cuando quien escribe es el ingestor de un webhook.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_order_fact(
  p_order      public.orders,
  p_event_type text,
  p_note       text,
  p_payload    jsonb,
  p_source     public.order_event_source default 'backoffice'
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.order_events (
    organization_id, company_id, store_id, order_id,
    event_type, note, payload, source, actor_id, actor_email
  ) values (
    p_order.organization_id, p_order.company_id, p_order.store_id, p_order.id,
    p_event_type,
    nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
    coalesce(p_payload, '{}'::jsonb),
    p_source, ebim.user_id(), left(ebim.email(), 320));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1 · ebim.fulfillment_sync_order — el espejo del pedido.
--
-- El orden de las preguntas importa y no es arbitrario:
--
--   1. ¿Se entrego TODO?          -> `fulfilled`
--   2. ¿Se entrego ALGO?          -> `partially_fulfilled`
--   3. ¿Hay algo en marcha?       -> `in_progress`
--   4. Nada de lo anterior        -> se deja como esta
--
-- Y solo AVANZA. El ranking (`unfulfilled` < `in_progress` <
-- `partially_fulfilled` < `fulfilled`) coincide exactamente con los caminos que
-- `ebim.assert_order_axes` (P08) permite, asi que esta funcion nunca intenta
-- una transicion que el trigger vaya a rechazar. `returned` y `cancelled` los
-- escribe otro: el dominio de devoluciones y el de pedidos.
-- ---------------------------------------------------------------------------
create or replace function ebim.fulfillment_sync_order(p_order_id uuid)
returns public.fulfillment_status
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order     public.orders%rowtype;
  v_ordered   numeric := 0;
  v_delivered numeric := 0;
  v_active    boolean := false;
  v_target    public.fulfillment_status;
  v_rank      integer;
  v_current   integer;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return null;
  end if;

  select coalesce(sum(oi.quantity), 0) into v_ordered
  from public.order_items oi where oi.order_id = v_order.id;

  select coalesce(sum(fi.quantity), 0) into v_delivered
  from public.fulfillment_items fi
  join public.fulfillments f on f.id = fi.fulfillment_id
  where f.order_id = v_order.id and f.state = 'delivered';

  select exists (
    select 1 from public.fulfillments f
    where f.order_id = v_order.id
      and f.state in ('allocated','picking','packed','ready','in_transit','failed')
  ) into v_active;

  if v_ordered > 0 and v_delivered >= v_ordered then
    v_target := 'fulfilled';
  elsif v_delivered > 0 then
    v_target := 'partially_fulfilled';
  elsif v_active then
    v_target := 'in_progress';
  else
    return v_order.fulfillment_status;
  end if;

  v_rank := case v_target
    when 'unfulfilled' then 0 when 'in_progress' then 1
    when 'partially_fulfilled' then 2 when 'fulfilled' then 3 else -1 end;
  v_current := case v_order.fulfillment_status
    when 'unfulfilled' then 0 when 'in_progress' then 1
    when 'partially_fulfilled' then 2 when 'fulfilled' then 3 else 99 end;

  if v_rank <= v_current then
    return v_order.fulfillment_status;
  end if;

  update public.orders set fulfillment_status = v_target where id = v_order.id;
  return v_target;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2 · ebim.plan_fulfillment — crear la promesa de entrega.
--
-- Es INTERNA (`ebim`) porque recibe una opcion YA COTIZADA y no la vuelve a
-- cotizar: quien la llama es `create_order` —que acaba de cotizarla para
-- escribir `shipping_total`— o el comando de backoffice, que cotiza antes. Si
-- fuera publica, alguien podria pasarle un importe inventado, que es
-- exactamente lo que la fase prohibe.
--
-- ## El reparto de `shipping_total`, y por que se calcula asi
--
-- `orders.shipping_total` es INMUTABLE desde P02. Partir una entrega en dos
-- —porque media salio ayer— no cobra transporte de mas, asi que la segunda
-- entrega nace con coste CERO y la suma de las entregas sigue siendo el total
-- del pedido. La formula lo hace estructural en vez de recordado:
--
--     coste = shipping_total - (lo ya asignado a entregas no anuladas)
--
-- Con una sola entrega da el total; con la segunda da cero; y no hay forma de
-- que las dos cifras dejen de cuadrar.
-- ---------------------------------------------------------------------------
create or replace function ebim.plan_fulfillment(
  p_order_id uuid,
  p_option   jsonb,
  p_choice   jsonb,
  p_lines    jsonb default null
)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  v_order    public.orders%rowtype;
  v_id       uuid := gen_random_uuid();
  v_seq      integer;
  v_assigned numeric(14,2);
  v_cost     numeric(14,2);
  v_point    uuid := ebim.safe_uuid(p_choice ->> 'pickup_point_id');
  v_lines    jsonb;
  v_stock    jsonb;
  v_warehouse uuid;
  v_weight   jsonb;
  v_strategy public.delivery_strategy;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  v_strategy := (p_option ->> 'strategy')::public.delivery_strategy;

  -- Las lineas: las que se pidan o, por defecto, TODO lo que queda sin
  -- comprometer. «Lo que queda» y no «todo» es lo que permite que la segunda
  -- entrega de un despacho parcial no intente llevarse lo que ya salio.
  v_lines := coalesce(p_lines, (
    select coalesce(jsonb_agg(jsonb_build_object(
             'order_item_id', oi.id,
             'quantity',      oi.quantity - coalesce(c.committed, 0))), '[]'::jsonb)
    from public.order_items oi
    left join lateral (
      select sum(fi.quantity) as committed
      from public.fulfillment_items fi
      join public.fulfillments f on f.id = fi.fulfillment_id
      where fi.order_item_id = oi.id and f.state <> 'cancelled'
    ) c on true
    where oi.order_id = v_order.id
      and oi.quantity - coalesce(c.committed, 0) > 0
  ));

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'ENTREGA_SIN_LINEAS: no queda nada por despachar en este pedido'
      using errcode = '22023';
  end if;

  select coalesce(max(f.sequence), 0) + 1 into v_seq
  from public.fulfillments f where f.order_id = v_order.id;

  select coalesce(sum(f.shipping_cost), 0) into v_assigned
  from public.fulfillments f
  where f.order_id = v_order.id and f.state <> 'cancelled';
  v_cost := greatest(v_order.shipping_total - v_assigned, 0);

  -- El almacen: la regla configurable del metodo, con el punto de recojo por
  -- encima. Se calcula sobre lo que ESTA entrega lleva, no sobre el pedido
  -- entero: una segunda entrega puede salir de otro sitio.
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', oi.product_id,
           'variant_id', oi.variant_id,
           'quantity',   (l ->> 'quantity')::numeric)), '[]'::jsonb)
    into v_stock
  from jsonb_array_elements(v_lines) as l
  join public.order_items oi on oi.id = (l ->> 'order_item_id')::uuid
  where oi.product_id is not null;

  v_warehouse := ebim.select_warehouse(
    v_order.store_id,
    coalesce((select m.sourcing from public.delivery_methods m
              where m.id = ebim.safe_uuid(p_option ->> 'delivery_method_id')),
             'store_priority'::public.sourcing_strategy),
    v_point,
    v_stock);

  v_weight := ebim.basket_weight(v_order.store_id, v_stock);

  insert into public.fulfillments (
    id, organization_id, company_id, store_id, order_id, sequence,
    delivery_method_id, method_code, method_name, strategy, provider_code,
    warehouse_id, pickup_point_id,
    window_date, window_starts_at, window_ends_at, promised_from, promised_to,
    currency, shipping_cost, weight,
    address, contact_name, contact_phone,
    state
  ) values (
    v_id, v_order.organization_id, v_order.company_id, v_order.store_id, v_order.id, v_seq,
    ebim.safe_uuid(p_option ->> 'delivery_method_id'),
    p_option ->> 'code', p_option ->> 'name', v_strategy,
    (select m.provider_code from public.delivery_methods m
      where m.id = ebim.safe_uuid(p_option ->> 'delivery_method_id')),
    v_warehouse, v_point,
    (p_choice -> 'window' ->> 'date')::date,
    (p_choice -> 'window' ->> 'starts_at')::time,
    (p_choice -> 'window' ->> 'ends_at')::time,
    (p_option ->> 'promised_from')::date,
    (p_option ->> 'promised_to')::date,
    v_order.currency, v_cost,
    case when coalesce((v_weight ->> 'known')::boolean, false)
         then (v_weight ->> 'weight')::numeric end,
    -- Una entrega en punto de recojo NO congela la direccion del comprador:
    -- congela la del punto. Guardar la del comprador ahi seria decir que se
    -- entrego en su casa algo que fue a buscar.
    case when v_strategy = 'pickup'
         then coalesce((select pp.address from public.pickup_points pp where pp.id = v_point),
                       '{}'::jsonb)
         else coalesce(v_order.shipping_address, '{}'::jsonb) end,
    v_order.customer_name, v_order.customer_phone,
    'pending'
  );

  insert into public.fulfillment_items (
    organization_id, company_id, store_id, fulfillment_id, order_item_id, quantity
  )
  select v_order.organization_id, v_order.company_id, v_order.store_id, v_id,
         (l ->> 'order_item_id')::uuid, (l ->> 'quantity')::integer
  from jsonb_array_elements(v_lines) as l
  where (l ->> 'quantity')::integer > 0;

  perform ebim.log_order_fact(
    v_order, 'fulfillment.created', null,
    jsonb_strip_nulls(jsonb_build_object(
      'fulfillment_id', v_id,
      'sequence',       v_seq,
      'method_code',    p_option ->> 'code',
      'strategy',       v_strategy,
      'shipping_cost',  v_cost::text,
      'warehouse_id',   v_warehouse,
      'pickup_point_id', v_point)),
    'system');

  perform ebim.publish_event(
    v_order.organization_id, v_order.company_id, v_order.store_id,
    'fulfillment.created', 'fulfillment', v_id,
    jsonb_build_object(
      'fulfillment_id', v_id,
      'order_id',       v_order.id,
      'order_number',   v_order.order_number,
      'sequence',       v_seq,
      'strategy',       v_strategy,
      'method_code',    p_option ->> 'code'),
    'fulfillment.created:' || v_id::text);

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3 · public.fulfillment_create — el despacho PARCIAL desde el backoffice.
--
-- Recotiza con `ebim.quote_delivery_choice` y no acepta importe: el operador
-- elige metodo, punto y franja; cuanto cuesta y si se puede entregar lo decide
-- la base con la fila delante. La parte del transporte que se le cobro al
-- comprador ya esta en el pedido y no cambia (ver `ebim.plan_fulfillment`).
-- ---------------------------------------------------------------------------
create or replace function public.fulfillment_create(
  p_order_id        uuid,
  p_method_code     text,
  p_lines           jsonb default null,
  p_pickup_point_id uuid  default null,
  p_window          jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order  public.orders%rowtype;
  v_lines  jsonb;
  v_option jsonb;
  v_id     uuid;
begin
  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_order_operator(v_order);

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', oi.product_id,
           'variant_id', oi.variant_id,
           'quantity',   oi.quantity)), '[]'::jsonb)
    into v_lines
  from public.order_items oi where oi.order_id = v_order.id;

  v_option := ebim.quote_delivery_choice(
    v_order.store_id, p_method_code, v_order.shipping_address,
    v_lines, v_order.subtotal, p_pickup_point_id);

  v_id := ebim.plan_fulfillment(
    v_order.id,
    v_option,
    jsonb_strip_nulls(jsonb_build_object(
      'pickup_point_id', p_pickup_point_id,
      'window',          p_window)),
    p_lines);

  perform ebim.fulfillment_sync_order(v_order.id);

  return jsonb_build_object('fulfillment_id', v_id, 'order_id', v_order.id);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4 · public.fulfillment_assign — de que almacen sale.
--
-- Con `p_warehouse_id` NULL vuelve a preguntarle a la regla del metodo; con
-- valor, lo impone una persona. Las dos formas existen porque la regla acierta
-- casi siempre y la excepcion —«ese almacen esta cerrado hoy»— no cabe en
-- ninguna regla.
-- ---------------------------------------------------------------------------
create or replace function public.fulfillment_assign(
  p_fulfillment_id uuid,
  p_warehouse_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ful   public.fulfillments%rowtype;
  v_order public.orders%rowtype;
  v_stock jsonb;
  v_target uuid;
begin
  select * into v_ful from public.fulfillments f where f.id = p_fulfillment_id for update;
  if not found then
    raise exception 'ENTREGA_NO_ENCONTRADA: no hay ninguna entrega con ese identificador'
      using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = v_ful.order_id;
  perform ebim.assert_order_operator(v_order);

  if v_ful.state in ('delivered', 'cancelled') then
    raise exception 'ENTREGA_CERRADA: una entrega % ya no se reasigna', v_ful.state
      using errcode = '23514';
  end if;

  if p_warehouse_id is null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'product_id', oi.product_id,
             'variant_id', oi.variant_id,
             'quantity',   fi.quantity)), '[]'::jsonb)
      into v_stock
    from public.fulfillment_items fi
    join public.order_items oi on oi.id = fi.order_item_id
    where fi.fulfillment_id = v_ful.id and oi.product_id is not null;

    v_target := ebim.select_warehouse(
      v_ful.store_id,
      coalesce((select m.sourcing from public.delivery_methods m where m.id = v_ful.delivery_method_id),
               'store_priority'::public.sourcing_strategy),
      v_ful.pickup_point_id,
      v_stock);
  else
    -- Un almacen de OTRA sociedad no se puede imponer aunque llegue en el
    -- cuerpo: la comprobacion es contra la fila, no contra lo declarado.
    if not exists (
      select 1 from public.warehouses w
      where w.id = p_warehouse_id
        and w.organization_id = v_ful.organization_id
        and w.company_id      = v_ful.company_id
    ) then
      raise exception 'ALMACEN_NO_ENCONTRADO: ese almacen no es de esta sociedad'
        using errcode = '22023';
    end if;
    v_target := p_warehouse_id;
  end if;

  update public.fulfillments
     set warehouse_id = v_target,
         state = case when state = 'pending' and v_target is not null
                      then 'allocated'::public.fulfillment_state else state end
   where id = v_ful.id;

  perform ebim.log_order_fact(
    v_order, 'fulfillment.assigned', null,
    jsonb_strip_nulls(jsonb_build_object(
      'fulfillment_id', v_ful.id, 'warehouse_id', v_target)));

  perform ebim.fulfillment_sync_order(v_order.id);

  return jsonb_build_object('fulfillment_id', v_ful.id, 'warehouse_id', v_target);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5 · public.fulfillment_transition — mover la entrega.
--
-- El destino se comprueba contra las etiquetas del enum ANTES de convertirlo,
-- igual que en `order_transition` (P08): un valor inventado tiene que salir con
-- codigo de dominio y no como `invalid input value for enum`, que la pantalla
-- no sabe traducir.
-- ---------------------------------------------------------------------------
create or replace function public.fulfillment_transition(
  p_fulfillment_id uuid,
  p_to             text,
  p_reason         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ful    public.fulfillments%rowtype;
  v_order  public.orders%rowtype;
  v_to     text := lower(btrim(coalesce(p_to, '')));
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  v_from   text;
  v_status public.fulfillment_status;
begin
  select * into v_ful from public.fulfillments f where f.id = p_fulfillment_id for update;
  if not found then
    raise exception 'ENTREGA_NO_ENCONTRADA: no hay ninguna entrega con ese identificador'
      using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = v_ful.order_id;
  perform ebim.assert_order_operator(v_order);

  if not exists (
    select 1 from unnest(enum_range(null::public.fulfillment_state)::text[]) as label
    where label = v_to
  ) then
    raise exception 'ESTADO_NO_VALIDO: "%" no es un estado de entrega', p_to
      using errcode = '22023';
  end if;

  v_from := v_ful.state::text;
  if v_from = v_to then
    return jsonb_build_object('fulfillment_id', v_ful.id, 'state', v_to, 'changed', false);
  end if;

  -- Cancelar sin decir por que deja una entrega anulada que nadie sabe explicar
  -- tres meses despues. Es el mismo criterio que P08 aplica a la anulacion.
  if v_to = 'cancelled' and v_reason is null then
    raise exception 'MOTIVO_REQUERIDO: cancelar una entrega exige decir por que'
      using errcode = '22023';
  end if;

  update public.fulfillments
     set state = v_to::public.fulfillment_state,
         cancel_reason = case when v_to = 'cancelled' then v_reason else cancel_reason end
   where id = v_ful.id;

  perform ebim.log_order_fact(
    v_order, 'fulfillment.state_changed', v_reason,
    jsonb_build_object(
      'fulfillment_id', v_ful.id, 'from', v_from, 'to', v_to));

  v_status := ebim.fulfillment_sync_order(v_order.id);

  if v_to = 'delivered' then
    perform ebim.publish_event(
      v_order.organization_id, v_order.company_id, v_order.store_id,
      'fulfillment.delivered', 'fulfillment', v_ful.id,
      jsonb_build_object(
        'fulfillment_id', v_ful.id,
        'order_id',       v_order.id,
        'order_number',   v_order.order_number),
      'fulfillment.delivered:' || v_ful.id::text);
  end if;

  return jsonb_build_object(
    'fulfillment_id',     v_ful.id,
    'state',              v_to,
    'changed',            true,
    'fulfillment_status', v_status);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6 · public.shipment_open — abrir el bulto.
--
-- `p_idempotency_key` es obligatoria y unica por entrega: pedir la guia dos
-- veces por un reintento de red devuelve EL MISMO envio en vez de dos guias
-- pagadas. Es el mismo cerrojo que `payment_attempts` (P09) y por la misma
-- razon: lo que cuesta dinero no se repite porque se repita la peticion.
--
-- Nace en `draft` cuando hay operador —la guia todavia no existe, la pide el
-- adaptador— y en `created` cuando no lo hay, porque un reparto propio no
-- espera a nadie.
-- ---------------------------------------------------------------------------
create or replace function public.shipment_open(
  p_fulfillment_id  uuid,
  p_idempotency_key text,
  p_service_code    text default null,
  p_lines           jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ful      public.fulfillments%rowtype;
  v_order    public.orders%rowtype;
  v_existing public.shipments%rowtype;
  v_id       uuid := gen_random_uuid();
  v_key      text := btrim(coalesce(p_idempotency_key, ''));
begin
  select * into v_ful from public.fulfillments f where f.id = p_fulfillment_id for update;
  if not found then
    raise exception 'ENTREGA_NO_ENCONTRADA: no hay ninguna entrega con ese identificador'
      using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = v_ful.order_id;
  perform ebim.assert_order_operator(v_order);

  if char_length(v_key) < 8 or char_length(v_key) > 200 then
    raise exception 'IDEMPOTENCIA_INVALIDA: la clave debe tener entre 8 y 200 caracteres'
      using errcode = '22023';
  end if;

  -- Primer cerrojo: el reintento encuentra su envio y no abre otro.
  select * into v_existing
  from public.shipments s
  where s.fulfillment_id = v_ful.id and s.idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'shipment_id', v_existing.id, 'state', v_existing.state, 'replay', true);
  end if;

  if v_ful.state in ('delivered', 'cancelled') then
    raise exception 'ENTREGA_CERRADA: una entrega % no admite envios nuevos', v_ful.state
      using errcode = '23514';
  end if;

  if v_ful.strategy in ('pickup', 'digital') then
    raise exception 'ENVIO_NO_APLICA: una entrega de tipo % no genera envio', v_ful.strategy
      using errcode = '22023';
  end if;

  insert into public.shipments (
    id, organization_id, company_id, store_id, fulfillment_id,
    provider_code, service_code, state, currency, idempotency_key
  ) values (
    v_id, v_ful.organization_id, v_ful.company_id, v_ful.store_id, v_ful.id,
    v_ful.provider_code,
    nullif(btrim(coalesce(p_service_code, '')), ''),
    case when v_ful.provider_code is null
         then 'created'::public.shipment_state
         else 'draft'::public.shipment_state end,
    v_ful.currency, v_key
  );

  -- Sin lineas declaradas, el bulto lleva TODO lo que la entrega comprometio.
  insert into public.shipment_items (
    organization_id, company_id, store_id, shipment_id, fulfillment_item_id, quantity
  )
  select v_ful.organization_id, v_ful.company_id, v_ful.store_id, v_id,
         fi.id, coalesce(sel.quantity, fi.quantity)
  from public.fulfillment_items fi
  left join lateral (
    select (l ->> 'quantity')::integer as quantity
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as l
    where (l ->> 'fulfillment_item_id')::uuid = fi.id
    limit 1
  ) sel on true
  where fi.fulfillment_id = v_ful.id
    and (p_lines is null or sel.quantity is not null)
    and coalesce(sel.quantity, fi.quantity) > 0;

  perform ebim.log_order_fact(
    v_order, 'shipment.opened', null,
    jsonb_strip_nulls(jsonb_build_object(
      'fulfillment_id', v_ful.id, 'shipment_id', v_id,
      'provider_code', v_ful.provider_code, 'service_code', p_service_code)));

  return jsonb_build_object('shipment_id', v_id, 'state',
    case when v_ful.provider_code is null then 'created' else 'draft' end,
    'replay', false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7 · public.shipment_apply_outcome — lo que dijo el operador al crear la guia.
--
-- Solo `service_role`: es el resultado de una llamada externa que hace el
-- adaptador desde el borde, y no hay ninguna forma legitima de que un navegador
-- afirme «el operador me dio esta guia». El paralelo exacto es
-- `payment_apply_outcome` de P09.
-- ---------------------------------------------------------------------------
create or replace function public.shipment_apply_outcome(
  p_shipment_id     uuid,
  p_state           text,
  p_tracking_number text default null,
  p_tracking_url    text default null,
  p_label_ref       text default null,
  p_cost            numeric default null,
  p_currency        text default null,
  p_estimated       date default null,
  p_error_code      text default null,
  p_error_detail    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ship  public.shipments%rowtype;
  v_ful   public.fulfillments%rowtype;
  v_order public.orders%rowtype;
  v_to    text := lower(btrim(coalesce(p_state, '')));
begin
  select * into v_ship from public.shipments s where s.id = p_shipment_id for update;
  if not found then
    raise exception 'ENVIO_NO_ENCONTRADO: no hay ningun envio con ese identificador'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from unnest(enum_range(null::public.shipment_state)::text[]) as label
    where label = v_to
  ) then
    raise exception 'ESTADO_NO_VALIDO: "%" no es un estado de envio', p_state
      using errcode = '22023';
  end if;

  select * into v_ful   from public.fulfillments f where f.id = v_ship.fulfillment_id;
  select * into v_order from public.orders o       where o.id = v_ful.order_id;

  update public.shipments
     set state = case
                   when v_to = v_ship.state::text then v_ship.state
                   when v_to = any (ebim.shipment_allowed_next(v_ship.state))
                     then v_to::public.shipment_state
                   else v_ship.state
                 end,
         tracking_number = coalesce(nullif(btrim(coalesce(p_tracking_number, '')), ''), tracking_number),
         tracking_url    = coalesce(nullif(btrim(coalesce(p_tracking_url, '')), ''), tracking_url),
         label_ref       = coalesce(nullif(btrim(coalesce(p_label_ref, '')), ''), label_ref),
         cost            = coalesce(p_cost, cost),
         currency        = coalesce(upper(nullif(btrim(coalesce(p_currency, '')), '')), currency),
         estimated_delivery = coalesce(p_estimated, estimated_delivery),
         last_error_code    = nullif(btrim(coalesce(p_error_code, '')), ''),
         last_error_detail  = nullif(btrim(coalesce(p_error_detail, '')), '')
   where id = v_ship.id
  returning * into v_ship;

  perform ebim.log_order_fact(
    v_order, 'shipment.updated', p_error_detail,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id',     v_ship.id,
      'state',           v_ship.state,
      'tracking_number', v_ship.tracking_number,
      'error_code',      v_ship.last_error_code)),
    'system');

  return jsonb_build_object(
    'shipment_id',     v_ship.id,
    'state',           v_ship.state,
    'tracking_number', v_ship.tracking_number);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8 · public.shipment_track_ingest — el seguimiento, idempotente y auditado.
--
-- Es la regla 6 del encargo entera, en una funcion. Tres propiedades:
--
-- 1. **Un aviso repetido no duplica nada.** El `on conflict do nothing` sobre
--    `(shipment_id, external_event_id)` es el cerrojo, y esta en la BASE: no
--    depende de que el borde recuerde comprobarlo antes.
-- 2. **Un aviso sin firma verificada NO mueve un envio.** Se registra —queda
--    constancia del intento, que es lo que «auditado» significa— y no cambia
--    ni un estado. Es la misma decision que P09 tomo con los webhooks de
--    pasarela.
-- 3. **Un aviso desordenado no rompe la ingesta.** Un operador puede mandar
--    «entregado» y despues «en transito»; el segundo se guarda como hecho y
--    NO se intenta aplicar, porque `ebim.shipment_allowed_next` dice que no se
--    puede. Que la ingesta fallara ahi condenaria el aviso a reintentarse para
--    siempre.
-- ---------------------------------------------------------------------------
create or replace function public.shipment_track_ingest(
  p_shipment_id        uuid,
  p_events             jsonb,
  p_source             text default 'provider_webhook',
  p_signature_verified boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ship      public.shipments%rowtype;
  v_ful       public.fulfillments%rowtype;
  v_order     public.orders%rowtype;
  v_event     jsonb;
  v_source    public.tracking_source;
  v_status    public.tracking_status;
  v_inserted  integer := 0;
  v_duplicated integer := 0;
  v_id        uuid;
  v_last      public.tracking_status;
  v_ship_to   text;
  v_ful_to    text;
begin
  select * into v_ship from public.shipments s where s.id = p_shipment_id for update;
  if not found then
    raise exception 'ENVIO_NO_ENCONTRADO: no hay ningun envio con ese identificador'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from unnest(enum_range(null::public.tracking_source)::text[]) as label
    where label = lower(btrim(coalesce(p_source, '')))
  ) then
    raise exception 'ORIGEN_NO_VALIDO: "%" no es un origen de seguimiento', p_source
      using errcode = '22023';
  end if;
  v_source := lower(btrim(p_source))::public.tracking_source;

  select * into v_ful   from public.fulfillments f where f.id = v_ship.fulfillment_id;
  select * into v_order from public.orders o       where o.id = v_ful.order_id;

  for v_event in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    if not exists (
      select 1 from unnest(enum_range(null::public.tracking_status)::text[]) as label
      where label = lower(btrim(coalesce(v_event ->> 'status', '')))
    ) then
      raise exception 'ESTADO_NO_VALIDO: "%" no es un estado canonico de seguimiento',
        v_event ->> 'status' using errcode = '22023';
    end if;
    v_status := lower(btrim(v_event ->> 'status'))::public.tracking_status;

    insert into public.tracking_events (
      organization_id, company_id, store_id, shipment_id,
      external_event_id, provider_code, status, provider_status,
      occurred_at, description, location, source, signature_verified, payload
    ) values (
      v_ship.organization_id, v_ship.company_id, v_ship.store_id, v_ship.id,
      left(btrim(coalesce(v_event ->> 'external_event_id', '')), 200),
      v_ship.provider_code, v_status,
      left(nullif(btrim(coalesce(v_event ->> 'provider_status', '')), ''), 120),
      coalesce((v_event ->> 'occurred_at')::timestamptz, now()),
      left(nullif(btrim(coalesce(v_event ->> 'description', '')), ''), 1000),
      left(nullif(btrim(coalesce(v_event ->> 'location', '')), ''), 200),
      v_source, coalesce(p_signature_verified, false),
      -- El sobre se guarda REDACTADO. `ebim.redact_sensitive` (P09) quita
      -- credenciales y datos de tarjeta a cualquier profundidad antes de que el
      -- CHECK los vea, asi que un operador descuidado no tumba la ingesta.
      ebim.redact_sensitive(coalesce(v_event -> 'payload', '{}'::jsonb))
    )
    on conflict (shipment_id, external_event_id) do nothing
    returning id into v_id;

    if v_id is null then
      v_duplicated := v_duplicated + 1;
    else
      v_inserted := v_inserted + 1;
      v_last := v_status;
      v_id := null;
    end if;
  end loop;

  -- Solo un aviso NUEVO y con firma verificada mueve algo.
  if v_last is not null and coalesce(p_signature_verified, false) then
    v_ship_to := case v_last
      when 'label_created'      then 'created'
      when 'picked_up'          then 'picked_up'
      when 'in_transit'         then 'in_transit'
      when 'out_for_delivery'   then 'out_for_delivery'
      when 'delivery_attempted' then 'failed'
      when 'delivered'          then 'delivered'
      when 'exception'          then 'failed'
      when 'returned'           then 'returned'
      when 'cancelled'          then 'cancelled'
      else null
    end;

    if v_ship_to is not null and v_ship_to = any (ebim.shipment_allowed_next(v_ship.state)) then
      update public.shipments set state = v_ship_to::public.shipment_state
       where id = v_ship.id;

      v_ful_to := case v_ship_to
        when 'picked_up'        then 'in_transit'
        when 'in_transit'       then 'in_transit'
        when 'out_for_delivery' then 'in_transit'
        when 'delivered'        then 'delivered'
        when 'failed'           then 'failed'
        else null
      end;

      if v_ful_to is not null and v_ful_to = any (ebim.fulfillment_allowed_next(v_ful.state)) then
        update public.fulfillments set state = v_ful_to::public.fulfillment_state
         where id = v_ful.id;

        if v_ful_to = 'delivered' then
          perform ebim.publish_event(
            v_order.organization_id, v_order.company_id, v_order.store_id,
            'fulfillment.delivered', 'fulfillment', v_ful.id,
            jsonb_build_object(
              'fulfillment_id', v_ful.id,
              'order_id',       v_order.id,
              'order_number',   v_order.order_number),
            'fulfillment.delivered:' || v_ful.id::text);
        end if;
      end if;

      perform ebim.fulfillment_sync_order(v_order.id);
    end if;
  end if;

  if v_inserted > 0 then
    perform ebim.log_order_fact(
      v_order, 'shipment.tracking', null,
      jsonb_strip_nulls(jsonb_build_object(
        'shipment_id',        v_ship.id,
        'events',             v_inserted,
        'duplicated',         v_duplicated,
        'status',             v_last,
        'signature_verified', coalesce(p_signature_verified, false))),
      'system');
  end if;

  return jsonb_build_object(
    'shipment_id', v_ship.id,
    'accepted',    v_inserted,
    'duplicated',  v_duplicated,
    -- `replay = true` cuando NADA era nuevo: es lo que el borde contesta al
    -- operador para que no siga reintentando.
    'replay',      v_inserted = 0 and v_duplicated > 0,
    'status',      v_last);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9 · public.shipment_track_note — el hecho que anota una persona.
--
-- Existe porque la mitad del seguimiento real de esta region llega por
-- telefono. Se marca `source = 'operator'` y `signature_verified = false`, asi
-- que —igual que un webhook sin firma— NO mueve el envio: para eso esta
-- `fulfillment_transition`, que es un acto autorizado con nombre y apellido.
-- ---------------------------------------------------------------------------
create or replace function public.shipment_track_note(
  p_shipment_id uuid,
  p_status      text,
  p_description text default null,
  p_occurred_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ship  public.shipments%rowtype;
  v_ful   public.fulfillments%rowtype;
  v_order public.orders%rowtype;
begin
  select * into v_ship from public.shipments s where s.id = p_shipment_id;
  if not found then
    raise exception 'ENVIO_NO_ENCONTRADO: no hay ningun envio con ese identificador'
      using errcode = '22023';
  end if;

  select * into v_ful   from public.fulfillments f where f.id = v_ship.fulfillment_id;
  select * into v_order from public.orders o       where o.id = v_ful.order_id;
  perform ebim.assert_order_operator(v_order);

  return public.shipment_track_ingest(
    v_ship.id,
    jsonb_build_array(jsonb_build_object(
      'external_event_id', 'operator:' || gen_random_uuid()::text,
      'status',            p_status,
      'occurred_at',       coalesce(p_occurred_at, now()),
      'description',       p_description)),
    'operator',
    false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10 · Los permisos. Lo que decide el servidor NO lo puede llamar una sesion.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.log_order_fact(public.orders, text, text, jsonb, public.order_event_source),
  ebim.fulfillment_sync_order(uuid),
  ebim.plan_fulfillment(uuid, jsonb, jsonb, jsonb)
from public, anon, authenticated;

grant execute on function
  ebim.log_order_fact(public.orders, text, text, jsonb, public.order_event_source),
  ebim.fulfillment_sync_order(uuid),
  ebim.plan_fulfillment(uuid, jsonb, jsonb, jsonb)
to service_role;

-- `shipment_apply_outcome` y `shipment_track_ingest` son de SERVIDOR: son el
-- resultado de hablar con un operador externo, y ninguna sesion puede afirmar
-- lo que dijo un tercero. Listarlas para `authenticated` invitaria a
-- intentarlo desde el bundle, que es la misma decision que P09 tomo con
-- `payment_apply_outcome`.
revoke execute on function
  public.shipment_apply_outcome(uuid, text, text, text, text, numeric, text, date, text, text),
  public.shipment_track_ingest(uuid, jsonb, text, boolean)
from public, anon, authenticated;

grant execute on function
  public.shipment_apply_outcome(uuid, text, text, text, text, numeric, text, date, text, text),
  public.shipment_track_ingest(uuid, jsonb, text, boolean)
to service_role;

revoke execute on function
  public.fulfillment_create(uuid, text, jsonb, uuid, jsonb),
  public.fulfillment_assign(uuid, uuid),
  public.fulfillment_transition(uuid, text, text),
  public.shipment_open(uuid, text, text, jsonb),
  public.shipment_track_note(uuid, text, text, timestamptz)
from public, anon;

grant execute on function
  public.fulfillment_create(uuid, text, jsonb, uuid, jsonb),
  public.fulfillment_assign(uuid, uuid),
  public.fulfillment_transition(uuid, text, text),
  public.shipment_open(uuid, text, text, jsonb),
  public.shipment_track_note(uuid, text, text, timestamptz)
to authenticated, service_role;

comment on function ebim.fulfillment_sync_order(uuid) is
  'Espejo de orders.fulfillment_status derivado de las cantidades entregadas. Solo AVANZA: el relato de un pedido no retrocede.';
comment on function public.fulfillment_create(uuid, text, jsonb, uuid, jsonb) is
  'Despacho parcial desde el backoffice. Recotiza con la fila delante y no acepta importe: partir una entrega no cobra transporte de mas.';
comment on function public.shipment_track_ingest(uuid, jsonb, text, boolean) is
  'Ingesta de seguimiento: idempotente por el id de evento del operador y auditada. Sin firma verificada se registra y NO mueve nada.';
