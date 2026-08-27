# SAAS_BASELINE — estado real del repositorio

Fecha del corte: **2026-08-27** · Rama `dev` · HEAD `77df9a3` (`docs: baseline auditado del SaaS y roadmap P01-P17`)
Fase que produce este documento: **P00 — Auditoría y baseline** del pack `claude-saas-opus`.
Este documento **describe**, no propone. Cada afirmación lleva el archivo o la migración que la sostiene.

> **Segunda pasada (2026-08-27, HEAD `77df9a3`).** El baseline se volvió a ejecutar entero y los cinco
> gates siguen verdes. Entre `6e66080` y `77df9a3` no cambió una línea de producto —el commit es solo
> documentación—, así que las cifras materiales se mantienen. Lo que **sí** cambió es lo que se pudo
> verificar: los lineamientos EBIM resultaron accesibles (§1.3) y su lectura directa produjo dos
> hallazgos nuevos, **R11** y **R12**, además de corregir **R10**.

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
| Tests | `npm run test` (`vitest run`) | **PASS** — **569 tests / 40 archivos**, 37,1 s | incluye los de BD |
| Tests de BD | `npm run test:db` (`vitest run supabase/tests`) | **PASS** — **303 tests / 15 archivos**, 13,4 s | PGlite, sin proyecto remoto |
| Build | `npm run build` (`vite build`) | **PASS** — exit 0, 4,25 s | con **1 aviso** (ver 1.1) |

Los tiempos son los de la segunda pasada (misma máquina, caché de `node_modules` caliente); los conteos
de tests y el tamaño del bundle son idénticos a la primera. Ningún script se modificó.

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

### 1.3 Lineamientos EBIM: accesibles, en otra letra de unidad

