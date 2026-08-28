-- =============================================================================
-- P14-SaaS · 4/7 — La API EMPRESARIAL: credenciales, scopes, tasa e idempotencia
--
-- ## Tres APIs distintas, y esta es la tercera
--
-- Este repositorio ya expone dos superficies y ninguna sirve para lo que pide
-- la fase:
--
--   1. **API del navegador** — PostgREST con la clave publicable y el JWT del
--      usuario. La autoridad es la RLS. Su contrato es el ESQUEMA, y por eso
--      cambia cuando cambia una columna.
--   2. **API publica de la vitrina** — las vistas `public_*` y las funciones
--      `*_for_slug`, para un comprador anonimo. Solo lectura de lo publicado.
--   3. **API de socio / empresarial** — ESTA. La consume el sistema de un
--      tercero, sin navegador y sin sesion de persona.
--
-- La regla que separa la tercera de la primera esta escrita en el encargo: «no
-- expongas Supabase como contrato empresarial directo si eso acopla a clientes
-- externos». Un socio que integra contra PostgREST queda atado a nuestros
-- nombres de tabla, a nuestro dialecto de filtros y a nuestra forma de error; el
-- dia que renombramos una columna, se rompe su integracion y la culpa es
-- nuestra. Por eso la API empresarial tiene:
--
--   · **version en la ruta** (`/v1/...`) y no en una cabecera opcional;
--   · **recursos**, no tablas — `orders`, `products`, `stock`, `customers`;
--   · **errores canonicos** con codigo estable, no el `message` de PostgREST;
--   · **scopes** con el vocabulario canonico del dominio (`order.create`,
--     `stock.read`), el MISMO que ya usan `integration_providers.capabilities`
--     y `integration_outbox.operation`. Tres cosas, un vocabulario.
--
-- ## La propiedad que hace imposible el cruce de tenants
--
-- Ninguna funcion de recurso acepta `organization_id` ni `company_id`. Aceptan
-- el **id del cliente de API** y derivan el tenant de SU FILA. No es que el
-- parametro se valide: es que **no existe el parametro**. Es la misma tecnica
-- que `public.my_business_accounts()` (P05) llevo al extremo de no aceptar
-- ningun argumento. Un borde mal escrito no puede cruzar tenants porque no hay
-- forma de pedirselo.
--
-- ## HTTPS: lo que esta app asume y lo que NO puede garantizar
--
-- El transporte es TLS 1.2+ y lo termina la plataforma (Supabase Edge Runtime),
-- no este codigo: una Edge Function no escucha en texto claro y no hay forma de
-- desplegarla en http. Por eso aqui NO hay una comprobacion de esquema — seria
-- teatro, porque la peticion ya llego cifrada o no llego—. Lo que SI vive en la
-- base es la mitad que si depende de nosotros: los secretos se guardan como
-- sha256 y nunca en claro, el token viaja una sola vez en la respuesta del
-- `token endpoint`, y toda URL a la que NOSOTROS llamamos (webhooks) esta
-- obligada a https por un CHECK.
--
-- ## Por que la base guarda el HASH del token y el borde le pasa el hash
--
-- `api_authenticate` recibe `p_token_hash`, no el token. Asi el secreto de
-- portador no entra jamas en el registro de sentencias de Postgres, que es
-- donde acaban los parametros cuando alguien sube el nivel de log para
-- diagnosticar otra cosa. El coste es una linea en el borde; el beneficio es
-- que un `log_min_duration_statement = 0` puesto un martes no filtra las
-- credenciales de todos los socios.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.random_token — entropia sin depender de `pgcrypto`
--
-- `gen_random_bytes` vive en la extension pgcrypto, que este proyecto no
-- habilita. Dos uuid v4 son 244 bits de aleatoriedad del mismo generador que ya
-- produce todas las claves primarias; el sha256 los mezcla y da 64 caracteres
-- hexadecimales. No se inventa criptografia: se usa la que la base ya trae.
-- ---------------------------------------------------------------------------
create or replace function ebim.random_token()
returns text
language sql
volatile
set search_path = ''
as $fn$
  select encode(
    sha256(convert_to(
      gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text,
      'UTF8')),
    'hex');
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.api_scope_catalog — el vocabulario de scopes, en un solo sitio
--
-- Es una FUNCION y no una tabla a proposito. Una tabla de scopes seria un
-- catalogo global mas al que habria que eximir del aislamiento multitenant, y
-- lo que describe no es un dato: es el contrato del producto, igual que el
-- formato de `integration_outbox.operation`. Los tests de contrato comparan
-- esta lista con la de TypeScript y con las rutas declaradas en el borde, asi
-- que un scope que nadie sirve —o una ruta que pide un scope inexistente— pone
-- la suite roja.
--
-- Solo estan los scopes que tienen recurso DETRAS. `invoice.*` no aparece
-- porque esta app no emite facturas: declararlo dejaria en el contrato publico
-- una promesa que nadie cumple, y un socio la integraria.
-- ---------------------------------------------------------------------------
create or replace function ebim.api_scope_catalog()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array[
    'order.read',
    'order.create',
    'product.read',
    'stock.read',
    'customer.read'
  ]::text[];
