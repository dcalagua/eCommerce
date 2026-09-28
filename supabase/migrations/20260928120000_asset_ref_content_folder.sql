-- =============================================================================
-- Las imagenes de campana y de bloques viven en `content/`, y la regla lo acepta.
--
-- ## El problema
--
-- Desde P18 el front sube las imagenes que ILUSTRAN (foto de una campana,
-- imagen de un bloque hero/banner/campana del CMS) a
-- `{org}/{store}/content/...`, separadas del branding porque se cambian cada
-- temporada. Pero `ebim.is_store_asset_ref` —la regla de las columnas
-- `promotions.image_url`, `content_blocks.media_url` y `content_pages.og_image_url`—
-- seguia aceptando solo `{org}/{store}/branding/...`. La imagen se subia al
-- bucket y el guardado se estrellaba contra el CHECK: «Esa combinacion de
-- campos no es valida para este tipo de campana». Le paso a `ferromax` con
-- cuatro intentos seguidos.
--
-- ## La regla
--
-- Una ruta del bucket vale si es de la PROPIA tienda (org y store de la fila)
-- y cuelga de `branding/` o de `content/`. Nada mas cambia: https externo como
-- antes, sin `..`, y la ruta de otro tenant sigue sin entrar.
--
-- La lectura publica no necesita cambio: `ebim.store_object_visible` decide
-- por org y tienda activa, no por carpeta.
-- =============================================================================

create or replace function ebim.is_store_asset_ref(p_value text, p_org uuid, p_store uuid)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_value is null then true
    -- Externo: solo https. Un `http://` en el logo del tenant degrada la
    -- vitrina a contenido mixto y el navegador lo bloquea igual.
    when p_value like 'https://%'
     and char_length(p_value) >= 12
     and p_value !~ '[[:space:]]' then true
    when p_org is null or p_store is null then false
    else p_value !~ '\.\.'
     and (
       (p_value like (p_org::text || '/' || p_store::text || '/branding/%')
        and char_length(p_value) > char_length(p_org::text || '/' || p_store::text || '/branding/'))
       or
       (p_value like (p_org::text || '/' || p_store::text || '/content/%')
        and char_length(p_value) > char_length(p_org::text || '/' || p_store::text || '/content/'))
     )
  end;
$fn$;

comment on function ebim.is_store_asset_ref(text, uuid, uuid) is
  'Un asset de tienda es https externo o una ruta del PROPIO tenant bajo branding/ (lo que define la tienda) o content/ (lo que ilustra: campanas y bloques). Valida contra las columnas de la fila.';
