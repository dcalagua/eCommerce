# Arquitectura inicial — eCommerce by EBIM

Compatible con `EBIM-CONTRATO-PLATAFORMA.md` (§0 principios, §1 topología, §2 identidad, §3 jerarquía,
§5 Platform Context API, §7 qué vive dónde, §8 convenciones).

## Topología

```
Comprador (público) ─┐
                     ├─► App eCommerce (React + TS + Vite + MUI)
Usuario del tenant ──┘      ├─ /s/:storeSlug  storefront público (tenant por slug/dominio)
                            └─ /app           backoffice (sesión + membership + active_company)
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

## Modelo de datos (implementado en P02)

Nueve tablas en `supabase/migrations`, todas con `organization_id uuid` + `company_id uuid` (uuids del hub),
`created_at`/`updated_at`, PK uuid y RLS default deny **forzada**:

```
tenants (PK = organization_id del hub)
  └── tenant_members (usuario × sociedad × rol de app)
  └── stores (una tienda por sociedad; slug/dominio públicos)
        ├── store_settings (1:1 — branding publicable + config interna)
        ├── categories (árbol dentro de la misma tienda)
        ├── products ──── product_images (ruta en Storage)
        └── orders ────── order_items (snapshot de precio; line_total GENERATED)
```

- **`organization_id` es el "tenant_id"** del modelo: nombre exacto del contrato §3, sin variantes.
  `store_id` es la dimensión adicional propia de eCommerce.
- **FK compuestas** `(store_id, organization_id, company_id) → stores`: una fila hija no puede declarar un
  tenant distinto al de su tienda, aunque alguien se equivoque copiando uuids.
- **Predicado único de acceso** `ebim.can_access(org, company)`: claims del JWT **y** membresía activa.
  Escritura además por rol: `ebim.has_role(...)` con `owner/admin/catalog/orders/viewer`.
- **Dinero en `numeric(14,2)`**, nunca float; los importes salen de la API como string decimal.
- Storefront público: policies `to anon` limitadas a tienda activa + producto publicado, con **GRANT por
  columna** (RLS filtra filas, nunca columnas) y vistas `security_invoker` encima
  (`public_stores`, `public_categories`, `public_products`, `public_store_branding` — §4.3).
- Sin forks de schema por cliente: diferencias por `store_settings.config` + `products.custom_fields` (JSONB).
- Pendiente de fases siguientes: `product_variants`, `price_lists`, `customers`, `carts`, `payments`, `audit_log`.

## Operaciones de servidor y Edge Functions (P02)

| Función | Autoriza | Cliente | Por qué |
|---|---|---|---|
| `bootstrap-tenant` | clave en cabecera `x-ebim-provisioning-key` | `service_role` | crea el tenant: no hay todavía un token del que derivarlo |
| `create-order` | ninguna (comprador anónimo) | `service_role` | el pedido no puede insertarse desde el navegador |
| `catalog-product` | JWT del usuario | clave publicable + `Authorization` | **decide la RLS**, no la función |
| `update-order-status` | JWT del usuario | clave publicable + `Authorization` | idem, más el trigger de transiciones |

`supabase/functions/_shared/` (auth, CORS, errores, validación, reglas de pedido, roles) es TypeScript puro:
lo compila el `tsc` del repo y lo cubren los tests. `_runtime/clients.ts` queda aparte porque importa el SDK
con especificador `npm:` y solo existe dentro de Deno.

## Seguridad

- `service_role` solo dentro de Edge Functions; el bundle del front lleva únicamente URL + clave publicable.
- Tenant siempre derivado del JWT en el servidor; el storefront anónimo se resuelve por host contra tabla de
  dominios, nunca por header o parámetro declarado por el cliente.
- `SECURITY DEFINER` únicamente con autorización explícita dentro de la función y `REVOKE EXECUTE` a
  `anon`/`authenticated`/`public`.
- `audit_log` no legible ni borrable por `anon`; se escribe solo vía función validada.
- Rol operador/super-admin no asignable desde UI y con guard 403 en servidor (`_shared/governance.ts`).

## Frontend

Estructura real desde P01 (organización por features; storefront y backoffice siguen siendo
áreas lógicamente separadas — rutas, layouts y guards distintos, design system compartido):

```
src/
  app/                  router, providers, ErrorBoundary, queryClient
  theme/                tokens (CSS vars + escalas), createEbimTheme, apariencia por usuario
  shared/               ui kit (EbimMark, SectionTabs, SearchField, estados), i18n ES/EN, lib (env, supabase, format)
  features/auth/        login (anatomía de suite §4.5), sesión, guard RequireSession
  features/tenant/      resolución de tenant: branding público por slug + contexto desde el JWT
  features/admin/       AdminLayout, dashboard, configuración
  features/catalog/     productos del backoffice
  features/orders/      pedidos del backoffice
  features/storefront/  StorefrontLayout + vitrina, ficha, carrito, checkout
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
