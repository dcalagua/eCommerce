# B2B GAP ANALYSIS — de eCommerce SaaS a plataforma B2B corporativo + canal tradicional

> **Fase 00** del recorrido `claude_b2b_upgrade` (17 fases). Documento de DESCUBRIMIENTO:
> no cambia comportamiento productivo.
> Fecha: 2026-09-02 · Rama: `feat/b2b-upgrade` · HEAD: `f534960`

## 0 · Cómo se produjo este documento

Todo estado de esta tabla sale de **leer el repositorio**, no de suponerlo. Las fuentes son:

| Fuente | Qué aporta |
|---|---|
| `src/domain/boundaries.ts` | mapa de fronteras con `state` declarado y ruta de cada una |
| `src/domain/capabilities.ts` | 6 capacidades baseline + 12 vendibles, con `state` real |
| `supabase/migrations/` (112 archivos) | 113 tablas `public.*` — la lista es exhaustiva, se extrajo con `grep` |
| `src/app/routes.tsx` · `src/features/admin/navigation.tsx` | rutas y menú reales del backoffice |
| `src/shared/lib/roles.ts` + `supabase/functions/_shared/roles.ts` | matriz de permisos (duplicada a propósito, con test de paridad) |
| `src/architecture.test.ts` | las reglas que se ponen rojas si el mapa deja de ser cierto |

**Línea base de validación ANTES de esta fase** (ejecutada el 2026-09-02, árbol limpio):

