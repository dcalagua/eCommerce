-- =============================================================================
-- P13-SaaS · 1/6 — El HILO: correlation id, y las guardas de PII
--
-- Este archivo no crea ni una tabla. Crea la propiedad de la que depende toda
-- la fase: que un incidente de compra se pueda seguir desde la peticion del
-- navegador hasta el mensaje que no salio hacia el sistema externo, con UNA
-- sola cadena.
--
-- ## Por que el correlation id es un DEFAULT de columna y no un parametro
--
-- Porque la alternativa era reescribir `create_order`, `checkout_place_order`,
-- `payment_apply_outcome`, `integration_enqueue` y otras once funciones para
-- que aceptaran un argumento mas y lo fueran pasando. Eso es exactamente lo que
-- la regla 4 del contrato de ejecucion prohibe —«conserva lo que ya funciona»—
-- y ademas es la clase de cambio que se olvida en la doceava funcion, que es
-- justo la que se rompe el dia del incidente.
--
-- `ebim.correlation_id()` lee el contexto de la PETICION, no un argumento:
--
--   1. `ebim.correlation_id` puesto con `set_config` — el camino del servidor;
--   2. la cabecera `x-correlation-id` que PostgREST publica en
--      `request.headers` — el camino de toda llamada desde una Edge Function o
--      desde el navegador.
--
-- Puesto como DEFAULT de la columna, cada fila escrita DURANTE esa peticion
-- queda cosida al hilo sin que ninguna funcion de dominio se entere. Ni una
-- linea de `create_order` cambia.
--
-- Lo que NO hace, y es deliberado: no lo INVENTA. Sin cabecera y sin
-- `set_config` la columna queda en NULL. Un id generado aqui seria distinto en
-- cada fila y daria la ilusion de trazabilidad sin trazar nada.
--
-- ## Y por que hay guardas de PII en un archivo de trazas
--
-- Porque las tres tablas que vienen detras —analitica, auditoria y bitacora de
-- operacion— guardan payloads que nadie revisa a mano, y el requisito de la
-- fase es explicito: «no envies PII innecesaria a analytics», «no registres
-- secretos ni tokens». P09 ya dejo hechas las guardas de TARJETA
-- (`ebim.sensitive_json_keys`, `looks_like_pan`, `jsonb_is_card_safe`,
-- `redact_sensitive`); lo que falta es la otra mitad —correo, telefono,
-- documento, direccion— y vive aqui para que las tres tablas la compartan en
-- vez de escribirla tres veces con tres criterios distintos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.correlation_id — el hilo de la peticion en curso.
--
-- STABLE y no VOLATILE: dentro de una misma sentencia tiene que devolver
-- SIEMPRE lo mismo, o dos filas de la misma transaccion colgarian de hilos
-- distintos. Ademas es lo que permite anadirla como DEFAULT sin reescribir la
-- tabla entera al aplicar la migracion.
--
-- El formato se valida aqui y no en cada CHECK: lo que llega es una cabecera de
-- HTTP, o sea texto de fuera. Un id con saltos de linea dentro es como se
-- falsifica una entrada de bitacora.
-- ---------------------------------------------------------------------------
create or replace function ebim.correlation_id()
returns text
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_value text;
begin
  v_value := nullif(btrim(coalesce(current_setting('ebim.correlation_id', true), '')), '');

  if v_value is null then
    -- `request.headers` lo publica PostgREST. Puede no existir (conexion
    -- directa) o no ser JSON valido (nadie lo garantiza): las dos cosas son
    -- «no hay hilo», nunca un error que tumbe el INSERT que lo llamo.
    begin
      v_value := nullif(btrim(coalesce(
        (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-correlation-id',
        '')), '');
    exception when others then
      v_value := null;
    end;
  end if;

  if v_value is null or v_value !~ '^[A-Za-z0-9_.:-]{8,120}$' then
    return null;
  end if;

  return v_value;
end;
$fn$;

comment on function ebim.correlation_id() is
  'Hilo de la peticion en curso: set_config(ebim.correlation_id) o la cabecera x-correlation-id. NULL cuando no hay hilo: nunca se inventa uno.';

-- ---------------------------------------------------------------------------
-- ebim.request_id — un SALTO dentro del hilo.
--
-- Existe separada porque son dos preguntas distintas y confundirlas cuesta el
-- diagnostico: el correlation id es «el mismo incidente» (checkout -> cobro ->
-- webhook -> sistema externo, minutos u horas) y el request id es «la misma
-- llamada». Sin el segundo, dos reintentos del mismo checkout son
-- indistinguibles en la bitacora.
-- ---------------------------------------------------------------------------
create or replace function ebim.request_id()
returns text
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_value text;
begin
  v_value := nullif(btrim(coalesce(current_setting('ebim.request_id', true), '')), '');

  if v_value is null then
    begin
      v_value := nullif(btrim(coalesce(
        (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-request-id',
        '')), '');
    exception when others then
      v_value := null;
    end;
  end if;

  if v_value is null or v_value !~ '^[A-Za-z0-9_.:-]{8,120}$' then
    return null;
  end if;

  return v_value;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.hash_token — resumen estable de un identificador opaco.
--
-- `sha256` es nucleo de Postgres desde la 11 y vive en `pg_catalog`, que se
-- busca siempre: esto no depende de que `pgcrypto` este habilitada — misma
-- regla que siguio `carts.token` con `gen_random_uuid()`.
--
-- Para que se usa: la analitica necesita saber si dos visitas son la MISMA
-- sesion, y no necesita saber cual. Guardar el identificador crudo daria las
-- dos cosas; guardar su resumen da solo la primera.
-- ---------------------------------------------------------------------------
create or replace function ebim.hash_token(p_value text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when nullif(btrim(coalesce(p_value, '')), '') is null then null
    else encode(sha256(convert_to(btrim(p_value), 'UTF8')), 'hex')
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- Las guardas de PII. Complementan —no sustituyen— las de tarjeta de P09.
-- ---------------------------------------------------------------------------

/** Claves que no pueden aparecer en un payload de analitica, auditoria u operacion. */
create or replace function ebim.pii_json_keys()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array[
    -- Contacto
    'email', 'e_mail', 'mail', 'correo', 'customer_email', 'contact_email',
    'phone', 'telephone', 'telefono', 'celular', 'mobile', 'msisdn',
    'customer_phone', 'contact_phone', 'whatsapp',
    -- Nombre de una PERSONA. `name` a secas NO entra: el nombre de un producto
    -- o de un metodo de entrega es dato de negocio, y prohibirlo dejaria a la
    -- analitica sin poder decir QUE se vendio.
    'full_name', 'first_name', 'last_name', 'given_name', 'family_name',
    'customer_name', 'contact_name', 'nombre', 'apellido', 'apellidos',
    -- Documento y fiscalidad de la persona
    'dni', 'ruc', 'nif', 'cif', 'document_number', 'documento', 'tax_id',
    'national_id', 'passport',
    -- Domicilio
    'address', 'address_line1', 'address_line2', 'direccion', 'street',
    'postal_code', 'zip', 'zipcode',
    -- Rastro tecnico que identifica a una persona
    'ip', 'ip_address', 'remote_addr', 'user_agent', 'device_id', 'session_id',
    'birthdate', 'birth_date', 'fecha_nacimiento'
  ]::text[];
$fn$;

/**
 * Un texto con forma de correo. Deliberadamente conservador: exige arroba,
 * etiqueta antes y despues, y un TLD alfabetico de dos letras o mas. Un
 * `sku@2x` no es un correo, y bloquearlo obligaria a alguien a apagar el CHECK,
 * que es como se pierden estas guardas.
 */
create or replace function ebim.looks_like_email(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(p_value ~* '[A-Z0-9._+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}', false);
$fn$;

/**
 * ¿Este jsonb esta limpio de PII y de datos de tarjeta? Recorre objeto y array
 * a cualquier profundidad. Se usa como CHECK, igual que `jsonb_is_card_safe`, y
 * por la misma razon: la comprobacion en el borde se puede desplegar mal o
 * saltarse con un insert de `service_role`; un CHECK, no.
 */
create or replace function ebim.jsonb_is_pii_free(p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  with recursive nodes(k, v) as (
    select null::text, coalesce(p_payload, '{}'::jsonb)
    union all
    select c.k, c.v
    from nodes n
    cross join lateral (
      select je.key as k, je.value as v
      from jsonb_each(case when jsonb_typeof(n.v) = 'object' then n.v else '{}'::jsonb end) je
      union all
      select n.k as k, ae.value as v
      from jsonb_array_elements(case when jsonb_typeof(n.v) = 'array' then n.v else '[]'::jsonb end) ae
    ) c
  )
  select not exists (
    select 1
    from nodes
    where (
            -- Una clave prohibida es un problema salvo que su valor sea
            -- EXACTAMENTE la marca de redaccion. Sin esta excepcion, el CHECK
            -- rechazaria lo que `ebim.redact_pii` acaba de dejar limpio —la
            -- redaccion conserva la clave y sustituye el valor, que es lo que
            -- permite saber que ahi habia algo— y la puerta de la vitrina no
            -- podria escribir ni un hecho con un `props.email` dentro. La
            -- guarda no se debilita: `'[redactado]'` es un literal, no un dato.
            nodes.k is not null
            and (lower(nodes.k) = any (ebim.pii_json_keys())
                 or lower(nodes.k) = any (ebim.sensitive_json_keys()))
            and nodes.v is distinct from to_jsonb('[redactado]'::text)
          )
       or (jsonb_typeof(nodes.v) = 'string' and ebim.looks_like_pan(nodes.v #>> '{}'))
       or (jsonb_typeof(nodes.v) = 'string' and ebim.looks_like_email(nodes.v #>> '{}'))
  );
$fn$;

/**
 * Deja el jsonb limpio en vez de rechazarlo, como hace `ebim.redact_sensitive`
 * con el sobre de un webhook y por la misma razon: perder el hecho es peor que
 * guardarlo redactado. Un comprador que teclea su correo en el buscador no
 * puede quedarse sin poder buscar.
 */
create or replace function ebim.redact_pii(p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_out jsonb;
  v_key text;
  v_val jsonb;
begin
  if p_payload is null then
    return null;
  end if;

  if jsonb_typeof(p_payload) = 'object' then
    v_out := '{}'::jsonb;
    for v_key, v_val in select key, value from jsonb_each(p_payload) loop
      if lower(v_key) = any (ebim.pii_json_keys())
         or lower(v_key) = any (ebim.sensitive_json_keys()) then
        v_out := v_out || jsonb_build_object(v_key, '[redactado]');
      else
        v_out := v_out || jsonb_build_object(v_key, ebim.redact_pii(v_val));
      end if;
    end loop;
    return v_out;
  end if;

  if jsonb_typeof(p_payload) = 'array' then
    return coalesce(
      (select jsonb_agg(ebim.redact_pii(e)) from jsonb_array_elements(p_payload) e),
      '[]'::jsonb);
  end if;

  if jsonb_typeof(p_payload) = 'string'
     and (ebim.looks_like_pan(p_payload #>> '{}') or ebim.looks_like_email(p_payload #>> '{}')) then
    return to_jsonb('[redactado]'::text);
  end if;

  return p_payload;
end;
$fn$;

/** Texto libre que va a una bitacora: sin correo, sin tarjeta y acotado. */
create or replace function ebim.redact_text(p_value text, p_max integer default 500)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when nullif(btrim(coalesce(p_value, '')), '') is null then null
    when ebim.looks_like_pan(btrim(p_value)) or ebim.looks_like_email(btrim(p_value))
      then '[redactado]'
    else left(btrim(p_value), greatest(1, coalesce(p_max, 500)))
  end;
$fn$;

revoke execute on function
  ebim.correlation_id(), ebim.request_id(), ebim.hash_token(text),
  ebim.pii_json_keys(), ebim.looks_like_email(text),
  ebim.jsonb_is_pii_free(jsonb), ebim.redact_pii(jsonb), ebim.redact_text(text, integer)
from public;

-- Las evaluan CHECKs y DEFAULTs que corren como el llamante —un insert de la
-- vitrina, uno del backoffice, uno del servidor—, asi que el permiso lo
-- necesita quien escribe y no el propietario de la tabla. Es la misma
-- concesion, y con el mismo alcance, que P09 hizo con las guardas de tarjeta:
-- son funciones PURAS que no leen ni una fila de negocio.
grant execute on function
  ebim.correlation_id(), ebim.request_id(), ebim.hash_token(text),
  ebim.pii_json_keys(), ebim.looks_like_email(text),
  ebim.jsonb_is_pii_free(jsonb), ebim.redact_pii(jsonb), ebim.redact_text(text, integer)
to anon, authenticated, service_role;

-- =============================================================================
-- El hilo, cosido a las ocho tablas por las que pasa un incidente de compra.
--
-- La lista no es «todas las tablas»: es EL CAMINO que recorre una compra que
-- sale mal, que es lo que la Definition of Done exige poder reconstruir.
--
--   checkout_intents   donde empezo y en que etapa se rompio
--   orders             que llego a existir, si es que llego
--   payment_intents    si el dinero se movio
--   payment_events     que dijo la pasarela
--   fulfillments       si salio de almacen
--   domain_events      que hechos se publicaron
--   integration_outbox / integration_inbox   que se mando fuera y que entro
--
-- Se anade como columna con DEFAULT y no se toca ni una funcion. Las filas
-- anteriores a esta migracion quedan en NULL, que es la verdad: de ellas no se
-- guardo el hilo.
-- =============================================================================
alter table public.checkout_intents   add column correlation_id text default ebim.correlation_id();
alter table public.orders             add column correlation_id text default ebim.correlation_id();
alter table public.payment_intents    add column correlation_id text default ebim.correlation_id();
alter table public.payment_events     add column correlation_id text default ebim.correlation_id();
alter table public.fulfillments       add column correlation_id text default ebim.correlation_id();
alter table public.domain_events      add column correlation_id text default ebim.correlation_id();
alter table public.integration_outbox add column correlation_id text default ebim.correlation_id();
alter table public.integration_inbox  add column correlation_id text default ebim.correlation_id();

-- Indices parciales: la consulta real es «dame TODO lo del hilo X», nunca «dame
-- todo lo que no tiene hilo». Sin el `where` el indice cargaria con las filas
-- historicas, que son justo las que no interesan.
create index checkout_intents_correlation_idx
  on public.checkout_intents (correlation_id) where correlation_id is not null;
create index orders_correlation_idx
  on public.orders (correlation_id) where correlation_id is not null;
create index payment_intents_correlation_idx
  on public.payment_intents (correlation_id) where correlation_id is not null;
create index payment_events_correlation_idx
  on public.payment_events (correlation_id) where correlation_id is not null;
create index fulfillments_correlation_idx
  on public.fulfillments (correlation_id) where correlation_id is not null;
create index domain_events_correlation_idx
  on public.domain_events (correlation_id) where correlation_id is not null;
create index integration_outbox_correlation_idx
  on public.integration_outbox (correlation_id) where correlation_id is not null;
create index integration_inbox_correlation_idx
  on public.integration_inbox (correlation_id) where correlation_id is not null;

-- `checkout_intents` es la unica de las ocho con GRANT POR COLUMNA (P07: ni
-- `reservation_token` ni `result` salen al backoffice). Un GRANT por columna no
-- crece solo, asi que sin esta linea el hilo del checkout —justo el que la
-- Definition of Done nombra— seria invisible para el comercio.
grant select (correlation_id) on public.checkout_intents to authenticated;

comment on column public.checkout_intents.correlation_id is
  'Hilo de la peticion. Lo pone el DEFAULT ebim.correlation_id(), nunca un argumento: asi ninguna funcion de dominio tuvo que cambiar.';
comment on column public.orders.correlation_id is
  'Hilo de la peticion que creo el pedido. NULL en los pedidos anteriores a P13: de ellos no se guardo.';
