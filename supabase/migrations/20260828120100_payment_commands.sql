-- =============================================================================
-- P09-SaaS · 2/3 — Los COMANDOS del dinero: cobrar es una orden, no un UPDATE
--
-- ## Por que ninguna de estas tablas tiene GRANT de escritura
--
-- La migracion 120000 dio a `authenticated` un `select` sobre todo el dominio y
-- escritura sobre NADA salvo `payment_methods`, que es configuracion. Aqui esta
-- la razon: mover dinero exige cuatro cosas a la vez y las cuatro tienen que
-- pasar o ninguna.
--
--   autorizacion  +  idempotencia  +  aritmetica  +  bitacora
--
-- Un `UPDATE payment_intents SET status = 'captured'` hace la tercera a medias y
-- se salta las otras tres. Es la misma decision que P08 tomo con los ejes del
-- pedido, y por eso estos comandos tienen la misma forma que `order_transition`.
--
-- ## Las tres reglas de la fase que se vuelven imposibles de romper AQUI
--
--  · **Regla 6 — el navegador no decide.** `payment_apply_outcome` con
--    `p_source = 'browser_return'` REGISTRA la vuelta del comprador y se niega a
--    mover el estado. No es una convencion: es un `raise`. La redireccion es una
--    pista de que algo paso, nunca la prueba de que se cobro.
--  · **Regla 4 — un webhook sin firma verificada no mueve dinero.** Mismo sitio,
--    mismo `raise`. El adaptador verifica la firma con el secreto del vault
--    ANTES de llamar; si no la verifico, la base no le deja escribir.
--  · **Regla 5 — un callback repetido no duplica nada.** Tres cerrojos
--    independientes, y basta con que aguante uno:
--      1. `payment_events (provider_code, external_event_id)` — el evento del
--         proveedor ya se vio: se devuelve `replay` y no se toca nada.
--      2. `payment_attempts (payment_intent_id, operation, idempotency_key)` —
--         la misma llamada con la misma clave es UNA fila.
--      3. `payments (provider_code, provider_reference)` — un cobro por
--         referencia del proveedor, lo pida quien lo pida.
--
-- ## Quien llama a que
--
--   servidor (`service_role`)   intent_open · attach_order · apply_outcome ·
--                               refund_settle
--   backoffice (`authenticated`) refund_request · reconciliation_import ·
--                               reconciliation_match
--   navegador                    nada. Ni una sola de estas funciones.
--
-- El tenant NUNCA viaja en la firma: sale de la fila (intento, cobro) o del JWT
-- (conciliacion). No hay forma de pedir un cobro sobre un tenant ajeno.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0 · Autorizacion del operador de pagos
--
-- Una sola funcion, misma razon que `ebim.assert_order_operator`: el dia que
-- una se relaje, se relajan todas o ninguna. Rol de pagos = rol de pedidos:
-- quien puede mover el estado de un pedido es quien responde por su cobro, y
-- inventar un `payments` en `app_role` obligaria a migrar las membresias vivas.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_payment_operator(
  p_organization_id uuid,
  p_company_id      uuid
)
returns void
language plpgsql
stable
set search_path = ''
as $fn$
begin
  -- Regla de suite: el super admin no es actor de negocio de un tenant. Aqui y
  -- no solo en el borde, porque un guard que vive en la Edge Function se salta
  -- llamando a la funcion por PostgREST.
  if ebim.is_suite_super_admin() then
    raise exception 'OPERADOR_NO_ES_ACTOR: el super admin de suite no mueve dinero de un tenant'
      using errcode = '42501';
  end if;

  if not ebim.has_role(
       p_organization_id, p_company_id,
       array['owner','admin','orders']::public.app_role[])
  then
    raise exception 'SIN_PERMISO: hace falta rol de pedidos sobre este tenant'
      using errcode = '42501';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1 · ebim.payment_sync_order — el pedido se entera, pero no depende
--
-- El eje `payment_status` del pedido es un ESPEJO de lo que paso en el dominio
-- de pagos, escrito desde aqui. La direccion importa: pagos conoce al pedido,
-- el pedido no conoce a pagos. Por eso esta funcion vive en `ebim` y no hay ni
-- una columna nueva en `orders`.
--
-- **No propaga la excepcion.** Si el eje del pedido no admite la transicion
-- —el caso real: un pedido B2B pendiente de aprobacion, cuyo trigger de P08
-- congela los ejes a proposito— el dinero YA se movio y ya esta escrito. Hacer
-- fallar la transaccion aqui borraria el registro del cobro para salvar la
-- coherencia de una etiqueta, que es exactamente el intercambio equivocado. Se
-- devuelve `false` y el comando lo publica en su bitacora, que es donde alguien
-- puede verlo.
-- ---------------------------------------------------------------------------
create or replace function ebim.payment_sync_order(
  p_order_id uuid,
  p_target   public.payment_status,
  p_reason   text
)
returns boolean
language plpgsql
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null then
    return false;
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return false;
  end if;
  if v_order.payment_status = p_target then
    return true;
  end if;

  -- La linea de tiempo del pedido la escribe su propio trigger; lo unico que
  -- hace falta es decirle de donde viene el cambio. `system` y no `backoffice`:
  -- esto lo mueve una pasarela o un proceso, nunca una persona con sesion.
  perform set_config('ebim.order_event_reason', coalesce(p_reason, ''), true);
  perform set_config('ebim.order_event_source', 'system', true);

  begin
    update public.orders set payment_status = p_target where id = v_order.id;
  exception
    when others then
      return false;
  end;

  return true;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2 · public.payment_intent_open — la intencion de cobrar
