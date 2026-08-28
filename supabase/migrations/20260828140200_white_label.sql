-- =============================================================================
-- P11-SaaS · 3/5 — White-label por TOKENS: tipografia, radio, densidad,
--                  identidad de correo, nombre comercial y dominio propio.
--
-- El encargo dice «extiende el branding actual mediante tokens» y «no dupliques
-- componentes por tenant». Las dos frases son la misma decision vista por los
-- dos lados: si la personalizacion es un token, el componente es uno; en cuanto
-- una tienda necesita "su" tarjeta, hay dos tarjetas y a la tercera hay cinco.
--
-- ## Que se anade y por que ahi
--
--  · `font_family` — tipografia de una LISTA CERRADA. Ver el comentario de
--    `store_settings_font` mas abajo: la lista no es una limitacion temporal,
--    es la diferencia entre un token y una URL remota que el tenant elige.
--  · `ui_radius` / `ui_density` — los dos mandos que el design system SI puede
--    absorber sin tocar un componente, porque ya son CSS vars.
--  · `business_display_name` — el nombre legal/comercial para documentos y
--    correo. `stores.name` sigue siendo el nombre de la VITRINA: son dos cosas
--    ("Zapatos Pepe" en la portada, "Calzados Pepe S.A.C." en la factura) y
--    hacerlas una obliga a elegir cual se sacrifica.
--  · `email_from_name` / `email_reply_to` — identidad del correo saliente.
--    Metadato: esta fase NO envia correo (eso es P14). Existe ahora porque el
--    dia que exista el envio, la identidad ya estara configurada y no habra que
--    pedirsela otra vez a cada tenant.
--  · `custom_domain_status` / `_verified_at` / `_token` — METADATO del dominio
--    propio. El dominio en si sigue siendo `stores.domain` (unico, ya indexado
--    desde P02): esto es su estado de verificacion, no una segunda copia. La
--    comprobacion DNS es trabajo de infraestructura y no de esta fase; lo que
--    esta fase deja hecho es que el estado tenga donde vivir y que el token de
--    verificacion nazca en el servidor.
--
-- ## Donde se traza la linea del addon premium
--
-- `content.white_label` gatea las CUATRO cosas que hacen que la tienda —y su
-- correo— dejen de parecer de la suite: `white_label`, `font_family`,
-- `email_from_name`/`email_reply_to` y el dominio propio. NO gatea el acento,
-- el logo, el favicon, el radio ni la densidad: eso es tematizacion, el lockup
-- "by EBIM" sigue puesto, y cobrar por elegir esquinas redondeadas seria vender
-- una casilla en vez de una capacidad.
--
-- Y como en P02: retirar el addon APAGA SU EFECTO. El trigger de mas abajo lo
-- hace para TODOS los caminos que cambian entitlements, no solo para
-- `sync_platform_context` — que es lo que aquella fase solo pudo cubrir en un
-- sitio.
-- =============================================================================

alter table public.store_settings
  add column font_family              text,
  add column ui_radius                text,
  add column ui_density               text,
  add column business_display_name    text,
  add column email_from_name          text,
  add column email_reply_to           text,
  add column custom_domain_status     text not null default 'none',
  add column custom_domain_verified_at timestamptz,
  add column custom_domain_token      text;

