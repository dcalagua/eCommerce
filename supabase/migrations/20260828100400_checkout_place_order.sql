-- =============================================================================
-- P07-SaaS · La transaccion que cierra el checkout
--
-- Todo lo que TIENE que pasar junto pasa aqui, en una sola transaccion de
-- Postgres, y nada mas pasa aqui:
--
--   pedido creado  +  intento marcado como exitoso  +  carrito convertido
--                  +  hechos publicados en el outbox
--
-- Si cualquiera de las cuatro falla, no ocurre ninguna. Esa es toda la razon de
-- que exista esta funcion en vez de cuatro llamadas seguidas desde el
-- orquestador: entre dos llamadas cabe un despliegue, un timeout y un proceso
-- muerto, y el estado que dejan —"pedido creado, nadie enterado"— es
-- precisamente el que este proyecto no puede tener.
--
-- ## Lo que NO pasa aqui, y es igual de importante
--
-- **Ninguna llamada externa.** Ni pasarela, ni correo, ni ERP. Autorizar un
-- cobro es una peticion de red que puede tardar quince segundos; hacerla dentro
-- de esta transaccion mantendria bloqueadas las filas de existencia todo ese
-- tiempo y convertiria una caida ajena en una tienda parada. El cobro se
-- autoriza ANTES, fuera de la transaccion, y lo que entra aqui es su
-- RESULTADO: una referencia y un estado. Los avisos salen DESPUES, por el
-- outbox. Es la regla "no llamadas externas dentro de transacciones DB largas"
-- aplicada al unico sitio donde se podia incumplir.
--
-- ## Idempotencia, otra vez y en el ultimo sitio
--
-- Aunque `checkout_begin` ya haya filtrado el reintento, esta funcion vuelve a
-- comprobar el estado del intento con la fila BLOQUEADA. Es la ultima linea, la
-- misma idea que el CHECK de sobreventa de P06: la correccion no depende de que
-- el llamante se acuerde.
-- =============================================================================

