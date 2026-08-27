# Arquitectura inicial — eCommerce by EBIM

Compatible con `EBIM-CONTRATO-PLATAFORMA.md` (§0 principios, §1 topología, §2 identidad, §3 jerarquía,
§5 Platform Context API, §7 qué vive dónde, §8 convenciones).

## Topología

```
Comprador (público) ─┐
                     ├─► App eCommerce (React + TS + Vite + MUI)
Usuario del tenant ──┘      ├─ /            storefront público (por dominio/slug de tenant)
                            └─ /admin       backoffice (sesión + membership + active_company)
                                   │
                                   ▼
                     Supabase eCommerce (proyecto propio)
                       ├─ PostgreSQL (RLS default deny)
                       ├─ Storage (imágenes de producto, path por tenant)
                       └─ Edge Functions (Deno)
                            ├─ platform-context ──► HUB EBIM (sociedades, addons, config)
                            ├─ sso              ──► HUB EBIM (verifica JWT contra JWKS)
                            └─ checkout/orders  (lógica de negocio con service_role, solo servidor)
```

El **hub EBIM** es el emisor de identidad y dueño del catálogo/billing. eCommerce **lee** del hub y nunca
escribe en él. La identidad del comprador final del storefront es **local** a este proyecto (patrón §2.5,
igual que los proveedores externos de eSupplier); los usuarios del tenant llegan por SSO del hub.

## Modelo de datos (base)

- Toda tabla de negocio: `organization_id uuid`, `company_id uuid` (uuids del hub), `created_at`, `updated_at`.
- Núcleo previsto: `stores` (config de storefront por sociedad), `categories`, `products`, `product_variants`,
  `product_images`, `inventory`, `price_lists`, `customers` (local), `carts`, `cart_items`, `orders`,
  `order_items`, `payments`, `audit_log`.
- RLS en todas: default deny + policy `org_id = jwt.org_id AND company_id = ANY(jwt.companies)`.
- Storefront público: policies de **solo lectura** limitadas a filas publicadas (`status = 'published'`) del
  tenant resuelto por dominio/slug, expuestas mediante vistas públicas que no filtran datos internos.
- Sin forks de schema por cliente: diferencias por `config` en capas + `custom_fields` (JSONB) + addons.

## Seguridad

- `service_role` solo dentro de Edge Functions; el bundle del front lleva únicamente URL + clave publicable.
- Tenant siempre derivado del JWT en el servidor; el storefront anónimo se resuelve por host contra tabla de
  dominios, nunca por header o parámetro declarado por el cliente.
- `SECURITY DEFINER` únicamente con autorización explícita dentro de la función y `REVOKE EXECUTE` a
  `anon`/`authenticated`/`public`.
- `audit_log` no legible ni borrable por `anon`; se escribe solo vía función validada.
- Rol operador/super-admin no asignable desde UI y con guard 403 en servidor (`_shared/governance.ts`).

## Frontend

```
src/
  app/         router, providers, theme (tokens de marca), i18n
  shared/      ui kit (MUI wrappers, SectionTabs, SearchField), hooks, lib/supabase, types
  storefront/  rutas públicas: home, catálogo, producto, carrito, checkout
  admin/       backoffice: catálogo, pedidos, inventario, configuración, branding
  features/    dominios compartidos entre ambas áreas
supabase/
  migrations/  SQL versionado (tabla nueva = tabla + RLS + policies en la misma migración)
  functions/   Edge Functions (Deno) + _shared/
```

- Theming por tokens; el acento proviene del branding del tenant (`accent_color`), nunca hardcodeado.
- Light + dark, densidad configurable, WCAG AA, mobile-first real.
- Pantallas largas → tabs centrados con deep-link `#hash`; listados → un buscador general.

## Integración con la suite

- Registro de `ecommerce` en el hub (`apps`, `workspace_apps`) y lectura de addons por sociedad para gating.
- Vitrina cruzada (§6.1): momento contextual hacia eExpense/eSupplier cuando el tenant no las tiene contratadas.
- Coordinación por el buzón `coordinacion\` en Drive; cambios a interfaces compartidas = propuesta al contrato.
