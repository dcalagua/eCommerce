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

                            ├─ platform-context   ──► HUB EBIM (addons y config, §5)
                            │                        [escrita y probada; el hub todavía
                            │                         no conoce esta app → HUB_NO_CONFIGURADO]
                            │
                            └─ sso  [PENDIENTE]    ──► HUB EBIM (verifica JWT contra JWKS)
```

> **Estado real de la identidad.** `sso` sigue sin existir; `platform-context` sí existe desde
> P02-SaaS, pero su camino hacia el hub nunca se ha ejercitado contra un hub real porque
> `ecommerce` no está dado de alta en la suite (`SAAS_ROADMAP` §5.1). La identidad efectiva de DEV/QAS es Supabase Auth más el hook
> `ebim.demo_access_token_hook` (migraciones `20260827120000` y `..._121000`), y el camino contra el
> hub no se ha ejercitado nunca. Corregido en P01-SaaS por ser un error de documentación; el cambio
> de identidad en sí está bloqueado (contrato §2, cambios breaking al buzón) y corresponde a
> P02/P16.

El **hub EBIM** es el emisor de identidad y dueño del catálogo/billing. eCommerce **lee** del hub y nunca
escribe en él. La identidad del comprador final del storefront es **local** a este proyecto (patrón §2.5,
igual que los proveedores externos de eSupplier); los usuarios del tenant llegan por SSO del hub.

## Modelo de datos (implementado hasta P06-SaaS)

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
  **generada** (`stock > 0`): `anon` la lee, pero nunca lee `stock` (P05). Desde P06 la vista
  publica un booleano calculado por ATP, y la cifra exacta sigue sin salir a `anon`.
- Sin forks de schema por cliente: diferencias por `store_settings.config` + `products.custom_fields` (JSONB).
- Pendiente de fases siguientes: `carts`, `payments`, `audit_log`. (`customers` llegó en P05-SaaS;
  los almacenes y las reservas, en P06-SaaS.)

### PIM: variantes, atributos, unidades y kits (P03-SaaS)

Once tablas más, migraciones `20260827170000`–`20260827170300`. Decisiones completas en
[`adr/003-pim-variantes-uom-kits.md`](adr/003-pim-variantes-uom-kits.md).

```
VOCABULARIO DE LA SOCIEDAD (sin store_id: se reusa en todas sus tiendas)
  brands · product_families · units_of_measure
  attributes ──── attribute_values          (dominio cerrado de los de tipo lista)

EL PRODUCTO CRECE
  products + kind (simple | variant | bundle) + brand_id + family_id

LO QUE CUELGA DEL PRODUCTO (con store_id: el producto es de una tienda)
  product_variants ──── variant_attribute_values   (la combinación que ES cada variante)
  product_attribute_values                          (ficha técnica, una columna por tipo)
  product_uoms                                      (factor de conversión a unidad base)
  bundle_items                                      (receta del kit; NO hay tabla `bundles`)
  product_relations                                 (accesorio, sustituto, venta cruzada)
```

- **El producto sigue siendo el maestro único.** Un kit ES un producto con `kind = 'bundle'`; darle
  tabla propia habría duplicado SKU, precio, imágenes y publicación. Un maestro de variantes **no se
  vende**: se vende una de sus filas de `product_variants`.
- **Cuatro reglas del modelo se impiden con FK, no con triggers**: columna denormalizada + CHECK +
  FK a una clave de apoyo del padre con `on update cascade`. Es lo que permite que un CHECK mire otra
  tabla — variante solo bajo un `kind='variant'`, valor solo bajo un atributo de lista, eje solo si
  está declarado eje, y ningún kit dentro de otro kit.
- **Un solo espacio de nombres de SKU por tienda** entre `products` y `product_variants`, con el
  trigger `ebim.assert_sku_unique_in_store`. Es lo único que ningún índice puede expresar.
- **`factor` en `numeric(18,6)`**, nunca float: multiplicado por miles de líneas, el redondeo binario
  es descuadre de inventario. Una conversión que no da unidades base enteras se rechaza.
- **`products.price` y `products.stock` NO se retiran** (cinco consumidores vivos); lo que cambia es
  su significado por tipo, escrito en `comment on column`. Retirar `stock` es trabajo de P06.
- **Disponibilidad pública por tipo**: `public_products.in_stock` es la columna generada para el
  simple, `bool_or` de variantes para el maestro, y `ebim.bundle_is_available` para el kit — única
  función `SECURITY DEFINER` nueva, con su autorización dentro y limitada a kits ya públicos.
- Vista nueva `public_product_variants` (precio heredado ya resuelto, sin SKU ni existencia exacta).
  La composición del kit y los atributos **no** salen a `anon` en esta fase.

### Motor de precios (P04-SaaS)

Cinco tablas más, migraciones `20260827180000`–`20260827180200`. Decisiones completas en
[`adr/004-pricing-engine.md`](adr/004-pricing-engine.md).

```
VOCABULARIO DE LA SOCIEDAD (sin store_id)
  customer_segments                el grupo comercial; P05 le cuelga los clientes

