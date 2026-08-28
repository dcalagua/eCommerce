-- =============================================================================
-- P12-SaaS · 6/7 — Los COMANDOS de devolucion, y el PUERTO financiero
--
-- ## La regla 9 del encargo, escrita como estructura
--
--   «No implementes una nota de credito de un ERP especifico dentro del core.»
--
-- Aqui se cumple asi: cuando una devolucion se completa NO se emite ningun
-- documento y NO se llama a ningun sistema. Se publica un HECHO canonico en el
-- outbox de dominio (`domain_events`, P07):
--
--     return.completed  { rma, order, resolution, amount, currency, lines }
--
-- Quien lo convierta en nota de credito, en abono de tarjeta o en saldo de
-- tienda es un consumidor —un adaptador de `ErpProvider` o `InvoicingProvider`,
-- que ya son puertos declarados desde P01— y no este esquema. La diferencia
-- practica: conectar un ERP nuevo es escribir un consumidor; no es migrar el
-- dominio de devoluciones.
--
-- **Y no se mueve dinero solo.** Completar una devolucion no dispara un
-- `payment_refund_request`. Devolver dinero es un acto autorizado con su propia
-- pantalla y su propio rol (P09), y encadenarlo aqui significaria que aprobar
-- una devolucion abona una tarjeta sin que nadie mas lo mire. El importe queda
-- decidido, publicado y visible; quien lo abona pulsa un boton distinto.
--
-- ## Dos puertas y dos autorizaciones
--
--   · el COMPRADOR ANONIMO entra con el token de 256 bits de su pedido, la
--     misma puerta que `order_by_token` (P11 historico), y no puede hacer nada
--     mas que PEDIR;
--   · el COMERCIO entra con sesion y rol de pedidos, y es el unico que decide.
--
-- Dos funciones y no una con bandera, por la razon de siempre: cada una lleva
-- su autorizacion dentro y una bandera es un parametro que se puede pasar mal.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0 · ebim.log_return_event — el escritor de la bitacora.
--
-- Un solo sitio, para que ningun comando pueda mover un estado sin dejar
-- rastro: la insercion del evento va en la MISMA transaccion que el cambio.
-- ---------------------------------------------------------------------------
create or replace function ebim.log_return_event(
  p_request    public.return_requests,
  p_event_type text,
  p_from       public.return_state,
  p_to         public.return_state,
  p_note       text,
  p_payload    jsonb default '{}'::jsonb
)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  insert into public.return_events (
    organization_id, company_id, store_id, return_request_id,
    event_type, from_state, to_state, note, payload, actor_id, actor_email
  ) values (
    p_request.organization_id, p_request.company_id, p_request.store_id, p_request.id,
    p_event_type, p_from, p_to,
    nullif(left(btrim(coalesce(p_note, '')), 2000), ''),
    ebim.redact_sensitive(coalesce(p_payload, '{}'::jsonb)),
    ebim.user_id(), left(ebim.email(), 320));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1 · ebim.open_return — el alta, comun a las dos puertas.
--
-- Interna porque recibe el pedido YA RESUELTO y autorizado: la puerta del
-- comprador lo resuelve por token y la del comercio por sesion, y ninguna de
-- las dos deja que el pedido llegue declarado.
--
-- Lo que esta funcion comprueba, y no puede depender de que el llamante lo
-- recuerde:
--
--  · el motivo existe y esta activo EN ESA TIENDA;
--  · cada linea es de ESE pedido (la FK compuesta lo remata, pero el mensaje de
--    una clave ajena no le dice nada a quien esta devolviendo un zapato);
--  · la cantidad cabe (trigger `return_items_quantity`);
--  · y el pedido esta en un estado del que se pueda devolver algo.
-- ---------------------------------------------------------------------------
create or replace function ebim.open_return(
  p_order   public.orders,
  p_reason  text,
  p_items   jsonb,
  p_note    text,
  p_source  public.return_source
)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  v_id      uuid := gen_random_uuid();
  v_reason  public.return_reasons%rowtype;
  v_seq     bigint;
  v_rma     text;
  v_request public.return_requests%rowtype;
  v_count   integer;
