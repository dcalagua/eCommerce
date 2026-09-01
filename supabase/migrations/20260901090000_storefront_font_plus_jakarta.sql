-- =============================================================================
-- P17 · `plus-jakarta` entra en la lista blanca de tipografias del tenant.
--
-- La lista sigue siendo CERRADA, y por la misma razon de siempre: un tenant que
-- pudiera escribir su propia `@font-face` estaria cargando un recurso remoto de
-- su eleccion en el dominio de la vitrina — que es exactamente lo que "nada de
-- codigo arbitrario del tenant" prohibe, y que no se cumple permitiendo CSS
-- arbitrario. Anadir una fuente sigue siendo una decision de producto: hay que
-- cargarla, medirla y comprobar su contraste.
--
-- Esta se AUTO-ALOJA (`@fontsource/plus-jakarta-sans`), asi que no anade ni una
-- peticion a un tercero desde la tienda del comercio, y viaja en el chunk del
-- storefront: el backoffice no baja un byte de ella.
--
-- Es ademas la que la vitrina usa POR DEFECTO desde esta fase. El defecto vive
-- en el codigo del storefront, no en la fila: una tienda con `font_family` en
-- null sigue siendo una tienda que no ha elegido, y el dia que la suite cambie
-- de fuente por defecto, cambia para todas sin migrar datos.
-- =============================================================================

alter table public.store_settings
  drop constraint if exists store_settings_font;

alter table public.store_settings
  add constraint store_settings_font
    check (font_family is null
           or font_family in ('dm-sans', 'plus-jakarta', 'system', 'grotesk', 'serif', 'mono'));

comment on constraint store_settings_font on public.store_settings is
  'Tipografia de una lista blanca. Nunca una URL: seria un recurso remoto elegido por el tenant en el dominio de la vitrina.';
