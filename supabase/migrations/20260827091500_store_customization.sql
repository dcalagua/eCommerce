-- =============================================================================
-- P07 · 02/02 — Personalización de la tienda desde `/app/settings`.
--
-- Casi todo lo que pide el encargo (nombre comercial, descripción, logo,
-- banner, color primario y contacto) YA existe en el esquema: `stores.name`,
-- `store_settings.hero_subtitle`, `logo_url`, `banner_url`, `accent_color`,
-- `support_email`, `contact_phone` y `contact_address`. Esta migración no
-- inventa columnas nuevas para lo mismo — añade la pieza que faltaba para que
-- los assets vivan en el bucket `store-assets` sin abrir un agujero:
--
--   `logo_url` y `banner_url` pasan a admitir DOS formas y solo dos:
--     · una URL `https://` externa — que es lo que el contrato §4.3 produce con
--       el "logo-auto" al provisionar (dominio del admin → Clearbit), y
--     · una RUTA dentro de `store-assets` con el prefijo del propio tenant:
--       `{organization_id}/{store_id}/branding/...`
--
--   El CHECK es el mismo mecanismo que `product_images_path_tenant` de P02:
--   la ruta se valida contra las columnas de tenant de la PROPIA fila, así que
--   apuntar el banner de mi tienda al objeto de otra no es una operación que la
--   base acepte y luego haya que auditar — simplemente no entra.
--
--   El bucket sigue siendo PRIVADO (decisión P02 #18): la vitrina firma la
--   ruta con el cliente anónimo bajo `ebim_objects_select_public_asset`, que
--   solo deja pasar objetos de tienda ACTIVA. Un banner de una tienda en
--   borrador no se puede ver ni sabiendo la ruta exacta.
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
    -- Sin cuantificador acotado: Postgres limita las repeticiones POSIX a 255
    -- y la longitud ya la controla `store_settings_*_len`.
    when p_value like 'https://%'
     and char_length(p_value) >= 12
     and p_value !~ '[[:space:]]' then true
    when p_org is null or p_store is null then false
    else p_value like (p_org::text || '/' || p_store::text || '/branding/%')
     and char_length(p_value) > char_length(p_org::text || '/' || p_store::text || '/branding/')
     and p_value !~ '\.\.'
  end;
$fn$;

revoke execute on function ebim.is_store_asset_ref(text, uuid, uuid) from public;
grant execute on function ebim.is_store_asset_ref(text, uuid, uuid)
  to anon, authenticated, service_role;

alter table public.store_settings
  add constraint store_settings_logo_len
    check (logo_url is null or char_length(logo_url) between 4 and 1024),
  add constraint store_settings_logo_ref
    check (ebim.is_store_asset_ref(logo_url, organization_id, store_id)),
  add constraint store_settings_banner_ref
    check (ebim.is_store_asset_ref(banner_url, organization_id, store_id));

comment on column public.store_settings.logo_url is
  'URL https externa (logo-auto del contrato §4.3) o ruta {organization_id}/{store_id}/branding/... del bucket privado store-assets.';
comment on column public.store_settings.hero_subtitle is
  'Descripcion breve publicable de la tienda. Es EL texto descriptivo del tenant: no existe un segundo campo `description` que se desincronice.';
comment on function ebim.is_store_asset_ref(text, uuid, uuid) is
  'Un asset de branding es https externo o una ruta del PROPIO tenant. Valida contra las columnas de la fila, no contra un argumento del cliente.';