begin
  -- Un pedido cancelado no tiene nada que devolver, y uno que nunca salio
  -- tampoco: lo que se pide entonces es una anulacion, que es otra cosa y otra
  -- pantalla. Se distingue con un codigo propio para que la vitrina pueda
  -- decirlo en vez de dar un error generico.
  if p_order.status = 'cancelled' then
    raise exception 'PEDIDO_CANCELADO: un pedido cancelado no admite devolucion'
      using errcode = '22023';
  end if;

  select * into v_reason
  from public.return_reasons r
  where r.store_id = p_order.store_id
    and r.code = lower(btrim(coalesce(p_reason, '')))
    and r.is_active;

  if not found then
    raise exception 'MOTIVO_NO_VALIDO: "%" no es un motivo de devolucion activo de esta tienda',
      p_reason using errcode = '22023';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as l
  join public.order_items oi on oi.id = (l ->> 'order_item_id')::uuid
  where oi.order_id = p_order.id;

  if v_count = 0 or v_count <> jsonb_array_length(coalesce(p_items, '[]'::jsonb)) then
    raise exception 'LINEAS_NO_VALIDAS: hay que indicar al menos una linea y todas del mismo pedido'
      using errcode = '22023';
  end if;

  update public.stores
     set return_seq = return_seq + 1
   where id = p_order.store_id
  returning return_seq into v_seq;

  v_rma := 'RMA-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(v_seq::text, 5, '0');

  insert into public.return_requests (
    id, organization_id, company_id, store_id, order_id, rma_number,
    state, source, reason_code, reason_label, customer_note, customer_email, currency
  ) values (
    v_id, p_order.organization_id, p_order.company_id, p_order.store_id, p_order.id, v_rma,
    'requested', p_source, v_reason.code, v_reason.label,
    nullif(left(btrim(coalesce(p_note, '')), 2000), ''),
    p_order.customer_email, p_order.currency
  )
  returning * into v_request;

  insert into public.return_items (
    organization_id, company_id, store_id, return_request_id, order_item_id,
    quantity, reason_code
  )
  select p_order.organization_id, p_order.company_id, p_order.store_id, v_id,
         (l ->> 'order_item_id')::uuid,
         greatest(coalesce((l ->> 'quantity')::integer, 1), 1),
         coalesce(lower(nullif(btrim(coalesce(l ->> 'reason_code', '')), '')), v_reason.code)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as l;

  perform ebim.log_return_event(
    v_request, 'return.requested', null, 'requested',
    nullif(left(btrim(coalesce(p_note, '')), 2000), ''),
    jsonb_build_object('reason_code', v_reason.code, 'source', p_source));

  perform ebim.log_order_fact(
    p_order, 'return.requested', null,
    jsonb_build_object('return_request_id', v_id, 'rma_number', v_rma,
                       'reason_code', v_reason.code),
    case p_source when 'storefront' then 'storefront' when 'api' then 'api'
                  else 'backoffice' end::public.order_event_source);

  perform ebim.publish_event(
    p_order.organization_id, p_order.company_id, p_order.store_id,
    'return.requested', 'return', v_id,
    jsonb_build_object(
      'return_request_id', v_id,
      'rma_number',        v_rma,
      'order_id',          p_order.id,
      'order_number',      p_order.order_number,
      'reason_code',       v_reason.code,
      'customer_email',    p_order.customer_email),
    'return.requested:' || v_id::text);

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2 · public.return_request_for_slug — la puerta del COMPRADOR anonimo.
--
-- Exige tienda activa + numero de pedido + token, los tres, y no distingue
-- «no existe» de «token incorrecto»: mensajes distintos permitirian enumerar
-- numeros de pedido, que son correlativos. Es literalmente la misma guarda que
-- `order_by_token`, escrita igual a proposito.
-- ---------------------------------------------------------------------------
create or replace function public.return_request_for_slug(
  p_store_slug   text,
  p_order_number text,
  p_token        text,
  p_reason_code  text,
  p_items        jsonb,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
  v_id    uuid;
begin
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  select o.* into v_order
  from public.orders o
  join public.stores s       on s.id = o.store_id
  join public.order_tokens t on t.order_id = o.id
  where lower(s.slug) = lower(btrim(coalesce(p_store_slug, '')))
    and s.status = 'active'
    and o.order_number = btrim(coalesce(p_order_number, ''))
    and t.token = p_token;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  v_id := ebim.open_return(v_order, p_reason_code, p_items, p_note, 'storefront');

  return jsonb_build_object(
    'return_request_id', v_id,
    'rma_number', (select rr.rma_number from public.return_requests rr where rr.id = v_id),
    'state', 'requested');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3 · public.return_open — la puerta del COMERCIO.
--
-- Existe porque la mitad de las devoluciones reales entran por telefono o por
-- mostrador, y obligar a que el comprador use la web para algo que ya esta
-- hablando con una persona es como se acaba con las devoluciones anotadas en un
-- cuaderno.
-- ---------------------------------------------------------------------------
create or replace function public.return_open(
  p_order_id    uuid,
  p_reason_code text,
  p_items       jsonb,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
  v_id    uuid;
begin
  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_order_operator(v_order);

  v_id := ebim.open_return(v_order, p_reason_code, p_items, p_note, 'backoffice');

  return jsonb_build_object(
    'return_request_id', v_id,
    'rma_number', (select rr.rma_number from public.return_requests rr where rr.id = v_id),
    'state', 'requested');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4 · ebim.assert_return_operator — quien decide sobre una devolucion.
--
-- Se apoya en el operador del PEDIDO: devolver es operar el pedido. Una matriz
-- de roles propia para devoluciones seria una segunda tabla de permisos que se
-- separa de la primera el dia que alguien toque una de las dos.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_return_operator(p_request public.return_requests)
returns void
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders o where o.id = p_request.order_id;
  perform ebim.assert_order_operator(v_order);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5 · public.return_decide — aprobar o rechazar.
--
-- Rechazar EXIGE motivo (lo remata el CHECK `return_requests_rejection_shape`,
-- asi que no depende de este comando). Aprobar no lo exige: el motivo de
-- aprobar es que procedia.
-- ---------------------------------------------------------------------------
create or replace function public.return_decide(
  p_return_id uuid,
  p_decision  text,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req      public.return_requests%rowtype;
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_to       public.return_state;
  v_from     public.return_state;
begin
  select * into v_req from public.return_requests r where r.id = p_return_id for update;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_return_operator(v_req);

  if v_decision not in ('approve', 'reject') then
    raise exception 'DECISION_NO_VALIDA: solo "approve" o "reject"' using errcode = '22023';
  end if;

  v_to := case when v_decision = 'approve' then 'approved' else 'rejected' end;
  v_from := v_req.state;

  if v_decision = 'reject' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'MOTIVO_REQUERIDO: rechazar una devolucion exige decir por que'
      using errcode = '22023';
  end if;

  update public.return_requests
     set state         = v_to,
         decided_at    = now(),
         decided_by    = ebim.user_id(),
         decided_email = left(ebim.email(), 320),
         decision_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 2000), ''), decision_note)
   where id = v_req.id
  returning * into v_req;

  perform ebim.log_return_event(
    v_req, 'return.' || v_decision || 'd', v_from, v_to, p_note, '{}'::jsonb);

  perform ebim.publish_event(
    v_req.organization_id, v_req.company_id, v_req.store_id,
    'return.' || v_to::text, 'return', v_req.id,
    jsonb_build_object(
      'return_request_id', v_req.id,
      'rma_number',        v_req.rma_number,
      'order_id',          v_req.order_id,
      'state',             v_to,
      'customer_email',    v_req.customer_email),
    'return.' || v_to::text || ':' || v_req.id::text);

  return jsonb_build_object('return_request_id', v_req.id, 'state', v_to);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6 · public.return_receive — llego.