$fn$;

-- ---------------------------------------------------------------------------
-- api_clients — la credencial de un socio, por SOCIEDAD
--
-- Una credencial pertenece a una sociedad, no a la cuenta: el ERP de la filial
-- A no lee los pedidos de la filial B aunque sean del mismo grupo. Es la misma
-- regla de jerarquia del contrato §3 aplicada a un actor que no es una persona.
-- ---------------------------------------------------------------------------
create table public.api_clients (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  name            text        not null,
  description     text,
  -- Identificador PUBLICO. Viaja en claro, identifica y no autoriza.
  client_id       text        not null unique,
  -- sha256 del secreto. El secreto en claro no existe en ninguna fila de esta
  -- base: se devuelve UNA vez, al crearlo o al rotarlo.
  secret_hash     text        not null,
  -- Ultimos seis caracteres, para reconocer cual de las tres credenciales es
  -- sin poder reconstruirla. Es lo mismo que `gift_cards.code_last4` (P10).
  secret_hint     text        not null,
  scopes          text[]      not null default '{}',
  is_active       boolean     not null default true,
  -- Techo de peticiones por minuto. Por cliente y no global: un socio que se
  -- vuelve loco no puede dejar sin servicio a los otros socios del tenant.
  rate_limit_per_minute integer not null default 120,
  -- Caducidad de la credencial. NULL = sin caducidad, que es lo que quiere una
  -- integracion estable; una fecha, para accesos temporales de un implantador.
  expires_at      timestamptz,
  last_used_at    timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint api_clients_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint api_clients_desc_len check (description is null or char_length(description) <= 300),
  constraint api_clients_client_id_fmt check (client_id ~ '^ec_[a-f0-9]{32}$'),
  constraint api_clients_secret_hash_fmt check (secret_hash ~ '^[a-f0-9]{64}$'),
  constraint api_clients_secret_hint_fmt check (secret_hint ~ '^[a-f0-9]{6}$'),
  constraint api_clients_rate_limit check (rate_limit_per_minute between 1 and 6000),
  -- Un scope fuera del catalogo es un permiso que nadie hace cumplir: se
  -- rechaza en la base, no en la revision de codigo.
  constraint api_clients_scopes_known
    check (scopes <@ ebim.api_scope_catalog()),
  -- Una credencial sin ningun scope no puede hacer nada y confunde: parece
  -- concedida y no lo esta.
  constraint api_clients_scopes_present check (cardinality(scopes) > 0)
);

create index api_clients_tenant_idx on public.api_clients (organization_id, company_id);
create index api_clients_lookup_idx on public.api_clients (client_id) where is_active;