| Gate | Resultado |
|---|---|
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm test` | PASS — **133 archivos, 2735 tests**, 0 fallos |
| `npm run build` | PASS (exit 0) |

No hay deuda de gates preexistente. Cualquier fallo que aparezca en las fases 01–16 será
**causado por esas fases**, y este es el registro que lo demuestra.

---

## 1 · Qué es hoy este producto

**Stack:** React 18 + TypeScript estricto + Vite 6 + MUI 6 · TanStack Query · React Router 6 ·
react-hook-form + zod · Supabase (Postgres con RLS, Auth, Edge Functions en Deno, Storage) ·
Vitest (unit + PGlite para SQL) · i18n ES/EN propio.

**Estructura:** `src/app` (router/providers) · `src/domain` (puro, sin infraestructura) ·
`src/features/<dominio>` (19 carpetas) · `src/shared` (ui kit, lib, i18n, security, seo) ·
`src/theme` · `supabase/migrations` · `supabase/functions`.

### 1.1 · Los tres ejes de autorización (ya existen, y no son intercambiables)

Esto es lo más importante que hay que entender antes de tocar nada, y está documentado en
`src/domain/capabilities.ts:1-30`:

| Eje | Pregunta | Quién manda | Dónde vive |
|---|---|---|---|
| **Permiso** (`Permission`) | ¿este ROL puede hacerlo? | la app | `src/shared/lib/roles.ts` |
| **Entitlement** | ¿la cuenta CONTRATÓ el módulo? | el hub EBIM | `tenant_entitlements` + cache |
| **Flag** | ¿está encendido técnicamente? | el tenant | `tenant_feature_flags` |

La composición es `app_active AND (baseline OR entitlement) AND flag ≠ false`, implementada
**dos veces a propósito**: en `resolveCapabilities()` (puro, para la UI) y en
`ebim.has_capability` (dentro de las policies, que es la autoridad real).

Tres reglas fijadas por test que las fases B2B **no pueden romper**:

1. `appActive: false` no deja ni lo baseline.
2. Un flag jamás concede — solo resta.
3. Un flag no apaga lo baseline.

### 1.2 · Multi-tenant

Jerarquía `organization_id` → `company_id` → `store_id`. Toda tabla de negocio lleva las dos
primeras; los helpers son `ebim.can_access` y `ebim.has_role` (migración `20260827090000`).
RLS activada y forzada (`force row level security`) con *default deny*.

**Patrón que las fases nuevas deben copiar literalmente**, visto en `business_accounts`
(`20260827190100`): FK **compuestas** que arrastran el tenant
(`foreign key (x_id, organization_id, company_id) references … (id, organization_id, company_id)`).
No es decorativo: impide por construcción que una fila cuelgue de un padre de otro tenant, cosa
que una FK simple sobre el uuid permite.

### 1.3 · Permisos actuales — **solo 5**

```
tenant.manage · store.manage · catalog.write · orders.write · orders.export
```

sobre 5 roles (`owner, admin, catalog, orders, viewer`). La matriz está **duplicada** en
`src/shared/lib/roles.ts` y `supabase/functions/_shared/roles.ts`, con un test que compara
las dos. **Cualquier permiso nuevo hay que añadirlo en los dos sitios.**

### 1.4 · La regla de arquitectura que condiciona TODAS las fases siguientes

`src/architecture.test.ts` exige que **todo archivo bajo `src/features` pertenezca a una
frontera declarada en `boundaries.ts`**. Consecuencia operativa directa:

> Crear `src/features/salesforce/` sin registrar la frontera en `src/domain/boundaries.ts`
> **pone la suite en rojo**. No es opcional y no es un detalle de estilo: es el primer paso
> de cada fase que introduzca una carpeta.

---

## 2 · Inventario del core existente

Leyenda: **IMPLEMENTADO** = esquema + servidor + pantalla en uso · **PARCIAL** = existe una
parte (normalmente solo base o solo contrato) · **DECLARADO** = contrato escrito, sin código ·
**FALTANTE** = no existe nada.

| Dominio | Estado | Evidencia |
|---|---|---|
| Catálogo + categorías | IMPLEMENTADO | `features/catalog`, migr. 090300/091100/091200, `category_tree` (090901xx) |
| PIM (variantes, atributos, UoM, bundles, familias, marcas) | IMPLEMENTADO | `features/catalog/pim` (11 archivos), migr. 170000 — 11 tablas |
| Pricing (listas, segmentos, asignaciones, escalas, vigencia) | IMPLEMENTADO | `features/pricing` (14 archivos), `ebim.resolve_prices` (180100) — **única autoridad de precio** |
| Inventario (almacenes, movimientos, reservas, ATP) | IMPLEMENTADO | `features/inventory`, `ebim.atp` / `take_units` / `hold_stock` (200100) |
| Clientes + cuentas B2B | IMPLEMENTADO | `features/customers` (17 archivos), migr. 190000/190100 |
| Checkout (carrito servidor, intención idempotente, pipeline 11 etapas) | IMPLEMENTADO | `functions/checkout`, `carts`, `checkout_intents`, `checkout_place_order` |
| Pedidos (4 ejes de estado, timeline, snapshots, comandos) | IMPLEMENTADO | `features/orders`, migr. 110000–110500 |
| **Pedidos avanzados** (programados, repetición, importación) | **DECLARADO** | `capabilities.ts` `state:'declared'` · migr. 110600 **crea la capacidad y NINGUNA tabla** |
| Pagos (intento, captura, devolución, conciliación) | IMPLEMENTADO | `features/payments`, 7 tablas (120000), conector `sandbox` |
| Promociones (campañas, cupones, gift cards) | IMPLEMENTADO | `features/promotions`, `ebim.evaluate_promotions` (130100) |
| Fulfillment (zonas, métodos, ventanas, pickup, envíos, devoluciones) | IMPLEMENTADO | `features/fulfillment`, migr. 150000–150700 |
| CMS + white-label + búsqueda | IMPLEMENTADO | `features/content`, `ebim.resolve_content`, `search_vector`+pg_trgm |
| Analytics (9 hechos canónicos, embudo, KPIs) | IMPLEMENTADO | `features/analytics`, `analytics_events` (160100) |
| Integraciones (outbox/inbox, disyuntor, webhooks, API de socio) | IMPLEMENTADO | `features/integrations`, migr. 150000/170000–170600, `functions/api` |
| Observabilidad (correlation id, audit_log, ops_health, trace) | IMPLEMENTADO | `features/ops`, migr. 160000/160300/160400 |
| Storefront + portal del comprador | IMPLEMENTADO | `features/storefront` (60+ archivos), `/s/:storeSlug/account` |

**113 tablas** en total. El core de comercio está completo y probado; **este proyecto no
necesita rehacer nada de lo anterior.**

---

## 3 · Hallazgos de trabajo PARCIAL directamente relevante para las fases B2B

Esto es lo que la fase pedía detectar explícitamente. Los hallazgos son reales y están
verificados por lectura de código.

### H1 · `orders.advanced` está DECLARADA y deliberadamente vacía → alimenta la **Fase 05 (P04)**

`supabase/migrations/20260828110600_orders_advanced_capability.sql` inserta la fila en
`app_capabilities` y **no crea ninguna tabla**, con la justificación escrita. Además dejó
puestos cuatro enganches que las fases siguientes deben **reutilizar, no reinventar**:

1. `orders.source_channel` **ya tiene los valores** `scheduled`, `repeat`, `import`
   (enum `public.order_source_channel`, migr. 110000:81).
2. `order_external_refs` ya modela el lote de importación (`ref_type = 'import_batch'`).
3. La idempotencia de carga masiva ya existe: `checkout_intents` (una compra por clave).
4. La repetición de pedido no necesita esquema: las líneas son snapshot y
   `cart_replace_lines` acepta esa forma.

> **Riesgo:** crear `order_schedules` / `order_batches` desde cero en P04 duplicaría un diseño
> que la migración 110600 argumenta en contra. Hay que partir de estos cuatro enganches.

### H2 · Crédito y estado de cuenta: PARCIAL, con la puerta de salida ya escrita → **Fase 04 (P03)**

`supabase/migrations/20260831140000_shopper_portal.sql` añadió a `business_accounts`:
`credit_limit numeric(14,2)` y `payment_terms_days integer` (0–365), y creó
`public.my_account_statement()` (DEFINER, sin parámetros, deriva las cuentas del vínculo).

Lo que **ya calcula**: línea, deuda viva, vencido, días de atraso, documentos, comprado y
pagado a 12 meses, crédito disponible.

Lo que **NO existe** y hay que construir:

- No hay tabla de documentos por cobrar: *«no se inventa una tabla de facturas: el documento
  que esta app conoce es el PEDIDO»* (comentario de la migración).
- No hay cobranza: ni recibo, ni aplicación de pago a documento, ni antigüedad de saldos.
- **No hay bloqueo por mora**: nada en `create_order` ni en el pipeline de checkout consulta
  `credit_limit`. Un cliente con la línea agotada compra igual.
- El estado de cuenta solo se ve desde el **portal del comprador**
  (`features/storefront/account/AccountStatementSection.tsx`). El backoffice **no tiene**
  pantalla de crédito ni de cobranza.

> La propia migración dejó escrito el punto de extensión: *«el día que exista facturación de
> verdad, el estado de cuenta leerá de ahí y esta función cambia por dentro sin tocar la
> pantalla»*. P03 y P06 deben respetar ese contrato.

### H3 · Facturación: puerto ESCRITO, cero implementación → **Fase 07 (P06)**

`src/domain/ports/invoicing.ts` define `InvoicingProvider` con `issue()` / `read()`,
`InvoiceRequest`, `InvoiceLine` e `InvoiceStatus`, y las operaciones `invoice.issue` /
`invoice.read` declaradas en `integration_providers`.

**No existe ninguna tabla `invoices`** (confirmado contra la lista de 113 tablas).

**El «bloqueo de diseño» del puerto ya está RESUELTO — no rehacerlo en P06** (verificado en
esta fase): el comentario de `src/domain/ports/invoicing.ts:12-17` advierte que `InvoiceLine`
exige `taxRate` y `taxAmount` **por línea**, que `order_items` no los guardaba, y anuncia que
«lo cierra P08». **P08 lo cerró, y el comentario quedó obsoleto.**

- `supabase/migrations/20260828110100_order_item_snapshots.sql` añadió a `order_items` las
  columnas `tax_rate`, `tax_amount`, `tax_inclusive` y `tax_category_code` (además de
  `discount_amount` / `discount_snapshot` y `components_snapshot`).
- La versión vigente de `create_order`
  (`20260828150600_create_order_delivery.sql:713-738`) **las escribe línea a línea**,
  resolviendo la tasa con `ebim.effective_tax_rate(store, tax_category, now())`.

Es decir: un carrito con dos tipos impositivos **sí** puede reconstruir su comprobante desde
la base. P06 **no** necesita migración de esquema para el desglose fiscal de la línea.

> **El caveat real, que sí sigue en pie:** esas columnas fiscales son NULLABLE y sin default
> —decisión explicada en la propia migración: `0` significaría «el impuesto era cero», no «no
> se sabe»—. Las líneas creadas **antes** de `110100` tienen `tax_rate`/`tax_amount` en NULL.
> P06 debe tratar ese NULL como «pedido no facturable por falta de dato fiscal» y nunca
> como cero, y de paso actualizar el comentario obsoleto de `ports/invoicing.ts`.

### H4 · Aprobaciones B2B: el motor existe, el flujo también → reutilizar en **Fase 05 (P04)**

Ya implementado, y es más de lo que parece:

- `approval_rules` (por cuenta, `min_amount`, `approver_role`), `business_account_users.spending_limit`.
- `public.purchase_approval(account, amount)` — decisión pura: si hace falta aprobación y por qué.
- `orders.approval_status` (`not_required|pending|approved|rejected`) + `approval_decided_at/by/email/reason`.
- `public.order_approval_decide(...)` (migr. 110400) — **el comando de decisión ya existe**.
- UI: `features/customers/ApprovalRulesPanel.tsx`.

> P04 **no debe crear un motor de aprobaciones**. Lo que falta es la *bandeja del aprobador* y
> las notificaciones, no el modelo.

### H5 · Canal comercial vs origen técnico — ya separados, reutilizables tal cual

- `channels` (`kind: b2c | b2b | internal`, `requires_auth`, `is_default`) decide **precio,
  catálogo y si exige sesión**. `product_channels` restringe visibilidad y `create_order`
  rechaza un producto fuera de canal.
- `orders.source_channel` es **el origen técnico** (`storefront|backoffice|api|import|scheduled|repeat`).

Las fases de fuerza de ventas y preventa deben usar estos dos ejes existentes; el pedido
tomado por un vendedor es `source_channel = 'backoffice'` (o uno nuevo) sobre un
`channel_id` B2B, **no un tipo de pedido paralelo**.

---

## 4 · Estado de los 15 dominios que piden las fases 01–15

Verificado por búsqueda exhaustiva de identificadores (`seller`, `route_`, `territor`,
`visit_`, `assortment`, `commission`, `goal_`, `forecast`, `invoice_`, `pod_`…) sobre `src/`
y `supabase/`. Los aciertos en español (`ruta`, `zona`, `visita`, `cotiza`, `factura`) se
inspeccionaron uno a uno y son **comentarios o vocabulario de otros dominios**
(`ruta` = path, `zona` = `delivery_zones`, `cotizar` = resolver precio), **no** entidades.

| # | Fase | Estado | Evidencia / qué reutiliza |
|---|---|---|---|
| 01 | P00 Maestro comercial | **FALTANTE** (con base sólida) | Reutiliza `customers`, `customer_segments`, `customer_external_ids`, `business_accounts`, `channels`. Falta la clasificación de canal tradicional: giro/tipo de negocio, categoría de cliente, frecuencia. |
| 02 | P01 Fuerza de ventas | **FALTANTE** | Cero tablas de vendedor. `tenant_members` es del **backoffice**, no una fuerza de ventas con jerarquía y cartera. |
| 03 | P02 Zonas/territorios/rutas | **FALTANTE** | `delivery_zones` existe pero es **cobertura logística de reparto**, no territorio comercial ni ruta de visita. No confundirlas. |
| 04 | P03 Crédito y cobranza | **PARCIAL** → ver **H2** | `credit_limit`, `payment_terms_days`, `my_account_statement()`. Falta cobranza, documentos, bloqueo por mora y pantalla de backoffice. |
| 05 | P04 Pedido B2B avanzado | **PARCIAL** → ver **H1** y **H4** | Enum, `order_external_refs`, `checkout_intents`, `cart_replace_lines`, motor de aprobación completo. Faltan programación, repetición e importación. |
| 06 | P05 Cotizaciones | **FALTANTE** | No hay entidad `quotes`. Los aciertos de «quote» son `price_quote` / `resolve_prices` — **motor de precios reutilizable como base de la cotización**. |
| 07 | P06 Facturación | **DECLARADO** → ver **H3** | Puerto `InvoicingProvider` + operaciones en `integration_providers`. Cero tablas. El impuesto por línea **ya está resuelto** (H3): no requiere migración de esquema. |
| 08 | P07 Surtidos | **FALTANTE** | `product_channels` y `price_list_assignments` dan el patrón de «qué ve quién», pero no hay surtido por cliente. |
| 09 | P08 Promociones trade | **PARCIAL** | Motor completo (`evaluate_promotions`, prioridad, stacking, audiencias por cuenta/cliente). Faltan mecánicas trade: escalonado por volumen, combo, bonificación en producto, presupuesto por cliente. |
| 10 | P09 Planificación de reparto | **PARCIAL** | `fulfillments`, `shipments`, `delivery_windows`, `pickup_points`, `ebim.select_warehouse`. Falta la **planificación**: carga de vehículo, secuencia, capacidad, hoja de ruta. |
| 11 | P10 Evidencia de entrega (POD) | **PARCIAL** | `tracking_events`, `return_evidence` (patrón de evidencia + Storage). Falta POD: firma, foto, geo, entrega parcial, motivo de rechazo. |
| 12 | P11 Metas y comisiones | **FALTANTE** | Cero. Depende por completo de P01 (vendedor) y P02 (territorio). |
| 13 | P12 Visitas / SFA | **FALTANTE** | Cero. Depende de P01 y P02. |
| 14 | P13 Recomendación de pedido | **FALTANTE** | Insumos ya existen: `orders`+`order_items` históricos, `analytics_events`, ATP, surtido (P07). |
| 15 | P14 Forecast | **FALTANTE** | `analytics_timeseries` da la serie; no hay proyección ni demanda. |

**Recuento:** 8 FALTANTE · 5 PARCIAL · 1 DECLARADO · 1 FALTANTE-con-base.

---

## 5 · Gaps de backend

Este repositorio **tiene backend real** (Postgres + Edge Functions) y el operador puede
crear migraciones. Por tanto **no hay gap de "no existe backend"**: el gap es de *esquema aún
no escrito*. Consecuencia para las fases: **no se admite pantalla con datos hardcodeados** —
si una fase necesita una tabla, la crea con su RLS en la misma migración (regla del repo).

Gaps que **no** se cierran escribiendo SQL y hay que declarar como tales:

| Gap | Naturaleza | Impacto |
|---|---|---|
| Catálogo de addons en el hub EBIM | **Decisión del operador**, no código | `ENTITLEMENT_PREFIX = 'ecommerce.'` es **provisional** (`capabilities.ts:88-96`). Toda capacidad B2B nueva nace `declared` hasta que el hub la confirme. |
| Proveedor de facturación electrónica | Decisión comercial + credenciales | P06 puede escribir el adaptador contra el puerto, no puede emitir de verdad. |
| Pasarela de pago real | Solo hay conector `sandbox` | Afecta a la cobranza real de P03. |
| Impuesto por línea en `order_items` | Deuda de esquema conocida | **Bloquea P06**. Verificar `order_item_snapshots` (110100) antes de diseñar. |
| Geolocalización / mapas | Sin proveedor ni PostGIS | Afecta a P02 (rutas), P09 (reparto) y P10 (POD con geo). |

---

## 6 · Riesgos de acoplamiento y deuda técnica

1. **La frontera declarada es un test, no un comentario.** `architecture.test.ts` rompe si una
   carpeta de `features/` no tiene frontera. *Mitigación:* registrar la frontera en
   `boundaries.ts` como **primer commit** de cada fase.

2. **La matriz de permisos está duplicada** (`src/shared/lib/roles.ts` y
   `supabase/functions/_shared/roles.ts`) con test de paridad. *Mitigación:* todo permiso nuevo
   se escribe en los dos archivos en el mismo commit.

3. **`ebim.resolve_prices` es la ÚNICA autoridad de precio.** Cotizaciones (P05), surtidos (P07)
   y promociones trade (P08) tienen incentivo a calcular precio por su cuenta. *Riesgo:* dos
   precios distintos para la misma línea. *Mitigación:* toda fase que necesite precio **llama al
   motor**; jamás lo recalcula.

4. **`delivery_zones` (logística) ≠ territorio comercial (P02).** Nombres casi idénticos,
   semánticas distintas. *Riesgo:* colisión conceptual y consultas cruzadas erróneas.
   *Mitigación:* nombrar el territorio comercial de forma inequívoca (`sales_territories`) y
   documentar la diferencia en la migración.

5. **El comprador B2B no es miembro del tenant.** Su JWT solo trae `sub`; todo su acceso pasa
   por funciones `SECURITY DEFINER` que **no aceptan la cuenta como parámetro**
   (`my_account_statement`, `my_business_orders`, `my_coupons`). *Riesgo:* una función nueva que
   sí acepte `p_business_account_id` abre acceso cruzado entre clientes. *Mitigación:* copiar el
   patrón, derivar siempre del vínculo, y `REVOKE EXECUTE … FROM public, anon`.

6. **El vendedor de campo es un actor nuevo que no encaja en los 5 roles actuales.** No es
   `owner/admin/catalog/orders/viewer` ni es `business_role` (que es del *cliente*). *Riesgo:*
   forzarlo dentro de `app_role` da a un vendedor acceso al backoffice completo. Es la decisión
   de diseño más delicada de P01 y se resuelve en `B2B_TARGET_ARCHITECTURE.md §4`.

7. **Escala de la suite de tests.** 2735 tests, ~145 s. Las pruebas SQL corren sobre PGlite
   (10–12 s cada archivo). *Riesgo:* 15 fases añadiendo tablas alargan el gate hasta hacerlo
   incómodo. *Mitigación:* un archivo de test SQL por fase, no por tabla.

8. **`tsc --noEmit` funciona hoy** (no hay OOM). Si aparece, el precedente del repo es usar
   `vite build` y **decirlo explícitamente**.

---

## 7 · Dependencias entre fases

```
01 P00 Maestro comercial ─┬─> 02 P01 Fuerza de ventas ─┬─> 03 P02 Zonas/rutas ──┬─> 13 P12 Visitas
                          │                            │                        └─> 10 P09 Reparto
                          │                            └─> 12 P11 Metas y comisiones
                          ├─> 04 P03 Crédito ──────────> 07 P06 Facturación
                          ├─> 08 P07 Surtidos ─────────> 14 P13 Recomendación
                          └─> 09 P08 Promos trade
