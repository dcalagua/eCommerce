# SAAS_BASELINE — estado real del repositorio

Fecha del corte: **2026-08-27** · Rama `dev` · HEAD `6e66080` (`feat: framework de integraciones (F0 del RFP)`)
Fase que produce este documento: **P00 — Auditoría y baseline** del pack `claude-saas-opus`.
Este documento **describe**, no propone. Cada afirmación lleva el archivo o la migración que la sostiene.

> **Aviso de numeración.** Conviven dos numeraciones de fase y no son la misma:
> - **Histórica** (`docs/STATE.md`): P00–P12, el trabajo ya ejecutado en este repo (P12 = framework de integraciones).
> - **Productización SaaS** (`claude-saas-opus/config/phases.json`): P00–P17, el plan que arranca con este documento.
>
> En `docs/SAAS_ROADMAP.md` y `docs/SAAS_KEEP_REFACTOR_BUILD.md`, «P01…P17» siempre se refieren a la
> numeración de productización. La histórica se cita como «P0x histórico».

---

## 1. Baseline técnico ejecutado

Solo con los scripts que ya existían en `package.json`. Ninguno se modificó.

| Gate | Comando | Resultado | Evidencia |
|---|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **PASS** — exit 0, sin OOM | sin salida de error |
| Lint | `npm run lint` (`eslint .`) | **PASS** — exit 0, 0 problemas | sin salida de error |
| Tests | `npm run test` (`vitest run`) | **PASS** — **569 tests / 40 archivos**, 52,6 s | incluye los de BD |
| Tests de BD | `npm run test:db` (`vitest run supabase/tests`) | **PASS** — **303 tests / 15 archivos**, 13,6 s | PGlite, sin proyecto remoto |
| Build | `npm run build` (`vite build`) | **PASS** — exit 0, 7,33 s | con **1 aviso** (ver 1.1) |

`tsc --noEmit` **no** dio OOM en esta máquina, así que el gate se ejecutó completo y no hizo falta el
recurso a `vite build` que documenta el precedente de eSupplier.

### 1.1 Único aviso del build

```
dist/assets/index-Deg2vAxT.js   742.10 kB │ gzip: 219.93 kB
(!) Some chunks are larger than 500 kB after minification.
```

El chunk de entrada creció de 738 kB (P08 histórico) a **742 kB** (219,93 kB gzip). El code-splitting por
ruta **sí funciona** —hay 19 chunks separados: `ProductsPage`, `OrdersPage`, `SettingsPage`,
`StorefrontLayout`, `zod`, `TextField`, `Modal`, `Tabs`…—, así que lo que pesa es el vendor común
(React + MUI + Supabase) sin `manualChunks`. Es el mismo pendiente abierto desde P08 histórico y entra
en P15.

### 1.2 Comprobaciones de seguridad hechas sobre el baseline

| Comprobación | Resultado |
|---|---|
| `service_role` / `sb_secret_` en el bundle de `dist/` | **Limpio.** Las dos únicas coincidencias son el propio guard `assertNoServiceKey` de `src/shared/lib/env.ts` (la regex y su mensaje de error), no una clave |
| `.env` versionado | **No.** `git ls-files` solo devuelve `.env.example`; `.gitignore` cubre `.env` y `.env.*` |
| Nombre de cliente cableado en el core | **No.** `alicorp` / `casa-nordica` solo aparecen como datos de fixture en `src/features/storefront/*.test.tsx` |
| Esquema `ebim` expuesto por PostgREST | **No.** `supabase/config.toml` → `schemas = ["public"]` |

---

## 2. Arquitectura actual, tal como está

### 2.1 Topología

```
Comprador anónimo ──► /s/:storeSlug/*   (storefront, cliente Supabase ANÓNIMO dedicado)
Usuario del tenant ─► /app/*            (backoffice, sesión + membresía + sociedad activa)
                            │
                            ▼
              Supabase eCommerce  ref ehxlxbhtlmfgneiagdcj  (DEV/QAS enlazado)
                ├─ PostgreSQL 15 · 24 tablas · RLS forzada default deny
                ├─ Storage: product-images, store-assets (privados, policy por tenant)
                └─ Edge Functions (Deno) · 4 desplegables
```

### 2.2 Lo que existe en la base

**28 migraciones**, 5.034 líneas SQL, `20260827090000` … `20260827150100`.

