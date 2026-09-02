# B2B TARGET ARCHITECTURE — dominios de distribución sobre el core existente

> **Fase 00** del recorrido `claude_b2b_upgrade`. Propuesta de arquitectura, no implementación.
> Se lee **después** de [`B2B_GAP_ANALYSIS.md`](B2B_GAP_ANALYSIS.md).
> Fecha: 2026-09-02 · Rama: `feat/b2b-upgrade`

## 0 · Principio rector

> **REUTILIZAR > EXTENDER > CREAR.**

El core de comercio (113 tablas, 12 dominios `implemented`) **no se toca salvo extensión
aditiva**. Lo que se añade es la capa que hoy no existe: la **operación comercial de
distribución** — quién vende, a qué territorio, en qué ruta, con qué crédito, contra qué meta.

Regla de decisión para cada fase, en este orden:

1. ¿Existe ya la tabla/función/pantalla? → **usarla**.
2. ¿Existe algo que solo necesita una columna o un valor de enum? → **extender** (`add column`,
   `alter type … add value`), nunca una tabla paralela.
3. Solo si no hay nada → **crear**, con RLS en la misma migración.

---

## 1 · Los cuatro dominios nuevos (y por qué son cuatro, no quince)

Las 15 fases funcionales **no son 15 dominios**. Agruparlas en cuatro fronteras evita quince
carpetas de `features/` con tres archivos cada una y mantiene el mapa legible:

| Frontera nueva | `kind` | Responsabilidad (qué decide, y por tanto qué NO decide ninguna otra) | Fases |
|---|---|---|---|
| **`sales`** | domain | Quién vende y con qué estructura comercial: vendedor, jerarquía, cartera, territorio, ruta, visita, meta y comisión. **No** decide precio ni stock. | 02, 03, 12, 13 |
| **`credit`** | domain | Cuánto se le fía a un cliente y cuánto debe: línea, condiciones, documento por cobrar, cobranza, antigüedad y bloqueo. **No** decide si el pedido se despacha. | 04, 07 |
| **`trade`** | domain | Qué se le ofrece a cada cliente del canal: surtido, cotización y mecánica trade. **No** calcula precio — se lo pide a `pricing`. | 06, 08, 09 |
| **`planning`** | domain | Qué se prevé y qué se sugiere: recomendación de pedido y forecast de demanda. **No** crea pedidos. | 14, 15 |

Y **tres extensiones** de fronteras existentes, sin frontera nueva:

| Fase | Frontera existente que se extiende | Por qué no es un dominio nuevo |
|---|---|---|
| 01 · Maestro comercial | `customers` | Es clasificación de la ficha de cliente (giro, categoría, frecuencia). Un maestro comercial aparte duplicaría `customers`. |
| 05 · Pedido B2B avanzado | `orders` | La capacidad `orders.advanced` **ya está declarada** en ese dominio (H1). |
| 10 · Reparto · 11 · POD | `fulfillment` | La planificación y la evidencia son fases del despacho que ya existe, no un despacho paralelo. |

### 1.1 · Registro obligatorio en `boundaries.ts`

Por `src/architecture.test.ts`, **antes de crear un solo archivo** en `src/features/sales/`
hay que añadir su entrada a `DOMAIN_IDS` y a `BOUNDARIES` en `src/domain/boundaries.ts`, con
`state` honesto (`declared` al empezar, `implemented` al cerrar la fase) y sus `paths`.
Es el primer commit de cada fase, no el último.

---

## 2 · Mapa de entidades y relaciones

Notación: `→` = FK. **Toda tabla lleva `organization_id` + `company_id`** y las FK son
**compuestas y con tenant**, siguiendo el patrón de `business_accounts`.

### 2.1 · Fase 01 · Maestro comercial → EXTIENDE `customers`

```
customers  (EXISTE — se extiende, no se duplica)
  + business_type_id  → customer_business_types   [NUEVA]  giro: bodega, farmacia, ferretería…
  + customer_tier     enum                        [NUEVA]  A/B/C — clasificación de valor
  + visit_frequency   enum                        [NUEVA]  semanal, quincenal, mensual
  + geo_lat / geo_lng                             [NUEVAS] punto del negocio (sin PostGIS)

customer_business_types [NUEVA]  vocabulario del tenant, como customer_segments
```

**Reutiliza:** `customer_segments` (dimensión de precio, ya existe — **no se sustituye**),
`customer_external_ids` (código en el ERP), `customer_addresses`, `business_accounts`.