-- ---------------------------------------------------------------------------
-- api_access_tokens — los tokens vivos del grant `client_credentials`
--
-- Token corto y renovable en vez de la credencial viajando en cada peticion:
-- un token que caduca en una hora limita la ventana de una filtracion en los
-- logs de un proxy del socio, que es por donde de verdad se escapan.
--
-- Se guarda el HASH. Un token robado de esta tabla no sirve para nada.
-- ---------------------------------------------------------------------------
create table public.api_access_tokens (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  api_client_id   uuid        not null references public.api_clients (id) on delete cascade,
  token_hash      text        not null unique,
  -- Scopes EFECTIVOS del token: la interseccion de lo pedido con lo concedido.
  -- Se congelan aqui para que quitarle un scope al cliente no amplie ni reduzca
  -- un token ya emitido de forma sorprendente — caduca solo.
  scopes          text[]      not null,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),

  constraint api_access_tokens_hash_fmt check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint api_access_tokens_scopes_known check (scopes <@ ebim.api_scope_catalog()),
  constraint api_access_tokens_window check (expires_at > issued_at)
);

create index api_access_tokens_tenant_idx on public.api_access_tokens (organization_id, company_id);
create index api_access_tokens_client_idx on public.api_access_tokens (api_client_id, issued_at desc);
create index api_access_tokens_live_idx
  on public.api_access_tokens (expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- api_requests — el contador con ventana Y el pulso del socio
--
-- Dos usos con una tabla, como `checkout_attempts` (P10): cuenta para el limite
-- de tasa y da al monitor «cuando llamo por ultima vez y con que resultado».
-- NO guarda cuerpos ni cabeceras: un registro de peticiones con payloads dentro
-- es la copia sin control de acceso de todo lo que pasa por la API.
-- ---------------------------------------------------------------------------
create table public.api_requests (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  api_client_id   uuid        not null references public.api_clients (id) on delete cascade,
  method          text        not null,
  route           text        not null,
  status          integer,
  correlation_id  text        default ebim.correlation_id(),
  created_at      timestamptz not null default now(),

  constraint api_requests_method check (method in ('GET','POST','PUT','PATCH','DELETE')),
  constraint api_requests_route_fmt check (route ~ '^/v[0-9]{1,3}(/[A-Za-z0-9_{}.-]+)*$'),
  constraint api_requests_status check (status is null or status between 100 and 599),
  constraint api_requests_correlation_fmt
    check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9_.:-]{8,120}$')
);

create index api_requests_tenant_idx on public.api_requests (organization_id, company_id);
create index api_requests_window_idx on public.api_requests (api_client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- api_idempotency — la misma clave dos veces es UNA operacion
--
-- Sin esto, un socio cuyo cliente HTTP reintenta un `POST /v1/orders` al primer
-- tiempo agotado crea dos pedidos, descuenta dos veces existencia y consume dos
-- numeros de pedido. Y el reintento es AUTOMATICO en casi todas las librerias:
-- no es un caso raro, es el caso normal.
--
-- `request_hash` no es decoracion: sin el, reusar la misma clave con otro
-- cuerpo devolveria la respuesta del cuerpo ANTERIOR y el socio creeria que
-- creo el pedido que acaba de mandar. Con el, eso es un 409 explicito.
-- ---------------------------------------------------------------------------
create table public.api_idempotency (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  api_client_id   uuid        not null references public.api_clients (id) on delete cascade,
  idempotency_key text        not null,
  request_hash    text        not null,
  status          integer,
  -- La respuesta guardada. Lleva datos de negocio del propio tenant, asi que
  -- NO tiene GRANT de lectura para `authenticated`: el backoffice ve que hubo
  -- una operacion idempotente y con que resultado, no su contenido.
  response        jsonb,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),

  constraint api_idempotency_key_len check (char_length(idempotency_key) between 8 and 200),
  constraint api_idempotency_hash_fmt check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint api_idempotency_status check (status is null or status between 100 and 599),
  constraint api_idempotency_unique unique (api_client_id, idempotency_key)
);

create index api_idempotency_tenant_idx on public.api_idempotency (organization_id, company_id);
create index api_idempotency_age_idx on public.api_idempotency (created_at);