**24 tablas:**
`tenants` · `tenant_members` · `stores` · `store_settings` · `categories` · `products` · `product_images` ·
`orders` · `order_items` · `order_status_events` · `order_tokens` · `currencies` · `tenant_currencies` ·
`tax_categories` · `tax_rates` · `channels` · `product_channels` · `checkout_attempts` ·
`integration_providers` · `tenant_integrations` · `integration_outbox` · `integration_inbox` ·
`integration_messages` · `integration_circuit`.

**Vistas públicas** (`security_invoker`, para `anon`): `public_stores`, `public_categories`,
`public_products`, `public_product_images`, `public_store_branding` (tres de ellas redefinidas en la
migración 12).

**Predicado único de acceso:** `ebim.can_access(org, company)` = claims del JWT **y** membresía activa;
escritura además por `ebim.has_role(...)` sobre el enum `public.app_role`
(`owner/admin/catalog/orders/viewer`).

**Operaciones de servidor** (funciones `public.*`): `bootstrap_tenant`, `create_order`,
`create_order_for_slug`, `order_by_token`, `set_tax_rate`, `set_primary_product_image`,
`reorder_product_images`, `product_deletion_usage`, `category_deletion_usage`, `dashboard_kpis`,
`purge_checkout_attempts`, `integration_enqueue/claim/succeed/fail/reclaim_stale`.

### 2.3 Lo que existe en el front

`src/` — **146 archivos, 17.600 líneas** TS/TSX. Organización **por feature**, no por la carpeta
`src/storefront` + `src/admin` que nombra `CLAUDE.md`:

```
src/app/          router, providers, ErrorBoundary, queryClient
src/theme/        tokens CSS + createEbimTheme + apariencia por usuario
src/shared/       ui kit, i18n ES/EN, lib (env, supabase, money, search, csv, roles)
src/features/auth        login de suite, sesión, RequireSession
src/features/tenant      contexto de tenant derivado del JWT
src/features/onboarding  alta de espacio
src/features/admin       AdminLayout, dashboard, configuración (+ impuestos)
src/features/catalog     productos, categorías, imágenes
src/features/orders      pedidos del backoffice
src/features/storefront  vitrina, carrito, checkout, consulta de pedido
```

Esta divergencia con `CLAUDE.md` está **declarada** en `docs/architecture.md` («Estructura real desde
P01 (organización por features…)») y respeta lo que la regla protege: storefront y backoffice tienen
rutas, layouts, guards y **cliente Supabase** distintos. No se contabiliza como deuda (principio 5 del
encargo), pero conviene alinear el texto de `CLAUDE.md` con la realidad.

### 2.4 Acoplamiento con Supabase

`getSupabaseClient()` y `getStorefrontClient()` (`src/shared/lib/supabase.ts`) se consumen desde
**capas de servicio, nunca desde un componente**: la búsqueda de `getSupabaseClient|getStorefrontClient`
en archivos `.tsx` de producción devuelve **cero** resultados. Los 9 puntos de acceso a Storage viven en
`features/*/api*.ts`. Es la decisión 35 de `docs/STATE.md` y se sostiene.

Lo que **no** existe todavía es la capa de puertos: los servicios hablan directamente el vocabulario de
PostgREST (`.from('products').select(...)`), así que hoy «capa de datos» y «Supabase» son sinónimos.
Eso es exactamente lo que P01 viene a separar; no es un defecto del código actual sino el punto de
partida.

Matiz de aislamiento en escritura: las altas del backoffice **sí envían** `organization_id`/`company_id`
en el cuerpo de la fila (`features/catalog/api/categories.ts:69`, `features/admin/settings/api.ts:156`,
`features/admin/settings/taxes.ts:100`), tomados del contexto de tenant que deriva del JWT. Un valor
falsificado no entra porque el `with check` de cada policy lo compara contra los claims. Es correcto y
está documentado, pero la defensa depende **enteramente** de que toda tabla nueva nazca con su `with
check`; el test de invariantes es el que lo mantiene honesto.

### 2.5 Identidad

**Lo que dice `docs/architecture.md`:** dos Edge Functions `platform-context` y `sso` hacia el hub EBIM.
**Lo que hay en `supabase/functions/`:** `bootstrap-tenant`, `catalog-product`, `create-order`,
`update-order-status`. Las dos del hub **no existen**.

En su lugar, la identidad de DEV/QAS la resuelve un Custom Access Token Hook local
(`20260827120000_dev_demo_auth_hook.sql` + su corrección `_strict`) que inyecta
`org_id`/`companies[]`/`active_company`/`apps[]` en el token a partir de `app_metadata`, solo para
usuarios marcados `ebim_demo = true`. El propio archivo declara «NO ES ARQUITECTURA DEFINITIVA» y
documenta su retirada. Es una decisión deliberada y bien acotada —no toca `can_access` ni ninguna
policy—, pero implica que **hoy no hay integración de identidad con el hub**.

