Lee CLAUDE.md y docs/STATE.md. Exige GUIDELINES_STATUS: VERIFIED. Ejecuta P02.

Implementa foundation Supabase multitenant respetando Drive.

Modelo minimo:
tenants, tenant_members, stores, store_settings, categories, products, product_images, orders, order_items.

Reglas:
- entidades negocio aisladas por tenant_id; ecommerce tambien store_id donde corresponda
- UUID, timestamps, FK/constraints e indices
- dinero numeric, nunca float
- roles iniciales owner/admin/catalog/orders/viewer salvo convencion EBIM distinta
- RLS: usuario solo tenants con membresia activa
- publico solo stores/categorias/productos activos y publicados
- tenant A nunca accede a B
- no confiar en tenant_id del frontend

Storage:
product-images y store-assets, path {tenant_id}/{store_id}/..., lectura publica solo de assets publicables y escritura protegida.

Edge Functions compartiendo auth/CORS/errors:
bootstrap-tenant, catalog-product, create-order, update-order-status.
bootstrap-tenant crea tenant + owner membership + store de forma transaccional.
create-order obtiene productos/precios desde DB y recalcula totales server-side.
service_role solo dentro de Edge Functions si es realmente necesario.

Migraciones aplicadas son inmutables: cualquier correccion nueva = nueva migracion.
Tests minimos tenant A/B + publico. No deploy remoto. Actualiza STATE.md. Commit: feat: add multitenant supabase foundation
Salida <= 10 lineas.
