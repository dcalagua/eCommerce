-- =============================================================================
-- Datos de AYUDA y LEGALES de la tienda: lo que pide un pie de tienda real
-- (aprobado por el operador, 2026-10-02, para la demo «Porta»).
--
-- Hasta aquí el pie solo podía enseñar correo, teléfono y dirección. Una tienda
-- peruana necesita además:
--
--   · RAZÓN SOCIAL y RUC: los exige la hoja del Libro de Reclamaciones y el pie
--     de cualquier comercio formal («PRO BAGS PERÚ SAC»);
--   · WHATSAPP: el canal de atención real de casi todo el comercio local;
--   · HORARIO de atención, y una NOTA corta («Ventas corporativas», «Solo
--     mensajes, no llamadas»);
--   · REDES SOCIALES.
--
-- Mismo criterio que `value_props` (20260923140000): columnas propias en
-- `store_settings` —`config` no tiene GRANT para `anon`—, GRANT por columna,
-- CHECK de verdad en la base y la vista pública recreada con los campos nuevos.
--
-- Todo es TEXTO o una lista cerrada: no hay HTML ni estilos. Las URL de redes
-- solo pueden ser https y de una red de la lista, y se pintan como enlaces con
-- `rel="noopener noreferrer"`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.social_links_are_valid — la lista de redes.
--
-- Array de 0..6 objetos {network, url}. `network` de lista cerrada (decide el
-- icono: es presentación), sin red repetida; `url` https, 12..300 caracteres y
-- sin espacios ni caracteres de control. `coalesce(..., false)` porque un CHECK
-- que evalúa a NULL pasa (ver value_prop_is_valid).
-- ---------------------------------------------------------------------------
create or replace function ebim.social_links_are_valid(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select p_value is not null
     and jsonb_typeof(p_value) = 'array'
     and jsonb_array_length(p_value) <= 6
     and not exists (
       select 1 from jsonb_array_elements(p_value) as e(enlace)
       where not coalesce((
         jsonb_typeof(e.enlace) = 'object'
         and (select count(*) from jsonb_object_keys(e.enlace)) = 2
         and jsonb_typeof(e.enlace -> 'network') = 'string'
         and (e.enlace ->> 'network') in
             ('facebook', 'instagram', 'youtube', 'tiktok', 'x', 'linkedin', 'pinterest')
         and jsonb_typeof(e.enlace -> 'url') = 'string'
         and char_length(e.enlace ->> 'url') between 12 and 300
         and (e.enlace ->> 'url') ~ '^https://[^[:space:][:cntrl:]]+$'
       ), false)
     )
     and (
       select count(distinct e.enlace ->> 'network')
       from jsonb_array_elements(p_value) as e(enlace)
     ) = jsonb_array_length(p_value)
  ), false);
$fn$;

revoke execute on function ebim.social_links_are_valid(jsonb) from public;
grant  execute on function ebim.social_links_are_valid(jsonb) to anon, authenticated, service_role;

comment on function ebim.social_links_are_valid(jsonb) is
  'Redes de la tienda: array de 0..6 {network de lista cerrada, url https 12..300}, sin red repetida.';

-- ---------------------------------------------------------------------------
-- Las columnas.
-- ---------------------------------------------------------------------------
alter table public.store_settings
  add column if not exists legal_name     text,
  add column if not exists tax_id         text,
  add column if not exists whatsapp_phone text,
  add column if not exists help_note      text,
  add column if not exists business_hours text,
  add column if not exists social_links   jsonb not null default '[]'::jsonb;

alter table public.store_settings
  add constraint store_settings_legal_name_len
    check (legal_name is null
           or (char_length(btrim(legal_name)) between 2 and 160 and legal_name !~ '[[:cntrl:]]'));

-- RUC peruano (11 dígitos) u otro identificador fiscal: alfanumérico y guiones.
alter table public.store_settings
  add constraint store_settings_tax_id_fmt
    check (tax_id is null or tax_id ~ '^[0-9A-Za-z-]{5,20}$');

alter table public.store_settings
  add constraint store_settings_whatsapp_fmt
    check (whatsapp_phone is null or whatsapp_phone ~ '^\+?[0-9][0-9 ]{5,19}$');

alter table public.store_settings
  add constraint store_settings_help_note_len
    check (help_note is null
           or (char_length(btrim(help_note)) between 1 and 160 and help_note !~ '[[:cntrl:]]'));

-- El horario admite SALTOS DE LÍNEA (una línea por tramo) y nada más de control.
alter table public.store_settings
  add constraint store_settings_business_hours_len
    check (business_hours is null
           or (char_length(btrim(business_hours)) between 1 and 240
               and business_hours !~ '[\x01-\x09\x0B-\x1F\x7F]'));

alter table public.store_settings
  add constraint store_settings_social_links
    check (ebim.social_links_are_valid(social_links));

comment on column public.store_settings.legal_name is 'Razón social del comercio (pie y Libro de Reclamaciones).';
comment on column public.store_settings.tax_id is 'Identificador fiscal (RUC en Perú).';
comment on column public.store_settings.whatsapp_phone is 'WhatsApp de atención, en formato internacional.';
comment on column public.store_settings.help_note is 'Nota corta de atención: «Ventas corporativas», «solo mensajes».';
comment on column public.store_settings.business_hours is 'Horario de atención; una línea por tramo.';
comment on column public.store_settings.social_links is 'Redes sociales: 0..6 {network, url https}.';

grant select (legal_name, tax_id, whatsapp_phone, help_note, business_hours, social_links)
  on public.store_settings to anon, authenticated;
grant update (legal_name, tax_id, whatsapp_phone, help_note, business_hours, social_links)
  on public.store_settings to authenticated;

-- ---------------------------------------------------------------------------
-- La vista pública, recreada con los campos nuevos (copia fiel de
-- 20260923180000 más los seis de ayuda).
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
  ebim.store_default_country(s.id)                                  as default_country
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

revoke all on public.public_stores from public;
grant select on public.public_stores to anon, authenticated, service_role;

comment on view public.public_stores is
  'Lo publicable de una tienda activa: identidad, contacto, tema, propuestas de valor, identidad V3, ayuda y datos legales (razon social, RUC, WhatsApp, horario, redes) y pais por defecto. security_invoker: las policies siguen mandando.';
