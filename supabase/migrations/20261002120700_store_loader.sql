-- ===========================================================================
-- Indicador de carga propio de la tienda (2026-10-02)
--
-- La vitrina esperaba con el isotipo de la SUITE girando: en una tienda de
-- marca blanca, lo único que no era del comercio. Ahora el comercio puede
-- subir SU imagen y elegir cómo se mueve.
--
-- No es «cualquier imagen»: un indicador de carga se pinta a 34–48 px sobre el
-- fondo de la página, en claro y en oscuro. Por eso se le EXIGE (y lo comprueba
-- la pantalla de Ajustes antes de subir, ver `loaderImage.ts`):
--
--   · PNG o WebP con fondo TRANSPARENTE (un cuadrado blanco girando sobre el
--     modo oscuro es lo primero que se ve, y mal),
--   · cuadrada, entre 96 y 1024 px de lado,
--   · 200 KB como mucho (es lo primero que se descarga en cada espera).
--
-- Aquí, en la base, lo que no se puede saltar desde fuera de la pantalla: que
-- la ruta sea un objeto de ESTA tienda en `branding/loader-…` y en PNG/WebP
-- (nunca una URL externa ni un SVG, que en un bucket servido aparte podría
-- llevar script), y que la animación sea una de las tres conocidas.
--
-- Sin tabla nueva ni policy nueva: dos columnas de `store_settings`, que ya
-- tiene su RLS forzada; el objeto vive en `store-assets`, cuyo acceso público
-- ya es «lo de una tienda activa» (`ebim.store_object_visible`).
-- ===========================================================================

alter table public.store_settings
  add column if not exists loader_url text,
  add column if not exists loader_animation text not null default 'spin';

alter table public.store_settings drop constraint if exists store_settings_loader_animation_check;
alter table public.store_settings
  add constraint store_settings_loader_animation_check
    check (loader_animation in ('spin', 'pulse', 'none'));

alter table public.store_settings drop constraint if exists store_settings_loader_url_check;
alter table public.store_settings
  add constraint store_settings_loader_url_check
    check (
      loader_url is null
      or (
        loader_url like organization_id::text || '/' || store_id::text || '/branding/loader-%'
        and loader_url ~ '\.(png|webp)$'
        and char_length(loader_url) <= 300
      )
    );

comment on column public.store_settings.loader_url is
  'Ruta en store-assets de la imagen del indicador de carga: {org}/{tienda}/branding/loader-*.png|webp. NULL = el de la suite.';
comment on column public.store_settings.loader_animation is
  'Movimiento del indicador: spin (gira y para), pulse (late) o none. Con prefers-reduced-motion la vitrina lo deja quieto.';

grant select (loader_url, loader_animation) on public.store_settings to anon, authenticated;
grant update (loader_url, loader_animation) on public.store_settings to authenticated;

-- ---------------------------------------------------------------------------
-- La vista pública, con las dos columnas AL FINAL (`create or replace` no
-- admite otra cosa y así conserva sus grants). Copia fiel de 20261002120000.
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
  coalesce(ss.loader_animation, 'spin')                             as loader_animation
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

comment on view public.public_stores is
  'Lo publicable de una tienda activa: identidad, contacto, tema, propuestas de valor, identidad V3, ayuda y datos legales, pais por defecto e indicador de carga propio. security_invoker: las policies siguen mandando.';