alter table public.store_settings
  -- Lista CERRADA de tipografias, y todas resolubles SIN una peticion de red
  -- nueva salvo la que la app ya hace: `dm-sans` es la de suite y ya viene
  -- cargada; las otras cuatro son pilas del sistema operativo. Dejar que el
  -- tenant escriba una `@font-face` con su URL seria cargar un recurso remoto
  -- elegido por el cliente en el dominio de la vitrina — que es exactamente la
  -- clase de cosa que esta fase tiene prohibida ("no JavaScript arbitrario del
  -- tenant" no se cumple permitiendo CSS arbitrario).
  add constraint store_settings_font
    check (font_family is null
           or font_family in ('dm-sans', 'system', 'grotesk', 'serif', 'mono')),
  add constraint store_settings_radius
    check (ui_radius is null or ui_radius in ('sharp', 'soft', 'round')),
  -- Los mismos tres nombres que usa la apariencia del usuario desde P02. El
  -- tenant fija el DEFAULT de su vitrina; el usuario del backoffice sigue
  -- eligiendo la suya. No compiten: son dos superficies distintas.
  add constraint store_settings_ui_density
    check (ui_density is null or ui_density in ('comoda', 'equilibrada', 'compacta')),
  add constraint store_settings_business_name_len
    check (business_display_name is null
           or char_length(btrim(business_display_name)) between 1 and 200),
  add constraint store_settings_email_from_len
    check (email_from_name is null
           or char_length(btrim(email_from_name)) between 1 and 120),
  add constraint store_settings_email_reply
    check (email_reply_to is null
           or (char_length(email_reply_to) between 5 and 320
               and position('@' in email_reply_to) > 1
               and email_reply_to !~ '[[:space:]]')),
  add constraint store_settings_domain_status
    check (custom_domain_status in ('none', 'pending', 'verified', 'failed')),
  -- Un dominio verificado sin sello de cuando lo fue no es verificable: la
  -- fecha ES la prueba, y sin ella nadie sabe si hay que volver a comprobarlo.
  add constraint store_settings_domain_verified_at
    check ((custom_domain_status = 'verified') = (custom_domain_verified_at is not null)),
  add constraint store_settings_domain_token
    check (custom_domain_token is null or custom_domain_token ~ '^[0-9a-f]{32}$'),
  -- Deuda de P07 que esta fase cierra de paso: `favicon_url` era la unica
  -- referencia de asset de branding SIN CHECK. Podia apuntar a cualquier cosa,
  -- incluida la ruta de otro tenant.
  add constraint store_settings_favicon_len
    check (favicon_url is null or char_length(favicon_url) between 4 and 1024),
  add constraint store_settings_favicon_ref
    check (ebim.is_store_asset_ref(favicon_url, organization_id, store_id));

comment on column public.store_settings.font_family is
  'Token de tipografia de una lista cerrada. Nunca una URL: una fuente remota elegida por el tenant es contenido remoto en el dominio de la vitrina.';
comment on column public.store_settings.business_display_name is
  'Nombre legal/comercial para documentos y correo. stores.name sigue siendo el nombre de la VITRINA: son dos cosas distintas.';
comment on column public.store_settings.custom_domain_status is
  'Estado de verificacion del dominio propio (stores.domain). El dominio no se duplica aqui; esto es su estado.';
comment on column public.store_settings.custom_domain_token is
  'Valor a publicar en un TXT del DNS para probar la propiedad. Lo genera el servidor: un token que elige el cliente no prueba nada.';

-- ---------------------------------------------------------------------------
-- Lo que `anon` puede leer de lo nuevo.
--
-- GRANT POR COLUMNA, como todo lo publicable de esta tabla desde P02: la RLS
-- filtra filas, nunca columnas. Entran los cuatro tokens de PRESENTACION.
-- **No entran** `email_from_name`, `email_reply_to`, `custom_domain_token` ni
-- `custom_domain_status`: la identidad del correo saliente y el estado de un
-- dominio a medio verificar son configuracion interna del comercio, y el token
-- es literalmente el secreto que prueba la propiedad del dominio.
-- ---------------------------------------------------------------------------
grant select (font_family, ui_radius, ui_density, business_display_name)
  on public.store_settings to anon;

-- ---------------------------------------------------------------------------
-- Enforcement del addon premium.
--
-- Se REEMPLAZAN las dos policies de P02-SaaS (que solo miraban `white_label`)
-- porque la lista de lo premium crece. El `using` del UPDATE sigue SIN pedir la
-- capacidad, por el mismo motivo que entonces: un tenant al que se le retira el
-- addon tiene que poder APAGAR lo que tenia encendido.
-- ---------------------------------------------------------------------------
drop policy store_settings_write_admin  on public.store_settings;
drop policy store_settings_update_admin on public.store_settings;

create policy store_settings_write_admin on public.store_settings
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and (
      not (
        white_label
        or font_family is not null
        or email_from_name is not null
        or email_reply_to is not null
        or custom_domain_status <> 'none'
      )
      or ebim.has_capability(organization_id, company_id, 'content.white_label')
    )
  );