### 2.2 · Fase 02 · Fuerza de ventas → frontera `sales`

```
sales_reps [NUEVA]
  user_id            uuid    -- el `sub` del JWT, SIN FK a auth.users (patrón business_account_users)
  employee_code      text
  manager_id         → sales_reps   -- jerarquía; ciclos prohibidos por trigger
  status, hired_at

sales_rep_customers [NUEVA]   cartera: qué clientes atiende cada vendedor
  sales_rep_id → sales_reps
  customer_id  → customers
  is_primary   boolean
```

**Decisión clave — el vendedor NO es un `app_role`.** Ver §4.

### 2.3 · Fase 03 · Territorios y rutas → frontera `sales`

```
sales_territories [NUEVA]     -- COMERCIAL. Nombrada así para no colisionar
  parent_id → sales_territories  -- con delivery_zones, que es LOGÍSTICA
  code, name

sales_rep_territories [NUEVA]  → sales_reps, sales_territories

sales_routes [NUEVA]           -- la ruta de visita del preventista
  sales_rep_id → sales_reps
  territory_id → sales_territories
  weekday, frequency

sales_route_stops [NUEVA]      -- secuencia de clientes en la ruta
  route_id → sales_routes
  customer_id → customers
  sequence int
```

### 2.4 · Fase 04 · Crédito y cobranza → frontera `credit`

```
business_accounts  (EXISTE: credit_limit, payment_terms_days — ver H2)
  + credit_status enum [NUEVA]  ok | watch | blocked

ar_documents [NUEVA]           -- documento por cobrar
  order_id   → orders          -- hoy nace del pedido…
  invoice_id → invoices        -- …y cuando P06 exista, de la factura (nullable)
  business_account_id → business_accounts
  issued_at, due_at, currency, amount, balance

ar_receipts [NUEVA]            -- el cobro
ar_applications [NUEVA]        -- aplicación recibo → documento (N:M, es lo que hace cuadrar)
```

> **`my_account_statement()` se reescribe por dentro para leer de `ar_documents`, y su forma
> de salida NO cambia** — la pantalla del portal no se toca. Ese contrato ya estaba escrito en
> la migración 20260831140000 y esta arquitectura lo honra.

**Bloqueo por mora:** se implementa como un **gancho del pipeline de checkout**
(`functions/_shared/checkout`), que ya tiene puertos y ganchos, **no** como un `if` dentro de
`create_order`.

### 2.5 · Fase 05 · Pedido B2B avanzado → EXTIENDE `orders`

```
order_schedules [NUEVA]   -- lo único que de verdad falta: la programación con estado
order_templates [NUEVA]   -- plantilla recurrente

-- NO se crea order_batches: order_external_refs (ref_type='import_batch') ya lo cubre,
--    y checkout_intents ya da la idempotencia por fila (H1).
-- NO se crea motor de aprobación: purchase_approval + order_approval_decide existen (H4).
--    Lo que se construye es la BANDEJA del aprobador.
```

### 2.6 · Fase 06 · Cotizaciones → frontera `trade`

```
quotes [NUEVA]        status: draft|sent|accepted|rejected|expired, valid_until
quote_items [NUEVA]   MISMA forma que order_items (para convertir sin traducir)
```

**Reutiliza obligatoriamente `ebim.resolve_prices`** para cotizar. La conversión
cotización → pedido pasa por `cart_replace_lines` + el pipeline de checkout: **no** hay un
segundo camino de creación de pedidos.

### 2.7 · Fase 07 · Facturación → frontera `credit`

```
invoices [NUEVA]        implementa InvoiceRequest/Invoice del puerto YA ESCRITO
invoice_items [NUEVA]   con tax_rate y tax_amount POR LÍNEA  ← requisito del puerto
invoice_events [NUEVA]  aceptada/rechazada por la autoridad
```

> **Precondición dura:** verificar primero si `order_item_snapshots` (migr. 110100) ya guarda
> el impuesto por línea. Si no, esa columna es lo primero que hay que añadir. El puerto está
> escrito para que **no se pueda implementar a medias sin que se note** (H3).
> La emisión sale por el **outbox de integraciones existente**, no por un cliente HTTP nuevo.

### 2.8 · Fase 08 · Surtidos → frontera `trade`

```
assortments [NUEVA]
assortment_items [NUEVA]      → products / product_variants
assortment_assignments [NUEVA] → customers | customer_segments | sales_territories | channels
```

