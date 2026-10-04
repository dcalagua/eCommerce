-- ===========================================================================
-- Carrusel de videos en la portada (2026-10-04)
--
-- Una sección nueva de la portada, `videos`: el comercio sube clips de 30 s a
-- 1 min y la vitrina los reproduce uno tras otro, en bucle. Dos piezas:
--
--   1. El CONTENIDO — `store_settings.home_videos`, una lista de
--      {path, title, duration}. Fuera de `home_layout` a propósito: la
--      composición dice qué secciones y en qué orden; lo de cada una vive en su
--      sitio (como `value_props` para «Servicios»).
--   2. La SECCIÓN — `videos` entra en la lista cerrada de ids de la portada
--      (y en la de fondos que admite), con lo que se enciende, apaga y ordena
--      como cualquier otra.
--
-- Qué exige la base de cada video, aunque alguien se salte la pantalla:
--   · la ruta es un objeto de ESTA tienda: {org}/{tienda}/content/video-<uuid>
--     .mp4|.webm (nunca una URL externa);
--   · la duración son 30..60 segundos, en entero;
--   · el título, si lo hay, hasta 80 caracteres;
--   · como mucho 8 videos y sin repetir ruta.
-- El peso (30 MB) y la duración REAL los comprueba la pantalla antes de subir:
-- la base no ve el archivo, solo su ruta.
--
-- Sin tabla nueva ni policy nueva: una columna de `store_settings` (RLS
-- forzada, escritura solo owner/admin). El objeto vive en `store-assets`, cuyo
-- acceso público ya es «lo de una tienda activa» (`ebim.store_object_visible`).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · La lista de videos
-- ---------------------------------------------------------------------------
create or replace function ebim.home_videos_are_valid(p_value jsonb, p_org uuid, p_store uuid)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select jsonb_typeof(p_value) = 'array'
     and jsonb_array_length(p_value) <= 8
     and not exists (
       select 1
       from jsonb_array_elements(p_value) as e(video)
       where not (
         jsonb_typeof(e.video) = 'object'
         and not exists (
           select 1 from jsonb_object_keys(e.video) as k(clave)
           where k.clave not in ('path', 'title', 'duration')
         )
         and jsonb_typeof(e.video -> 'path') = 'string'
         and (e.video ->> 'path') ~ (
           '^' || p_org::text || '/' || p_store::text
           || '/content/video-[0-9a-f-]{36}\.(mp4|webm)$'
         )
         and (
           not (e.video ? 'title')
           or jsonb_typeof(e.video -> 'title') = 'null'
           or (jsonb_typeof(e.video -> 'title') = 'string' and char_length(e.video ->> 'title') <= 80)
         )
         and jsonb_typeof(e.video -> 'duration') = 'number'
         and (e.video ->> 'duration') ~ '^[0-9]{2}$'
         and (e.video ->> 'duration')::int between 30 and 60
       )
     )
     and (
       select count(distinct e.video ->> 'path') from jsonb_array_elements(p_value) as e(video)
     ) = jsonb_array_length(p_value)
  ), false);
$fn$;

revoke execute on function ebim.home_videos_are_valid(jsonb, uuid, uuid) from public;
grant  execute on function ebim.home_videos_are_valid(jsonb, uuid, uuid)
  to anon, authenticated, service_role;

comment on function ebim.home_videos_are_valid(jsonb, uuid, uuid) is
  'Videos de la portada: 0..8 {path de la propia tienda en content/video-*.mp4|webm, title <=80, duration 30..60} sin rutas repetidas.';

alter table public.store_settings
  add column if not exists home_videos jsonb not null default '[]'::jsonb;

alter table public.store_settings drop constraint if exists store_settings_home_videos_check;
alter table public.store_settings
  add constraint store_settings_home_videos_check
    check (ebim.home_videos_are_valid(home_videos, organization_id, store_id));

comment on column public.store_settings.home_videos is
  'Videos del carrusel de la portada, en orden: [{path, title, duration}]. La seccion `videos` de home_layout decide si se ven y donde.';