create policy store_settings_update_admin on public.store_settings
  for update to authenticated
  using  (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and (
      not (
        white_label
        or font_family is not null
        or email_from_name is not null
        or email_reply_to is not null
        or custom_domain_status <> 'none'
      )
      or ebim.has_capability(organization_id, company_id, 'content.white_label')
    )
  );

-- ---------------------------------------------------------------------------
-- ebim.reset_premium_branding — retirar el addon APAGA su efecto.
--
-- P02-SaaS resolvio esto dentro de `sync_platform_context`, que es UN camino.
-- Un trigger sobre `tenant_entitlements` cubre todos: la sincronizacion del
-- hub, una correccion manual del operador y cualquier camino futuro. La
-- comprobacion se hace preguntando a `ebim.company_is_entitled` en vez de
-- comparando el codigo de la fila, para que el dia que el hub cambie el codigo
-- del addon no haya que acordarse de este archivo.
--
-- `white_label` se apaga; `font_family`, la identidad de correo y el dominio
-- propio vuelven a nulo. El acento, el logo, el favicon, el radio y la densidad
-- NO se tocan: no son premium y borrarlos seria castigar una baja comercial con
-- una perdida de configuracion.
-- ---------------------------------------------------------------------------
create or replace function ebim.reset_premium_branding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid;
  v_company uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_company := old.company_id;
  else
    v_org := new.organization_id;
    v_company := new.company_id;
  end if;

  if ebim.company_is_entitled(v_org, v_company, 'content.white_label') then
    return null;
  end if;

  update public.store_settings
     set white_label            = false,
         font_family            = null,
         email_from_name        = null,
         email_reply_to         = null,
         custom_domain_status   = 'none',
         custom_domain_verified_at = null,
         custom_domain_token    = null
   where organization_id = v_org
     and company_id      = v_company
     and (
       white_label
       or font_family is not null
       or email_from_name is not null
       or email_reply_to is not null
       or custom_domain_status <> 'none'
     );

  return null;
end;
$fn$;

revoke execute on function ebim.reset_premium_branding() from public, anon, authenticated;

create trigger tenant_entitlements_reset_branding
  after insert or update or delete on public.tenant_entitlements
  for each row execute function ebim.reset_premium_branding();

comment on function ebim.reset_premium_branding() is
  'Retirar content.white_label apaga su efecto persistido. Cubre TODOS los caminos que cambian entitlements, no solo sync_platform_context.';

