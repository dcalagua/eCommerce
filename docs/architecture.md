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

## Modelo de datos (implementado hasta P03-SaaS)

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
- Pendiente de fases siguientes: `customers`, `carts`, `payments`, `audit_log`.

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
  promotions, content, fulfillment, analytics, integrations— y **seis áreas de plataforma**
  —identity, tenancy, entitlements, provisioning, configuration, shell—, declarados en
  `src/domain/boundaries.ts` con su estado real (`implemented` / `partial` / `declared`) y su ruta
  en `src/`. (`entitlements` la añade P02-SaaS: no es un módulo vendible, es la que decide qué
  módulos hay.)
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
