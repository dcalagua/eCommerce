-- =============================================================================
-- P12-SaaS · 8/8 — El conector de pruebas, la capacidad, las vistas del
--                  backoffice y lo que el COMPRADOR ve de su entrega
--
-- ## Por que hay un operador `sandbox_carrier` en el catalogo GLOBAL
--
-- Por la misma razon exacta que P09 metio `sandbox` en el catalogo de
-- pasarelas, y el argumento se sostiene igual: la Definition of Done de esta
-- fase es «se puede conectar un operador logistico nuevo mediante adapter», y
-- un simulador que solo existiera en los tests demostraria que los tests
-- compilan, no que el despacho funciona. `delivery_methods.provider_code` tiene
-- una FK real contra este catalogo: sin fila no hay metodo que crear.
--
-- No es un cliente ni una marca: es una capacidad del producto, igual que lo es
-- «hay conector para SAP R/3». Sirve para tres cosas que pasan de verdad:
--
--   · un comercio prueba su flujo de entrega ANTES de contratar transportista;
--   · una demo genera guias y eventos de seguimiento sin mover una caja;
--   · los tests de la fase —guia, transito, entrega, aviso repetido y
--     devolucion— corren contra el MISMO camino que la produccion.
--
-- Su comportamiento es DETERMINISTA y vive en TypeScript
-- (`_shared/fulfillment/sandbox.ts`): la base no simula nada, solo sabe que
-- existe un conector con ese codigo.
--
-- ## Por que la capacidad pasa a `implemented` y no nace una nueva
--
-- `fulfillment` ya estaba declarada desde P02 con su entitlement
-- `ecommerce.fulfillment`. Lo que cambia hoy es que detras hay pantalla y
-- comando, que es exactamente lo que la columna `state` significa. Inventar
-- `fulfillment.returns` como segunda capacidad vendible seria decidir el
-- empaquetado comercial desde el repositorio, y el catalogo comercial es del
-- hub (contrato §5/§6).
-- =============================================================================

insert into public.integration_providers (code, kind, name, capabilities) values
  ('sandbox_carrier', 'logistics', 'Operador de pruebas',
   '{shipment.create,shipment.track,shipment.cancel}')
on conflict (code) do nothing;

update public.app_capabilities
   set state = 'implemented'
 where code = 'fulfillment';

-- ---------------------------------------------------------------------------
-- La cola de preparacion: una entrega, su pedido y sus cuentas, en una fila.
--
-- `security_invoker`: no amplia ni un permiso. Se apoya en las policies de
-- `fulfillments` y de `orders`, asi que un miembro de otra sociedad no ve nada
-- aunque consulte la vista directamente.
--
-- Existe para que la pantalla no encadene cinco consultas y, sobre todo, para
-- que los conteos —cuantas unidades lleva, cuantos bultos, si hay guia— salgan
-- de un sitio y no de la suma que haga el navegador.
-- ---------------------------------------------------------------------------
create view public.fulfillment_overview
with (security_invoker = on) as
select
  f.id               as fulfillment_id,
  f.organization_id,
  f.company_id,
  f.store_id,
  f.order_id,
  o.order_number,
  o.customer_email,
  o.status           as order_status,
  o.payment_status,
  o.fulfillment_status,
  f.sequence,
  f.method_code,
  f.method_name,
  f.strategy,
  f.provider_code,
  f.state,
  f.warehouse_id,
  w.code             as warehouse_code,
  f.pickup_point_id,
  pp.name            as pickup_point_name,
  f.window_date,
  f.window_starts_at,
  f.window_ends_at,
  f.promised_from,
  f.promised_to,
  f.currency,
  f.shipping_cost,
  f.weight,
  f.address,
  f.contact_name,
  f.contact_phone,
  f.created_at,
  f.allocated_at,
  f.shipped_at,
  f.delivered_at,
  (select coalesce(sum(fi.quantity), 0)
     from public.fulfillment_items fi where fi.fulfillment_id = f.id) as unit_count,
  (select count(*) from public.shipments s where s.fulfillment_id = f.id) as shipment_count,
  (select s.tracking_number
     from public.shipments s
     where s.fulfillment_id = f.id and s.tracking_number is not null
     order by s.created_at desc limit 1) as tracking_number,
  (select s.tracking_url
     from public.shipments s
     where s.fulfillment_id = f.id and s.tracking_url is not null
     order by s.created_at desc limit 1) as tracking_url,
  (select count(*)
     from public.tracking_events te
     join public.shipments s on s.id = te.shipment_id
    where s.fulfillment_id = f.id) as tracking_event_count,
  -- Se llego tarde: la promesa es de la entrega y la fecha real tambien, asi
  -- que la comparacion se hace donde estan las dos y no en la pantalla.
  (f.promised_to is not null
   and f.state not in ('delivered', 'cancelled')
   and f.promised_to < (now() at time zone 'utc')::date) as is_late