EL ACUERDO (de la tienda)
  price_lists ──── price_list_items         precio por producto/variante, presentación y escala
              └── price_list_assignments    a quién: tienda · canal · segmento · cliente

BITÁCORA
  price_change_events               alta, cambio y baja de precio, con actor. Sin FK: sobrevive a la lista
```

- **Una sola autoridad de precio: `ebim.resolve_prices`.** `create_order` deja de calcular y pasa a
  preguntar (`180200`); la vitrina lee un precio ya resuelto; el carrito cotiza contra la misma
  función. Lo que se muestra, lo que se cotiza y lo que se cobra salen del mismo sitio, y hay un
  test que lo compra comparando los tres totales.
- **Contexto explícito y nada de él viene del navegador**: tienda (del slug), canal (de la tienda),
  segmento y cliente (solo si los pone un llamante de servidor). La lista negra del payload crece
  con `segment_id`, `customer_id`, `price_list_id`, `price_source` y `channel_id`, en el borde y en
  la base.
- **Precedencia TOTAL y documentada**: especificidad del alcance (cliente 40 > segmento 30 > canal
  20 > tienda 10) → `priority` → `valid_from` más reciente → `id`. La especificidad no es
  configurable; el último paso lo denuncia `public.price_list_conflicts` como ambigüedad.
- **La escala se mide en unidades base**, nunca en unidades de venta: si no, cambiar de presentación
  cambiaría el descuento sin que nadie lo decidiera.
- **Fallback al precio de catálogo** cuando ninguna lista alcanza —incluido el tenant que no tiene
  `pricing.lists` contratado—. Por eso ningún test de pedido de P02/P03 cambió una línea.
- **El entitlement se comprueba con un JOIN** dentro de `ebim.active_price_lists` y no llamando a
  `has_capability`: una función invocada dentro de una vista definer corre como el usuario que
  pregunta, y para `anon` devolvería «no» siempre.
- **La vitrina muestra el precio resuelto** (`ebim.public_unit_prices`, definer, limitada a alcances
  tienda y canal público). Un precio de segmento o de cliente no sale nunca a `anon`.
- **Tres puertas públicas, tres autorizaciones**: `price_quote_for_slug` (anónima, por slug),
  `price_quote` (backoffice, con membresía) y `price_list_conflicts` (invoker, la RLS decide).
- `order_items` gana `price_source` y `price_list_id`: la línea explica por qué costó lo que costó.

### Clientes y cuentas B2B (P05-SaaS)

Ocho tablas más, migraciones `20260827190000`–`20260827190200`. Decisiones completas en
[`adr/005-customers-b2b.md`](adr/005-customers-b2b.md).

```
VOCABULARIO DE LA SOCIEDAD (sin store_id: el cliente lo es de todas sus tiendas)
  customers ──── customer_addresses      envío y facturación, con estado de verificación
            ├─── customer_contacts       las personas del cliente; NO son usuarios
            └─── customer_external_ids   cómo se llama en cada sistema externo

