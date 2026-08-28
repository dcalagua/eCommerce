/**
 * Generador de la migración `20260828150600_create_order_delivery.sql` (P12-SaaS).
 *
 * `create_order`, `create_order_for_slug` y `checkout_place_order` se redefinen
 * ENTERAS en cada fase que les añade un parámetro (es la única forma de cambiar
 * la firma de una función de Postgres). Copiar 700 líneas a mano es donde se
 * cuelan las diferencias silenciosas, así que la copia la hace un script: parte
 * de la versión vigente (P10-SaaS) y aplica parches con anclas exactas, y falla
 * ruidosamente si un ancla no aparece exactamente una vez.
 *
 * Es una herramienta de construcción de UNA migración, no código de producto:
 * se ejecuta una vez, su salida se versiona y se revisa como cualquier otro
 * archivo. Se conserva en el repositorio porque la fase siguiente que toque
 * `create_order` querrá exactamente esto.
 *
 *   node scripts/build-p12-create-order.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'supabase/migrations/20260828130300_create_order_promotions.sql')
const TARGET = join(ROOT, 'supabase/migrations/20260828150600_create_order_delivery.sql')

// El árbol de trabajo está en CRLF (`core.autocrlf = true` en Windows) y el
// resto de este script razona en `\n`. Se normaliza al leer: sin esto, cada
// ancla multilínea fallaría por un `\r` invisible.
const lines = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n').split('\n')
/** Rebanada 1-indexada e inclusiva, como las cuenta `sed`. */
const slice = (from, to) => lines.slice(from - 1, to).join('\n')

let createOrder = slice(63, 785)
let forSlug = slice(793, 862)
let placeOrder = slice(878, 1040)

/** Sustitución que EXIGE una única ocurrencia: un ancla ambigua es un bug. */
function patch(text, anchor, replacement, label) {
  const parts = text.split(anchor)
  if (parts.length !== 2) {
    throw new Error(`Ancla "${label}" aparece ${parts.length - 1} veces; se esperaba 1`)
  }
  return parts[0] + replacement + parts[1]
}

function patchAll(text, anchor, replacement, label, expected) {
  const parts = text.split(anchor)
  if (parts.length - 1 !== expected) {
    throw new Error(`Ancla "${label}" aparece ${parts.length - 1} veces; se esperaban ${expected}`)
  }
  return parts.join(replacement)
}

// --- Firmas: las tres funciones ganan un `jsonb` al final -------------------
const SIG_ORDER = '(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[])'
const SIG_SLUG = '(text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb, text[])'
const SIG_PLACE = '(uuid, text, jsonb, text, text, jsonb, text, text, jsonb, uuid, jsonb, jsonb, text[])'

// ---------------------------------------------------------------------------
// create_order
// ---------------------------------------------------------------------------
createOrder = patch(
  createOrder,
  `  p_coupon_codes        text[] default null
)`,
  `  p_coupon_codes        text[] default null,
  -- ---- P12-SaaS -----------------------------------------------------------
  -- \`p_delivery\`: la ELECCION de entrega del comprador, nunca su precio.
  -- {"method_code": "...", "pickup_point_id": uuid?, "window": {...}?}
  -- Cuanto cuesta lo decide \`ebim.quote_delivery_choice\` aqui dentro, con el
  -- subtotal recien calculado y la fila de tarifa delante. NULL = la tienda no
  -- cobra transporte, que es lo que pasaba antes de esta fase.
  p_delivery            jsonb default null
)`,
  'create_order · params',
)

createOrder = patch(
  createOrder,
  `  v_snapshot    jsonb;`,
  `  v_snapshot    jsonb;
  -- ---- P12-SaaS ---------------------------------------------------------
  v_option      jsonb := null;   -- la opcion de entrega ya cotizada
  v_ship        numeric(14,2) := 0;
  v_ful         uuid := null;`,
  'create_order · declare',
)