create or replace function public.checkout_place_order(
  p_intent_id         uuid,
  p_customer_email    text,
  p_items             jsonb,
  p_customer_name     text default null,
  p_customer_phone    text default null,
  p_shipping_address  jsonb default '{}'::jsonb,
  p_notes             text default null,
  p_reservation_token text default null,
  -- Resultado del cobro, ya obtenido FUERA de esta transaccion. Referencias y
  -- estado; jamas un numero de tarjeta ni un token de tarjeta (contrato del
  -- puerto de pagos: aqui no se toca un medio de pago).
  p_payment           jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_intent   public.checkout_intents%rowtype;
  v_store    public.stores%rowtype;
  v_order    jsonb;
  v_order_id uuid;
  v_cart     public.carts%rowtype;
  v_payment  jsonb;
begin
  select * into v_intent
  from public.checkout_intents i
  where i.id = p_intent_id
  for update;

  if not found then
    raise exception 'INTENTO_NO_ENCONTRADO: no hay ningun intento de compra con esos datos'
      using errcode = '22023';
  end if;

  -- Ultima linea contra el pedido duplicado: si el intento ya cerro bien, se
  -- devuelve lo que se creo entonces y no se crea nada.
  if v_intent.status = 'succeeded' then
    return v_intent.result || jsonb_build_object('replay', true, 'intent_id', v_intent.id);
  end if;

  if v_intent.status <> 'running' then
    raise exception 'INTENTO_NO_VIGENTE: ese intento de compra ya se cerro'
      using errcode = '22023';
  end if;

  select * into v_store from public.stores s where s.id = v_intent.store_id;

  -- El pedido. Precio, impuesto, canal, existencia y numero salen de aqui
  -- dentro; el payload solo dice QUE y CUANTO.
  v_order := public.create_order(
    v_store.id,
    p_customer_email,
    p_items,
    p_customer_name,
    p_customer_phone,
    p_shipping_address,
    p_notes,
    p_reservation_token
  );

  v_order_id := (v_order ->> 'order_id')::uuid;

  -- El carrito acabo en este pedido. Se cierra aqui y no antes: un carrito
  -- vaciado por adelantado deja al comprador sin nada si el pedido falla.
  if v_intent.cart_id is not null then
    select * into v_cart from public.carts c where c.id = v_intent.cart_id for update;
    if found and v_cart.status = 'active' then
      update public.carts
         set status = 'converted', order_id = v_order_id, last_activity_at = now()
       where id = v_cart.id;
    end if;
  end if;

  -- Nunca se guarda el medio de pago, solo su rastro de conciliacion.
  v_payment := case
    when p_payment is null then null
    else jsonb_build_object(
      'status',             p_payment ->> 'status',
      'provider_reference', p_payment ->> 'provider_reference',
      'provider_code',      p_payment ->> 'provider_code')
  end;

  -- Los hechos, en ESTA transaccion. `dedupe_key` sale de la clave de
  -- idempotencia, asi que un reintento no vuelve a publicarlos.
  perform ebim.publish_event(
    v_store.organization_id, v_store.company_id, v_store.id,
    'order.created', 'order', v_order_id,
    jsonb_build_object(
      'order_id',       v_order_id,
      'order_number',   v_order ->> 'order_number',
      'status',         v_order ->> 'status',
      'channel',        v_order ->> 'channel',
      'currency',       v_order ->> 'currency',
      'subtotal',       v_order ->> 'subtotal',
      'tax_total',      v_order ->> 'tax_total',
      'grand_total',    v_order ->> 'grand_total',
      'customer_email', lower(btrim(coalesce(p_customer_email, ''))),
      'item_count',     jsonb_array_length(coalesce(v_order -> 'items', '[]'::jsonb)),
      'payment',        v_payment),
    'order.created:' || v_intent.idempotency_key);

  -- El aviso al comprador es un hecho aparte del pedido: se procesa por su
  -- cuenta, se reintenta por su cuenta y si el proveedor de mensajeria esta
  -- caido, el pedido sigue existiendo. Ese es el punto del outbox.
  perform ebim.publish_event(
    v_store.organization_id, v_store.company_id, v_store.id,
    'notification.order_confirmation', 'order', v_order_id,
    jsonb_build_object(
      'order_id',       v_order_id,
      'order_number',   v_order ->> 'order_number',
      'customer_email', lower(btrim(coalesce(p_customer_email, ''))),
      'customer_name',  nullif(btrim(coalesce(p_customer_name, '')), ''),
      'grand_total',    v_order ->> 'grand_total',
      'currency',       v_order ->> 'currency'),
    'notification.order_confirmation:' || v_intent.idempotency_key);

  update public.checkout_intents
     set status = 'succeeded',
         stage = 'publish_events',
         order_id = v_order_id,
         result = v_order,
         reservation_token = null,
         completed_at = now()
   where id = v_intent.id;

  return v_order || jsonb_build_object('replay', false, 'intent_id', v_intent.id);
end;
$fn$;

revoke execute on function
  public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb)
from public, anon, authenticated;

grant execute on function
  public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb)
to service_role;

comment on function
  public.checkout_place_order(uuid, text, jsonb, text, text, jsonb, text, text, jsonb) is
  'La transaccion que cierra el checkout: pedido + intento + carrito + hechos del outbox, o ninguna de las cuatro. Sin una sola llamada externa dentro.';

-- ---------------------------------------------------------------------------
-- NO se añade ninguna capacidad nueva, y es a proposito.
--
-- `checkout` ya esta en `app_capabilities` como BASELINE e `implemented` desde
-- P02-SaaS. Cobrar aparte por "checkout fiable" no seria un modulo: seria
-- vender la version que no duplica pedidos como si la otra tambien fuera un
-- producto. Lo que P07 hace es cambiar COMO funciona lo que ya se entregaba,
-- no abrir una casilla nueva en el catalogo comercial.
--
-- Lo que si nace vendible mas adelante es `payments` —que sigue `declared`
-- porque aqui no se cobra— y `promotions`, que P10 conectara a la etapa vacia
-- que este pipeline ya deja reservada.
-- ---------------------------------------------------------------------------