EL PORTAL (se contrata: `customers.b2b`)
  business_accounts ──── business_locations      sucursales y centros de entrega
                    ├─── business_account_users  EL VÍNCULO usuario ↔ cuenta
                    └─── approval_rules          desde qué importe y quién aprueba
```

- **`customers` no tiene `user_id`.** Usuario autenticado y cliente son dos ejes distintos: la
  identidad la emite el hub y el vínculo con personas es una RELACIÓN, porque una columna solo sabe
  expresar «uno». Un test de esquema falla si esa columna aparece.
- **La ficha es baseline; el portal se vende.** `customers` entra en `app_capabilities` como
  capacidad baseline y `customers.b2b` pasa a `implemented`. Escribir un cliente pide rol
  (`owner`/`admin`/`orders`); escribir una cuenta pide rol (`owner`/`admin`) **y** capacidad.
- **Una cuenta corporativa sobre una persona es imposible**: FK compuesta `(customer_id,
  customer_kind)` contra `customers (id, kind)`, la técnica del PIM.
- **`public.my_business_accounts()` no acepta argumentos.** Es la forma de la regla «el acceso a una
  cuenta exige vínculo servidor»: sin parámetro no hay id que el navegador pueda declarar. Los
  usuarios B2B **no tienen ni una policy** sobre estas tablas —no son miembros del tenant— y esa
  función definer es su única puerta.
- **Roles fijos, importes configurables**: enum `business_role` (`admin`, `approver`, `buyer`,
  `viewer`) y límites por persona (`spending_limit`) y por cuenta (`approval_rules.min_amount`). Un
  rol cuyos permisos fueran datos permitiría marcar «puede aprobar» sobre un comprador.
- **`public.purchase_approval(cuenta, importe)`** decide y explica el motivo (`user_limit`, `rule`,
  `account_threshold`). Es una función pura: no crea solicitudes ni cambia estados. La llaman por
  igual el portal y el backoffice.
- **La dirección**: uso en dos banderas (envío/facturación, al menos una), predeterminado por índice
  parcial único, y verificación como ESTADO de cuatro valores —«no se preguntó» y «lo rechazaron» no
  son lo mismo—. `verified_at` lo estampa un trigger.
- **El identificador externo es atributo, nunca clave**: no es único entre sistemas, cambia con la
  versión del ERP y no existe para el cliente de ayer.
- **Cierra la deuda de P04**: `price_list_assignments.customer_id` gana su FK tenant-safe y
  `public.price_quote` deriva el segmento de la ficha cuando no se declara.
- **`orders` NO gana `customer_id`**: el checkout sigue siendo anónimo y esa columna solo la podría
  rellenar el navegador. `public.customer_orders` enlaza por correo y lo dice.

### Inventario multi-almacén, ATP y reservas (P06-SaaS)

Seis tablas más, migraciones `20260827200000`–`20260827200400`. Decisiones completas en
[`adr/006-inventory-atp-reservations.md`](adr/006-inventory-atp-reservations.md).

```
VOCABULARIO DE LA SOCIEDAD (sin store_id: el almacén sirve a todas sus tiendas)
  warehouses ──── store_warehouses      qué tienda se sirve de cuál, y en qué orden
                                        SIN filas = todas: declarar es restringir

LA EXISTENCIA
  inventory_levels     on_hand · reserved · available (GENERADA) · safety_stock · reorder_point
  inventory_movements  libro mayor inmutable: delta con signo, saldo resultante y por qué

LO COMPROMETIDO
  inventory_reservations ──── inventory_reservation_items
