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
                            ├─ bootstrap-tenant   (alta de tenant, clave de aprovisionamiento)
                            ├─ create-order       (checkout anónimo, service_role, solo servidor)
                            ├─ catalog-product    (alta/edición con el JWT del usuario)
                            └─ update-order-status (transiciones con el JWT del usuario)

                            [PENDIENTES, no existen todavía]
                            ├─ platform-context ──► HUB EBIM (sociedades, addons, config)
                            └─ sso              ──► HUB EBIM (verifica JWT contra JWKS)
```

> **Estado real de la identidad.** `platform-context` y `sso` estaban en este diagrama como si
> existieran; no existen. La identidad efectiva de DEV/QAS es Supabase Auth más el hook
> `ebim.demo_access_token_hook` (migraciones `20260827120000` y `..._121000`), y el camino contra el
> hub no se ha ejercitado nunca. Corregido en P01-SaaS por ser un error de documentación; el cambio
> de identidad en sí está bloqueado (contrato §2, cambios breaking al buzón) y corresponde a
> P02/P16.

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
  (`public_stores`, `public_categories`, `public_products`, `public_product_images` y
  `public_store_branding` — §4.3). La disponibilidad se publica como `products.in_stock`, columna
  **generada** (`stock > 0`): `anon` la lee, pero nunca lee `stock` (P05).
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
- Rol operador/super-admin no asignable desde UI y con guard 403 en servidor (`_shared/roles.ts`).

## Frontend

Estructura real (organización por features; storefront y backoffice siguen siendo
áreas lógicamente separadas — rutas, layouts y guards distintos, design system compartido):

```
src/
  domain/               PURO: fronteras, puertos, errores, dinero. Sin React, MUI ni Supabase (P01-SaaS)
    boundaries.ts         los 12 dominios + 5 areas de plataforma, con su estado real
    errors.ts             AppError con discriminante `kind`
    money.ts              importe = decimal en TEXTO, nunca number
    ports/                PricingPort, InventoryPort, PaymentProvider, ErpProvider, ...
  app/                  router, providers, ErrorBoundary, queryClient
  theme/                tokens (CSS vars + escalas), createEbimTheme, apariencia por usuario
  shared/               ui kit (EbimMark, SectionTabs, SearchField, estados), i18n ES/EN,
                        lib (env, supabase, db-schema, format, search, slug)
  features/auth/        login (anatomía de suite §4.5), sesión, guard RequireSession
  features/tenant/      contexto de tenant del backoffice, derivado del JWT
  features/admin/       AdminLayout, dashboard, configuración
  features/catalog/     productos del backoffice
  features/orders/      pedidos del backoffice
  features/storefront/  vitrina pública: resolución por slug, catálogo, ficha, carrito/checkout (P06)
  architecture.test.ts  las reglas de frontera, comprobadas sobre el codigo real
supabase/
  migrations/  SQL versionado (tabla nueva = tabla + RLS + policies en la misma migración)
  functions/   Edge Functions (Deno) + _shared/
  tests/       PGlite: RLS, invariantes de esquema y contrato de integraciones
```

### Fronteras de dominio y puertos (P01-SaaS)

Decisiones completas en [`adr/001-domain-boundaries.md`](adr/001-domain-boundaries.md). En resumen:

- **Doce dominios de negocio** —catalog, pricing, customers, inventory, checkout, orders, payments,
  promotions, content, fulfillment, analytics, integrations— y **cinco áreas de plataforma**
  —identity, tenancy, provisioning, configuration, shell—, declarados en `src/domain/boundaries.ts`
  con su estado real (`implemented` / `partial` / `declared`) y su ruta en `src/`.
- **Un puerto existe solo si hay una segunda implementación ya declarada**: una fila de
  `integration_providers` con esa operación, o dos llamantes concretos hoy. Por eso hay
  `PricingPort`, `InventoryPort`, `PaymentProvider`, `FulfillmentProvider`, `NotificationProvider`,
  `ErpProvider` e `InvoicingProvider`, y **no** hay `SearchPort`.
- **Ningún puerto recibe el tenant como parámetro**: `organization_id`/`company_id` salen del JWT
  en el servidor. Un parámetro que se puede pasar se puede pasar mal.
- **El vocabulario canónico es el de la base.** `src/domain/ports/operations.ts` replica el enum
  `integration_kind` y las `capabilities` sembradas, y
  `supabase/tests/integration-contract.test.ts` compara las dos copias contra Postgres real.
- **Ningún nombre de fabricante, banco, transportista o cliente en `src/`**, ni en código ni en
  comentarios. Los proveedores concretos son filas de `integration_providers`.
- **Errores con discriminante.** `AppError.kind` —`config`, `unauthorized`, `forbidden`,
  `not_found`, `conflict`, `invalid`, `rate_limited`, `unavailable`, `unknown`— en vez de comparar
  textos. Lo desconocido nunca es reintentable. Solo tres módulos leen el texto de un error:
  `shared/lib/appError.ts`, `shared/lib/edgeError.ts` y `features/auth/authApi.ts`.
- **Nombres de persistencia en un solo sitio**: `shared/lib/db-schema.ts`, tipado con `satisfies`
  contra `database.types.ts` (generado por `npm run db:types` → `scripts/gen-db-types.mjs`).

Todas estas reglas las comprueba `src/architecture.test.ts`: no son convenciones, son tests.

- Theming por tokens; el acento proviene del branding del tenant (`accent_color`), nunca hardcodeado.
- Light + dark, densidad configurable, WCAG AA, mobile-first real.
- Pantallas largas → tabs centrados con deep-link `#hash`; listados → un buscador general.

## Integración con la suite

- Registro de `ecommerce` en el hub (`apps`, `workspace_apps`) y lectura de addons por sociedad para gating.
- Vitrina cruzada (§6.1): momento contextual hacia eExpense/eSupplier cuando el tenant no las tiene contratadas.
- Coordinación por el buzón `coordinacion\` en Drive; cambios a interfaces compartidas = propuesta al contrato.