---

## 3. Inventario de dominios y nivel de madurez

Escala: **completo** (usable de punta a punta por un tenant) · **parcial** (existe y funciona, con hueco
declarado) · **placeholder** (hay una pieza que hace de sustituto) · **inexistente**.

| # | Dominio | Madurez | Evidencia | Qué falta |
|---|---|---|---|---|
| 1 | Multitenancy y RLS | **completo** | `20260827090000_ebim_tenant_helpers.sql`, `..._tenants_and_members.sql`; 35 tests en `supabase/tests/rls-tenant-isolation.test.ts`; 17 invariantes en `schema-invariants.test.ts` | nada estructural |
| 2 | Identidad / SSO | **parcial** | Supabase Auth + `ebim.demo_access_token_hook`; `src/features/auth/*` | JWKS del hub, `platform-context`, `sso`, MFA, política de contraseñas |
| 3 | Entitlements / addons / capabilities | **inexistente** | 0 referencias a `addon` en `src/` fuera de un comentario en `StoreSwitcher.tsx:91` | todo el gating por capacidad (P02) |
| 4 | Tiendas, branding y white-label | **completo** para su alcance | `stores`, `store_settings`, CHECK `ebim.is_store_asset_ref` (mig. 15), `SettingsPage.tsx`, `StoreAssetField.tsx` | favicon, tipografía, radius (P11) |
| 5 | Catálogo / PIM | **parcial** | `products` (precio único, `stock`, `custom_fields`), `categories`, `product_images`; `ProductsPage`/`CategoriesPage` | variantes, atributos, marcas, UoM, bundles, paginación server-side (P03) |
| 6 | Canales (B2C/B2B/interno) | **parcial — backend sin superficie** | `channels`, `product_channels`, `orders.channel_id` (mig. 20-21), 12 tests en `channels.test.ts` | **0 referencias a `channel` en todo `src/`**: no hay UI de canales ni storefront por canal |
| 7 | Pricing | **placeholder** | `products.price numeric(14,2)` + `compare_at_price` | listas, vigencias, escalas, segmento, cliente, precedencia (P04) |
| 8 | Impuestos y monedas | **completo** para su alcance | `currencies`, `tenant_currencies`, `tax_categories`, `tax_rates` con vigencia, `ebim.effective_tax_rate`, pestaña Impuestos; 10 tests en `taxes.test.ts` | impuestos por jurisdicción de envío |
| 9 | Clientes / cuentas B2B | **inexistente** | `orders` guarda `customer_email/name/phone` desnormalizados; no hay tabla `customers` | todo el dominio (P05) |
| 10 | Inventario | **placeholder** | `products.stock integer` + columna generada `in_stock`; `create_order` descuenta al confirmar | almacenes, movimientos, reservas, ATP (P06) |
| 11 | Carrito | **parcial** | `src/features/storefront/cart/*`, `localStorage` con clave por `store_id`, `CartStoreMismatchError` | carrito servidor, recuperación entre dispositivos, merge al iniciar sesión (P07) |
| 12 | Checkout | **parcial — sólido en su alcance** | `create_order_for_slug` → `create_order` (mig. 12, 21, 23, 25): precio, tenant, canal e impuesto los pone el SERVIDOR; límite de tasa en la BASE (mig. 22) | idempotencia por clave, pipeline extensible, pago (P07/P09) |
| 13 | Pedidos / OMS | **parcial** | enum `order_status` + trigger `ebim.assert_order_transition`, `order_status_events` append-only, `/app/orders` con buscador+tabs+CSV, `order_by_token` | `payment_status`/`fulfillment_status`, snapshot fiscal por línea, referencias externas (P08) |
| 14 | Pagos | **inexistente** | los proveedores solo existen como filas del catálogo `integration_providers` | todo (P09) |
| 15 | Promociones | **inexistente** | `orders.discount_total` siempre 0 | todo (P10) |
| 16 | Fulfillment / logística | **inexistente** | `orders.shipping_total` siempre 0; `shipping_address` acepta 2 claves | todo (P12) |
| 17 | CMS / merchandising / búsqueda | **placeholder** | hero y banner desde `store_settings`; búsqueda = un `TextField` + `sanitizeSearchTerm` + filtros en la URL | bloques administrables, colecciones, autocompletado (P11) |
| 18 | Analítica y observabilidad | **placeholder** | `public.dashboard_kpis` (SECURITY INVOKER) + `useDashboardKpis.ts` | eventos canónicos, `audit_log` general, exportables (P13) |
| 19 | Framework de integraciones | **parcial — completo y sin usar** | 6 tablas + 5 funciones de transporte (mig. 26-27), 21 tests en `integration-framework.test.ts` | **ningún flujo de negocio encola**: `integration_enqueue` solo lo invocan los tests. Sin adaptador, sin worker, sin UI (P14) |
| 20 | Design system, i18n, apariencia | **completo** | `src/theme/*`, `src/shared/i18n/*` con paridad ES/EN probada, `SectionTabs`, `SearchField` | — |
| 21 | Storefront | **parcial** | vitrina, ficha, galería, carrito, checkout, consulta de pedido por token | SEO, paginación, resolución por dominio (P15) |
| 22 | Infraestructura de pruebas | **completo** | harness PGlite (`supabase/tests/harness.ts`), reproducibilidad de esquema probada entre dos bases vírgenes | E2E en navegador real (Playwright) |

