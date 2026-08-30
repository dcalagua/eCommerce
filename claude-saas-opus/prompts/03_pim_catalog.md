# P03 — PIM: catálogo avanzado, variantes, atributos, UoM y bundles

## Objetivo

Evolucionar el catálogo simple existente hacia un PIM suficientemente flexible para B2C y B2B, conservando compatibilidad con productos actuales.

## Modelo esperado

Evalúa y diseña de forma normalizada, según lo que ya exista:

- brands
- product_families
- attributes
- attribute_values
- product_variants
- variant_attribute_values
- units_of_measure
- product_uoms
- bundles / kits
- bundle_items
- product_relations

No crees tablas redundantes si el repositorio ya resuelve parte del problema correctamente.

## Reglas

1. Producto maestro único; canal no debe duplicar el SKU.
2. SKU/variant SKU únicos dentro del alcance correcto del tenant.
3. Soporta múltiples unidades de venta y factor de conversión con precisión decimal adecuada.
4. Bundles deben conocer componentes y cantidades; el stock futuro se calcula por componentes.
5. Atributos deben ser extensibles y utilizables para filtros, pero no conviertas todo el modelo a JSONB.
6. `custom_fields` puede usarse para extensiones no críticas, no para relaciones centrales.
7. Mantén imágenes y publicación existentes; migra de forma compatible.
8. Toda tabla nueva: `organization_id` + `company_id`, y `store_id` solo si la entidad realmente pertenece a una tienda.
9. Agrega índices para búsqueda y filtros frecuentes.
10. Backoffice profesional:
    - listado server-side
    - buscador único
    - tabs de estado si aplica
    - paginación
    - edición clara de variantes/UoM/atributos
    - loading, error, empty
11. Evita formularios monolíticos; usa secciones/tabs coherentes con el design system.
12. Añade tests de aislamiento, restricciones y casos de variantes/UoM/bundle.
13. Documenta la migración de `products.price/stock_qty` si todavía existen; no los elimines prematuramente si otros flujos dependen de ellos.

## Definition of Done

PASS si el catálogo soporta producto simple y producto con variantes/UoM/bundle sin romper storefront, pedidos ni aislamiento tenant.