```

- **La sobreventa la impide un CHECK, no la disciplina del que escribe.**
  `inventory_levels_no_oversell` (`reserved <= on_hand` y `on_hand >= 0`, salvo backorder explícito)
  aborta la transacción aunque el reparto fallara. Es la última línea, y hay un test que intenta
  saltársela como `service_role`.
- **`available_qty` es una columna GENERADA** (`on_hand - reserved`): no puede discrepar de sus dos
  sumandos. Lo *prometible* descuenta además `safety_stock` y lo calcula `ebim.atp`, porque el
  colchón es política comercial y no un hecho del almacén.
- **El reparto decide DENTRO de la sentencia que escribe** (`ebim.take_units`): una CTE con
  `SELECT … FOR UPDATE` toma el bloqueo y relee la fila ya bloqueada, así que la cantidad a tomar
  sale de la cifra verdadera y no de una foto anterior. Sin bucle de reintento: no hay conflicto que
  reintentar.
- **El backorder es una política del almacén**, denormalizada en el nivel con FK a
  `warehouses (id, allows_backorder)` y `on update cascade` — la técnica del PIM, que es lo que
  permite que un CHECK mire otra tabla.
- **«No se sabe» no es «no hay»**: un almacén `source = 'erp'` con la cifra caducada deja de aportar
  (`stale_policy = 'unknown'`, `ebim.atp` responde `unknown: true`) o sigue con la última cifra
  (`trust_last_known`). Nunca cero. El checkout se niega con `DISPONIBILIDAD_DESCONOCIDA` y la
  vitrina **no se vacía**.
- **La reserva tiene caducidad obligatoria** (`expires_at` NOT NULL), **idempotencia de negocio**
  (`reference_key`, índice único parcial sobre `held`) y un **secreto de 256 bits** (`token`) que es
  lo único que permite al checkout reclamarla. Caduca sola al reservar y al pedir: este proyecto no
  tiene cron garantizado.
- **Ninguna existencia se escribe con `UPDATE`**: las cuatro tablas de saldo no tienen GRANT de
  escritura para `authenticated` ni `anon`. Toda entrada, corrección y reserva pasa por una función
  que mueve y anota en la misma transacción.
- **El libro mayor es idempotente por `external_ref`** (índice único parcial): un webhook reenviado
  no descuenta dos veces. `sync_inventory_level` recibe SALDOS absolutos del ERP y calcula el delta.
- **`products.stock` NO se retira**: pasa a ser el camino de FALLBACK. `ebim.consume_stock` tiene los
  dos caminos dentro y `create_order` llama a uno solo; sin almacenes que sirvan a la tienda hace
  exactamente lo de antes. Ningún test de pedido de P02/P03/P04 cambió una línea.
  `public.seed_inventory_from_catalog` copia el catálogo al almacén, idempotente.
- **La vitrina pregunta en vez de leer una columna**: `in_stock` sale de
  `ebim.product_is_available` (definer, autorización dentro, solo un booleano) y el kit de
  `ebim.bundle_is_available` recalculado contra el ATP de sus componentes.
- **`warehouse_locations` y `reservation_events` NO se crearon**, y el ADR dice el disparador de cada
  una: las ubicaciones son WMS y P12; el historial de la reserva ya es la propia fila más el asiento
  del libro mayor.
- `InventoryPort` gana **dos** implementaciones —backoffice (con cifra) y vitrina (solo semáforo)—,
  que es exactamente lo que justificaba el puerto desde P01.

### Capacidades y entitlements (P02-SaaS)

Cuatro tablas más, migración `20260827160000`. Decisiones completas en
[`adr/002-capabilities-entitlements.md`](adr/002-capabilities-entitlements.md).

```
app_capabilities          registro TÉCNICO del producto (global, sin tenant, como integration_providers)
tenant_platform_context   cache de la respuesta del hub (§5): app_active, plan, origen, sincronización
tenant_entitlements       cache de los addons ACTIVOS por sociedad (§6). Solo lectura para el backoffice
tenant_feature_flags      interruptores técnicos del tenant. Solo restan; nunca conceden
```

- **`ebim.has_capability(org, company, cap)`** = `can_access` **y** `company_is_entitled`. Es la
  autoridad: se usa dentro de las policies, no solo en la UI.
- **`public.effective_capabilities(company)`** es lo que lee la app; la sociedad es alcance y el JWT
  sigue decidiendo (`can_access` antes de devolver nada, y `SIN_PERMISO` si no).
- **`public.sync_platform_context(...)`** es la única puerta de escritura: `service_role`, con
  `REVOKE EXECUTE` a `anon`/`authenticated`/`public`. Reemplaza el conjunto entero, así que un addon
  que el hub deja de devolver se apaga.
- Enforcement real hoy: `store_settings.white_label` exige `content.white_label` (addon premium del
  contrato §4.3) y escribir `tenant_integrations` exige `integrations.enterprise`.

## Operaciones de servidor y Edge Functions (P02)

| Función | Autoriza | Cliente | Por qué |
|---|---|---|---|
| `bootstrap-tenant` | clave en cabecera `x-ebim-provisioning-key` | `service_role` | crea el tenant: no hay todavía un token del que derivarlo |
| `create-order` | ninguna (comprador anónimo) | `service_role` | el pedido no puede insertarse desde el navegador |
| `catalog-product` | JWT del usuario | clave publicable + `Authorization` | **decide la RLS**, no la función |
| `update-order-status` | JWT del usuario | clave publicable + `Authorization` | idem, más el trigger de transiciones |
| `platform-context` | JWT del usuario **o** clave de aprovisionamiento | `service_role` | es la única que tiene la credencial del hub; el navegador nunca habla con el hub |

Desde P04-SaaS hay además tres funciones de base con autorización propia, y no una con bandera
porque cada una responde a un llamante distinto: `public.price_quote_for_slug` (comprador **anónimo**;
resuelve tienda por slug y canal público por defecto), `public.price_quote` (backoffice; comprueba
membresía contra la tienda antes de mirar un precio) y `public.price_list_conflicts` (invoker: la RLS
decide qué tiendas ve quien pregunta).

Desde P06-SaaS hay nueve más, agrupadas por llamante y no por tema, porque cada grupo trae su
propia autorización: del **backoffice con sesión** (rol + capacidad, tenant derivado de la tienda o
del almacén) `reserve_inventory`, `release_inventory_reservation`, `commit_inventory_reservation`,
`adjust_inventory`, `set_inventory_policy`, `seed_inventory_from_catalog` e
`inventory_availability`; del **servidor** (`service_role`, revocadas a `authenticated`)
`reserve_inventory_for_slug`, `release_inventory_by_token`, `expire_inventory_reservations` y
`sync_inventory_level`; y del **comprador anónimo**, `availability_for_slug`, que devuelve el
semáforo por cantidad y nunca la cifra.

Desde P05-SaaS hay tres más, y la primera es la que sostiene la regla del vínculo:
`public.my_business_accounts()` (definer, **sin parámetros**: el usuario B2B no es miembro del tenant
y su cuenta la resuelve el servidor), `public.purchase_approval` (definer, con su autorización
dentro: o vínculo con la cuenta, o membresía del tenant) y `public.customer_orders` /
`public.customer_deletion_usage` (invoker: la RLS decide qué ve quien pregunta).

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
    boundaries.ts         los 12 dominios + 6 areas de plataforma, con su estado real
    capabilities.ts       los 16 modulos del producto y la resolucion efectiva (P02-SaaS)
    flags.ts              interruptores tecnicos: solo restan, nunca conceden
    errors.ts             AppError con discriminante `kind`
    money.ts              importe = decimal en TEXTO, nunca number
    ports/                PricingPort, InventoryPort, PaymentProvider, ErpProvider, ...
  app/                  router, providers, ErrorBoundary, queryClient
  theme/                tokens (CSS vars + escalas), createEbimTheme, apariencia por usuario
  shared/               ui kit (EbimMark, SectionTabs, SearchField, estados), i18n ES/EN,
                        lib (env, supabase, db-schema, format, search, slug)
  features/auth/        login (anatomía de suite §4.5), sesión, guard RequireSession
  features/tenant/      contexto de tenant del backoffice, derivado del JWT
  features/capabilities/ que modulos tiene la sociedad: provider, gate, diagnostico
  features/admin/       AdminLayout, dashboard, configuración
  features/catalog/     productos del backoffice
    pim/                  PIM (P03-SaaS): marcas, familias, atributos, unidades,
                          variantes, UoM de producto, componentes de kit y relaciones
  features/pricing/     motor de precios (P04-SaaS): listas, renglones, asignaciones,
                        segmentos, simulador, diagnostico, importacion CSV y el
                        adaptador `serverPricing` que implementa `PricingPort`
  features/customers/   clientes y cuentas B2B (P05-SaaS): ficha, contactos,
                        direcciones, identificadores externos, cuentas de empresa
                        con usuarios, sucursales y reglas de autorizacion
  features/inventory/   almacenes, existencias por almacen, libro mayor, reservas y
                        alertas (P06-SaaS), mas los dos adaptadores de `InventoryPort`
  features/orders/      pedidos del backoffice
  features/storefront/  vitrina pública: resolución por slug, catálogo, ficha, carrito/checkout (P06)
                        + StoreAccountPage: área de cuenta del comprador B2B (P05-SaaS),
                          resuelta por `my_business_accounts()` y no por la URL
  architecture.test.ts  las reglas de frontera, comprobadas sobre el codigo real
supabase/
  migrations/  SQL versionado (tabla nueva = tabla + RLS + policies en la misma migración)
  functions/   Edge Functions (Deno) + _shared/
  tests/       PGlite: RLS, invariantes de esquema y contrato de integraciones
```