-- =============================================================================
-- COMANDOS DEL BACKOFFICE — crear y rotar credenciales
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.api_client_create — la unica forma de que exista una credencial
--
-- No hay policy de INSERT sobre `api_clients`: el secreto tiene que generarse
-- en el servidor y devolverse UNA vez. Si el navegador pudiera insertar, podria
-- elegir el hash — que es lo mismo que elegir el secreto.
-- ---------------------------------------------------------------------------
create or replace function public.api_client_create(
  p_name        text,
  p_scopes      text[],
  p_description text        default null,
  p_rate_limit  integer     default null,
  p_expires_at  timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org       uuid := ebim.org_id();
  v_company   uuid := ebim.active_company();
  v_secret    text;
  v_client_id text;
  v_row       public.api_clients%rowtype;
  v_scopes    text[];
begin
  if v_org is null or v_company is null then
    raise exception 'SIN_PERMISO: el token no trae la jerarquia de tenant'
      using errcode = '42501';
  end if;
  if not ebim.has_role(v_org, v_company, array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: crear credenciales de API es cosa del propietario o un administrador'
      using errcode = '42501';
  end if;
  perform ebim.assert_integrations_enterprise();

  v_scopes := coalesce(p_scopes, '{}'::text[]);
  if cardinality(v_scopes) = 0 then
    raise exception 'SCOPES_REQUERIDOS: una credencial sin permisos no puede hacer nada'
      using errcode = '22023';
  end if;
  if not (v_scopes <@ ebim.api_scope_catalog()) then
    raise exception 'SCOPE_DESCONOCIDO: hay permisos que esta API no reconoce'
      using errcode = '22023';
  end if;

  v_secret    := ebim.random_token();
  v_client_id := 'ec_' || left(ebim.random_token(), 32);

  insert into public.api_clients (
    organization_id, company_id, name, description, client_id,
    secret_hash, secret_hint, scopes, rate_limit_per_minute, expires_at, created_by
  ) values (
    v_org, v_company, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''),
    v_client_id, ebim.hash_token(v_secret), right(v_secret, 6),
    v_scopes, coalesce(p_rate_limit, 120), p_expires_at, ebim.user_id()
  )
  returning * into v_row;

  -- El secreto sale AQUI y no vuelve a salir nunca. Es deliberado: una
  -- credencial que se puede releer es una credencial que acaba en un correo.
  return jsonb_build_object(
    'id',            v_row.id,
    'client_id',     v_row.client_id,
    'client_secret', v_secret,
    'scopes',        to_jsonb(v_row.scopes),
    'expires_at',    v_row.expires_at,
    'rate_limit_per_minute', v_row.rate_limit_per_minute);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.api_client_rotate_secret — rotar sin perder la identidad
--
-- El `client_id` no cambia: el socio no tiene que volver a configurar quien es,
-- solo con que se autentica. Todos los tokens vivos se revocan en el acto,
-- porque rotar un secreto por sospecha de filtracion y dejar vivos los tokens
-- que salieron de el no revoca nada.
-- ---------------------------------------------------------------------------
create or replace function public.api_client_rotate_secret(p_client_ref uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row    public.api_clients%rowtype;
  v_secret text;
begin
  select * into v_row from public.api_clients where id = p_client_ref;
  if not found then
    raise exception 'CREDENCIAL_NO_ENCONTRADA: no existe esa credencial'
      using errcode = '22023';
  end if;
  if not ebim.has_role(v_row.organization_id, v_row.company_id,
                       array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: rotar una credencial es cosa del propietario o un administrador'
      using errcode = '42501';
  end if;

  v_secret := ebim.random_token();

  update public.api_clients
     set secret_hash = ebim.hash_token(v_secret),
         secret_hint = right(v_secret, 6)
   where id = p_client_ref;

  update public.api_access_tokens
     set revoked_at = now()
   where api_client_id = p_client_ref and revoked_at is null;

  perform ebim.audit(
    p_organization_id => v_row.organization_id,
    p_company_id      => v_row.company_id,
    p_action          => 'api_client.secret_rotated',
    p_entity_type     => 'api_client',
    p_entity_id       => v_row.id,
    p_entity_label    => v_row.name);

  return jsonb_build_object('id', v_row.id, 'client_id', v_row.client_id,
                            'client_secret', v_secret);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Desactivar una credencial revoca sus tokens EN EL ACTO
--
-- Va en trigger y no dentro de un comando para que valga para todos los caminos
-- —la pantalla, un `update` del servidor, un script de emergencia—. Sin esto,
-- «desactivar» dejaria al socio operando hasta una hora mas, que es justo el
-- rato en el que importa.
-- ---------------------------------------------------------------------------
create or replace function ebim.api_client_revoke_tokens()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if old.is_active and not new.is_active then
    update public.api_access_tokens
       set revoked_at = now()
     where api_client_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$fn$;

create trigger api_clients_revoke_tokens
  after update of is_active on public.api_clients
  for each row execute function ebim.api_client_revoke_tokens();

-- =============================================================================
-- EL BORDE — emision, verificacion, tasa e idempotencia. Todo `service_role`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.api_token_issue — el grant `client_credentials` de OAuth 2.0
--
-- Mismo mensaje para «ese cliente no existe» y «ese secreto no es»: distinguir
-- los dos casos es un oraculo que convierte adivinar credenciales en adivinar
-- solo secretos.
-- ---------------------------------------------------------------------------
create or replace function public.api_token_issue(
  p_client_id   text,
  p_secret      text,
  p_scopes      text[] default null,
  p_ttl_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row      public.api_clients%rowtype;
  v_token    text;
  v_scopes   text[];
  v_ttl      integer := greatest(60, least(coalesce(p_ttl_seconds, 3600), 86400));
  v_expires  timestamptz;
begin
  select * into v_row
  from public.api_clients c
  where c.client_id = p_client_id;

  if not found
     or not v_row.is_active
     or v_row.secret_hash is distinct from ebim.hash_token(p_secret)
     or (v_row.expires_at is not null and v_row.expires_at <= now()) then
    raise exception 'CREDENCIAL_INVALIDA: cliente o secreto no validos'
      using errcode = '42501';
  end if;

  -- Sin scopes pedidos, se emiten TODOS los concedidos. Con scopes pedidos, la
  -- interseccion: pedir mas de lo concedido no amplia nada y no es un error —
  -- es como se comporta el `scope` de OAuth 2.0 (RFC 6749 §3.3).
  v_scopes := coalesce(
    (select array_agg(s) from unnest(coalesce(p_scopes, v_row.scopes)) as s
      where s = any (v_row.scopes)),
    '{}'::text[]);

  if cardinality(v_scopes) = 0 then
    raise exception 'SCOPE_INSUFICIENTE: ninguno de los permisos pedidos esta concedido'
      using errcode = '42501';
  end if;

  v_token   := ebim.random_token();
  v_expires := now() + make_interval(secs => v_ttl);

  insert into public.api_access_tokens
    (organization_id, company_id, api_client_id, token_hash, scopes, expires_at)
  values (v_row.organization_id, v_row.company_id, v_row.id,
          ebim.hash_token(v_token), v_scopes, v_expires);

  return jsonb_build_object(
    'access_token', v_token,
    'token_type',   'Bearer',
    'expires_in',   v_ttl,
    'scope',        array_to_string(v_scopes, ' '));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.api_authenticate — token (ya hasheado) + scope exigido → tenant
--
-- Devuelve el contexto o levanta. Nunca devuelve «no autorizado» como dato:
-- un borde que se olvidara de mirar la respuesta seguiria estando cerrado.
-- ---------------------------------------------------------------------------
create or replace function public.api_authenticate(
  p_token_hash text,
  p_scope      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_token  public.api_access_tokens%rowtype;
  v_client public.api_clients%rowtype;
begin
  select * into v_token
  from public.api_access_tokens t
  where t.token_hash = p_token_hash;

  if not found or v_token.revoked_at is not null then
    raise exception 'TOKEN_INVALIDO: el token no existe o fue revocado'
      using errcode = '42501';
  end if;
  if v_token.expires_at <= now() then
    raise exception 'TOKEN_EXPIRADO: el token caduco, pide otro'
      using errcode = '42501';
  end if;

  select * into v_client from public.api_clients c where c.id = v_token.api_client_id;
  if not found or not v_client.is_active
     or (v_client.expires_at is not null and v_client.expires_at <= now()) then
    raise exception 'TOKEN_INVALIDO: la credencial que lo emitio ya no esta activa'
      using errcode = '42501';
  end if;

  if p_scope is not null and not (p_scope = any (v_token.scopes)) then
    raise exception 'SCOPE_INSUFICIENTE: este token no incluye %', p_scope
      using errcode = '42501';
  end if;

  update public.api_clients set last_used_at = now() where id = v_client.id;

  return jsonb_build_object(
    'api_client_id',   v_client.id,
    'client_id',       v_client.client_id,
    'organization_id', v_client.organization_id,
    'company_id',      v_client.company_id,
    'scopes',          to_jsonb(v_token.scopes),
    'rate_limit_per_minute', v_client.rate_limit_per_minute);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.api_authorize — la comprobacion que va DENTRO de cada recurso
--
-- Devuelve el tenant derivado de la fila del cliente. Es la pieza que hace que
-- una funcion de recurso no necesite —ni acepte— parametros de tenant.
-- ---------------------------------------------------------------------------
create or replace function ebim.api_authorize(
  p_api_client_id uuid,
  p_scope         text
)
returns public.api_clients
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_row public.api_clients%rowtype;
begin
  select * into v_row from public.api_clients c where c.id = p_api_client_id;
  if not found or not v_row.is_active
     or (v_row.expires_at is not null and v_row.expires_at <= now()) then
    raise exception 'TOKEN_INVALIDO: la credencial no existe o no esta activa'
      using errcode = '42501';
  end if;
  if not (p_scope = any (v_row.scopes)) then
    raise exception 'SCOPE_INSUFICIENTE: la credencial no incluye %', p_scope
      using errcode = '42501';
  end if;
  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- public.api_rate_limit_hit — contar y decidir en la MISMA transaccion
--
-- Igual que `ebim.assert_checkout_allowed` (P10): entre comprobar y registrar
-- no cabe otra peticion. Devuelve el id de la peticion para que el borde le
-- ponga despues el estado.
-- ---------------------------------------------------------------------------
create or replace function public.api_rate_limit_hit(
  p_api_client_id uuid,
  p_method        text,
  p_route         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row       public.api_clients%rowtype;
  v_count     integer;
  v_request   uuid;
begin
  select * into v_row from public.api_clients c where c.id = p_api_client_id;
  if not found then
    raise exception 'TOKEN_INVALIDO: la credencial no existe'
      using errcode = '42501';
  end if;

  select count(*) into v_count
  from public.api_requests r
  where r.api_client_id = p_api_client_id
    and r.created_at > now() - interval '1 minute';

  if v_count >= v_row.rate_limit_per_minute then
    raise exception 'LIMITE_DE_TASA: esta credencial supero % peticiones por minuto',
      v_row.rate_limit_per_minute
      using errcode = '22023';
  end if;

  insert into public.api_requests
    (organization_id, company_id, api_client_id, method, route)
  values (v_row.organization_id, v_row.company_id, p_api_client_id,
          upper(p_method), p_route)
  returning id into v_request;

  return jsonb_build_object(
    'request_id', v_request,
    'limit',      v_row.rate_limit_per_minute,
    'remaining',  greatest(0, v_row.rate_limit_per_minute - v_count - 1));
end;
$fn$;

create or replace function public.api_request_complete(
  p_request_id uuid,
  p_status     integer
)
returns void
language sql
volatile
security definer
set search_path = ''
as $fn$
  update public.api_requests set status = p_status where id = p_request_id;
$fn$;

-- ---------------------------------------------------------------------------
-- Idempotencia: reservar la clave ANTES de operar
--
-- `insert ... on conflict do nothing` y no «mira si existe y si no, escribe»:
-- entre mirar y escribir caben dos reintentos simultaneos del mismo socio, que
-- es exactamente cuando esto importa.
-- ---------------------------------------------------------------------------
create or replace function public.api_idempotency_begin(
  p_api_client_id uuid,
  p_key           text,
  p_request_hash  text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_client public.api_clients%rowtype;
  v_id     uuid;
  v_row    public.api_idempotency%rowtype;
begin
  select * into v_client from public.api_clients c where c.id = p_api_client_id;
  if not found then
    raise exception 'TOKEN_INVALIDO: la credencial no existe'
      using errcode = '42501';
  end if;

  insert into public.api_idempotency
    (organization_id, company_id, api_client_id, idempotency_key, request_hash)
  values (v_client.organization_id, v_client.company_id, p_api_client_id,
          p_key, p_request_hash)
  on conflict (api_client_id, idempotency_key) do nothing
  returning id into v_id;

  -- Clave nueva: el borde puede operar.
  if v_id is not null then
    return jsonb_build_object('status', 'nuevo');
  end if;

  select * into v_row
  from public.api_idempotency i
  where i.api_client_id = p_api_client_id and i.idempotency_key = p_key;

  if v_row.request_hash is distinct from p_request_hash then
    raise exception 'IDEMPOTENCIA_CONFLICTO: esa clave ya se uso con otro contenido'
      using errcode = '22023';
  end if;

  -- Misma clave, mismo contenido y respuesta ya guardada: se devuelve tal cual.
  if v_row.completed_at is not null then
    return jsonb_build_object('status', 'repetido',
                              'http_status', v_row.status,
                              'response', v_row.response);
  end if;

  -- Misma clave, mismo contenido y TODAVIA en curso. No se opera dos veces.
  return jsonb_build_object('status', 'en_curso');
end;
$fn$;

create or replace function public.api_idempotency_finish(
  p_api_client_id uuid,
  p_key           text,
  p_status        integer,
  p_response      jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $fn$
  update public.api_idempotency
     set status = p_status, response = p_response, completed_at = now()
   where api_client_id = p_api_client_id and idempotency_key = p_key;
$fn$;

-- ---------------------------------------------------------------------------
-- Purgas. Ni el contador de tasa ni la memoria de idempotencia son bitacoras:
-- sin purga crecen sin fin y degradan justo la ruta mas caliente.
-- ---------------------------------------------------------------------------
create or replace function public.purge_api_requests(p_older_than interval default '48 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_n integer;
begin
  delete from public.api_requests where created_at < now() - p_older_than;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

create or replace function public.purge_api_idempotency(p_older_than interval default '48 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_n integer;
begin
  delete from public.api_idempotency where created_at < now() - p_older_than;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

create or replace function public.purge_api_tokens(p_older_than interval default '7 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_n integer;
begin
  delete from public.api_access_tokens
   where expires_at < now() - p_older_than;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

-- =============================================================================
-- RLS y permisos
-- =============================================================================
alter table public.api_clients       enable row level security;
alter table public.api_clients       force  row level security;
alter table public.api_access_tokens enable row level security;
alter table public.api_access_tokens force  row level security;
alter table public.api_requests      enable row level security;
alter table public.api_requests      force  row level security;
alter table public.api_idempotency   enable row level security;
alter table public.api_idempotency   force  row level security;

revoke all on public.api_clients, public.api_access_tokens,
              public.api_requests, public.api_idempotency
  from public, anon, authenticated;

grant all on public.api_clients, public.api_access_tokens,
             public.api_requests, public.api_idempotency
  to service_role;

-- GRANT POR COLUMNA, no por fila: la RLS filtra filas y nunca columnas. El
-- `secret_hash` no sale ni a un `owner`. No protege del propietario legitimo
-- —que puede rotar el secreto cuando quiera— sino del `select *` que acaba en
-- una exportacion, en una captura de pantalla o en un ticket de soporte.
grant select (id, organization_id, company_id, name, description, client_id,
              secret_hint, scopes, is_active, rate_limit_per_minute,
              expires_at, last_used_at, created_by, created_at, updated_at)
  on public.api_clients to authenticated;

-- Y ESCRITURA por columna: lo que se puede cambiar desde la pantalla no incluye
-- ni el hash ni la pista. Poder escribir `secret_hash` es poder elegir el
-- secreto, que es exactamente lo que `api_client_create` existe para impedir.
grant update (name, description, scopes, is_active, rate_limit_per_minute, expires_at)
  on public.api_clients to authenticated;
grant delete on public.api_clients to authenticated;

-- Los tokens: se ve que existen y cuando caducan, nunca su hash.
grant select (id, organization_id, company_id, api_client_id, scopes,
              issued_at, expires_at, revoked_at, created_at)
  on public.api_access_tokens to authenticated;

grant select on public.api_requests to authenticated;

-- La memoria de idempotencia SIN la respuesta: que hubo una operacion y con que
-- resultado, no su contenido.
grant select (id, organization_id, company_id, api_client_id, idempotency_key,
              status, completed_at, created_at)
  on public.api_idempotency to authenticated;

create policy api_clients_select_member on public.api_clients
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy api_clients_update_admin on public.api_clients
  for update to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
              and ebim.has_capability(organization_id, company_id, 'integrations.enterprise'));

create policy api_clients_delete_admin on public.api_clients
  for delete to authenticated
  using (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy api_access_tokens_select_member on public.api_access_tokens
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy api_requests_select_member on public.api_requests
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy api_idempotency_select_member on public.api_idempotency
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create trigger api_clients_updated_at before update on public.api_clients
  for each row execute function ebim.set_updated_at();

-- Bitacora. `secret_hash` se tapa con el tercer argumento, igual que
-- `gift_cards.code` (P10): un hash en la bitacora es material para atacar
-- fuera de linea, y la bitacora la leen `owner` y `admin`.
create trigger api_clients_audit
  after insert or update or delete on public.api_clients
  for each row execute function ebim.audit_row('api_client', 'name', 'secret_hash');

-- ---------------------------------------------------------------------------
-- Permisos de funcion
-- ---------------------------------------------------------------------------
revoke execute on function
  ebim.random_token(),
  ebim.api_authorize(uuid, text),
  ebim.api_client_revoke_tokens(),
  public.api_token_issue(text, text, text[], integer),
  public.api_authenticate(text, text),
  public.api_rate_limit_hit(uuid, text, text),
  public.api_request_complete(uuid, integer),
  public.api_idempotency_begin(uuid, text, text),
  public.api_idempotency_finish(uuid, text, integer, jsonb),
  public.purge_api_requests(interval),
  public.purge_api_idempotency(interval),
  public.purge_api_tokens(interval)
from public, anon, authenticated;

grant execute on function
  ebim.api_authorize(uuid, text),
  public.api_token_issue(text, text, text[], integer),
  public.api_authenticate(text, text),
  public.api_rate_limit_hit(uuid, text, text),
  public.api_request_complete(uuid, integer),
  public.api_idempotency_begin(uuid, text, text),
  public.api_idempotency_finish(uuid, text, integer, jsonb),
  public.purge_api_requests(interval),
  public.purge_api_idempotency(interval),
  public.purge_api_tokens(interval)
to service_role;

-- El catalogo de scopes lo lee la pantalla que concede permisos.
revoke execute on function ebim.api_scope_catalog() from public;
grant  execute on function ebim.api_scope_catalog() to anon, authenticated, service_role;

-- Crear y rotar credenciales es del BACKOFFICE: llega con el JWT del usuario y
-- la funcion comprueba rol y modulo por dentro.
revoke execute on function
  public.api_client_create(text, text[], text, integer, timestamptz),
  public.api_client_rotate_secret(uuid)
from public, anon;
grant execute on function
  public.api_client_create(text, text[], text, integer, timestamptz),
  public.api_client_rotate_secret(uuid)
to authenticated, service_role;

comment on table public.api_clients is
  'Credencial de socio por SOCIEDAD. El secreto se guarda en sha256 y se devuelve una sola vez, al crear o rotar.';
comment on function ebim.api_authorize(uuid, text) is
  'Deriva el tenant de la FILA del cliente de API. Las funciones de recurso no aceptan organization_id ni company_id: no existe el parametro.';
comment on function public.api_authenticate(text, text) is
  'Recibe el HASH del token, no el token: el secreto de portador no entra nunca en el registro de sentencias de Postgres.';
comment on function public.api_idempotency_begin(uuid, text, text) is
  'Reserva la clave antes de operar. Misma clave con otro contenido es 409, no la respuesta anterior.';