Modelado **calcando `price_list_assignments`**, que ya resuelve exactamente el mismo problema
(«qué aplica a quién, con precedencia»). Precedencia documentada, como en pricing.

### 2.9 · Fase 09 · Promociones trade → EXTIENDE `promotions`

```
promotions.kind  ALTER TYPE ... ADD VALUE  -- volume_tier | combo | free_goods
promotion_budgets [NUEVA]                  -- presupuesto por cliente/territorio y su consumo
```

**Se extiende `ebim.evaluate_promotions` con ramas nuevas.** No hay segundo motor: la
migración 130100 dice que añadir un tipo es una rama, no una tabla.

### 2.10 · Fases 10–11 · Reparto y POD → EXTIENDEN `fulfillment`

```
delivery_vehicles [NUEVA]
delivery_plans [NUEVA]       -- la hoja de ruta del día
delivery_plan_stops [NUEVA]  → fulfillments   (el despacho YA existe)

proof_of_delivery [NUEVA]    -- firma, geo, recibido por, motivo de rechazo
pod_evidence [NUEVA]         -- calcado de return_evidence: mismo patrón, mismo Storage
```

### 2.11 · Fases 12–13 · Metas, comisiones y visitas → frontera `sales`

```
sales_goals [NUEVA]           por vendedor/territorio/periodo, en importe o unidades
commission_rules [NUEVA]
commission_statements [NUEVA] liquidación por periodo, con su detalle

sales_visits [NUEVA]          → sales_reps, customers, sales_routes
  planned_at, checked_in_at, checked_out_at, geo, outcome, order_id (nullable)
sales_visit_tasks [NUEVA]     el guion de la visita
```

### 2.12 · Fases 14–15 · Recomendación y forecast → frontera `planning`

```
order_suggestions [NUEVA]         cabecera de la sugerencia + su motivo (auditable)
order_suggestion_items [NUEVA]
demand_forecasts [NUEVA]          producto × periodo × territorio
```

Insumos: histórico de `orders`/`order_items`, `analytics_timeseries`, `ebim.atp` y el surtido
de P07. **La sugerencia no crea pedidos**: produce un carrito que una persona confirma.

---

## 3 · Capacidades nuevas (eje entitlement)

Se añaden a `SELLABLE_CAPABILITY_IDS` en `src/domain/capabilities.ts` **y** a la tabla
`app_capabilities` por migración (hay test de paridad entre las dos).

| Capacidad | Frontera | Entitlement | Estado al declarar | Concede |
|---|---|---|---|---|
| `sales.force` | `sales` | `ecommerce.sales.force` | `declared` → `implemented` en fase 02 | Vendedores, jerarquía y cartera |
| `sales.territory` | `sales` | `ecommerce.sales.territory` | `declared` | Territorios, rutas y visitas |
| `sales.performance` | `sales` | `ecommerce.sales.performance` | `declared` | Metas, KPIs y comisiones |
| `credit.management` | `credit` | `ecommerce.credit.management` | `declared` | Línea, cobranza, antigüedad y bloqueo por mora |
| `invoicing` | `credit` | `ecommerce.invoicing` | `declared` | Emisión de comprobante electrónico |
| `trade.quotes` | `trade` | `ecommerce.trade.quotes` | `declared` | Cotizaciones y proformas |
| `trade.assortments` | `trade` | `ecommerce.trade.assortments` | `declared` | Surtido por cliente, segmento o territorio |
| `fulfillment.routing` | `fulfillment` | `ecommerce.fulfillment.routing` | `declared` | Planificación de reparto y evidencia de entrega |
| `planning.demand` | `planning` | `ecommerce.planning.demand` | `declared` | Recomendación de pedido y forecast |

`orders.advanced` **ya existe declarada** — la fase 05 solo cambia su `state` a `implemented`.

**Regla de degradación (la del repo, sin excepción):** sin la capacidad el tenant **sigue
vendiendo como antes**. Nada de lo nuevo puede ser un prerrequisito del checkout existente.

> **Aviso:** los códigos `ecommerce.*` son **provisionales** hasta que el operador dé de alta
> el catálogo de addons en el hub EBIM (`capabilities.ts:88-96`). Si no coinciden, lo que
> cambia es la constante y la columna `entitlement_code` — **ni una línea de gating**.

---

## 4 · Permisos nuevos (eje rol) — y la decisión del vendedor

