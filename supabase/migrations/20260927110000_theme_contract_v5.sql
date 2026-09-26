-- ---------------------------------------------------------------------------
-- Resumen v2 · Retail «Feria de ofertas» (contrato V5)
--
-- ## Qué cambia
--
--   · `categoryVariant` acepta `icons` — las familias como tarjetas con su
--     icono, en fila, con una tarjeta final que lleva a todas las ofertas.
--   · La presentación de `categories` acepta también `icons`.
--   · `offers` acepta `flash` — la banda oscura de «Ofertas relámpago», con la
--     cuenta regresiva de la campaña que antes termina (si tiene fecha de fin).
--   · `promotions` acepta `banners` — dos campañas lado a lado, una clara y otra
--     oscura. Hasta aquí `offers` y `promotions` compartían la misma lista; se
--     separan porque cada una gana una opción que en la otra no significa nada.
--
-- ## Lo que NO cambia
--
--   · Las migraciones anteriores no se tocan (`create or replace` en su sitio).
--   · Se siguen rechazando las claves y los valores desconocidos.
--   · La lista solo CRECE: nada de lo que ya pasaba el CHECK deja de pasarlo.
--   · Mismos grants y mismo `search_path` vacío.
--   · Ningún valor es un COLOR: el color es de la tienda (decisión del operador,
--     2026-09-26). Lo que se nombra aquí son formas.
-- ---------------------------------------------------------------------------
create or replace function ebim.storefront_style_is_valid(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce((
    select p_value is not null
     and jsonb_typeof(p_value) = 'object'
     and not exists (
       select 1
       from jsonb_each(p_value) as e(clave, valor)
       where jsonb_typeof(e.valor) <> 'string'
          or not (
               (e.clave = 'headerVariant'
                  and e.valor #>> '{}' in ('standard', 'compact', 'brand'))
            or (e.clave = 'heroVariant'
                  and e.valor #>> '{}' in ('product', 'statement', 'bento'))
            or (e.clave = 'productCardVariant'
                  and e.valor #>> '{}' in ('comfortable', 'compact', 'editorial'))
            or (e.clave = 'categoryVariant'
                  and e.valor #>> '{}' in ('tiles', 'pills', 'mosaic', 'circles', 'icons'))
            or (e.clave = 'contentWidth'
                  and e.valor #>> '{}' in ('lg', 'xl'))
            or (e.clave = 'imageRatio'
                  and e.valor #>> '{}' in ('square', 'portrait', 'landscape'))
            or (e.clave = 'sectionSpacing'
                  and e.valor #>> '{}' in ('compact', 'comfortable', 'spacious'))
            or (e.clave = 'productMediaFit'
                  and e.valor #>> '{}' in ('cover', 'contain'))
          )
     )
  ), false);
$fn$;

revoke execute on function ebim.storefront_style_is_valid(jsonb) from public;
grant  execute on function ebim.storefront_style_is_valid(jsonb)
  to anon, authenticated, service_role;

comment on function ebim.storefront_style_is_valid(jsonb) is
  'Lista blanca del estilo de vitrina (V5): ocho claves cerradas; V5 suma las familias en tarjetas con icono. Lo que no esta nombrado no entra.';

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
           or (p_id in ('offers', 'promotions', 'new-arrivals', 'best-sellers', 'featured')
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

revoke execute on function ebim.section_presentation_is_valid(text, jsonb) from public;
grant  execute on function ebim.section_presentation_is_valid(text, jsonb)
  to anon, authenticated, service_role;

comment on function ebim.section_presentation_is_valid(text, jsonb) is
  'Presentacion de una seccion de la portada (V5): variant/surface/width de listas cerradas POR id; categories suma icons, offers flash y promotions banners. Lo que no esta nombrado no entra.';