-- ---------------------------------------------------------------------------
-- public.store_domain_claim — pedir el token de verificacion del dominio.
--
-- El token lo genera el SERVIDOR (`gen_random_uuid`), nunca el cliente: un
-- valor que elige quien reclama el dominio no prueba nada. Deja el estado en
-- `pending`; pasarlo a `verified` es trabajo de la comprobacion DNS, que no
-- existe en esta fase y por eso ninguna funcion lo hace todavia. Lo que si
-- existe es la imposibilidad de saltarselo: `custom_domain_status` no tiene
-- GRANT de escritura para `authenticated` (ver el GRANT POR COLUMNA de abajo).
-- ---------------------------------------------------------------------------
create or replace function public.store_domain_claim(p_store_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_token text;
begin
  select * into v_store from public.stores s where s.id = p_store_id;

  if not found then
    raise exception 'TIENDA_NO_ENCONTRADA: la tienda no existe' using errcode = '22023';
  end if;

  if not ebim.has_role(v_store.organization_id, v_store.company_id,
                       array['owner','admin']::public.app_role[]) then
    raise exception 'SIN_PERMISO: hace falta rol owner o admin' using errcode = '42501';
  end if;

  if not ebim.has_capability(v_store.organization_id, v_store.company_id, 'content.white_label') then
    raise exception 'MODULO_NO_CONTRATADO: el dominio propio exige content.white_label'
      using errcode = '42501';
  end if;

  if v_store.domain is null then
    raise exception 'DOMINIO_NO_DECLARADO: la tienda no tiene dominio propio configurado'
      using errcode = '22023';
  end if;

  -- 128 bits en hexadecimal. `gen_random_uuid()` es nucleo de Postgres y no
  -- depende de que pgcrypto este habilitada en el proyecto (misma decision que
  -- el token de pedido de P02, migracion 140000).
  v_token := replace(gen_random_uuid()::text, '-', '');

  update public.store_settings
     set custom_domain_token       = v_token,
         custom_domain_status      = 'pending',
         custom_domain_verified_at = null
   where store_id = p_store_id;

  return jsonb_build_object(
    'store_id',   p_store_id,
    'domain',     v_store.domain,
    'record',     'TXT',
    'host',       '_ebim-verify.' || v_store.domain,
    'value',      v_token,
    'status',     'pending'
  );
end;
$fn$;

revoke execute on function public.store_domain_claim(uuid) from public, anon;
grant  execute on function public.store_domain_claim(uuid) to authenticated, service_role;

comment on function public.store_domain_claim(uuid) is
  'Genera el token TXT de verificacion del dominio propio. El token lo hace el servidor; pasar a verified es la comprobacion DNS, que no vive en esta fase.';

-- ---------------------------------------------------------------------------
-- GRANT POR COLUMNA sobre lo que el backoffice puede ESCRIBIR.
--
-- `store_settings` tenia GRANT de UPDATE a nivel de tabla desde P02. Se retira
-- y se sustituye por la lista explicita: el estado de verificacion del dominio,
-- su fecha y su token quedan FUERA. Marcarse a uno mismo el dominio como
-- `verified` desde la consola del navegador seria saltarse la unica prueba que
-- hay de que ese dominio es suyo — es el mismo razonamiento con el que P10 dejo
-- `usage_count` fuera del GRANT y P08 los tres ejes del pedido.
-- ---------------------------------------------------------------------------
revoke update on public.store_settings from authenticated;

grant update (
  accent_color, logo_url, favicon_url, white_label, default_locale, support_email,
  tax_rate, config, banner_url, hero_title, hero_subtitle, contact_phone,
  contact_address, font_family, ui_radius, ui_density, business_display_name,
  email_from_name, email_reply_to, updated_at
) on public.store_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Las dos vistas publicas de branding se recrean con los tokens nuevos.
--
-- DROP + CREATE en migracion NUEVA, nunca editando la que ya existe: la regla
-- del repositorio es que una migracion aplicada es inmutable.
-- ---------------------------------------------------------------------------
drop view if exists public.public_stores;

create view public.public_stores
with (security_invoker = on) as
select
  s.id            as store_id,
  s.slug,
  s.name,
  s.currency,
  s.domain,
  ss.accent_color,
  ss.logo_url,
  ss.favicon_url,
  ss.white_label,
  ss.default_locale,
  ss.support_email,
  ss.banner_url,
  ss.hero_title,
  ss.hero_subtitle,
  ss.contact_phone,
  ss.contact_address,
  ss.font_family,
  ss.ui_radius,
  ss.ui_density,
  ss.business_display_name
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

revoke all on public.public_stores from public;
grant select on public.public_stores to anon, authenticated, service_role;

drop view if exists public.public_store_branding;

-- Interfaz homologada del contrato §4.3. Los nombres estandar (`brand_slug`,
-- `logo_url`, `accent_color`, `white_label`) NO cambian: son del contrato. Lo
-- que se anade son tokens propios de esta app, con nombre propio.
create view public.public_store_branding
with (security_invoker = on) as
select
  s.slug          as brand_slug,
  s.name          as name,
  ss.logo_url     as logo_url,
  ss.favicon_url  as favicon_url,
  ss.accent_color as accent_color,
  coalesce(ss.white_label, false) as white_label,
  ss.font_family,
  ss.ui_radius,
  ss.ui_density,
  ss.business_display_name
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

revoke all on public.public_store_branding from public;
grant select on public.public_store_branding to anon, authenticated, service_role;

comment on view public.public_store_branding is
  'Lookup de branding homologado (contrato §4.3) mas los tokens de white-label de esta app. security_invoker: las policies siguen mandando.';
