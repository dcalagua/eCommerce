-- =============================================================================
-- P05 · 01/01 — Storefront público: branding ampliado, disponibilidad y
-- modelo de lectura anónimo definitivo.
--
-- Tres cosas que la vitrina necesita y P02 no dejó resueltas:
--   1. `store_settings` no tenía banner ni datos de contacto — el encargo pide
--      branding completo (logo, nombre, color, banner y contacto) y la regla es
--      que la identidad salga de la configuración del tenant, nunca del código.
--   2. El comprador necesita saber si un producto ESTÁ DISPONIBLE, pero `stock`
--      no se le puede enseñar (es dato de negocio y está fuera del GRANT de
--      `anon`). Se resuelve con una columna generada booleana: dice "hay/no hay"
--      sin filtrar cuántas unidades quedan.
--   3. Las vistas públicas no traían la categoría ni la galería, así que el
--      catálogo habría necesitado una consulta por producto para pintarse.
--
-- Sigue sin haber policy nueva: la RLS de P02 ya es default deny y las vistas
-- son `security_invoker`, así que no amplían ni un permiso.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Branding publicable: banner, textos del hero y contacto de la tienda.
--    `authenticated` y `service_role` ya tienen GRANT a nivel de tabla, que
--    cubre las columnas futuras; a `anon` hay que dárselas una a una porque su
--    permiso es por columna a propósito (RLS filtra filas, no columnas).
-- ---------------------------------------------------------------------------
alter table public.store_settings
  add column banner_url      text,
  add column hero_title      text,
  add column hero_subtitle   text,
  add column contact_phone   text,
  add column contact_address text;

alter table public.store_settings
  add constraint store_settings_banner_len
    check (banner_url is null or char_length(banner_url) between 4 and 1024),
  add constraint store_settings_hero_title_len
    check (hero_title is null or char_length(btrim(hero_title)) between 1 and 120),
  add constraint store_settings_hero_subtitle_len
    check (hero_subtitle is null or char_length(btrim(hero_subtitle)) between 1 and 240),
  add constraint store_settings_contact_phone_len
    check (contact_phone is null or char_length(btrim(contact_phone)) between 4 and 40),
  add constraint store_settings_contact_address_len
    check (contact_address is null or char_length(btrim(contact_address)) between 3 and 240);

grant select (banner_url, hero_title, hero_subtitle, contact_phone, contact_address)
  on public.store_settings to anon;

comment on column public.store_settings.banner_url is
  'Imagen del hero de la vitrina. Nula = fallback neutral por tokens, sin identidad cableada.';

-- ---------------------------------------------------------------------------
-- 2. Disponibilidad sin filtrar inventario.
--
--    Columna GENERADA: no se puede escribir a mano, así que no existe el estado
--    "dice disponible pero el stock es 0". Y `anon` recibe el GRANT sobre
--    `in_stock` pero NO sobre `stock`: el comprador ve el semáforo, no la
--    cantidad — que es información competitiva del tenant.
-- ---------------------------------------------------------------------------
alter table public.products
  add column in_stock boolean generated always as (stock > 0) stored;

create index products_available_idx on public.products (store_id)
  where status = 'published' and in_stock;

grant select (in_stock) on public.products to anon;

comment on column public.products.in_stock is
  'Derivada de stock > 0. Es lo unico de inventario que ve el comprador anonimo.';

-- ---------------------------------------------------------------------------
-- 3. Vistas públicas. Se recrean porque cambian de columnas; ninguna migración
--    de este proyecto está aplicada todavía, pero aun así se hace con DROP +
--    CREATE en migración NUEVA en vez de editar la de P02 (regla del repo:
--    migración aplicada es inmutable).
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
  ss.contact_address
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

drop view if exists public.public_products;

-- La categoría entra por LEFT JOIN contra la categoría ACTIVA: si el tenant
-- desactiva una categoría, sus productos publicados siguen comprándose pero
-- dejan de anunciar una sección que ya no existe en el menú. Un INNER JOIN los
-- habría hecho desaparecer del catálogo sin que nadie los despublicara.
create view public.public_products
with (security_invoker = on) as
select
  p.id            as product_id,
  p.store_id,
  p.category_id,
  p.slug,
  p.name,
  p.description,
  p.price,
  p.compare_at_price,
  p.currency,
  p.published_at,
  p.custom_fields,
  p.in_stock,
  c.slug           as category_slug,
  c.name           as category_name,
  img.storage_path as primary_image_path,
  img.alt          as primary_image_alt
from public.products p
left join public.categories c
  on c.id = p.category_id
 and c.store_id = p.store_id
 and c.is_active
left join lateral (
  select i.storage_path, i.alt
  from public.product_images i
  where i.product_id = p.id
  order by i.is_primary desc, i.position asc
  limit 1
) img on true
where p.status = 'published'
  and p.published_at is not null
  and p.published_at <= now();

-- Galería de la ficha. No lleva filtro propio: la RLS de `product_images` ya
-- limita a producto publicado de tienda activa, y duplicar la condición aquí
-- sería una segunda fuente de verdad que mañana se desincroniza.
create view public.public_product_images
with (security_invoker = on) as
select
  i.id         as image_id,
  i.product_id,
  i.store_id,
  i.storage_path,
  i.alt,
  i.position,
  i.is_primary
from public.product_images i;

revoke all on public.public_stores         from public;
revoke all on public.public_products       from public;
revoke all on public.public_product_images from public;

grant select on public.public_stores         to anon, authenticated, service_role;
grant select on public.public_products       to anon, authenticated, service_role;
grant select on public.public_product_images to anon, authenticated, service_role;

comment on view public.public_products is
  'Solo producto publicado de tienda activa y solo columnas publicables. Sin sku, sin stock exacto, sin tenant.';
comment on view public.public_product_images is
  'Galeria publica. El filtro lo hace la RLS de product_images, no una copia de la condicion.';