### 4.1 · Permisos a añadir

En **los dos** archivos (`src/shared/lib/roles.ts` y `supabase/functions/_shared/roles.ts`),
mismo commit:

| Permiso | Roles | Por qué |
|---|---|---|
| `sales.manage` | owner, admin | Alta de vendedores, territorios y rutas |
| `sales.operate` | owner, admin, **sales_rep** | Tomar pedido, registrar visita — la operación de campo |
| `credit.manage` | owner, admin | Cambiar la línea de crédito de un cliente |
| `credit.collect` | owner, admin, orders | Registrar un cobro |
| `invoicing.issue` | owner, admin | Emitir un comprobante fiscal |
| `trade.manage` | owner, admin, catalog | Surtidos y mecánicas trade |
| `quotes.write` | owner, admin, orders, **sales_rep** | Crear y enviar cotizaciones |
| `commissions.view` | owner, admin | Ver liquidaciones (dinero de terceros) |

### 4.2 · El rol `sales_rep` — la decisión de diseño más delicada

**Propuesta:** añadir `sales_rep` al enum `public.app_role`, **no** reutilizar `orders` ni
crear un cuarto eje de autorización.

Razonamiento:

- El vendedor de campo **sí es** personal del tenant (a diferencia del comprador B2B, que es
  del cliente y por eso vive en `business_role`). Meterlo en `business_role` sería un error
  categórico.
- Dárselo como rol `orders` le abriría el listado completo de pedidos del tenant y la
  exportación masiva de datos de clientes (`orders.export`). Un preventista debe ver **su
  cartera**, no la base entera.
- Un cuarto eje de autorización, para un solo actor, sería el tipo de complejidad que
  `capabilities.ts` documenta como el error que ya se cometió una vez.

**El alcance —"solo su cartera"— NO es un permiso: es una policy RLS** sobre
`sales_rep_customers`, igual que el tenant se deriva del JWT. El permiso dice *qué acción*;
la policy dice *sobre qué filas*. Confundirlos deja el control en el frontend.

> **Nota de contrato:** ampliar el enum `app_role` toca `tenant_members` y la matriz duplicada.
> Debe ir en la migración de la fase 02, con su test de aislamiento, y **verificarse contra
> `EBIM-CONTRATO-PLATAFORMA.md` §2/§3** antes de codificar — un cambio de claims o jerarquía es
> *breaking* y exige propuesta al buzón de coordinación.

---

## 5 · Rutas y navegación

Nuevas entradas en `src/app/routes.tsx` y `src/features/admin/navigation.tsx` (fuente única
del sidebar **y** de las migas — añadir en un solo sitio):

| Ruta | Capacidad (gate) | Permiso | Fase |
|---|---|---|---|
| `/app/sales` | `sales.force` | `sales.manage` | 02, 03 |
| `/app/sales/visits` | `sales.territory` | `sales.operate` | 13 |
| `/app/sales/performance` | `sales.performance` | `commissions.view` | 12 |
| `/app/credit` | `credit.management` | `credit.manage` | 04 |
| `/app/invoicing` | `invoicing` | `invoicing.issue` | 07 |
| `/app/quotes` | `trade.quotes` | `quotes.write` | 06 |
| `/app/assortments` | `trade.assortments` | `trade.manage` | 08 |
| `/app/planning` | `planning.demand` | `sales.manage` | 14, 15 |

**Reparto y POD no crean ruta**: son pestañas nuevas dentro de `/app/fulfillment`, que ya usa
`SectionTabs`.

**Portal del comprador** (`/s/:storeSlug/account`): pestañas nuevas para cotizaciones y
documentos por cobrar, con el mismo patrón DEFINER-sin-parámetros
(`my_quotes()`, `my_ar_documents()`).

### 5.1 · UI — reutilización obligatoria

`src/shared/ui` ya tiene todo lo necesario y **no hay que crear componentes equivalentes**:
`PageHeader`, `SectionTabs` (deep-link `#hash`), `SectionCard`, `FilterBar`, `SearchField`,
`TablePager`, `usePagedRows`, `TableSkeleton`, `states.tsx` (loading/empty/error),
`StatusChip`, `RowActions`, `FormDrawer`, `ConfirmDeleteDialog`, `MetricCard`.

Convención de suite que aplica a toda pantalla nueva: **un buscador general + tabs de estado +
Exportar**, nunca paneles de filtros multi-campo. Formularios grandes en tabs/secciones.
Tokens de tema, jamás colores literales.

