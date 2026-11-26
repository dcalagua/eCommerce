-- =============================================================================
-- 2026-11-26 · Integración con el ERP: los hechos que faltaban
--
-- Encima del contrato de integración v1 (20261124120000 y 20261124190000/191000/
-- 192000), sin tocar sus funciones salvo donde se dice:
--
--  1. `order.created` para TODO pedido. Hasta hoy solo lo publicaba la vitrina:
--     un pedido por la API, por el hub o de una cotización convertida no
--     avisaba al ERP. Disparador diferido; si la vitrina ya lo publicó, no se
--     repite.
--  2. `order.updated` cuando se edita lo que no es estado: direcciones,
--     contacto, notas, OC, cuenta de empresa.
--  3. `shipment.created` / `shipment.updated`: la guía, el transportista y el
--     estado del envío. `data.order` (el pedido completo, con sus envíos) lo
--     adjunta `webhook_fanout` porque el hecho lleva `order_id`.
--  4. Sobre versionado: `schema_version` y `aggregate {type, id, version}`.
--     Se redefine `ebim.webhook_fanout` copiando LITERAL la versión de
--     20261124190000 y añadiendo solo esos dos campos.
--  5. POST /v1/orders/{number}/tracking (scope `order.update`, que ya existe):
--     el ERP añade eventos de seguimiento a un envío ya registrado, con la
--     misma ingesta que los transportistas integrados.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · `order.created` para todo pedido
--
-- Diferido al final de la transacción: el pedido ya tiene sus líneas y, si vino
-- de la vitrina, `checkout_place_order` ya publicó el suyo.
-- ---------------------------------------------------------------------------
create or replace function ebim.order_created_ensure_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
begin
  if exists (
    select 1 from public.domain_events d
    where d.aggregate_type = 'order'
      and d.aggregate_id   = new.id
      and d.event_type     = 'order.created'
  ) then
    return null;
  end if;

  select * into v_order from public.orders o where o.id = new.id;
  if not found then
    return null;
  end if;

  perform ebim.publish_event(
    v_order.organization_id, v_order.company_id, v_order.store_id,
    'order.created', 'order', v_order.id,
    jsonb_build_object(
      'order_id',        v_order.id,
      'order_number',    v_order.order_number,
      'status',          v_order.status,
      'source_channel',  v_order.source_channel,
      'approval_status', v_order.approval_status,
      'currency',        v_order.currency,
      'subtotal',        v_order.subtotal::text,
      'tax_total',       v_order.tax_total::text,
      'discount_total',  v_order.discount_total::text,
      'shipping_total',  v_order.shipping_total::text,
      'grand_total',     v_order.grand_total::text,
      'customer_email',  lower(btrim(coalesce(v_order.customer_email, ''))),
      'item_count',      (select count(*) from public.order_items i where i.order_id = v_order.id)),
    'order.created:order:' || v_order.id::text);
  return null;
end;
$fn$;

drop trigger if exists orders_created_event on public.orders;
create constraint trigger orders_created_event
  after insert on public.orders
  deferrable initially deferred
  for each row execute function ebim.order_created_ensure_event();

-- ---------------------------------------------------------------------------
-- 2 · `order.updated`
--
-- Los estados ya tienen sus hechos (`order.status_changed`, …). Lo que pasa en
-- la misma transacción que creó el pedido es parte de nacer, no una edición.
-- ---------------------------------------------------------------------------
create or replace function ebim.order_publish_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_changed text[] := array[]::text[];
begin
  if new.created_at >= now() then
    return null;
  end if;

  if new.shipping_address      is distinct from old.shipping_address      then v_changed := array_append(v_changed, 'shipping_address'); end if;
  if new.billing_address       is distinct from old.billing_address       then v_changed := array_append(v_changed, 'billing_address'); end if;
  if new.notes                 is distinct from old.notes                 then v_changed := array_append(v_changed, 'notes'); end if;
  if new.customer_email        is distinct from old.customer_email        then v_changed := array_append(v_changed, 'customer_email'); end if;
  if new.customer_name         is distinct from old.customer_name         then v_changed := array_append(v_changed, 'customer_name'); end if;
  if new.customer_phone        is distinct from old.customer_phone        then v_changed := array_append(v_changed, 'customer_phone'); end if;
  if new.purchase_order_number is distinct from old.purchase_order_number then v_changed := array_append(v_changed, 'purchase_order_number'); end if;
  if new.business_account_id   is distinct from old.business_account_id   then v_changed := array_append(v_changed, 'business_account'); end if;

  if cardinality(v_changed) = 0 then
    return null;
  end if;

  perform ebim.publish_event(
    new.organization_id, new.company_id, new.store_id,
    'order.updated', 'order', new.id,
    jsonb_build_object(
      'order_id',     new.id,
      'order_number', new.order_number,
      'changed',      to_jsonb(v_changed)),
    'order.updated:' || new.id::text || ':' || gen_random_uuid()::text);
  return null;