grant select (home_videos) on public.store_settings to anon, authenticated;
grant update (home_videos) on public.store_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 2 · La sección `videos` en la portada (copias fieles + el id nuevo)
-- ---------------------------------------------------------------------------
create or replace function ebim.home_section_is_valid(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select p_value is not null
     and jsonb_typeof(p_value) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p_value) as k(clave)
       where k.clave not in ('id', 'enabled', 'maxItems', 'presentation')
     )
     and jsonb_typeof(p_value -> 'id') = 'string'
     and (p_value ->> 'id') in (
       'hero', 'services', 'offers', 'cms', 'promotions', 'categories', 'brands',
       'new-arrivals', 'best-sellers', 'featured', 'trust', 'business-info', 'newsletter',
       -- 2026-10-04 · carrusel de videos del comercio
       'videos'
     )
     and jsonb_typeof(p_value -> 'enabled') = 'boolean'
     and (
       not (p_value ? 'maxItems')
       or (
         jsonb_typeof(p_value -> 'maxItems') = 'number'
         and (p_value ->> 'maxItems') ~ '^[0-9]{1,3}$'
         and (p_value ->> 'maxItems')::int between 1 and 24
       )
     )
     -- Storefront V3 · P06
     and (
       not (p_value ? 'presentation')
       or ebim.section_presentation_is_valid(p_value ->> 'id', p_value -> 'presentation')
     )
  ), false);
$fn$;

create or replace function ebim.section_presentation_is_valid(p_id text, p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select p_value is not null
     and jsonb_typeof(p_value) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p_value) as k(clave)
       where k.clave not in ('variant', 'surface', 'width')
     )
     and (
       not (p_value ? 'variant')
       or (
         jsonb_typeof(p_value -> 'variant') = 'string'
         and (
              (p_id in ('new-arrivals', 'best-sellers', 'featured')
                 and (p_value ->> 'variant') in ('auto', 'rail', 'grid', 'spotlight'))
           or (p_id = 'categories'
                 and (p_value ->> 'variant') in ('auto', 'tiles', 'pills', 'mosaic', 'circles', 'icons'))
           or (p_id in ('brands', 'trust')
                 and (p_value ->> 'variant') in ('auto', 'cards', 'logos'))
              -- V5 · `offers` y `promotions` se separan: cada una gana la suya.
           or (p_id = 'offers'
                 and (p_value ->> 'variant') in ('auto', 'band', 'split', 'flash'))
           or (p_id = 'promotions'
                 and (p_value ->> 'variant') in ('auto', 'band', 'split', 'banners'))
         )
       )
     )
     and (
       not (p_value ? 'surface')
       or (
         jsonb_typeof(p_value -> 'surface') = 'string'
         and (
              (p_id in ('categories', 'brands', 'trust', 'services', 'business-info', 'newsletter')
                 and (p_value ->> 'surface') in ('plain', 'soft'))
           or (p_id in ('offers', 'promotions', 'new-arrivals', 'best-sellers', 'featured', 'videos')
                 and (p_value ->> 'surface') in ('plain', 'soft', 'contrast'))
           or (p_id in ('hero', 'cms') and (p_value ->> 'surface') = 'plain')
         )
       )
     )
     and (
       not (p_value ? 'width')
       or (
         jsonb_typeof(p_value -> 'width') = 'string'
         and (p_value ->> 'width') in ('contained', 'bleed')
       )
     )
  ), false);
$fn$;

-- ---------------------------------------------------------------------------
-- 3 · La vista pública, con la lista AL FINAL (copia fiel de 20261002120700).
-- ---------------------------------------------------------------------------
create or replace view public.public_stores
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
  ss.business_display_name,
  coalesce(ss.checkout_requires_account, false) as checkout_requires_account,
  coalesce(ss.theme_preset, 'universal')                            as theme_preset,
  coalesce(ss.storefront_style, '{}'::jsonb)                        as storefront_style,
  coalesce(ss.home_layout, '{"version": 1, "sections": []}'::jsonb) as home_layout,
  coalesce(ss.value_props, '[]'::jsonb)                             as value_props,
  ss.store_description,
  ss.hero_kicker,
  coalesce(ss.brand_lockup, 'logo_name')                            as brand_lockup,
  coalesce(ss.show_theme_toggle, false)                             as show_theme_toggle,
  coalesce(ss.announcement_messages, '[]'::jsonb)                   as announcement_messages,
  -- 2026-10-02 · ayuda y datos legales
  ss.legal_name,
  ss.tax_id,
  ss.whatsapp_phone,
  ss.help_note,
  ss.business_hours,
  coalesce(ss.social_links, '[]'::jsonb)                            as social_links,
  ebim.store_default_country(s.id)                                  as default_country,
  -- 2026-10-02 · indicador de carga propio
  ss.loader_url,
  coalesce(ss.loader_animation, 'spin')                             as loader_animation,
  -- 2026-10-04 · videos del carrusel de la portada
  coalesce(ss.home_videos, '[]'::jsonb)                             as home_videos
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

comment on view public.public_stores is
  'Lo publicable de una tienda activa: identidad, contacto, tema, propuestas de valor, identidad V3, ayuda y datos legales, pais por defecto, indicador de carga y videos de la portada. security_invoker: las policies siguen mandando.';
