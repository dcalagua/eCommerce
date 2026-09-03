-- =============================================================================
-- FIX · «Generar sugerido» no podia funcionar desde el backoffice.
--
-- Sintoma: el cajon calcula y devuelve «No se pudo completar la operacion»,
-- siempre, con cualquier cliente y cualquier periodo.
--
-- Causa: `ebim.suggest_order` vive en el esquema `ebim`, y el navegador llama
-- por PostgREST — que solo publica lo que hay en `public`. La llamada
-- `rpc('suggest_order')` buscaba `public.suggest_order`, que no existe, y el
-- error llegaba a la pantalla como el genérico de la fase. Los tests de base no
-- lo cazaron porque llaman a `ebim.suggest_order` directamente: probaban el
-- calculo, que estaba bien, no la PUERTA, que faltaba.
--
-- Es el mismo patron que ya usan las otras puertas de la aplicacion: la logica
-- en `ebim`, un envoltorio delgado en `public` con su GRANT.
--
-- ## Por que este envoltorio no abre nada
--
-- `ebim.suggest_order` es `security invoker` —no DEFINER— y lo unico que hace es
-- leer `orders`, `order_items` y `business_accounts`. Quien decide que filas se
-- ven es la RLS de esas tablas con el JWT de quien llama, y el envoltorio no la
-- puede saltar: hereda los privilegios del llamante igual que la funcion de
-- dentro. Por eso NO hace falta comprobar el tenant aqui — y por eso mismo
-- comprobarlo aqui seria enganoso: parecerian dos autoridades cuando solo hay
-- una.
--
-- `anon` no entra: un sugerido es historial de compra de un cliente concreto, y
-- eso no es dato publicado de la tienda.
-- =============================================================================

create or replace function public.suggest_order(
  p_store    uuid,
  p_customer uuid,
  p_days     int default 30
)
returns table (
  product_id           uuid,
  variant_id           uuid,
  suggested_quantity   numeric,
  last_period_quantity numeric,
  reason               text
)
language sql
stable
set search_path = ''
as $fn$
  select * from ebim.suggest_order(p_store, p_customer, p_days);
$fn$;

revoke execute on function public.suggest_order(uuid, uuid, int) from public, anon;
grant  execute on function public.suggest_order(uuid, uuid, int) to authenticated, service_role;

comment on function public.suggest_order(uuid, uuid, int) is
  'Puerta publica de ebim.suggest_order para PostgREST. Security INVOKER: la RLS del llamante decide que historial se ve.';


-- =============================================================================
-- FIX · La antiguedad de saldos tampoco tenia puerta.
--
-- Se encontro barriendo las 81 constantes de RPC del navegador contra las
-- migraciones: `customer_aging` era la otra que solo existia en `ebim`. Mismo
-- sintoma —el panel de credito no puede pedir el tramo de deuda de un cliente—
-- y mismo arreglo.
--
-- Tambien `security invoker`: lee `ar_documents` y la RLS de esa tabla decide
-- de quien es la deuda que se ve. `anon` no entra: la deuda de un cliente no
-- es dato publicado de la tienda.
-- =============================================================================

create or replace function public.customer_aging(p_customer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select ebim.customer_aging(p_customer);
$fn$;

revoke execute on function public.customer_aging(uuid) from public, anon;
grant  execute on function public.customer_aging(uuid) to authenticated, service_role;

comment on function public.customer_aging(uuid) is
  'Puerta publica de ebim.customer_aging para PostgREST. Security INVOKER: la RLS de ar_documents decide que deuda se ve.';
