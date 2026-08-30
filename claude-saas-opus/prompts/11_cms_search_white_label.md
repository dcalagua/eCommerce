# P11 — CMS, white-label, búsqueda y merchandising

## Objetivo

Dar autonomía comercial al tenant para modificar contenido, branding y discovery sin cambios de código.

## CMS / merchandising

Modela componentes administrables seguros, por ejemplo:

- hero
- banner
- carousel
- product collection
- category collection
- rich content sanitizado
- landing page
- campaign block

Cada bloque puede tener vigencia, canal y segmentación cuando sea razonable.

No permitas JavaScript arbitrario del tenant.

## White-label

Extiende el branding actual mediante tokens:

- logo
- favicon
- accent
- tipografía de una whitelist
- radius/density donde el design system lo permita
- email identity
- business display name
- custom domain metadata preparado

No dupliques componentes por tenant.

## Search

1. Crea/fortalece `SearchPort`.
2. Implementación inicial preferida si encaja con el stack:
   - PostgreSQL FTS
   - `pg_trgm`
3. Soporta:
   - autocomplete
   - typo tolerance razonable
   - category/brand/attributes
   - disponibilidad
   - rango de precio
4. Evita cargar catálogo completo al browser para buscar.
5. Deja el contrato preparado para Meilisearch/OpenSearch/Algolia sin que el dominio dependa de ellos.

## UX

- editor CMS con preview cuando sea razonable;
- búsquedas con debounce y cancelación;
- empty states útiles;
- no flashes de tema/branding;
- sanitización estricta de contenido enriquecido.

## Tests

Resolución de contenido por store/canal/vigencia, aislamiento tenant, sanitización, búsqueda, ranking básico y fallback.

## Definition of Done

PASS si el tenant puede cambiar contenido/branding y mejorar discovery sin deploy y sin ejecutar código arbitrario.