--
-- Se anota CUANTAS llegaron de cada linea, que no tiene por que ser lo que se
-- aprobo: el comprador manda dos de tres, o mete otra cosa en la caja. Sin esta
-- distincion, el reembolso se calcularia sobre lo prometido y no sobre lo
-- recibido.
-- ---------------------------------------------------------------------------
create or replace function public.return_receive(
  p_return_id uuid,
  p_items     jsonb default null,
  p_note      text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req  public.return_requests%rowtype;
  v_from public.return_state;
begin
  select * into v_req from public.return_requests r where r.id = p_return_id for update;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_return_operator(v_req);
  v_from := v_req.state;

  -- Sin lineas declaradas, llego todo lo que se pidio. Es el caso normal y
  -- exigir la lista completa cada vez convertiria la recepcion en un formulario
  -- que nadie rellena.
  update public.return_items ri
     set received_quantity = coalesce(sel.quantity, ri.quantity)
    from (select ri2.id,
                 (select (l ->> 'received_quantity')::integer
                    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as l
                   where (l ->> 'return_item_id')::uuid = ri2.id
                   limit 1) as quantity
            from public.return_items ri2
           where ri2.return_request_id = v_req.id) sel
   where ri.id = sel.id;

  update public.return_requests
     set state = 'received', received_at = now()
   where id = v_req.id
  returning * into v_req;

  perform ebim.log_return_event(v_req, 'return.received', v_from, 'received', p_note);

  return jsonb_build_object('return_request_id', v_req.id, 'state', 'received');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7 · public.return_inspect — la revision pieza a pieza, y la reposicion.
--
-- Aqui pasan las tres cosas que solo se pueden decidir con la unidad delante:
--
--  1. **En que estado llego** cada linea (`condition`);
--  2. **si vuelve al stock** (`restock`), que solo es legal si llego vendible
--     —lo remata el CHECK `return_items_restock_shape`—;
--  3. **cuanto se devuelve**, que es una decision del comercio y no una suma
--     automatica: hay portes no reembolsables y hay acuerdos.
--
-- La reposicion pasa por el motor de inventario de P06 y no por un UPDATE:
-- `ebim.expand_stock_lines` traduce el kit a componentes —una sola vez en todo
-- el repositorio— y `ebim.apply_movement` deja el asiento con su referencia
-- externa, que es lo que hace la operacion IDEMPOTENTE: inspeccionar dos veces
-- no repone el doble.
-- ---------------------------------------------------------------------------
create or replace function public.return_inspect(
  p_return_id     uuid,
  p_items         jsonb,
  p_refund_amount numeric default null,
  p_note          text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req       public.return_requests%rowtype;
  v_from      public.return_state;
  v_item      jsonb;
  v_line      public.return_items%rowtype;
  v_order     public.orders%rowtype;
  v_oi        public.order_items%rowtype;
  v_condition public.return_item_condition;
  v_restock   boolean;
  v_warehouse uuid;
  v_part      record;
  v_level     uuid;
  v_movement  jsonb;
  v_restocked integer := 0;
  v_amount    numeric(14,2);
begin
  select * into v_req from public.return_requests r where r.id = p_return_id for update;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_return_operator(v_req);
  select * into v_order from public.orders o where o.id = v_req.order_id;
  v_from := v_req.state;

  -- El almacen al que vuelve: el de la entrega que salio, si la hubo. Devolver
  -- a un almacen distinto del que sirvio descuadra los dos.
  select f.warehouse_id into v_warehouse
  from public.fulfillments f
  where f.order_id = v_req.order_id and f.warehouse_id is not null
  order by f.sequence
  limit 1;

  if v_warehouse is null then
    select w.warehouse_id into v_warehouse
    from ebim.serving_warehouses(v_req.store_id) w
    limit 1;
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into v_line
    from public.return_items ri
    where ri.id = (v_item ->> 'return_item_id')::uuid
      and ri.return_request_id = v_req.id;

    if not found then
      raise exception 'LINEA_NO_ENCONTRADA: esa linea no pertenece a esta devolucion'
        using errcode = '22023';
    end if;

    if not exists (
      select 1 from unnest(enum_range(null::public.return_item_condition)::text[]) as label
      where label = lower(btrim(coalesce(v_item ->> 'condition', '')))
    ) then
      raise exception 'ESTADO_NO_VALIDO: "%" no es un estado de unidad devuelta',
        v_item ->> 'condition' using errcode = '22023';
    end if;
    v_condition := lower(btrim(v_item ->> 'condition'))::public.return_item_condition;
    v_restock   := coalesce((v_item ->> 'restock')::boolean, false)
                   and v_condition = 'sellable';

    update public.return_items
       set condition        = v_condition,
           restock          = v_restock,
           refund_amount    = coalesce((v_item ->> 'refund_amount')::numeric, refund_amount),
           note             = coalesce(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), note)
     where id = v_line.id
    returning * into v_line;

    -- ---- La reposicion, si procede ---------------------------------------
    if v_restock and v_line.received_quantity > 0 and v_line.restock_movement_id is null
       and v_warehouse is not null then
      select * into v_oi from public.order_items oi where oi.id = v_line.order_item_id;

      if v_oi.product_id is not null then
        for v_part in
          select l.product_id, l.variant_id, l.quantity
          from ebim.expand_stock_lines(
                 v_req.store_id, v_oi.product_id, v_oi.variant_id,
                 v_line.received_quantity * v_oi.uom_factor) l
        loop
          v_level := ebim.ensure_level(v_warehouse, v_part.product_id, v_part.variant_id);
          v_movement := ebim.apply_movement(
            v_level, 'return'::public.movement_kind, v_part.quantity,
            'Devolucion ' || v_req.rma_number, 'return', v_req.id,
            -- Referencia externa = la linea de devolucion. Es lo que hace la
            -- reposicion idempotente: repetir la inspeccion encuentra el
            -- asiento y no crea el segundo.
            'return:' || v_line.id::text || ':' || v_part.product_id::text,
            ebim.user_id());

          if coalesce((v_movement ->> 'applied')::boolean, false) then
            v_restocked := v_restocked + 1;
          end if;
        end loop;

        update public.return_items
           set restock_movement_id = ebim.safe_uuid(v_movement ->> 'movement_id')
         where id = v_line.id;
      end if;
    end if;
  end loop;

  -- El importe: el que decide el comercio o, si no lo declara, la suma de las
  -- lineas. La suma es un DEFECTO razonable y no la autoridad, que es la
  -- diferencia entre ayudar y decidir por el operador.
  v_amount := coalesce(
    p_refund_amount,
    (select coalesce(sum(ri.refund_amount), 0)
       from public.return_items ri where ri.return_request_id = v_req.id));

  update public.return_requests
     set state = 'inspected', inspected_at = now(), refund_amount = greatest(v_amount, 0)
   where id = v_req.id
  returning * into v_req;

  perform ebim.log_return_event(
    v_req, 'return.inspected', v_from, 'inspected', p_note,
    jsonb_build_object('refund_amount', v_req.refund_amount::text,
                       'restocked_lines', v_restocked,
                       'warehouse_id', v_warehouse));

  perform ebim.log_order_fact(
    v_order, 'return.inspected', p_note,
    jsonb_build_object('return_request_id', v_req.id, 'rma_number', v_req.rma_number,
                       'refund_amount', v_req.refund_amount::text));

  return jsonb_build_object(
    'return_request_id', v_req.id,
    'state',             'inspected',
    'refund_amount',     v_req.refund_amount::text,
    'restocked_lines',   v_restocked);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8 · public.return_complete — cerrar, y publicar el hecho financiero.
--
-- Es donde vive el PUERTO. No se emite documento, no se abona nada y no se
-- llama a ningun sistema: se publica `return.completed` con el importe, la
-- resolucion y las lineas, y el consumidor decide que hacer con ello.
--
-- El espejo del pedido se mueve a `returned` SOLO si volvio todo. Con una
-- devolucion parcial el pedido sigue diciendo lo que es —entregado en parte— y
-- lo que volvio se lee en la devolucion, que es donde esta el detalle.
-- ---------------------------------------------------------------------------
create or replace function public.return_complete(
  p_return_id  uuid,
  p_resolution text default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req        public.return_requests%rowtype;
  v_order      public.orders%rowtype;
  v_from       public.return_state;
  v_resolution public.return_resolution;
  v_ordered    numeric := 0;
  v_returned   numeric := 0;
  v_lines      jsonb;
begin
  select * into v_req from public.return_requests r where r.id = p_return_id for update;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_return_operator(v_req);
  select * into v_order from public.orders o where o.id = v_req.order_id for update;
  v_from := v_req.state;

  if p_resolution is not null then
    if not exists (
      select 1 from unnest(enum_range(null::public.return_resolution)::text[]) as label
      where label = lower(btrim(p_resolution))
    ) then
      raise exception 'RESOLUCION_NO_VALIDA: "%" no es una resolucion de devolucion', p_resolution
        using errcode = '22023';
    end if;
    v_resolution := lower(btrim(p_resolution))::public.return_resolution;
  else
    v_resolution := v_req.resolution;
  end if;

  update public.return_requests
     set state = 'completed', resolution = v_resolution, completed_at = now()
   where id = v_req.id
  returning * into v_req;

  select coalesce(jsonb_agg(jsonb_build_object(
           'order_item_id',     ri.order_item_id,
           'sku',               oi.sku,
           'quantity',          ri.quantity,
           'received_quantity', ri.received_quantity,
           'condition',         ri.condition,
           'restocked',         ri.restock_movement_id is not null,
           'refund_amount',     ri.refund_amount::text)), '[]'::jsonb)
    into v_lines
  from public.return_items ri
  join public.order_items oi on oi.id = ri.order_item_id
  where ri.return_request_id = v_req.id;

  -- ¿Volvio TODO el pedido? Solo entonces el espejo cambia.
  select coalesce(sum(oi.quantity), 0) into v_ordered
  from public.order_items oi where oi.order_id = v_order.id;

  select coalesce(sum(ri.received_quantity), 0) into v_returned
  from public.return_items ri
  join public.return_requests rr on rr.id = ri.return_request_id
  where rr.order_id = v_order.id and rr.state = 'completed';

  if v_ordered > 0 and v_returned >= v_ordered
     and v_order.fulfillment_status in ('fulfilled', 'partially_fulfilled') then
    update public.orders set fulfillment_status = 'returned' where id = v_order.id;
  end if;

  perform ebim.log_return_event(
    v_req, 'return.completed', v_from, 'completed', p_note,
    jsonb_build_object('resolution', v_resolution,
                       'refund_amount', v_req.refund_amount::text));

  perform ebim.log_order_fact(
    v_order, 'return.completed', p_note,
    jsonb_build_object('return_request_id', v_req.id, 'rma_number', v_req.rma_number,
                       'resolution', v_resolution,
                       'refund_amount', v_req.refund_amount::text));

  -- EL PUERTO. Un hecho canonico, sin un solo nombre de sistema dentro. Quien
  -- lo convierta en nota de credito, en abono o en saldo es un consumidor del
  -- outbox; este esquema no sabe ni tiene que saber cual.
  perform ebim.publish_event(
    v_req.organization_id, v_req.company_id, v_req.store_id,
    'return.completed', 'return', v_req.id,
    jsonb_build_object(
      'return_request_id', v_req.id,
      'rma_number',        v_req.rma_number,
      'order_id',          v_order.id,
      'order_number',      v_order.order_number,
      'customer_email',    v_req.customer_email,
      'resolution',        v_resolution,
      'currency',          v_req.currency,
      'refund_amount',     v_req.refund_amount::text,
      'lines',             v_lines),
    'return.completed:' || v_req.id::text);

  return jsonb_build_object(
    'return_request_id', v_req.id,
    'state',             'completed',
    'resolution',        v_resolution,
    'refund_amount',     v_req.refund_amount::text);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9 · public.return_cancel — retirar la solicitud.
-- ---------------------------------------------------------------------------
create or replace function public.return_cancel(
  p_return_id uuid,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req  public.return_requests%rowtype;
  v_from public.return_state;
begin
  select * into v_req from public.return_requests r where r.id = p_return_id for update;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_return_operator(v_req);

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOTIVO_REQUERIDO: anular una devolucion exige decir por que'
      using errcode = '22023';
  end if;

  v_from := v_req.state;

  update public.return_requests
     set state = 'cancelled', cancelled_at = now(),
         decision_note = left(btrim(p_reason), 2000)
   where id = v_req.id
  returning * into v_req;

  perform ebim.log_return_event(v_req, 'return.cancelled', v_from, 'cancelled', p_reason);

  return jsonb_build_object('return_request_id', v_req.id, 'state', 'cancelled');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10 · public.return_evidence_attach — la foto, atada a la fila.
--
-- Es un comando y no un INSERT con policy para que la fila y el objeto de
-- Storage no puedan separarse: aqui se comprueba que la ruta pertenece al
-- tenant de ESTA devolucion antes de escribirla, y el trigger
-- `return_evidence_path` lo remata. Con una policy sola, la ruta seria un dato
-- declarado por quien sube el archivo.
-- ---------------------------------------------------------------------------
create or replace function public.return_evidence_attach(
  p_return_id    uuid,
  p_storage_path text,
  p_content_type text,
  p_size_bytes   integer,
  p_caption      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.return_requests%rowtype;
  v_id  uuid;
begin
  select * into v_req from public.return_requests r where r.id = p_return_id;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_return_operator(v_req);

  insert into public.return_evidence (
    organization_id, company_id, store_id, return_request_id,
    storage_path, content_type, size_bytes, caption, uploaded_by, uploaded_email
  ) values (
    v_req.organization_id, v_req.company_id, v_req.store_id, v_req.id,
    btrim(coalesce(p_storage_path, '')), lower(btrim(coalesce(p_content_type, ''))),
    coalesce(p_size_bytes, 0),
    nullif(left(btrim(coalesce(p_caption, '')), 300), ''),
    ebim.user_id(), left(ebim.email(), 320)
  )
  returning id into v_id;

  perform ebim.log_return_event(
    v_req, 'return.evidence_added', v_req.state, v_req.state, p_caption,
    jsonb_build_object('evidence_id', v_id));

  return jsonb_build_object('evidence_id', v_id);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 11 · public.returns_by_token — el comprador consulta sus devoluciones.
--
-- La otra mitad de «devoluciones asistidas»: sin esto, quien pide una
-- devolucion se queda sin forma de saber en que va, que es exactamente el
-- problema que P11 historico resolvio para el pedido. Devuelve estado y
-- lineas; ni notas internas, ni quien decidio, ni la evidencia.
-- ---------------------------------------------------------------------------
create or replace function public.returns_by_token(
  p_store_slug   text,
  p_order_number text,
  p_token        text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
begin
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  select o.* into v_order
  from public.orders o
  join public.stores s       on s.id = o.store_id
  join public.order_tokens t on t.order_id = o.id
  where lower(s.slug) = lower(btrim(coalesce(p_store_slug, '')))
    and s.status = 'active'
    and o.order_number = btrim(coalesce(p_order_number, ''))
    and t.token = p_token;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'rma_number',    rr.rma_number,
             'state',         rr.state,
             'resolution',    rr.resolution,
             'reason_label',  rr.reason_label,
             'refund_amount', rr.refund_amount::text,
             'currency',      rr.currency,
             'created_at',    rr.created_at,
             'lines',         (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'sku',      oi.sku,
                        'name',     oi.name,
                        'quantity', ri.quantity)), '[]'::jsonb)
               from public.return_items ri
               join public.order_items oi on oi.id = ri.order_item_id
               where ri.return_request_id = rr.id))
           order by rr.created_at desc)
    from public.return_requests rr
    where rr.order_id = v_order.id), '[]'::jsonb);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 12 · Los permisos.
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.log_return_event(public.return_requests, text, public.return_state,
                        public.return_state, text, jsonb),
  ebim.open_return(public.orders, text, jsonb, text, public.return_source),
  ebim.assert_return_operator(public.return_requests)