createOrder = patch(
  createOrder,
  `  v_grand    := (v_totals ->> 'grand_total')::numeric;`,
  `  v_grand    := (v_totals ->> 'grand_total')::numeric;

  -- ---- P12 · La ENTREGA, resuelta en el SERVIDOR --------------------------
  --
  -- \`p_delivery\` trae una eleccion y jamas un importe. El coste sale de
  -- \`ebim.quote_delivery_choice\`, que vuelve a comprobar cobertura, tarifa,
  -- tramo y umbral de gratuidad con el subtotal que el motor acaba de calcular
  -- —no con el que viera la vitrina hace diez minutos, que pudo cambiar—.
  --
  -- Se suma ANTES del umbral de aprobacion B2B a proposito: lo que la empresa
  -- paga incluye el transporte, y dejarlo fuera haria que un pedido cruzara el
  -- limite sin pedir firma.
  --
  -- Sin \`p_delivery\`, transporte CERO y ningun fulfillment: un tenant que no
  -- ha configurado entregas vende exactamente como antes de P12.
  if p_delivery is not null
     and nullif(btrim(coalesce(p_delivery ->> 'method_code', '')), '') is not null then
    v_option := ebim.quote_delivery_choice(
      v_store.id,
      p_delivery ->> 'method_code',
      coalesce(p_shipping_address, '{}'::jsonb),
      v_lines,
      v_subtotal,
      ebim.safe_uuid(p_delivery ->> 'pickup_point_id'));
    v_ship  := coalesce((v_option ->> 'amount')::numeric, 0);
    v_grand := v_grand + v_ship;
  end if;`,
  'create_order · quote',
)

createOrder = patch(
  createOrder,
  `    v_subtotal, v_tax, 0, v_discount, v_grand,`,
  `    v_subtotal, v_tax, v_ship, v_discount, v_grand,`,
  'create_order · insert shipping_total',
)

createOrder = patch(
  createOrder,
  `  return jsonb_build_object(
    'order_id',       v_order_id,`,
  `  -- ---- P12 · La promesa de entrega, en ESTA transaccion -------------------
  --
  -- El fulfillment nace CON el pedido y no despues, por la misma razon que el
  -- canje de promociones: entre dos transacciones cabe un proceso muerto, y el
  -- estado que deja —«pedido cobrado del que nadie sabe como sale»— es
  -- precisamente el que este proyecto no puede tener.
  --
  -- Lleva TODAS las lineas. Partirlo en dos entregas es una decision de
  -- operacion que se toma despues, con \`fulfillment_create\`, y que no cobra
  -- transporte de mas porque el reparto de \`shipping_total\` es estructural.
  if v_option is not null then
    v_ful := ebim.plan_fulfillment(v_order_id, v_option, coalesce(p_delivery, '{}'::jsonb));
  end if;

  return jsonb_build_object(
    'order_id',       v_order_id,`,
  'create_order · plan',
)

createOrder = patch(
  createOrder,
  `    'grand_total',    v_grand::text,`,
  `    'shipping_total', v_ship::text,
    'grand_total',    v_grand::text,
    -- P12: el comprador tiene derecho a ver COMO le llega y CUANDO, en la misma
    -- respuesta en la que se le dice cuanto pago. Sin entrega configurada es
    -- \`null\`, que es distinto de un objeto vacio: no se eligio nada.
    'delivery', case when v_option is null then null else jsonb_strip_nulls(jsonb_build_object(
      'fulfillment_id', v_ful,
      'method_code',    v_option ->> 'code',
      'method_name',    v_option ->> 'name',
      'strategy',       v_option ->> 'strategy',
      'amount',         v_option ->> 'amount',
      'currency',       v_option ->> 'currency',
      'promised_from',  v_option ->> 'promised_from',
      'promised_to',    v_option ->> 'promised_to')) end,`,
  'create_order · return',
)