`CLAUDE.md` y `docs/EBIM_GUIDELINES_TRACE.md` apuntan a `H:\.shortcut-targets-by-id\18EpkG…\EBIM-Plataforma\`.
**`H:` no existe en esta máquina** (`Get-PSDrive` devuelve `C`, `D`, `G`), y de ahí salió el bloqueo R10 de
la primera pasada. Google Drive está montado en **`G:`**, y el mismo destino se resuelve por el acceso
directo `G:\Mi unidad\EBIM-Plataforma.lnk`, cuyo `TargetPath` es:

```
G:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma
```

Los 22 elementos de esa carpeta se listaron y **se leyeron directamente** en esta sesión:
`EBIM-PLATAFORMA-INDEX.md`, `EBIM-CONTRATO-PLATAFORMA.md` (v1.15, §0/§1/§2/§5/§6/§7),
`EBIM-CREW-ROSTER.md`, `coordinacion\PROTOCOLO.md` y `coordinacion\BANDEJA.md` completa.
La letra de unidad es un detalle de la máquina, no del contrato: lo que importa es que **la fuente de
verdad sí está disponible** y que R10 ya no bloquea P02/P16. De esa lectura salen R11 y R12.

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
| 3 | Entitlements / addons / capabilities | **inexistente** | `grep -rin addon src/` → **cero coincidencias, sin excepción**. Lo más cercano es un comentario en `StoreSwitcher.tsx:89-92` que dice que `platform-context` no está cableado | todo el gating por capacidad (P02) |
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

Trece riesgos, ordenados por impacto sobre la venta multi-cliente. **Ninguno se corrige en P00.**
R11–R13 son de la segunda pasada; R10 quedó reducido tras verificar el acceso a la fuente (§1.3).

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

### R10 · La ruta de lineamientos de `CLAUDE.md` está mal — el riesgo real es de rumbo, no de acceso ~~(resuelto)~~
**Corregido en la segunda pasada.** La fuente **sí es accesible**, en `G:` y no en `H:` (§1.3), y se leyó
directamente. Lo que queda de este riesgo es menor pero persistente: `CLAUDE.md` y
`EBIM_GUIDELINES_TRACE.md` documentan una ruta que en esta máquina falla, así que cada sesión nueva
concluye «no hay contrato» y sigue adelante con la traza destilada en vez de la fuente. Eso es
exactamente cómo una app se desvía del contrato sin que nadie lo decida. **Se corrige documentando la
resolución por el acceso directo, no fijando una letra de unidad** (varía por máquina).
Baja a riesgo de proceso; **ya no bloquea P02 ni P16**.

### R11 · `database.types.ts` está commiteado **vacío**: regresión silenciosa *(nuevo)*
`src/shared/lib/database.types.ts` mide **0 bytes** en HEAD. No siempre fue así:

| commit | tamaño |
|---|---|
| `990010d` (`chore: alinea el repo con la BD…`) | 37.071 B |
| `e927262` (`feat: canales de venta…`) | 40.648 B |
| `6e66080` (`feat: framework de integraciones`) | **0 B** ← se vació aquí |

El script es `supabase gen types typescript --linked … > src/shared/lib/database.types.ts`: la
redirección `>` **trunca el archivo antes de ejecutar el comando**, así que un `supabase` que falle
—CLI ausente, proyecto no enlazado, red caída— deja el archivo en cero y devuelve un exit code que
nadie mira. Y nadie lo notó porque **ningún archivo del repo importa `database.types`**: `grep -rn
"database.types" src/ tsconfig.json` → cero. Los tipos que usan las pantallas son los de dominio
escritos a mano en `features/*/types.ts`.

Consecuencia doble: (a) la convención de `CLAUDE.md` —«Tipos de BD generados, no escritos a mano»— hoy
**no se cumple, y la evidencia de que se cumplía está borrada**; (b) cuando P03–P08 empiecen a mover el
esquema, no hay nada que compare el tipo de la pantalla contra la columna real. La regeneración es
trivial; lo que hay que arreglar de verdad es que el pipeline **no pueda** volver a vaciarlo (generar a
temporal y mover solo si el exit code es 0) y que algo lo consuma. **Cierra P01.**

### R12 · `ecommerce` no existe para la suite: no está en el contrato, ni en el protocolo, ni en el buzón *(nuevo, bloqueante de P02)*
Verificado por lectura directa de la fuente (§1.3):

| Dónde debería estar | Qué hay |
|---|---|
| `EBIM-CONTRATO-PLATAFORMA.md` v1.15, cabecera «Apps» | `gmao`, `eexpense`, `esupplier`, `echange`, `wms` (+ `odoo` futuro). **`ecommerce` no aparece ni una vez en las 59 kB del contrato.** |
| `coordinacion\PROTOCOLO.md`, «Agentes vigentes» | `gmao`, `eexpense`, `esupplier`, `echange`, `wms`. `ecommerce` **no es un `from`/`to` válido** |
| `coordinacion\BANDEJA.md` | **cero mensajes** de o hacia `ecommerce`, en toda la historia del buzón |
| `EBIM-CREW-ROSTER.md` (crew obligatorio, gmao-027) | sin entrada de eCommerce |
| `Estado de Suite\` | hay `EBIM-ESTADO-{GMAO,eExpense,eSupplier,eChange}.md`; **no hay uno de eCommerce** |

Esto no es un trámite. El principio §0.5 del contrato —«toda solución de la suite se integra y se
comunica con las demás, no es opcional»— exige registrarse en el hub, atender el buzón y **declarar los
canales de integración**; eSupplier, eExpense y eChange ya declararon los suyos en el hilo `gmao-033`
y eCommerce nunca lo hizo. El impacto técnico es directo sobre **P02**: §5 y §6 dicen que los addons
**se leen del hub** y que ninguna app define su catálogo local, pero el hub no tiene fila de la app
`ecommerce` ni `catalog_items` con código `ecommerce_*`. Un control plane de entitlements construido
ahora tendría que inventarse su propio catálogo local, que es precisamente lo que el contrato prohíbe.

Hay además obligaciones de suite dirigidas a `to: all` que eCommerce nunca acusó: `esupplier-031`
(anatomía única de login), `gmao-032` (mascota Bebim, hoy pausada por el operador), `gmao-037`
(contraseña de demo `Demo2026!`), `gmao-038` (usuario en varios tenants).

**No se resuelve desde este repo.** El contrato lo edita solo GMAO (owner), y `CLAUDE.md` prohíbe
escribir en la carpeta de lineamientos —es de solo lectura—, así que esta fase **documenta el bloqueo y
no lo toca**, conforme a la regla 14 del contrato de ejecución. Requiere que el operador dé de alta
`ecommerce` en el hub y en el protocolo, y que después eCommerce envíe su mensaje de alta declarando
canales. **Antes de P02.**

*(Dato a favor, de la misma lectura: eCommerce **sí cumple** el §3.2 —admin obligatorio al crear un
tenant— y lo cumple donde el contrato pide, en la base:
`20260827090700_server_operations.sql:45-48` levanta `ADMIN_EMAIL_REQUERIDO` sin parámetro opcional.
eSupplier y eExpense lo tienen como deuda abierta en el buzón. Es material para el mensaje de alta.)*

### R13 · Deriva entre la documentación y el código en nombres de archivo *(menor)*
`CLAUDE.md:74` y `docs/architecture.md:79` mandan usar `supabase/functions/_shared/governance.ts` para
los guards de rol. **Ese archivo no existe**: el módulo real es `_shared/roles.ts`. Es cosmético hoy,
pero es una regla normativa que apunta a nada, y quien la siga al pie de la letra creará un segundo
módulo de guards. Se corrige con una línea en cada documento.

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
| Tipos de dominio escritos a mano, sin contraste con el esquema | `features/*/types.ts`; `database.types.ts` vacío (R11) | cualquier fase que mueva columnas |

Ninguno es un error: cada uno fue el alcance correcto de su fase. Son el punto de partida de P03–P08.

### 5.3 Una colisión de vocabulario a resolver antes de P02

En este repo **`Capability` ya significa otra cosa**: `src/shared/lib/roles.ts` la define como permiso
**de rol** (`owner/admin/catalog/orders/viewer`), con su gemela en `supabase/functions/_shared/roles.ts`
y un test que compara ambas (`roles.test.ts:21-25`). El contrato §6, en cambio, llama capacidad a lo que
el tenant **contrató** (addon activo por sociedad). Son dos ejes ortogonales —qué puede hacer *este
usuario* frente a qué compró *esta cuenta*— y hoy comparten palabra. Si P02 introduce
`AppCapabilities` sin renombrar, el día que alguien lea `can('orders')` no sabrá cuál de los dos
sistemas está consultando. Cuesta nada decidirlo ahora y es caro después.

---

## 6. Lo que este documento NO cambió

P00 es auditoría. No se tocó una línea de producto, ni una migración, ni un test, ni `package.json`.
Los únicos archivos creados o modificados son `docs/SAAS_BASELINE.md`,
`docs/SAAS_KEEP_REFACTOR_BUILD.md`, `docs/SAAS_ROADMAP.md`, `docs/STATE.md`,
`docs/EBIM_GUIDELINES_TRACE.md` y una línea de ruta en `CLAUDE.md` (§1.3).

Tampoco se escribió **nada** en la carpeta de lineamientos: es de solo lectura por `CLAUDE.md`, y el
alta en el contrato y en el buzón que pide R12 la decide el operador con GMAO, no esta fase. En
particular, `database.types.ts` (R11) **se deja vacío a propósito**: regenerarlo exige el proyecto
enlazado y sería un cambio funcional dentro de una fase de auditoría. Se documenta y se pasa a P01.