### Fronteras de dominio y puertos (P01-SaaS)

Decisiones completas en [`adr/001-domain-boundaries.md`](adr/001-domain-boundaries.md). En resumen:

- **Doce dominios de negocio** —catalog, pricing, customers, inventory, checkout, orders, payments,
  promotions, content, fulfillment, analytics, integrations— y **seis áreas de plataforma**
  —identity, tenancy, entitlements, provisioning, configuration, shell—, declarados en
  `src/domain/boundaries.ts` con su estado real (`implemented` / `partial` / `declared`) y su ruta
  en `src/`. (`entitlements` la añade P02-SaaS: no es un módulo vendible, es la que decide qué
  módulos hay.)
- **Un puerto existe solo si hay una segunda implementación ya declarada**: una fila de
  `integration_providers` con esa operación, o dos llamantes concretos hoy. Por eso hay
  `PricingPort`, `InventoryPort`, `PaymentProvider`, `FulfillmentProvider`, `NotificationProvider`,
  `ErpProvider` e `InvoicingProvider`, y **no** hay `SearchPort`. `InventoryPort` es el primero con
  DOS implementaciones vivas (P06-SaaS): backoffice y vitrina, que no son dos capas de lo mismo sino
  dos actores con dos autorizaciones y dos respuestas distintas.
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