---

## 4. Riesgos reales, con evidencia

Ordenados por impacto sobre la venta multi-cliente. **Ninguno se corrige en P00.**

### R1 · No hay entitlements: el producto no se puede vender por módulos *(bloqueante comercial)*
La arquitectura objetivo es `Core → Add-ons → Ports → Adapters → Tenant Config` y hoy falta el segundo
eslabón entero. `grep -ri addon src/` devuelve una sola coincidencia, y es un comentario en
`src/features/admin/StoreSwitcher.tsx:91`. Consecuencia: cada cliente nuevo recibe el producto completo,
o alguien acaba escribiendo un `if` por tenant. **Cierra P02.**

### R2 · Canales implementados en la base y sin superficie *(riesgo de deriva)*
`channels` + `product_channels` + `orders.channel_id` están completos y probados, pero `grep -ri channel
src/` devuelve **cero**. Un tenant no puede crear un canal, ni asignar productos, ni comprar por uno
distinto del `is_default`. Una capacidad de servidor sin cliente durante varias fases es una capacidad
que se pudre: cuando llegue la UI, el modelo habrá cambiado bajo ella. **Cierra P02/P03.**

### R3 · El outbox no lo alimenta nadie *(mismo riesgo que R2, más caro)*
`integration_enqueue` solo aparece en `supabase/tests/integration-framework.test.ts:42`. El transporte
—idempotencia, `for update skip locked`, backoff con jitter, cola muerta, disyuntor— está bien
construido y **no ha entregado un solo mensaje real**. El primer adaptador de verdad es lo que valida si
el contrato canónico está bien planteado. **Cierra P14 (y antes, con un consumidor real en P07/P09).**

### R4 · El checkout no es idempotente frente a la red
`create_order` no acepta clave de idempotencia: la única unicidad de ese tipo en el esquema es
`integration_outbox_unique (organization_id, company_id, idempotency_key)`, en otra tabla y para otra
cosa. Hoy el doble envío se frena en el navegador —botón deshabilitado + corte en `onSubmit`
(`src/features/storefront/StoreCheckoutPage.tsx`)—, defensa que no cubre el reintento de una petición
cuya respuesta se perdió. Escenario concreto: móvil en 3G, el POST llega, la respuesta no; el reintento
crea un **segundo pedido con stock descontado dos veces**. **Cierra P07.**

### R5 · Un pedido no puede reconstruir su impuesto por línea
La migración 17 calcula la tasa **por línea** (`ebim.effective_tax_rate` por producto) y luego agrega por
tasa, pero `order_items` no tiene columna de impuesto ni de descuento: solo persisten `orders.tax_total`
y `orders.discount_total`. Con dos tipos impositivos en un carrito, el desglose que sostiene una factura
electrónica **no está en la base**, solo en el JSON de respuesta de la Edge Function. Es un problema de
snapshot inmutable, no de cálculo. **Cierra P08 (y lo necesita P09/facturación).**

