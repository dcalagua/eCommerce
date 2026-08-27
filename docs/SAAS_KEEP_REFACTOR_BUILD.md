# SAAS_KEEP / EXTEND / REFACTOR / BUILD

Corte: **2026-08-27**, HEAD `6e66080`. Base de evidencia: [`SAAS_BASELINE.md`](SAAS_BASELINE.md).
Numeración de fases = productización SaaS (P01–P17 de `claude-saas-opus`), no la histórica de
`docs/STATE.md`.

## Qué significa cada etiqueta

| Etiqueta | Significa |
|---|---|
| **KEEP** | Correcto para el producto objetivo. No se toca salvo para consumirlo. |
| **EXTEND** | La base es correcta; falta superficie o alcance. Se añade **encima**, sin rehacer. |
| **REFACTOR** | Funciona, pero su forma actual bloquea el SaaS multi-cliente. Se cambia con tests que lo respalden. |
| **BUILD** | No existe. Se construye desde cero. |

---

## Matriz

| # | Dominio / pieza | Clasificación | Fase | Justificación con evidencia |
|---|---|---|---|---|
| 1 | Multitenancy, RLS y helpers `ebim.*` | **KEEP** | — | `ebim.can_access` exige claims **y** membresía activa y está probado por 35 tests de aislamiento más 17 invariantes de esquema; es el activo más sólido del repo (`supabase/tests/rls-tenant-isolation.test.ts`, `schema-invariants.test.ts`). |
| 2 | Modelo `tenants` / `tenant_members` / `stores` con FK compuestas | **KEEP** | — | La FK `(store_id, organization_id, company_id) → stores` hace estructuralmente imposible que una fila hija declare otro tenant (`20260827090300_catalog.sql`), que es más fuerte que cualquier validación de aplicación. |
| 3 | Design system, tokens, apariencia e i18n ES/EN | **KEEP** | — | Tokens replicados 1:1 del handoff de suite, acento 100 % del tenant y paridad de diccionario probada (`src/theme/*`, `src/shared/i18n/messages.test.ts`); cambiarlo rompería la coherencia de suite sin ganar nada. |
| 4 | Separación storefront/backoffice y cliente Supabase anónimo dedicado | **KEEP** | — | `getStorefrontClient()` fuerza `anon` aunque haya sesión de backoffice, que es lo que hace correctas las policies `to anon` (`src/shared/lib/supabase.ts`, decisiones 17 y 43). |
| 5 | Harness de pruebas PGlite y test de reproducibilidad de migraciones | **KEEP** | — | Permite 303 tests de BD sin proyecto remoto y compara la huella completa del esquema entre dos bases vírgenes (`supabase/tests/harness.ts`, `schema-invariants.test.ts`). |
| 6 | Impuestos y monedas con vigencia | **KEEP** | — | `tax_rates` se versiona en vez de sobrescribirse y `ebim.effective_tax_rate` resuelve en cascada devolviendo un escalar, no filas de tenant (`20260827091600`, `..._091700`); es ya la forma que necesita el SaaS. |
| 7 | Máquina de estados del pedido y `order_status_events` | **KEEP** | — | Append-only por ausencia de GRANT, no por comentario, y con las tres copias de la máquina comparadas por test (decisiones 51–53); rehacerla en P08 sería tirar una garantía probada. |
| 8 | `create_order` server-authoritative | **KEEP** (lo autoritativo) | P07 | El precio, el tenant y el canal los pone la base y el cuerpo del cliente los tiene en lista negra (`20260827130300_create_order_rate_limited.sql:60-70`); el pipeline se construye **alrededor** de esta propiedad, no en su lugar. |
| 9 | Límite de tasa del checkout en la base | **KEEP** | — | El contador vive en la misma transacción que crea el pedido, así que no hay ventana entre contar y crear (`20260827130200_checkout_rate_limit.sql`); moverlo al borde lo debilitaría. |
| 10 | Consulta de pedido por token (`order_tokens` + `order_by_token`) | **KEEP** | — | Tabla propia en vez de columna «privada» de `orders` —un `revoke select (col)` no anula el grant de tabla— y error idéntico para pedido inexistente y token inválido (`20260827140000`, `order-lookup.test.ts`). |
| 11 | Framework de integraciones (outbox/inbox/circuito/mensajes) | **EXTEND** | P14 | Transporte correcto y probado (21 tests) pero **sin un solo consumidor real**: `integration_enqueue` solo lo llaman los tests. Se extiende con adaptador, worker y monitor; no se reconstruye. |
| 12 | Canales (`channels`, `product_channels`, `orders.channel_id`) | **EXTEND** | P02→P03 | El modelo es el correcto —canal como dimensión, no como tienda duplicada— y los CHECK de coherencia viven en la base; lo que falta es superficie: `grep -ri channel src/` = 0 resultados. |
| 13 | Branding / white-label de tienda | **EXTEND** | P11 | `store_settings` + CHECK `ebim.is_store_asset_ref` ya impiden apuntar al bucket de otro tenant; faltan favicon, tipografía y radius sobre el mismo mecanismo. |
| 14 | Storefront (vitrina, ficha, galería) | **EXTEND** | P15 | Navegable y con filtros en la URL, pero sin SEO, sin paginación y sirviendo un bundle de 742 kB; la experiencia se eleva sobre lo que hay, sin cambiar de framework. |
| 15 | Backoffice de catálogo y pedidos | **EXTEND** | P03, P08 | Buscador único + tabs + CSV siguen la regla de suite; lo que falta es listado server-side, paginación y las entidades nuevas (variantes, UoM). |
| 16 | Dashboard de KPIs | **EXTEND** | P13 | `dashboard_kpis` es `SECURITY INVOKER` a propósito —un panel DEFINER es el sitio perfecto para filtrar datos entre tenants sin que se note— y esa forma sirve igual para las métricas nuevas. |
| 17 | Bootstrap de tenant (`bootstrap-tenant` + `bootstrap_tenant`) | **EXTEND** | P02 | Sus dos credenciales (clave de aprovisionamiento y JWT verificado) ya están resueltas; solo hay que darle de alta también las capacidades efectivas del nuevo tenant. |
| 18 | Capa de acceso a datos `features/*/api*.ts` | **REFACTOR** | P01 | Ningún componente `.tsx` toca Supabase —eso está bien— pero los servicios hablan PostgREST directamente, así que hoy «capa de datos» y «Supabase» son lo mismo y no hay dónde enchufar un ERP. |
| 19 | Catálogo de producto (`products`) | **REFACTOR** | P03→P04 | `price`, `stock` y `currency` como columnas escalares del producto son el techo del modelo: sin variantes ni listas, B2B y multi-almacén no caben. Se migra de forma compatible, sin borrar las columnas mientras `create_order` dependa de ellas. |
| 20 | Inventario (`products.stock`) | **REFACTOR** | P06 | Un entero por producto no expresa `on_hand` / `reserved` / ATP, y `create_order` descuenta al confirmar; sin reservas transaccionales el overselling depende de la suerte. |
| 21 | Carrito en `localStorage` | **REFACTOR** | P07 | Correcto para el comprador anónimo —clave por tienda y descarte de carritos ajenos— pero sin carrito servidor no hay recuperación entre dispositivos, ni merge al iniciar sesión, ni carrito abandonado medible. |
| 22 | Snapshot de línea de pedido (`order_items`) | **REFACTOR** | P08 | Guarda `sku`, `name` y `unit_price` pero **no** impuesto ni descuento por línea, aunque la mig. 17 los calcula por línea: un pedido con dos tipos impositivos no puede reconstruir su factura desde la base. |
| 23 | Estado del pedido en un solo eje | **REFACTOR** | P08 | `orders.status` mezcla pago y entrega; en cuanto exista pasarela, «pagado pero no despachado» y «despachado contra reembolso» dejan de ser expresables. Se añaden ejes sin romper el enum actual ni su trigger. |
| 24 | Identidad | **REFACTOR** *(bloqueado por el operador)* | P02/P16 | `platform-context` y `sso` están en `docs/architecture.md` y no existen en `supabase/functions/`; el camino real de identidad nunca se ha ejercitado. **No se cambia por iniciativa propia** (contrato §2, cambios breaking al buzón). |
| 25 | Estructura `src/features/*` frente a `src/storefront` + `src/admin` de `CLAUDE.md` | **KEEP** | — | Divergencia **declarada** en `docs/architecture.md` que preserva lo que la regla protege (rutas, layouts, guards y cliente distintos); reorganizar 146 archivos sería un refactor cosmético. Pendiente: alinear el texto de `CLAUDE.md`. |
| 26 | Entitlements / capabilities / feature flags | **BUILD** | P02 | No existe nada: cero referencias a `addon` en `src/`. Sin esto no se puede vender el mismo producto con módulos distintos, que es el objetivo entero. |
| 27 | Puertos de dominio (`PricingPort`, `InventoryPort`, `PaymentProvider`, `ErpProvider`, …) | **BUILD** | P01 | No existe ninguna interfaz de frontera; el patrón adaptador solo vive en el catálogo `integration_providers`, que es datos, no código. |
| 28 | Motor de precios y listas | **BUILD** | P04 | Solo hay `products.price` + `compare_at_price`; no existe `price_lists` ni resolución por canal, segmento, cantidad o vigencia. |
| 29 | Clientes y cuentas B2B | **BUILD** | P05 | `orders` guarda contacto desnormalizado y no hay tabla `customers`: no existe el concepto de cliente separado del usuario autenticado. |
| 30 | Pagos | **BUILD** | P09 | Los proveedores solo existen como filas del catálogo; no hay `payment_intents`, ni webhooks, ni conciliación. El pedido nace en `pending` y la tienda cobra por su canal. |
| 31 | Promociones y cupones | **BUILD** | P10 | `orders.discount_total` está siempre en 0 y el CHECK de cuadre ya lo contempla, así que la columna existe y la lógica no. |
| 32 | Fulfillment, envíos y devoluciones | **BUILD** | P12 | `orders.shipping_total` siempre 0 y `shipping_address` acepta exactamente dos claves; no hay zonas, métodos, ventanas ni tracking. |
| 33 | CMS y merchandising | **BUILD** | P11 | El contenido de la vitrina son tres campos de `store_settings`; no hay bloques administrables, colecciones ni campañas. |
| 34 | `audit_log` transversal | **BUILD** | P13 | Existen dos bitácoras específicas (`order_status_events`, `integration_messages`) y ninguna general, pese a que `CLAUDE.md` la exige. |
| 35 | Adaptador ERP + simulador de BAPIs | **BUILD** | P14 | El contrato canónico está definido en `integration_providers.capabilities` y no hay ni un adaptador que lo implemente; un solo adaptador end-to-end es lo que valida el contrato. |
| 36 | E2E en navegador (Playwright) | **BUILD** | P17 | Los cuatro recorridos mínimos corren con router real y backend falso, no en navegador; abierto desde P08 histórico. |
| 37 | `deno check` en el gate | **BUILD** | P17 | `_runtime/*` y los cuatro `index.ts` quedan fuera de `tsc`; sin esto un error de tipos en el borde solo aparece al desplegar. |

---

## Lecturas rápidas

**Lo que sostiene el producto y no se toca (KEEP):** aislamiento multi-tenant, autoridad de servidor en
el checkout, design system e infraestructura de pruebas. Son cuatro cosas y las cuatro están probadas.

**Lo que ya existe y solo necesita superficie (EXTEND):** integraciones, canales, branding, storefront,
backoffice, KPIs. Aquí el riesgo no es técnico, es de tiempo: dos de ellas (canales e integraciones)
llevan fases enteras sin consumidor.

**Lo que hay que cambiar de forma (REFACTOR):** producto, inventario, carrito, snapshot de línea, eje de
estado y capa de datos. Todos con transición compatible: ninguna migración aplicada se modifica, ninguna
columna en uso se borra antes de tiempo.

**Lo que no existe (BUILD):** entitlements, puertos, pricing, clientes, pagos, promociones, fulfillment,
CMS, auditoría, adaptador ERP y los dos gates que faltan. Es la mayor parte del trabajo y el orden en
que se acomete está en [`SAAS_ROADMAP.md`](SAAS_ROADMAP.md).