end;
$fn$;

drop trigger if exists orders_publish_updated on public.orders;
create trigger orders_publish_updated
  after update of shipping_address, billing_address, notes, customer_email, customer_name,
                  customer_phone, purchase_order_number, business_account_id
  on public.orders
  for each row execute function ebim.order_publish_updated();

-- ---------------------------------------------------------------------------
-- 3 · `shipment.created` / `shipment.updated`
--
-- Un despacho es UN aviso: lo que cambia en la misma transacción que creó el
-- envío ya va en `shipment.created`, que sale al final de esa transacción.
-- `carrier` es el transportista integrado o, si no lo es, el servicio que
-- nombró el ERP (así guarda `api_order_update` uno no integrado).
-- ---------------------------------------------------------------------------
create or replace function ebim.shipment_publish_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order_id uuid;
  v_number   text;
  v_changed  text[] := array[]::text[];
begin
  if new.created_at >= now() then
    return null;
  end if;

  if new.state              is distinct from old.state              then v_changed := array_append(v_changed, 'state'); end if;
  if new.tracking_number    is distinct from old.tracking_number    then v_changed := array_append(v_changed, 'tracking_number'); end if;
  if new.tracking_url       is distinct from old.tracking_url       then v_changed := array_append(v_changed, 'tracking_url'); end if;
  if new.provider_code      is distinct from old.provider_code      then v_changed := array_append(v_changed, 'carrier'); end if;
  if new.service_code       is distinct from old.service_code       then v_changed := array_append(v_changed, 'service'); end if;
  if new.estimated_delivery is distinct from old.estimated_delivery then v_changed := array_append(v_changed, 'estimated_delivery'); end if;
  if new.cost               is distinct from old.cost               then v_changed := array_append(v_changed, 'cost'); end if;

  if cardinality(v_changed) = 0 then
    return null;
  end if;

  select f.order_id, o.order_number into v_order_id, v_number
  from public.fulfillments f join public.orders o on o.id = f.order_id
  where f.id = new.fulfillment_id;

  perform ebim.publish_event(
    new.organization_id, new.company_id, new.store_id,
    'shipment.updated', 'shipment', new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id',     new.id,
      'fulfillment_id',  new.fulfillment_id,
      'order_id',        v_order_id,
      'order_number',    v_number,
      'changed',         to_jsonb(v_changed),
      'from',            case when 'state' = any (v_changed) then old.state::text end,
      'to',              case when 'state' = any (v_changed) then new.state::text end,
      'state',           new.state,
      'carrier',         coalesce(new.provider_code, new.service_code),
      'tracking_number', new.tracking_number)),
    'shipment.updated:' || new.id::text || ':' || gen_random_uuid()::text);
  return null;
end;
$fn$;

drop trigger if exists shipments_publish_change on public.shipments;
create trigger shipments_publish_change
  after update of state, tracking_number, tracking_url, provider_code, service_code,
                  estimated_delivery, cost
  on public.shipments
  for each row execute function ebim.shipment_publish_change();

create or replace function ebim.shipment_publish_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ship     public.shipments%rowtype;
  v_order_id uuid;
  v_number   text;
begin
  select * into v_ship from public.shipments s where s.id = new.id;
  if not found then
    return null;
  end if;
  select f.order_id, o.order_number into v_order_id, v_number
  from public.fulfillments f join public.orders o on o.id = f.order_id
  where f.id = v_ship.fulfillment_id;

  perform ebim.publish_event(
    v_ship.organization_id, v_ship.company_id, v_ship.store_id,
    'shipment.created', 'shipment', v_ship.id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id',     v_ship.id,
      'fulfillment_id',  v_ship.fulfillment_id,
      'order_id',        v_order_id,
      'order_number',    v_number,
      'state',           v_ship.state,
      'carrier',         coalesce(v_ship.provider_code, v_ship.service_code),
      'tracking_number', v_ship.tracking_number)),
    'shipment.created:' || v_ship.id::text);
  return null;