createOrder = patchAll(createOrder, SIG_ORDER, SIG_ORDER.replace(', text[])', ', text[], jsonb)'), 'create_order · firmas', 3)

createOrder = patch(
  createOrder,
  `drop function if exists public.create_order(
  uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb);`,
  `-- Se dejan caer las DOS firmas vivas: la de P08 (doce argumentos) por si esta
-- base viene de antes de P10, y la de P10 (trece), que es la que hay hoy. Sin
-- la segunda, \`create or replace\` no basta: anadir un parametro con valor por
-- defecto crea una sobrecarga y las llamadas quedan ambiguas.
drop function if exists public.create_order(
  uuid, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb);
drop function if exists public.create_order${SIG_ORDER};`,
  'create_order · drop',
)


createOrder = patch(
  createOrder,
  `  'Crea el pedido, aplica las promociones con los cerrojos puestos y congela su snapshot completo. Del payload no se acepta precio, canal, lista, factor, almacen, tenant, origen ni DESCUENTO: solo codigos de cupon.';`,
  `  'Crea el pedido, aplica promociones, cotiza la ENTREGA en el servidor y planifica su fulfillment, todo en una transaccion. Del payload no se acepta precio, canal, lista, factor, almacen, tenant, origen, descuento ni COSTE DE ENVIO: solo codigos y elecciones.';`,
  'create_order · comment',
)

// ---------------------------------------------------------------------------
// create_order_for_slug
// ---------------------------------------------------------------------------
forSlug = patch(
  forSlug,
  `  p_coupon_codes        text[] default null
)`,
  `  p_coupon_codes        text[] default null,
  -- P12: se ARRASTRA sin interpretarla, igual que los cupones. Esta funcion no
  -- sabe que es una entrega; solo sabe resolver la tienda por slug.
  p_delivery            jsonb default null
)`,
  'for_slug · params',
)

forSlug = patch(
  forSlug,
  `    p_coupon_codes
  );`,
  `    p_coupon_codes,
    p_delivery
  );`,
  'for_slug · call',
)

forSlug = patchAll(forSlug, SIG_SLUG, SIG_SLUG.replace(', text[])', ', text[], jsonb)'), 'for_slug · firmas', 3)

forSlug = patch(
  forSlug,
  `drop function if exists public.create_order_for_slug(
  text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb);`,
  `drop function if exists public.create_order_for_slug(
  text, text, jsonb, text, text, jsonb, text, text, text, uuid, jsonb, jsonb);
drop function if exists public.create_order_for_slug${SIG_SLUG};`,
  'for_slug · drop',
)


forSlug = patch(
  forSlug,
  `  'Checkout publico: resuelve la tienda por slug (solo activa) y delega en create_order, arrastrando reserva, origen, cuenta B2B, direccion fiscal y codigos de cupon. Solo service_role.';`,
  `  'Checkout publico: resuelve la tienda por slug (solo activa) y delega en create_order, arrastrando reserva, origen, cuenta B2B, direccion fiscal, cupones y la eleccion de entrega. Solo service_role.';`,
  'for_slug · comment',
)

// ---------------------------------------------------------------------------
// checkout_place_order
// ---------------------------------------------------------------------------
placeOrder = patch(
  placeOrder,
  `  p_coupon_codes        text[] default null
)`,
  `  p_coupon_codes        text[] default null,
  -- P12: la eleccion de entrega que resolvio la etapa 7 del pipeline. Viaja sin
  -- importe: el coste lo recalcula \`create_order\` dentro de la transaccion.
  p_delivery            jsonb default null
)`,
  'place_order · params',
)

placeOrder = patch(
  placeOrder,
  `    p_coupon_codes
  );`,
  `    p_coupon_codes,
    p_delivery
  );`,
  'place_order · call',
)

