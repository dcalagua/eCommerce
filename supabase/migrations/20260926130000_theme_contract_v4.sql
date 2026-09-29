-- ---------------------------------------------------------------------------
-- Resumen v2 · La lista blanca del estilo, ampliada otra vez (contrato V4)
--
-- ## Qué cambia
--
--   · `heroVariant` acepta `bento` — la portada en mosaico: la oferta principal
--     grande y, al lado, dos piezas más (otra oferta y la puerta a todas). Llena
--     el hueco que la portada de producto dejaba en el centro en pantallas
--     anchas, que era lo primero que se veía de la tienda.
--   · `categoryVariant` acepta `circles` — las familias como círculos con su
--     icono, en una fila: una forma de explorar que no compite con la oferta.
--   · La presentación por sección de `categories` acepta también `circles`.
--
-- ## Lo que NO cambia
--
--   · Las migraciones anteriores no se tocan (`create or replace` en su sitio).
--   · Se siguen rechazando las claves y los valores desconocidos.
--   · La lista solo CRECE: nada de lo que ya pasaba el CHECK deja de pasarlo, y
--     por eso no hay que revalidar ni una fila.
--   · Mismos grants y mismo `search_path` vacío.
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
                  and e.valor #>> '{}' in ('tiles', 'pills', 'mosaic', 'circles'))
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
  'Lista blanca del estilo de vitrina (V4): ocho claves cerradas; V4 suma la portada bento y las familias en circulos. Lo que no esta nombrado no entra.';

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
              -- Familias: las cuatro del contrato del tema (V4 suma `circles`).
           or (p_id = 'categories'
                 and (p_value ->> 'variant') in ('auto', 'tiles', 'pills', 'mosaic', 'circles'))
           or (p_id in ('brands', 'trust')
                 and (p_value ->> 'variant') in ('auto', 'cards', 'logos'))
           or (p_id in ('offers', 'promotions')
                 and (p_value ->> 'variant') in ('auto', 'band', 'split'))
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
  'Presentacion de una seccion de la portada (V4): variant/surface/width de listas cerradas POR id; categories suma circles. Lo que no esta nombrado no entra.';