from public.fulfillments f
join public.orders o             on o.id = f.order_id
left join public.warehouses w    on w.id = f.warehouse_id
left join public.pickup_points pp on pp.id = f.pickup_point_id;

revoke all on public.fulfillment_overview from public, anon;
grant select on public.fulfillment_overview to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- La cola de devoluciones. Mismo criterio y mismas garantias.
-- ---------------------------------------------------------------------------
create view public.return_overview
with (security_invoker = on) as
select
  r.id               as return_request_id,
  r.organization_id,
  r.company_id,
  r.store_id,
  r.order_id,
  o.order_number,
  r.rma_number,
  r.state,
  r.resolution,
  r.source,
  r.reason_code,
  r.reason_label,
  r.customer_email,
  r.customer_note,
  r.decision_note,
  r.decided_at,
  r.decided_email,
  r.currency,
  r.refund_amount,
  r.created_at,
  r.received_at,
  r.inspected_at,
  r.completed_at,
  (select coalesce(sum(ri.quantity), 0)
     from public.return_items ri where ri.return_request_id = r.id) as unit_count,
  (select coalesce(sum(ri.received_quantity), 0)
     from public.return_items ri where ri.return_request_id = r.id) as received_count,
  (select count(*)
     from public.return_items ri
    where ri.return_request_id = r.id and ri.restock_movement_id is not null) as restocked_count,
  (select count(*)
     from public.return_evidence re where re.return_request_id = r.id) as evidence_count
from public.return_requests r
join public.orders o on o.id = r.order_id;

revoke all on public.return_overview from public, anon;
grant select on public.return_overview to authenticated, service_role;

comment on column public.integration_providers.kind is
  'Familia del conector. `logistics` agrupa a los operadores de transporte; `sandbox_carrier` es el simulador determinista del producto.';
comment on view public.fulfillment_overview is
  'Cola de preparacion: una entrega con su pedido, su almacen, su guia y sus conteos. security_invoker: las policies del dominio siguen mandando.';
comment on view public.return_overview is
  'Cola de devoluciones con sus conteos de unidades pedidas, recibidas y repuestas. security_invoker: las policies del dominio siguen mandando.';

