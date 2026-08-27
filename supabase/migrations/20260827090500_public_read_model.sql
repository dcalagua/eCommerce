-- =============================================================================
-- P02 · 06/08 — Modelo de lectura pública del storefront.
--
-- Vistas `security_invoker`: NO amplían permisos, se apoyan en las policies
-- `to anon` y en los GRANT por columna de las migraciones anteriores. Si mañana
-- alguien afloja una policy, la vista no lo tapa.
--
-- El storefront debe consultarlas con un cliente ANÓNIMO (sin Authorization),
-- aunque el visitante tenga sesión de backoffice: lo público no depende de
-- quién esté logueado.
-- =============================================================================

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
  ss.support_email
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

create view public.public_categories
with (security_invoker = on) as
select
  c.id            as category_id,
  c.store_id,
  c.parent_id,
  c.slug,
  c.name,
  c.position
from public.categories c
where c.is_active;

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
  img.storage_path as primary_image_path
from public.products p
left join lateral (
  select i.storage_path
  from public.product_images i
  where i.product_id = p.id
  order by i.is_primary desc, i.position asc, i.created_at asc
  limit 1
) img on true
where p.status = 'published'
  and p.published_at is not null
  and p.published_at <= now();

-- Interfaz de lookup de branding homologada por el contrato §4.3: nombres
-- estandar (`brand_slug`, `logo_url`, `accent_color`, `white_label`) servidos
-- como alias de las columnas internas. Es el contrato el que fija estos
-- nombres, no este proyecto.
create view public.public_store_branding
with (security_invoker = on) as
select
  s.slug          as brand_slug,
  s.name          as name,
  ss.logo_url     as logo_url,
  ss.accent_color as accent_color,
  coalesce(ss.white_label, false) as white_label
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

revoke all on public.public_store_branding from public;
grant select on public.public_store_branding to anon, authenticated, service_role;

revoke all on public.public_stores     from public;
revoke all on public.public_categories from public;
revoke all on public.public_products   from public;

grant select on public.public_stores     to anon, authenticated;
grant select on public.public_categories to anon, authenticated;
grant select on public.public_products   to anon, authenticated;
grant select on public.public_stores, public.public_categories, public.public_products to service_role;

comment on view public.public_products is
  'Solo producto publicado de tienda activa y solo columnas publicables. Sin sku, sin stock, sin tenant.';
