-- =============================================================================
-- Resumen v2 · `jost` entra en la lista blanca de tipografías del tenant.
--
-- El operador eligió Jost como la tipografía que PROPONE el tema Premium
-- (2026-09-27), en lugar de Fraunces, que se leía peor en precios y textos
-- chicos. Se auto-aloja (`@fontsource/jost`) igual que las demás: ninguna
-- petición a un tercero desde la tienda.
--
-- Fraunces NO sale de la lista: alguna tienda puede tenerla guardada, y una
-- lista que encoge dejaría filas válidas fuera del CHECK.
-- =============================================================================

alter table public.store_settings
  drop constraint if exists store_settings_font;

alter table public.store_settings
  add constraint store_settings_font
    check (font_family is null
           or font_family in ('dm-sans', 'plus-jakarta', 'system', 'grotesk', 'serif', 'mono',
                              'archivo', 'fraunces', 'plex', 'jost'));

comment on constraint store_settings_font on public.store_settings is
  'Tipografia de una lista blanca (fuentes auto-alojadas o pilas del sistema). Nunca una URL: seria un recurso remoto elegido por el tenant en el dominio de la vitrina.';