-- ---------------------------------------------------------------------------
-- El comprador ve COMO llega su pedido.
--
-- `order_by_token` es la unica puerta del comprador anonimo a su pedido (P11
-- historico) y su guarda no cambia: tienda activa + numero + token, los tres, y
-- sin distinguir «no existe» de «token incorrecto» —los numeros de pedido son
-- correlativos y distinguirlos permitiria enumerarlos—.
--
-- Lo que gana es lo que la fase le debe: el transporte que pago y en que va su
-- entrega. Sin esto, un comercio con entregas a semanas recibe la misma llamada
-- de siempre —«¿donde esta mi pedido?»— con un dominio logistico entero detras
-- que el comprador no puede consultar.
--
-- ## Que NO sale por aqui, y es deliberado
--
-- Ni el almacen, ni el operador, ni el coste que factura el transportista, ni
-- las notas internas. Lo que el comprador necesita es el estado, la fecha
-- prometida, donde recoger y su guia; el resto es informacion del comercio.
-- ---------------------------------------------------------------------------
create or replace function public.order_by_token(
  p_store_slug   text,
  p_order_number text,
  p_token        text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order      public.orders%rowtype;
  v_items      jsonb;
  v_deliveries jsonb;
begin
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  select o.* into v_order
  from public.orders o
  join public.stores s       on s.id = o.store_id
  join public.order_tokens t on t.order_id = o.id
  where s.slug = lower(btrim(p_store_slug))
    and s.status = 'active'
    and o.order_number = btrim(p_order_number)
    and t.token = p_token;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'sku',        i.sku,
           'name',       i.name,
           'quantity',   i.quantity,
           'unit_price', i.unit_price::text,
           'discount',   i.discount_amount::text,
           -- Solo la ETIQUETA y el importe de cada campana: ni su id, ni su
           -- codigo interno, ni el cupon con el que otro comprador la activo.
           'discounts',  coalesce((
             select jsonb_agg(jsonb_build_object(
                      'label',  d ->> 'label',
                      'amount', d ->> 'amount'))
             from jsonb_array_elements(i.discount_snapshot) as d), '[]'::jsonb)
         ) order by i.name), '[]'::jsonb)
    into v_items
  from public.order_items i
  where i.order_id = v_order.id;

  -- Las entregas del pedido, en el vocabulario del COMPRADOR. Una lista y no un
  -- objeto porque un pedido puede salir en varias: enseñar solo la primera
  -- convertiria un despacho parcial en «tu pedido ya llego» cuando falta media
  -- caja.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sequence',       f.sequence,
           'method_name',    f.method_name,
           'strategy',       f.strategy,
           'state',          f.state,
           'promised_from',  f.promised_from,
           'promised_to',    f.promised_to,
           'window_date',    f.window_date,
           'window_starts_at', f.window_starts_at,
           'window_ends_at', f.window_ends_at,
           -- Donde ir a recogerlo, si es un recojo. El nombre y la direccion
           -- publica del punto, que es exactamente lo que ya se le enseño antes
           -- de comprar.
           'pickup_point',   case when f.pickup_point_id is null then null else
             (select jsonb_build_object('name', pp.name, 'address', pp.address)
                from public.pickup_points pp where pp.id = f.pickup_point_id) end,
           -- La guia y su enlace: lo unico del operador que el comprador
           -- necesita. Ni su codigo interno, ni lo que nos cobra.
           'tracking_number', (select s2.tracking_number from public.shipments s2
                                where s2.fulfillment_id = f.id
                                  and s2.tracking_number is not null
                                order by s2.created_at desc limit 1),
           'tracking_url',    (select s2.tracking_url from public.shipments s2
                                where s2.fulfillment_id = f.id
                                  and s2.tracking_url is not null
                                order by s2.created_at desc limit 1)
         ) order by f.sequence), '[]'::jsonb)
    into v_deliveries
  from public.fulfillments f
  where f.order_id = v_order.id and f.state <> 'cancelled';

  return jsonb_build_object(
    'order_number',       v_order.order_number,
    'status',             v_order.status,
    'payment_status',     v_order.payment_status,
    'fulfillment_status', v_order.fulfillment_status,
    'approval_status',    v_order.approval_status,
    'currency',           v_order.currency,
    'placed_at',          v_order.placed_at,
    'customer_name',      v_order.customer_name,
    'subtotal',           v_order.subtotal::text,
    'tax_total',          v_order.tax_total::text,
    'discount_total',     v_order.discount_total::text,
    -- P12: el transporte va SEPARADO. Un comprador que ve un total mayor que la
    -- suma de sus lineas y ninguna linea que lo explique llama por telefono.
    'shipping_total',     v_order.shipping_total::text,
    'grand_total',        v_order.grand_total::text,
    'shipping_address',   v_order.shipping_address,
    'items',              v_items,
    'deliveries',         v_deliveries
  );
end;
$fn$;

comment on function public.order_by_token(text, text, text) is
  'Unica puerta del comprador anonimo a su pedido. Exige tienda activa + numero + token; no distingue "no existe" de "token incorrecto". Desde P12 devuelve el transporte cobrado y sus entregas con estado, plazo, punto de recojo y guia; sigue sin devolver almacen, operador, coste del transportista ni notas internas.';