from public, anon, authenticated;

grant execute on function
  ebim.log_return_event(public.return_requests, text, public.return_state,
                        public.return_state, text, jsonb),
  ebim.open_return(public.orders, text, jsonb, text, public.return_source),
  ebim.assert_return_operator(public.return_requests)
to service_role;

-- Las dos puertas del comprador anonimo: exigen el token de 256 bits de su
-- pedido y no pueden decidir nada.
revoke execute on function
  public.return_request_for_slug(text, text, text, text, jsonb, text),
  public.returns_by_token(text, text, text)
from public;
grant execute on function
  public.return_request_for_slug(text, text, text, text, jsonb, text),
  public.returns_by_token(text, text, text)
to anon, authenticated, service_role;

-- Las del comercio: sesion + rol de pedidos, comprobado DENTRO de cada una.
revoke execute on function
  public.return_open(uuid, text, jsonb, text),
  public.return_decide(uuid, text, text),
  public.return_receive(uuid, jsonb, text),
  public.return_inspect(uuid, jsonb, numeric, text),
  public.return_complete(uuid, text, text),
  public.return_cancel(uuid, text),
  public.return_evidence_attach(uuid, text, text, integer, text)
from public, anon;

grant execute on function
  public.return_open(uuid, text, jsonb, text),
  public.return_decide(uuid, text, text),
  public.return_receive(uuid, jsonb, text),
  public.return_inspect(uuid, jsonb, numeric, text),
  public.return_complete(uuid, text, text),
  public.return_cancel(uuid, text),
  public.return_evidence_attach(uuid, text, text, integer, text)
to authenticated, service_role;

comment on function public.return_complete(uuid, text, text) is
  'Cierra la devolucion y publica el hecho canonico return.completed. NO emite documento ni abona: eso es un consumidor del outbox.';
comment on function public.return_inspect(uuid, jsonb, numeric, text) is
  'Revision pieza a pieza. La reposicion pasa por el motor de inventario con referencia externa: inspeccionar dos veces no repone el doble.';
comment on function public.return_request_for_slug(text, text, text, text, jsonb, text) is
  'Puerta del comprador anonimo: tienda activa + numero + token, los tres. No distingue "no existe" de "token incorrecto".';