--
-- Nace SIN pedido: el checkout autoriza en la etapa 8 y crea el pedido en la 9
-- (P07). `p_idempotency_key` es la MISMA que ancla el intento de checkout, asi
-- que un reintento del navegador cae sobre el intento que ya existe y devuelve
-- `replay = true` en vez de abrir un segundo cobro.
--
-- El tenant sale de la TIENDA resuelta por slug, no de la firma.
-- ---------------------------------------------------------------------------
create or replace function public.payment_intent_open(
  p_store_slug      text,
  p_method_code     text,
  p_amount          numeric,
  p_currency        text,
  p_idempotency_key text,
  p_order_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store    public.stores%rowtype;
  v_method   public.payment_methods%rowtype;
  v_intent   public.payment_intents%rowtype;
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_replay   boolean := false;
begin
  select * into v_store from public.stores s where s.slug = p_store_slug;
  if not found then
    raise exception 'TIENDA_NO_ENCONTRADA: no hay ninguna tienda con ese identificador'
      using errcode = '22023';
  end if;
  if v_store.status <> 'active' then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda no esta activa'
      using errcode = '22023';
  end if;

  select * into v_method
  from public.payment_methods m
  where m.store_id = v_store.id and m.code = lower(btrim(coalesce(p_method_code, '')));
  if not found then
    raise exception 'MEDIO_DE_PAGO_NO_ENCONTRADO: "%" no es un medio de esta tienda', p_method_code
      using errcode = '22023';
  end if;
  if not v_method.is_active then
    raise exception 'MEDIO_DE_PAGO_INACTIVO: "%" no esta habilitado', p_method_code
      using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'IMPORTE_NO_VALIDO: el importe de un cobro es mayor que cero'
      using errcode = '22023';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'MONEDA_NO_VALIDA: "%" no es un codigo ISO de tres letras', p_currency
      using errcode = '22023';
  end if;

  insert into public.payment_intents (
    organization_id, company_id, store_id, order_id, payment_method_id,
    provider_code, currency, amount, capture_mode, idempotency_key
  ) values (
    v_store.organization_id, v_store.company_id, v_store.id, p_order_id, v_method.id,
    v_method.provider_code, v_currency, round(p_amount, 2), v_method.capture_mode,
    p_idempotency_key
  )
  on conflict (store_id, idempotency_key) do nothing
  returning * into v_intent;

  if v_intent.id is null then
    v_replay := true;
    select * into v_intent
    from public.payment_intents i
    where i.store_id = v_store.id and i.idempotency_key = p_idempotency_key;

    -- Misma clave, otro importe, es un error del llamante y no una repeticion.
    -- Devolver el intento viejo callando cobraria la cifra equivocada.
    if v_intent.amount <> round(p_amount, 2) or v_intent.currency <> v_currency then
      raise exception 'IDEMPOTENCIA_INCOHERENTE: la clave "%" ya ancla un cobro de % %',
        p_idempotency_key, v_intent.amount, v_intent.currency
        using errcode = '23505';
    end if;
  else
    insert into public.payment_events (
      organization_id, company_id, store_id, payment_intent_id,
      event_type, source, provider_code, payload
    ) values (
      v_intent.organization_id, v_intent.company_id, v_intent.store_id, v_intent.id,
      'payment.intent_opened', 'system', v_intent.provider_code,
      jsonb_build_object(
        'amount', v_intent.amount::text,
        'currency', v_intent.currency,
        'capture_mode', v_intent.capture_mode,
        'method_code', v_method.code)
    );
  end if;

  return jsonb_build_object(
    'intent_id',    v_intent.id,
    'status',       v_intent.status,
    'amount',       v_intent.amount::text,
    'currency',     v_intent.currency,
    'capture_mode', v_intent.capture_mode,
    'provider_code', v_intent.provider_code,
    'method_code',  v_method.code,
    'order_id',     v_intent.order_id,
    'replay',       v_replay);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3 · public.payment_intent_attach_order — atar el cobro al pedido, despues
--
-- Existe porque el orden real es cobrar y luego crear el pedido. Un intento ya
-- atado a OTRO pedido no se re-ata: eso seria mover un cobro de sitio.
-- ---------------------------------------------------------------------------
create or replace function public.payment_intent_attach_order(
  p_intent_id uuid,
  p_order_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_intent public.payment_intents%rowtype;
  v_order  public.orders%rowtype;
begin
  select * into v_intent from public.payment_intents i where i.id = p_intent_id for update;
  if not found then
    raise exception 'INTENTO_NO_ENCONTRADO: no hay ningun intento de pago con ese identificador'
      using errcode = '22023';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con ese identificador'
      using errcode = '22023';
  end if;
  if v_order.store_id <> v_intent.store_id then
    raise exception 'PEDIDO_DE_OTRA_TIENDA: el pedido no es de la tienda del cobro'
      using errcode = '42501';
  end if;

  if v_intent.order_id is not null and v_intent.order_id <> p_order_id then
    raise exception 'INTENTO_YA_ATADO: este cobro ya pertenece a otro pedido'
      using errcode = '23505';
  end if;

  if v_intent.order_id is null then
    update public.payment_intents set order_id = p_order_id where id = v_intent.id;

    update public.payments set order_id = p_order_id
     where payment_intent_id = v_intent.id and order_id is null;
    update public.refunds r set order_id = p_order_id
     where r.order_id is null
       and exists (select 1 from public.payments p
                    where p.id = r.payment_id and p.payment_intent_id = v_intent.id);

    insert into public.payment_events (
      organization_id, company_id, store_id, payment_intent_id,
      event_type, source, provider_code, payload
    ) values (
      v_intent.organization_id, v_intent.company_id, v_intent.store_id, v_intent.id,
      'payment.order_attached', 'system', v_intent.provider_code,
      jsonb_build_object('order_id', p_order_id, 'order_number', v_order.order_number)
    );

    -- El pedido nace `pending`; si el cobro ya estaba autorizado o capturado
    -- cuando se ato, el eje del pedido se pone al dia ahora.
    if v_intent.status = 'authorized' then
      perform ebim.payment_sync_order(p_order_id, 'authorized'::public.payment_status,
        'cobro autorizado antes de crear el pedido');
    elsif v_intent.status = 'captured' then
      perform ebim.payment_sync_order(p_order_id, 'paid'::public.payment_status,
        'cobro capturado antes de crear el pedido');
    end if;
  end if;

  return jsonb_build_object(
    'intent_id', v_intent.id,
    'order_id',  p_order_id,
    'status',    v_intent.status);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4 · public.payment_apply_outcome — el comando central
--
-- Un solo sitio donde el resultado de una llamada al proveedor entra al
-- sistema, venga de la respuesta sincrona, de un webhook o de una persona. Que
-- sea uno solo es la propiedad: si hubiera dos, uno de los dos acabaria sin
-- alguna de las tres reglas de arriba.
--
-- Hace, en esta transaccion y en este orden:
--   1. comprueba de donde viene y si puede decidir       (reglas 4 y 6)
--   2. descarta el evento ya visto                        (regla 5, cerrojo 1)
--   3. escribe el intento de llamada, o descarta          (regla 5, cerrojo 2)
--   4. mueve el intento por su maquina de estados
--   5. si capturo, escribe el COBRO                       (regla 5, cerrojo 3)
--   6. pone al dia el eje del pedido, sin depender de el
--   7. deja el hecho en la bitacora del dominio y en `domain_events`
-- ---------------------------------------------------------------------------
create or replace function public.payment_apply_outcome(
  p_intent_id            uuid,
  p_operation            text,
  p_idempotency_key      text,
  p_attempt_status       text,
  p_intent_status        text    default null,
  p_amount               numeric default null,
  p_provider_reference   text    default null,
  p_provider_result_code text    default null,
  p_error_code           text    default null,
  p_error_detail         text    default null,
  p_latency_ms           integer default null,
  p_source               text    default 'provider_response',
  p_external_event_id    text    default null,
  p_signature_verified   boolean default false,
  p_payload              jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_intent   public.payment_intents%rowtype;
  v_after    public.payment_intents%rowtype;
  v_payment  public.payments%rowtype;
  v_attempt  uuid;
  v_source   public.payment_event_source;
  v_from     text;
  v_to       text := nullif(lower(btrim(coalesce(p_intent_status, ''))), '');
  v_amount   numeric;
  v_synced   boolean := false;
  v_target   public.payment_status;
begin
  -- ---- 1 · De donde viene esto, y si puede decidir -----------------------
  if not exists (
    select 1 from unnest(enum_range(null::public.payment_event_source)::text[]) as label
    where label = lower(btrim(coalesce(p_source, '')))
  ) then
    raise exception 'ORIGEN_NO_VALIDO: "%" no es un origen de hecho de pago', p_source
      using errcode = '22023';
  end if;
  v_source := lower(btrim(p_source))::public.payment_event_source;

  -- Regla 6. La vuelta del comprador se REGISTRA y no decide nada. Quien tiene
  -- que confirmar el cobro es el proveedor, por su canal y con su firma.
  if v_source = 'browser_return' and (v_to is not null or p_amount is not null) then
    raise exception 'RETORNO_NO_DECIDE: la vuelta del navegador no cambia el estado de un cobro'
      using errcode = '42501';
  end if;

  -- Regla 4. Sin firma verificada, un webhook no mueve dinero.
  if v_source = 'provider_webhook' and not coalesce(p_signature_verified, false) then
    raise exception 'FIRMA_NO_VERIFICADA: un aviso de pasarela sin firma valida no mueve dinero'
      using errcode = '42501';
  end if;

  select * into v_intent from public.payment_intents i where i.id = p_intent_id for update;
  if not found then
    raise exception 'INTENTO_NO_ENCONTRADO: no hay ningun intento de pago con ese identificador'
      using errcode = '22023';
  end if;
  v_from := v_intent.status::text;

  -- ---- 2 · Regla 5, cerrojo 1: este evento del proveedor ya se vio -------
  if p_external_event_id is not null and exists (
    select 1 from public.payment_events e
    where e.provider_code = coalesce(v_intent.provider_code, '')
      and e.external_event_id = p_external_event_id
  ) then
    return jsonb_build_object(
      'intent_id', v_intent.id, 'status', v_from, 'from', v_from, 'to', v_from,
      'replay', true, 'reason', 'evento_ya_procesado');
  end if;

  -- ---- 3 · Regla 5, cerrojo 2: esta llamada ya se registro ---------------
  insert into public.payment_attempts (
    organization_id, company_id, store_id, payment_intent_id, attempt_no,
    operation, status, provider_code, provider_reference, provider_result_code,
    error_code, error_detail, latency_ms, idempotency_key
  )
  select
    v_intent.organization_id, v_intent.company_id, v_intent.store_id, v_intent.id,
    coalesce((select max(a.attempt_no) from public.payment_attempts a
               where a.payment_intent_id = v_intent.id), 0) + 1,
    p_operation, p_attempt_status::public.payment_attempt_status, v_intent.provider_code,
    p_provider_reference, p_provider_result_code, p_error_code,
    left(p_error_detail, 2000), p_latency_ms, p_idempotency_key
  on conflict (payment_intent_id, operation, idempotency_key) do nothing
  returning id into v_attempt;

  if v_attempt is null then
    return jsonb_build_object(
      'intent_id', v_intent.id, 'status', v_from, 'from', v_from, 'to', v_from,
      'replay', true, 'reason', 'llamada_ya_registrada');
  end if;

  -- ---- 4 · La maquina de estados del intento -----------------------------
  if v_to is not null and v_to <> v_from then
    if not exists (
      select 1 from unnest(enum_range(null::public.payment_intent_status)::text[]) as label
      where label = v_to
    ) then
      raise exception 'ESTADO_NO_VALIDO: "%" no es un estado de un intento de pago', p_intent_status
        using errcode = '22023';
    end if;

    update public.payment_intents i set
      status             = v_to::public.payment_intent_status,
      provider_reference = coalesce(p_provider_reference, i.provider_reference),
      last_error_code    = case when v_to in ('failed','cancelled','expired')
                                then p_error_code else null end,
      last_error_detail  = case when v_to in ('failed','cancelled','expired')
                                then left(p_error_detail, 2000) else null end
    where i.id = v_intent.id;

  elsif p_provider_reference is not null and v_intent.provider_reference is null then
    update public.payment_intents i set provider_reference = p_provider_reference
     where i.id = v_intent.id;
  end if;

  select * into v_after from public.payment_intents i where i.id = v_intent.id;

  -- ---- 5 · El dinero ------------------------------------------------------
  if v_after.status = 'authorized' and v_from <> 'authorized' then
    v_amount := round(coalesce(p_amount, v_after.amount), 2);
    update public.payment_intents set amount_authorized = v_amount where id = v_after.id;
  end if;

  if v_after.status = 'captured' and v_from <> 'captured' then
    v_amount := round(coalesce(p_amount, v_after.amount - v_after.amount_captured), 2);
    if v_amount <= 0 then
      raise exception 'IMPORTE_NO_VALIDO: no queda nada por capturar en este cobro'
        using errcode = '22023';
    end if;

    -- Regla 5, cerrojo 3. `on conflict` sobre el indice parcial por referencia
    -- del proveedor: dos avisos distintos que citan el MISMO cobro no crean dos.
    insert into public.payments (
      organization_id, company_id, store_id, payment_intent_id, order_id,
      amount, currency, provider_code, provider_reference
    ) values (
      v_after.organization_id, v_after.company_id, v_after.store_id, v_after.id,
      v_after.order_id, v_amount, v_after.currency, v_after.provider_code,
      coalesce(p_provider_reference, v_after.provider_reference)
    )
    on conflict (provider_code, provider_reference) where provider_reference is not null
      do nothing
    returning * into v_payment;

    if v_payment.id is not null then
      update public.payment_intents set
        amount_captured   = amount_captured + v_amount,
        amount_authorized = greatest(amount_authorized, v_amount)
      where id = v_after.id;
    end if;
    select * into v_after from public.payment_intents i where i.id = v_intent.id;
  end if;

  -- ---- 6 · El eje del pedido, que es un espejo y no una dependencia ------
  if v_after.order_id is not null and v_after.status::text <> v_from then
    v_target := case v_after.status
      when 'authorized' then 'authorized'::public.payment_status
      when 'captured'   then 'paid'::public.payment_status
      when 'failed'     then 'failed'::public.payment_status
      when 'cancelled'  then 'voided'::public.payment_status
      when 'expired'    then 'voided'::public.payment_status
      else null
    end;
    if v_target is not null then
      v_synced := ebim.payment_sync_order(
        v_after.order_id, v_target,
        'pago: ' || v_from || ' -> ' || v_after.status::text);
    end if;
  end if;

  -- ---- 7 · La bitacora ----------------------------------------------------
  insert into public.payment_events (
    organization_id, company_id, store_id, payment_intent_id, payment_id,
    event_type, source, provider_code, external_event_id, signature_verified,
    payload, note
  ) values (
    v_after.organization_id, v_after.company_id, v_after.store_id, v_after.id,
    v_payment.id,
    'payment.' || coalesce(nullif(v_after.status::text, v_from), p_attempt_status),
    v_source, v_after.provider_code, p_external_event_id,
    coalesce(p_signature_verified, false),
    -- El sobre del proveedor no lo controlamos: se guarda REDACTADO en vez de
    -- rechazarlo, porque perder el evento es peor que guardarlo sin lo sensible.
    ebim.redact_sensitive(coalesce(p_payload, '{}'::jsonb)) ||
      jsonb_strip_nulls(jsonb_build_object(
        'operation', p_operation,
        'attempt_status', p_attempt_status,
        'from', v_from,
        'to', v_after.status,
        'amount', case when v_amount is null then null else v_amount::text end,
        'result_code', p_provider_result_code,
        'error_code', p_error_code)),
    case when v_after.order_id is not null and not v_synced and v_after.status::text <> v_from
         then 'el eje de pago del pedido no acepto la transicion; el cobro si quedo escrito'
    end
  );

  if v_after.status::text <> v_from then
    perform ebim.publish_event(
      v_after.organization_id, v_after.company_id, v_after.store_id,
      'payment.' || v_after.status::text, 'payment_intent', v_after.id,
      jsonb_strip_nulls(jsonb_build_object(
        'intent_id',   v_after.id,
        'order_id',    v_after.order_id,
        'payment_id',  v_payment.id,
        'from',        v_from,
        'to',          v_after.status,
        'amount',      v_after.amount::text,
        'captured',    v_after.amount_captured::text,
        'currency',    v_after.currency,
        'provider_code', v_after.provider_code,
        'provider_reference', v_after.provider_reference)),
      'payment.outcome:' || v_after.id::text || ':' || v_from || ':' || v_after.status::text);
  end if;

  return jsonb_build_object(
    'intent_id',   v_after.id,
    'attempt_id',  v_attempt,
    'payment_id',  v_payment.id,
    'from',        v_from,
    'to',          v_after.status,
    'status',      v_after.status,
    'amount',      v_after.amount::text,
    'captured',    v_after.amount_captured::text,
    'refunded',    v_after.amount_refunded::text,
    'order_id',    v_after.order_id,
    'order_synced', v_synced,
    'replay',      false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5 · public.payment_refund_request — devolver es un acto autorizado
--
-- La UNICA funcion de este archivo que llama una persona con sesion, y por eso
-- la unica con guarda de rol. Queda escrito QUIEN la pidio: una devolucion es
-- dinero saliendo, y «refund autorizado y trazabilidad» es criterio de la fase.
--
-- No mueve dinero: deja la peticion y, si hay pasarela, la encola en el outbox
-- que ya existe (P12 historico). Quien devuelve de verdad es el adaptador, y su
-- resultado entra por `payment_refund_settle`. Un comercio sin pasarela deja la
-- peticion viva y la liquida a mano, que es lo que pasa con una transferencia.
-- ---------------------------------------------------------------------------
create or replace function public.payment_refund_request(
  p_payment_id      uuid,
  p_amount          numeric,
  p_idempotency_key text,
  p_reason          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_payment public.payments%rowtype;
  v_refund  public.refunds%rowtype;
  v_amount  numeric;
  v_replay  boolean := false;
begin
  select * into v_payment from public.payments p where p.id = p_payment_id for update;
  if not found then
    raise exception 'COBRO_NO_ENCONTRADO: no hay ningun cobro con ese identificador'
      using errcode = '22023';
  end if;

  perform ebim.assert_payment_operator(v_payment.organization_id, v_payment.company_id);

  v_amount := round(coalesce(p_amount, v_payment.amount - v_payment.amount_refunded), 2);
  if v_amount <= 0 then
    raise exception 'IMPORTE_NO_VALIDO: el importe de una devolucion es mayor que cero'
      using errcode = '22023';
  end if;
  -- Lo ya pedido cuenta: dos devoluciones a medias no pueden sumar mas que el
  -- cobro. Sin esta linea se devuelve de mas pidiendolo dos veces seguidas.
  if v_amount + v_payment.amount_refunded + coalesce((
       select sum(r.amount) from public.refunds r
       where r.payment_id = v_payment.id and r.status in ('requested', 'processing')
     ), 0) > v_payment.amount then
    raise exception 'DEVOLUCION_EXCEDE_COBRO: no se puede devolver mas de lo que se cobro'
      using errcode = '23514';
  end if;

  insert into public.refunds (
    organization_id, company_id, store_id, payment_id, order_id, amount, currency,
    reason, idempotency_key, provider_code, requested_by, requested_email
  ) values (
    v_payment.organization_id, v_payment.company_id, v_payment.store_id, v_payment.id,
    v_payment.order_id, v_amount, v_payment.currency,
    nullif(left(btrim(coalesce(p_reason, '')), 1000), ''), p_idempotency_key,
    v_payment.provider_code, ebim.user_id(), ebim.email()
  )
  on conflict (store_id, idempotency_key) do nothing
  returning * into v_refund;

  if v_refund.id is null then
    v_replay := true;
    select * into v_refund
    from public.refunds r
    where r.store_id = v_payment.store_id and r.idempotency_key = p_idempotency_key;
  else
    insert into public.payment_events (
      organization_id, company_id, store_id, payment_intent_id, payment_id, refund_id,
      event_type, source, provider_code, payload, note
    ) values (
      v_refund.organization_id, v_refund.company_id, v_refund.store_id,
      v_payment.payment_intent_id, v_payment.id, v_refund.id,
      'refund.requested', 'operator', v_refund.provider_code,
      jsonb_build_object('amount', v_refund.amount::text, 'currency', v_refund.currency,
                         'requested_by', ebim.email()),
      v_refund.reason
    );

    -- El outbox que ya existe, no un segundo mecanismo. Regla 8 de la fase.
    if v_refund.provider_code is not null then
      insert into public.integration_outbox (
        organization_id, company_id, provider_code, operation, payload, idempotency_key
      ) values (
        v_refund.organization_id, v_refund.company_id, v_refund.provider_code,
        'payment.refund',
        jsonb_build_object(
          'refund_id', v_refund.id,
          'payment_id', v_payment.id,
          'payment_intent_id', v_payment.payment_intent_id,
          'provider_reference', v_payment.provider_reference,
          'amount', v_refund.amount::text,
          'currency', v_refund.currency),
        'refund:' || v_refund.id::text
      )
      on conflict (organization_id, company_id, idempotency_key) do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'refund_id',  v_refund.id,
    'payment_id', v_refund.payment_id,
    'amount',     v_refund.amount::text,
    'currency',   v_refund.currency,
    'status',     v_refund.status,
    'replay',     v_replay);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6 · public.payment_refund_settle — el resultado de la devolucion
--
-- Servidor. Nunca un `UPDATE payments SET amount = amount - x`: el cobro
-- conserva su importe y lo devuelto se acumula aparte, que es lo que permite
-- que la conciliacion siga cuadrando meses despues.
-- ---------------------------------------------------------------------------
create or replace function public.payment_refund_settle(
  p_refund_id          uuid,
  p_status             text,
  p_provider_reference text    default null,
  p_error_code         text    default null,
  p_error_detail       text    default null,
  p_source             text    default 'provider_response',
  p_external_event_id  text    default null,
  p_signature_verified boolean default false,
  p_payload            jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_refund  public.refunds%rowtype;
  v_payment public.payments%rowtype;
  v_source  public.payment_event_source;
  v_from    text;
  v_to      text := lower(btrim(coalesce(p_status, '')));
  v_refunded numeric;
  v_synced  boolean := false;
begin
  if not exists (
    select 1 from unnest(enum_range(null::public.payment_event_source)::text[]) as label
    where label = lower(btrim(coalesce(p_source, '')))
  ) then
    raise exception 'ORIGEN_NO_VALIDO: "%" no es un origen de hecho de pago', p_source
      using errcode = '22023';
  end if;
  v_source := lower(btrim(p_source))::public.payment_event_source;

  if v_source = 'browser_return' then
    raise exception 'RETORNO_NO_DECIDE: la vuelta del navegador no liquida una devolucion'
      using errcode = '42501';
  end if;
  if v_source = 'provider_webhook' and not coalesce(p_signature_verified, false) then
    raise exception 'FIRMA_NO_VERIFICADA: un aviso de pasarela sin firma valida no mueve dinero'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from unnest(enum_range(null::public.refund_status)::text[]) as label
    where label = v_to
  ) then
    raise exception 'ESTADO_NO_VALIDO: "%" no es un estado de devolucion', p_status
      using errcode = '22023';
  end if;

  select * into v_refund from public.refunds r where r.id = p_refund_id for update;
  if not found then
    raise exception 'DEVOLUCION_NO_ENCONTRADA: no hay ninguna devolucion con ese identificador'
      using errcode = '22023';
  end if;
  v_from := v_refund.status::text;

  -- ¿Quien llama tiene SESION? Entonces es una persona, y una persona solo
  -- puede cerrar la devolucion de un medio OFFLINE —una transferencia que ya
  -- salio del banco— y solo con rol. El resto de origenes son del servidor.
  --
  -- Se distingue por los claims y no por el rol de Postgres porque dentro de un
  -- `security definer` el rol es siempre el dueno: `ebim.user_id()` es lo unico
  -- que sigue diciendo la verdad sobre quien inicio la llamada.
  if ebim.user_id() is not null then
    if v_source <> 'operator' then
      raise exception 'ORIGEN_NO_PERMITIDO: una sesion solo puede liquidar una devolucion como operador'
        using errcode = '42501';
    end if;
    if v_refund.provider_code is not null then
      raise exception 'DEVOLUCION_CON_PASARELA: esta devolucion la cierra el proveedor, no una persona'
        using errcode = '42501';
    end if;
    perform ebim.assert_payment_operator(v_refund.organization_id, v_refund.company_id);
  end if;

  -- Idempotencia: el mismo aviso, o una devolucion ya terminal, no vuelve a
  -- restar. Es lo que hace que un webhook repetido no devuelva dos veces.
  if v_from in ('succeeded', 'cancelled') or v_from = v_to then
    return jsonb_build_object(
      'refund_id', v_refund.id, 'status', v_from, 'replay', true);
  end if;
  if p_external_event_id is not null and exists (
    select 1 from public.payment_events e
    where e.provider_code = coalesce(v_refund.provider_code, '')
      and e.external_event_id = p_external_event_id
  ) then
    return jsonb_build_object(
      'refund_id', v_refund.id, 'status', v_from, 'replay', true);
  end if;

  select * into v_payment from public.payments p where p.id = v_refund.payment_id for update;

  update public.refunds set
    status             = v_to::public.refund_status,
    provider_reference = coalesce(p_provider_reference, provider_reference),
    error_code         = case when v_to = 'failed' then p_error_code end,
    error_detail       = case when v_to = 'failed' then left(p_error_detail, 2000) end,
    completed_at       = case when v_to in ('succeeded','failed','cancelled') then now() end
  where id = v_refund.id;

  if v_to = 'succeeded' then
    v_refunded := v_payment.amount_refunded + v_refund.amount;
    update public.payments set
      amount_refunded = v_refunded,
      status = case when v_refunded >= v_payment.amount
                    then 'refunded'::public.payment_record_status
                    else 'partially_refunded'::public.payment_record_status end
    where id = v_payment.id;

    update public.payment_intents
       set amount_refunded = amount_refunded + v_refund.amount
     where id = v_payment.payment_intent_id;

    if v_payment.order_id is not null then
      v_synced := ebim.payment_sync_order(
        v_payment.order_id,
        case when v_refunded >= v_payment.amount
             then 'refunded'::public.payment_status
             else 'partially_refunded'::public.payment_status end,
        'devolucion de ' || v_refund.amount::text || ' ' || v_refund.currency);
    end if;
  end if;

  insert into public.payment_events (
    organization_id, company_id, store_id, payment_intent_id, payment_id, refund_id,
    event_type, source, provider_code, external_event_id, signature_verified, payload
  ) values (
    v_refund.organization_id, v_refund.company_id, v_refund.store_id,
    v_payment.payment_intent_id, v_payment.id, v_refund.id,
    'refund.' || v_to, v_source, v_refund.provider_code, p_external_event_id,
    coalesce(p_signature_verified, false),
    ebim.redact_sensitive(coalesce(p_payload, '{}'::jsonb)) ||
      jsonb_strip_nulls(jsonb_build_object(
        'from', v_from, 'to', v_to,
        'amount', v_refund.amount::text,
        'error_code', p_error_code))
  );

  if v_to = 'succeeded' then
    perform ebim.publish_event(
      v_refund.organization_id, v_refund.company_id, v_refund.store_id,
      'payment.refunded', 'refund', v_refund.id,
      jsonb_strip_nulls(jsonb_build_object(
        'refund_id',  v_refund.id,
        'payment_id', v_payment.id,
        'order_id',   v_payment.order_id,
        'amount',     v_refund.amount::text,
        'currency',   v_refund.currency,
        'provider_code', v_refund.provider_code)),
      'payment.refunded:' || v_refund.id::text);
  end if;

  return jsonb_build_object(
    'refund_id',    v_refund.id,
    'payment_id',   v_payment.id,
    'from',         v_from,
    'status',       v_to,
    'order_synced', v_synced,
    'replay',       false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7 · La conciliacion — cruzar por referencia externa, sin nombrar a nadie
--
-- El tenant sale del JWT (`org_id` + `active_company`), no de la firma: es la
-- unica forma de que una carga no pueda escribirse en la sociedad de al lado.
-- La entrada es una lista de filas del extracto tal cual; que proveedor las
-- produjo es un dato del catalogo, no una rama de codigo.
-- ---------------------------------------------------------------------------
create or replace function public.payment_reconciliation_import(
  p_provider_code text,
  p_rows          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org      uuid := ebim.org_id();
  v_company  uuid := ebim.active_company();
  v_row      jsonb;
  v_record   public.reconciliation_records%rowtype;
  v_payment  public.payments%rowtype;
  v_imported integer := 0;
  v_repeated integer := 0;
  v_matched  integer := 0;
  v_diff     integer := 0;
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_TENANT: la sesion no declara sociedad activa'
      using errcode = '42501';
  end if;
  perform ebim.assert_payment_operator(v_org, v_company);

  if not exists (select 1 from public.integration_providers p where p.code = p_provider_code) then
    raise exception 'PROVEEDOR_NO_ENCONTRADO: "%" no esta en el catalogo de conectores', p_provider_code
      using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'EXTRACTO_NO_VALIDO: se esperaba una lista de filas de liquidacion'
      using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    insert into public.reconciliation_records (
      organization_id, company_id, provider_code, settlement_date, external_reference,
      gross_amount, fee_amount, net_amount, currency, source_batch, raw
    ) values (
      v_org, v_company, p_provider_code,
      (v_row ->> 'settlement_date')::date,
      btrim(v_row ->> 'external_reference'),
      round((v_row ->> 'gross_amount')::numeric, 2),
      round(coalesce((v_row ->> 'fee_amount')::numeric, 0), 2),
      round(coalesce((v_row ->> 'net_amount')::numeric,
                     (v_row ->> 'gross_amount')::numeric
                       - coalesce((v_row ->> 'fee_amount')::numeric, 0)), 2),
      upper(coalesce(v_row ->> 'currency', 'PEN')),
      nullif(v_row ->> 'source_batch', ''),
      -- La fila cruda se guarda redactada: un extracto puede traer de todo.
      ebim.redact_sensitive(v_row)
    )
    on conflict (organization_id, company_id, provider_code, external_reference) do nothing
    returning * into v_record;

    if v_record.id is null then
      v_repeated := v_repeated + 1;
      continue;
    end if;
    v_imported := v_imported + 1;

    -- El cruce: la referencia del extracto contra la del cobro, dentro del
    -- MISMO tenant. Sin el filtro de tenant, dos sociedades con el mismo
    -- proveedor se cuadrarian los cobros entre si.
    select * into v_payment
    from public.payments p
    where p.organization_id = v_org
      and p.company_id      = v_company
      and p.provider_code   = p_provider_code
      and p.provider_reference = v_record.external_reference
    limit 1;

    if v_payment.id is null then
      continue;
    end if;

    if v_payment.amount = v_record.gross_amount and v_payment.currency = v_record.currency then
      update public.reconciliation_records
         set status = 'matched', payment_id = v_payment.id, matched_at = now()
       where id = v_record.id;
      update public.payments
         set settlement_reference = v_record.external_reference,
             settled_at = v_record.settlement_date
       where id = v_payment.id;
      v_matched := v_matched + 1;
    else
      update public.reconciliation_records
         set status = 'discrepancy', payment_id = v_payment.id, matched_at = now(),
             discrepancy_reason = 'el extracto dice ' || v_record.gross_amount::text || ' '
               || v_record.currency || ' y el cobro dice ' || v_payment.amount::text || ' '
               || v_payment.currency
       where id = v_record.id;
      v_diff := v_diff + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'provider_code', p_provider_code,
    'imported',      v_imported,
    'duplicated',    v_repeated,
    'matched',       v_matched,
    'discrepancy',   v_diff,
    'unmatched',     v_imported - v_matched - v_diff);
end;
$fn$;

-- Cruce manual: cuando la referencia no coincide porque el proveedor la
-- renombro, una persona con rol lo ata. Queda `matched_at` y el cobro citado.
create or replace function public.payment_reconciliation_match(
  p_record_id  uuid,
  p_payment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_record  public.reconciliation_records%rowtype;
  v_payment public.payments%rowtype;
begin
  select * into v_record from public.reconciliation_records r where r.id = p_record_id for update;
  if not found then
    raise exception 'LIQUIDACION_NO_ENCONTRADA: no hay ninguna fila de conciliacion con ese identificador'
      using errcode = '22023';
  end if;
  perform ebim.assert_payment_operator(v_record.organization_id, v_record.company_id);

  select * into v_payment from public.payments p where p.id = p_payment_id;
  if not found then
    raise exception 'COBRO_NO_ENCONTRADO: no hay ningun cobro con ese identificador'
      using errcode = '22023';
  end if;
  -- El cobro tiene que ser del MISMO tenant que la liquidacion. Es la linea que
  -- impide cuadrar el extracto de una sociedad con el cobro de otra.
  if v_payment.organization_id <> v_record.organization_id
     or v_payment.company_id <> v_record.company_id then
    raise exception 'COBRO_DE_OTRO_TENANT: el cobro no pertenece a esta sociedad'
      using errcode = '42501';
  end if;

  update public.reconciliation_records set
    status = case when v_payment.amount = v_record.gross_amount
                   and v_payment.currency = v_record.currency
                  then 'matched'::public.reconciliation_status
                  else 'discrepancy'::public.reconciliation_status end,
    payment_id = v_payment.id,
    matched_at = now(),
    discrepancy_reason = case when v_payment.amount <> v_record.gross_amount
                                or v_payment.currency <> v_record.currency
                              then 'cuadre manual con importes distintos' end
  where id = v_record.id;

  update public.payments
     set settlement_reference = v_record.external_reference,
         settled_at = v_record.settlement_date
   where id = v_payment.id;

  select * into v_record from public.reconciliation_records r where r.id = p_record_id;

  return jsonb_build_object(
    'record_id',  v_record.id,
    'payment_id', v_payment.id,
    'status',     v_record.status);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8 · Los permisos. Lo que decide el servidor NO lo puede llamar una sesion.
--
-- `security definer` sin `revoke` es una escalada de privilegio con buena
-- letra: la funcion corre como su dueno y cualquiera con `EXECUTE` la usa.
-- Leccion esupplier-030, aplicada tabla por tabla y funcion por funcion.
-- ---------------------------------------------------------------------------
revoke execute on function ebim.assert_payment_operator(uuid, uuid) from public, anon, authenticated;
revoke execute on function ebim.payment_sync_order(uuid, public.payment_status, text)
  from public, anon, authenticated;

revoke execute on function public.payment_intent_open(text, text, numeric, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.payment_intent_attach_order(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.payment_apply_outcome(
  uuid, text, text, text, text, numeric, text, text, text, text, integer, text, text, boolean, jsonb)
  from public, anon, authenticated;
revoke execute on function public.payment_refund_settle(
  uuid, text, text, text, text, text, text, boolean, jsonb)
  from public, anon;

revoke execute on function public.payment_refund_request(uuid, numeric, text, text)
  from public, anon;

-- Lo que decide el SERVIDOR. Sin este grant, `revoke ... from public` deja
-- tambien a `service_role` fuera: `bypassrls` no es `bypass grants`.
grant execute on function public.payment_intent_open(text, text, numeric, text, text, uuid)
  to service_role;
grant execute on function public.payment_intent_attach_order(uuid, uuid) to service_role;
grant execute on function public.payment_apply_outcome(
  uuid, text, text, text, text, numeric, text, text, text, text, integer, text, text, boolean, jsonb)
  to service_role;
grant execute on function public.payment_refund_settle(
  uuid, text, text, text, text, text, text, boolean, jsonb) to service_role;
-- Y tambien el operador, para el UNICO caso que no tiene servidor detras: una
-- devolucion de un medio offline. La funcion comprueba el rol por dentro.
grant execute on function public.payment_refund_settle(
  uuid, text, text, text, text, text, text, boolean, jsonb) to authenticated;
revoke execute on function public.payment_reconciliation_import(text, jsonb) from public, anon;
revoke execute on function public.payment_reconciliation_match(uuid, uuid) from public, anon;

-- Las tres del backoffice: la autorizacion esta DENTRO de cada una.
grant execute on function public.payment_refund_request(uuid, numeric, text, text)
  to authenticated;
grant execute on function public.payment_reconciliation_import(text, jsonb) to authenticated;
grant execute on function public.payment_reconciliation_match(uuid, uuid) to authenticated;

comment on function public.payment_apply_outcome(
  uuid, text, text, text, text, numeric, text, text, text, text, integer, text, text, boolean, jsonb) is
  'Unico punto de entrada del resultado de una pasarela. Rechaza el retorno del navegador como decision y el webhook sin firma verificada; tres cerrojos de idempotencia.';
comment on function public.payment_refund_request(uuid, numeric, text, text) is
  'Pide una devolucion y la encola en integration_outbox. Deja escrito quien la autorizo; no mueve dinero por si misma.';
comment on function public.payment_reconciliation_import(text, jsonb) is
  'Importa un extracto de liquidacion y lo cruza por referencia externa dentro del tenant del JWT. Reimportar el mismo extracto no duplica ni descuadra.';