end;
$fn$;

drop trigger if exists shipments_publish_created on public.shipments;
create constraint trigger shipments_publish_created
  after insert on public.shipments
  deferrable initially deferred
  for each row execute function ebim.shipment_publish_created();

-- ---------------------------------------------------------------------------
-- 4 · Sobre versionado
--
-- Cuerpo LITERAL de 20261124190000; lo único nuevo es `schema_version` y
-- `aggregate`. `version` cuenta los hechos del mismo agregado: el receptor
-- descarta un mensaje que llega después de otro más nuevo.
-- ---------------------------------------------------------------------------
create or replace function ebim.webhook_fanout(
  p_organization_id uuid,
  p_company_id      uuid,
  p_event_id        uuid,
  p_event_type      text,
  p_payload         jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_endpoint  record;
  v_delivery  uuid;
  v_outbox    uuid;
  v_count     integer := 0;
  v_body      jsonb;
  v_order_id  uuid;
  v_agg_type  text;
  v_agg_id    uuid;
  v_version   integer;
begin
  if not exists (
    select 1 from public.tenant_integrations ti
    where ti.organization_id = p_organization_id
      and ti.company_id      = p_company_id
      and ti.provider_code   = 'webhook'
      and ti.is_active
  ) then
    return 0;
  end if;

  v_body := coalesce(p_payload, '{}'::jsonb);

  -- 2026-11-24 · El pedido COMPLETO (mismo objeto que GET /v1/orders/{number})
  -- en `data.order`: el ERP factura y despacha con el evento, sin volver a
  -- llamar. Solo si es un pedido de ESTA sociedad.
  v_order_id := ebim.safe_uuid(v_body ->> 'order_id');
  if v_order_id is not null and exists (
    select 1 from public.orders o
    where o.id = v_order_id
      and o.organization_id = p_organization_id
      and o.company_id      = p_company_id
  ) then
    v_body := v_body || jsonb_build_object('order', ebim.api_order_json(v_order_id, true));
  end if;

  -- Redacción de datos de TARJETA (P09) antes de salir del sistema.
  v_body := ebim.redact_sensitive(v_body);

  -- 2026-11-26 · De qué agregado es el hecho y en qué versión va.
  select d.aggregate_type, d.aggregate_id into v_agg_type, v_agg_id
  from public.domain_events d where d.id = p_event_id;
  if v_agg_id is not null then
    select count(*)::integer into v_version
    from public.domain_events d
    where d.aggregate_type = v_agg_type and d.aggregate_id = v_agg_id;
  end if;

  for v_endpoint in
    select distinct e.id, e.max_attempts
    from public.webhook_endpoints e
    join public.webhook_subscriptions s
      on s.endpoint_id = e.id and s.is_active
    where e.organization_id = p_organization_id
      and e.company_id      = p_company_id
      and e.is_active
      and ebim.webhook_matches(s.event_type, p_event_type)
  loop
    begin
      insert into public.webhook_deliveries
        (organization_id, company_id, endpoint_id, event_id, event_type)
      values (p_organization_id, p_company_id, v_endpoint.id, p_event_id, p_event_type)
      on conflict do nothing
      returning id into v_delivery;

      if v_delivery is null then
        continue;
      end if;

      v_outbox := public.integration_enqueue(
        p_organization_id,
        p_company_id,
        'webhook',
        'event.publish',
        jsonb_build_object(
          'event_id',       p_event_id,
          'event_type',     p_event_type,
          'delivery_id',    v_delivery,
          'occurred_at',    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'schema_version', 2,
          'aggregate',      jsonb_build_object(
                              'type', v_agg_type, 'id', v_agg_id, 'version', v_version),
          'data',           v_body),
        'wh:' || v_delivery::text,
        v_endpoint.id::text);

      update public.webhook_deliveries set outbox_id = v_outbox where id = v_delivery;
      update public.integration_outbox
         set max_attempts = v_endpoint.max_attempts
       where id = v_outbox;

      v_count := v_count + 1;
    exception when others then
      perform ebim.record_ops_event(
        p_organization_id, p_company_id,
        'integration_failed', 'WEBHOOK_NO_ENCOLADO',
        'wh-enqueue:' || v_endpoint.id::text || ':' || p_event_id::text,
        'error',
        'No se pudo encolar la entrega del evento ' || p_event_type,
        'db', 'event.publish', null, 'webhook_endpoint', v_endpoint.id);
    end;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5 · POST /v1/orders/{number}/tracking
--
-- El envío se identifica por su guía dentro del pedido (lo que el ERP conoce),
-- no por un uuid interno. Los eventos pasan por `shipment_track_ingest`: la
-- misma ingesta, idempotencia y avance de estado que un transportista
-- integrado. Reintentar con el mismo `id` de evento no duplica nada.
-- ---------------------------------------------------------------------------
create or replace function public.api_order_tracking_add(
  p_api_client_id uuid,
  p_number        text,
  p_store         text  default null,
  p_payload       jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_client  public.api_clients%rowtype;
  v_store   public.stores%rowtype;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_order   public.orders%rowtype;
  v_ship_id uuid;
  v_track   text;
  v_events  jsonb := '[]'::jsonb;
  v_event   jsonb;
  v_result  jsonb;
begin
  v_client := ebim.api_authorize(p_api_client_id, 'order.update');

  if jsonb_typeof(v_payload) <> 'object' or exists (
    select 1 from jsonb_object_keys(v_payload) k where k not in ('tracking_number', 'events')) then
    raise exception 'CAMPO_NO_PERMITIDO: el cuerpo es { tracking_number, events[] }'
      using errcode = '22023';
  end if;

  v_track := nullif(btrim(coalesce(v_payload ->> 'tracking_number', '')), '');
  if v_track is null then
    raise exception 'GUIA_REQUERIDA: tracking_number' using errcode = '22023';
  end if;

  if jsonb_typeof(v_payload -> 'events') is distinct from 'array'
     or jsonb_array_length(v_payload -> 'events') = 0 then
    raise exception 'EVENTOS_REQUERIDOS: manda al menos un evento en "events"' using errcode = '22023';
  end if;
  if jsonb_array_length(v_payload -> 'events') > 50 then
    raise exception 'ITEMS_EXCESIVOS: como maximo 50 eventos por llamada' using errcode = '22023';
  end if;

  v_store := ebim.api_store(v_client.organization_id, v_client.company_id, p_store);
  select * into v_order from public.orders o
   where o.organization_id = v_client.organization_id and o.company_id = v_client.company_id
     and o.store_id = v_store.id and o.order_number = btrim(coalesce(p_number, ''));
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese numero' using errcode = '22023';
  end if;

  select s.id into v_ship_id
  from public.shipments s
  join public.fulfillments f on f.id = s.fulfillment_id
  where f.order_id = v_order.id
    and s.tracking_number = v_track
  order by s.created_at desc
  limit 1;
  if v_ship_id is null then
    raise exception 'ENVIO_NO_ENCONTRADO: el pedido no tiene un envio con esa guia (registralo con POST /v1/orders/{number}/status)'
      using errcode = '22023';
  end if;

  for v_event in select value from jsonb_array_elements(v_payload -> 'events') loop
    if jsonb_typeof(v_event) <> 'object' or exists (
      select 1 from jsonb_object_keys(v_event) k
      where k not in ('id', 'status', 'carrier_status', 'occurred_at', 'description', 'location')) then
      raise exception 'CAMPO_NO_PERMITIDO: cada evento es { status, id?, occurred_at?, carrier_status?, description?, location? }'
        using errcode = '22023';
    end if;
    v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'external_event_id', 'api:' || coalesce(
                              nullif(btrim(coalesce(v_event ->> 'id', '')), ''),
                              md5(coalesce(v_event ->> 'status', '') || '|' ||
                                  coalesce(v_event ->> 'occurred_at', ''))),
      'status',          v_event ->> 'status',
      'provider_status', v_event ->> 'carrier_status',
      'occurred_at',     v_event ->> 'occurred_at',
      'description',     v_event ->> 'description',
      'location',        v_event ->> 'location')));
  end loop;

  begin
    v_result := public.shipment_track_ingest(v_ship_id, v_events, 'system', true);
  exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    raise exception 'EVENTO_INVALIDO: revisa occurred_at (ISO 8601)' using errcode = '22023';
  end;

  return ebim.api_order_json(v_order.id, true)
         || jsonb_build_object('tracking', v_result);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.order_created_ensure_event(),
  ebim.order_publish_updated(),
  ebim.shipment_publish_change(),
  ebim.shipment_publish_created()
from public, anon, authenticated;

revoke execute on function public.api_order_tracking_add(uuid, text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.api_order_tracking_add(uuid, text, text, jsonb) to service_role;