---

## 6 · Contratos y puertos

| Puerto | Acción | Motivo |
|---|---|---|
| `InvoicingProvider` | **usar tal cual** | Ya escrito. La fase 07 escribe el *adaptador*, no el puerto. |
| `ErpProvider` | **usar tal cual** | `ErpCustomer` ya trae `creditLimit` e `isBlocked` — el crédito del ERP entra por aquí. |
| `NotificationProvider` | **usar tal cual** | Aviso de aprobación pendiente, cotización enviada, mora. |
| Puertos nuevos | **NO crear** | La regla del repo (`ports/index.ts`) exige una *segunda implementación ya declarada*. Ninguna fase B2B la tiene hoy. Una interfaz con una sola implementación es indirección, no arquitectura. |

Toda salida a terceros usa el **outbox existente** (`integration_outbox` + `integration-worker`),
que ya trae idempotencia, backoff, cola muerta y disyuntor.

---

## 7 · Reglas de seguridad para todas las fases

1. `organization_id` / `company_id` **siempre del JWT**. Nunca del body, header, query ni
   localStorage.
2. RLS activada + forzada y *default deny* en **toda** tabla nueva, en la **misma migración**.
3. FK **compuestas con tenant** (patrón `business_accounts`).
4. Test de aislamiento tenant **obligatorio por tabla nueva**: un tenant no ve ni escribe datos
   de otro.
5. Funciones del portal del comprador: `SECURITY DEFINER`, `set search_path = ''`,
   **sin parámetro de cuenta**, `REVOKE EXECUTE … FROM public, anon`.
6. `service_role` jamás en el frontend ni en el bundle.
7. Escritura de bitácora solo por función `SECURITY DEFINER` validada.
8. El alcance del vendedor (su cartera) se hace cumplir en **policy**, no ocultando botones.

---

## 8 · Lo que esta arquitectura decide NO crear

Declararlo evita que una fase futura lo invente «porque faltaba»:

| No se crea | Por qué | Qué se usa en su lugar |
|---|---|---|
| Tabla `order_batches` | La migración 110600 ya argumenta en contra | `order_external_refs` + `checkout_intents` |
| Motor de aprobación nuevo | Ya existe y funciona | `purchase_approval` + `order_approval_decide` |
| Segundo motor de precios | `resolve_prices` es la única autoridad | `ebim.resolve_prices` desde cotizaciones y surtidos |
| Segundo motor de promociones | Añadir mecánica es una rama | `ebim.evaluate_promotions` extendida |
| Tabla de territorio dentro de `fulfillment` | Territorio comercial ≠ zona de reparto | `sales_territories` en `sales` |
| Puertos nuevos | No hay segunda implementación declarada | Los 10 puertos existentes |
| Cliente HTTP propio para facturación | Duplicaría el transporte | `integration_outbox` |
| Catálogo local de addons | Prohibido por contrato §6 | Platform Context API del hub |
| PostGIS | Peso desproporcionado para el caso de uso | `geo_lat`/`geo_lng` + cálculo en aplicación |

---

## 9 · Orden de ejecución recomendado

El del manifiesto es correcto y respeta el camino crítico `P00 → P01 → P02`. Dos observaciones
para el operador:

1. **Fase 04 (Crédito) antes que Fase 07 (Facturación).** Al arrancar la 04 hay que decidir si
   `ar_documents` nace del pedido con `invoice_id` nullable (propuesta de §2.4) o se espera a
   la 07. La propuesta permite avanzar sin bloquear y sin migrar datos después.
2. **Verificar el impuesto por línea al arrancar la Fase 07** (H3). Es la única precondición
   dura conocida de todo el recorrido.

---

## 10 · Definición de hecho, por fase

Una fase no está terminada hasta que:

- [ ] La frontera está registrada en `boundaries.ts` con `state` honesto.
- [ ] La capacidad está en `capabilities.ts` **y** en `app_capabilities` (test de paridad verde).
- [ ] Los permisos nuevos están en **los dos** archivos de `roles.ts`.
- [ ] Toda tabla nueva tiene RLS + policies en su misma migración.
- [ ] Hay test de aislamiento tenant por tabla nueva.
- [ ] Sin la capacidad, el tenant sigue vendiendo igual que antes (degradación, no rotura).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` y `npm run build` en verde.
- [ ] El informe de fase está en `.claude-b2b-state/phase-reports/<ID_FASE>.md`.