- **Tres ejes de autorización, tres nombres** (P02-SaaS): `Permission` es lo que puede un ROL
  (`shared/lib/roles.ts`, `ebim.has_role`); `Capability` es el módulo que la sociedad CONTRATÓ
  (`src/domain/capabilities.ts`, `ebim.has_capability`); `FeatureFlags` son interruptores técnicos
  del tenant que solo pueden restar. Se componen: hacen falta los tres.
- **Ningún uuid literal ni nombre de plan comercial en código de producción.** Un
  `if (org === '3f2a…')` es la versión del anti-patrón que sobrevive a la regla de los nombres
  propios, y es igual de mortal.

Todas estas reglas las comprueba `src/architecture.test.ts`: no son convenciones, son tests.

- Theming por tokens; el acento proviene del branding del tenant (`accent_color`), nunca hardcodeado.
- Light + dark, densidad configurable, WCAG AA, mobile-first real.
- Pantallas largas → tabs centrados con deep-link `#hash`; listados → un buscador general.

## Integración con la suite

- Registro de `ecommerce` en el hub (`apps`, `workspace_apps`): **pendiente del operador**
  (`SAAS_ROADMAP` §5.1). La lectura de addons por sociedad ya está construida (P02-SaaS) y responde
  `HUB_NO_CONFIGURADO` mientras tanto; el tenant se queda con lo baseline.
- Vitrina cruzada (§6.1): momento contextual hacia eExpense/eSupplier cuando el tenant no las tiene contratadas.
- Coordinación por el buzón `coordinacion\` en Drive; cambios a interfaces compartidas = propuesta al contrato.