05 P04 Pedido B2B avanzado ──> 06 P05 Cotizaciones
10 P09 Reparto ──> 11 P10 Evidencia de entrega
14 P13 Recomendación + histórico ──> 15 P14 Forecast
```

**Camino crítico:** `P00 → P01 → P02`. Tres fases seguidas sin las cuales seis fases
posteriores no tienen sobre qué apoyarse.

**Riesgo de orden:** el manifiesto pone **P03 Crédito (fase 04) antes de P06 Facturación
(fase 07)**, y el estado de cuenta se calcula hoy sobre `orders`. Si P03 modela documentos por
cobrar, P06 debe **conectarse a ese modelo**, no crear uno paralelo. Queda anotado como
decisión a tomar al inicio de la fase 04.

---

## 8 · Conclusión

El core de comercio está **completo, probado y bien documentado**: 113 tablas, 2735 tests
verdes, fronteras verificadas por test y tres ejes de autorización ya separados. El trabajo
B2B **no es una reescritura**: es añadir la capa comercial de distribución —vendedor,
territorio, ruta, visita, crédito, cotización, surtido, meta— sobre un núcleo que ya sabe
vender, cobrar, despachar y calcular el impuesto.

Lo que hay que reutilizar sin discusión: el motor de precios, el de promociones, el ATP, el
pipeline de checkout, el modelo de pedido con sus cuatro ejes, el motor de aprobaciones, el
outbox de integraciones, la bitácora y el patrón de funciones DEFINER del portal.

La propuesta de dominios está en **[`B2B_TARGET_ARCHITECTURE.md`](B2B_TARGET_ARCHITECTURE.md)**.