placeOrder = patch(
  placeOrder,
  `      'discount_total',  v_order ->> 'discount_total',`,
  `      'discount_total',  v_order ->> 'discount_total',
      -- P12: un consumidor que factura o sincroniza con un ERP necesita el
      -- transporte por separado —tributa distinto— y no puede deducirlo del
      -- total sin volver a leer el pedido.
      'shipping_total',  v_order ->> 'shipping_total',
      'delivery',        v_order -> 'delivery',`,
  'place_order · outbox',
)

placeOrder = patchAll(placeOrder, SIG_PLACE, SIG_PLACE.replace(', text[])', ', text[], jsonb)'), 'place_order · firmas', 3)

placeOrder = patch(
  placeOrder,
  `create function public.checkout_place_order(`,
  `drop function if exists public.checkout_place_order${SIG_PLACE};

create function public.checkout_place_order(`,
  'place_order · drop',
)


placeOrder = patch(
  placeOrder,
  `  'La transaccion que cierra el checkout: pedido + intento + carrito + hechos, o ninguna de las cuatro. Sin una sola llamada externa dentro. Desde P10 arrastra los codigos de cupon tecleados.';`,
  `  'La transaccion que cierra el checkout: pedido + intento + carrito + fulfillment + hechos, o ninguna de las cinco. Sin una sola llamada externa dentro. Arrastra cupones (P10) y la eleccion de entrega (P12).';`,
  'place_order · comment',
)

const header = `-- =============================================================================
-- P12-SaaS · 7/7 — El pedido aprende a cobrar el TRANSPORTE y a nacer con su
--                  promesa de entrega
--
-- ## Por que se vuelven a escribir enteras
--
-- Postgres no sabe anadir un parametro a una funcion: hay que dejarla caer y
-- volver a crearla. Es lo mismo que hicieron P03, P04, P06, P08 y P10 con estas
-- tres funciones, y el motivo de que la copia la haga un script
-- (\`scripts/build-p12-create-order.mjs\`) en vez de un par de manos: el script
-- parte de la version vigente y falla si un ancla no aparece exactamente una
-- vez, asi que una diferencia silenciosa entre la version anterior y esta no
-- puede colarse.
--
-- ## Que cambia, exactamente
--
-- 1. \`create_order\` acepta \`p_delivery\` — una ELECCION, nunca un importe— y
--    cotiza la entrega con \`ebim.quote_delivery_choice\`. El resultado va a
--    \`orders.shipping_total\`, que existia desde P02 y valia siempre cero.
-- 2. El coste entra en \`grand_total\` ANTES del umbral de aprobacion B2B: lo
--    que la empresa paga incluye el transporte.
-- 3. Nace el fulfillment, en la MISMA transaccion, con todas las lineas.
-- 4. La respuesta lleva \`shipping_total\` y \`delivery\`, y el hecho
--    \`order.created\` del outbox tambien: un ERP necesita el transporte
--    separado porque tributa distinto.
--
-- ## Lo que NO cambia, y es la mitad del valor
--
-- \`orders\` no gana ni una columna. Ni transportista, ni guia, ni metodo de
-- entrega: eso vive en \`fulfillments\`, que apunta al pedido. Y sin
-- \`p_delivery\` el comportamiento es EXACTAMENTE el de P10 —transporte cero,
-- sin fulfillment—, asi que la Edge Function \`create-order\`, sus tests y
-- cualquier tenant que no configure entregas siguen funcionando sin tocar nada.
-- =============================================================================

`

const out = [
  header,
  createOrder,
  '\n-- ===========================================================================',
  '-- create_order_for_slug — arrastra la eleccion de entrega, sin interpretarla',
  '-- ===========================================================================\n',
  forSlug,
  '\n-- ===========================================================================',
  '-- checkout_place_order — la quinta cosa que pasa junta: el fulfillment',
  '-- ===========================================================================\n',
  placeOrder,
  '',
].join('\n')

writeFileSync(TARGET, out, 'utf8')
console.log(`Escrito ${TARGET} (${out.split('\n').length} lineas)`)