### R6 · Identidad de hub ausente y hook de demo aplicado en DEV/QAS
`platform-context` y `sso` están descritos en `docs/architecture.md` y no existen en
`supabase/functions/`. La identidad efectiva es Supabase Auth + `ebim.demo_access_token_hook`, aplicado
en DEV/QAS. El hook está bien construido (sin `SECURITY DEFINER`, `search_path` fijo, `EXECUTE` solo a
`supabase_auth_admin`, puerta estricta por booleano tras la corrección de la mig. 21) y su retirada está
documentada. El riesgo no es el hook: es que **el camino real de identidad nunca se ha ejercitado**, y
descubrir que los claims del hub no encajan con `ebim.can_access` en P16 sería tarde. Requiere decisión
del operador y coordinación con GMAO — **no se resuelve por iniciativa propia**.

### R7 · Sin `audit_log` transversal
Hay dos bitácoras específicas y bien hechas —`order_status_events` (append-only por trigger) e
`integration_messages`— y ninguna general. `CLAUDE.md` la exige («Bitácora/audit: escritura solo vía
función `SECURITY DEFINER` validada»), la matriz del RFP da AD003 por cumplido y el objeto no existe.
Un cambio de precio, de branding o de rol no deja rastro. **Cierra P13.**

### R8 · Las Edge Functions siguen fuera del typecheck
`tsconfig.json` cubre `supabase/functions/_shared` (TS plano, con sus 53 tests en `edge-shared.test.ts`),
pero `_runtime/*` y los cuatro `index.ts` usan globales de Deno y quedan fuera de `tsc`. Sin `deno check`
en el gate, un error de tipos en el borde solo aparece al desplegar. Abierto desde P08 histórico.
**Cierra P17 (o antes, si se instala Deno).**

### R9 · Bundle de entrada de 742 kB
Ver 1.1. Impacto directo en un storefront mobile-first. **Cierra P15.**

### R10 · Los lineamientos EBIM no están montados en esta sesión
`H:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma\` **no es accesible**: la
unidad `H:` no está montada. Esta auditoría trabajó con las reglas ya destiladas en
`docs/EBIM_GUIDELINES_TRACE.md` (11 fuentes, leídas y verificadas el 2026-08-27). Para P00 no es
bloqueante —no se toca identidad, multitenant ni arquitectura de plataforma—, pero **P02 (entitlements)
y P16 (identidad/seguridad) no deben ejecutarse sin volver a montar la unidad**: el contrato manda sobre
el código y sus §2/§3/§5 son la fuente. También queda sin leer `coordinacion\BANDEJA.md`.

---

## 5. Duplicaciones y límites del modelo

### 5.1 Duplicaciones encontradas

- **Máquina de estados del pedido en tres copias**: trigger `ebim.assert_order_transition` (mig. 04),
  `supabase/functions/_shared/orders.ts` y `src/features/orders/status.ts`. **No es deuda**: hay un test
  que compara las tres entre sí y contra el SQL de la migración (decisión 51 de `STATE.md`). Es
  duplicación deliberada y vigilada.
- **`REFERENCE_CATALOG` en los tests de invariantes** (`currencies`, `integration_providers`): lista
  nominal, no un patrón, con un test que verifica que cada miembro es global y de solo lectura. Correcto.
- **Sin duplicaciones reales de lógica de negocio** entre backoffice y storefront: `moneyText` y
  `sanitizeSearchTerm` ya subieron a `src/shared/lib` (decisión 45).

### 5.2 Límites del modelo actual, uno por uno

| Límite | Dónde se ve | A quién bloquea |
|---|---|---|
| Un solo precio por producto | `products.price` | B2B, canal interno, precio negociado |
| Un solo stock por producto | `products.stock` | multi-almacén, ATP |
| Sin entidad cliente | `orders.customer_email` | cuentas B2B, aprobaciones, estado de cuenta |
| Producto sin variantes | no existe `product_variants` | talla/color, UoM de venta, bundles |
| Carrito solo en el navegador | `localStorage` | recuperación entre dispositivos, carrito abandonado |
| Un único eje de estado en el pedido | `orders.status` | pago y entrega evolucionan por separado |
| Categorías de un nivel por UI | `CategoryDrawer.tsx` sin selector de padre | navegación por familia/marca |
| Storefront SPA sin prerender | `vite build` | SEO del canal B2C |

Ninguno es un error: cada uno fue el alcance correcto de su fase. Son el punto de partida de P03–P08.

---

## 6. Lo que este documento NO cambió

P00 es auditoría. No se tocó una línea de producto, ni una migración, ni un test, ni `package.json`.
Los únicos archivos creados o modificados son `docs/SAAS_BASELINE.md`,
`docs/SAAS_KEEP_REFACTOR_BUILD.md`, `docs/SAAS_ROADMAP.md` y `docs/STATE.md`.
