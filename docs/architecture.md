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
                            ├─ checkout           (pipeline de 11 etapas, idempotente — P07-SaaS)
                            ├─ create-order       (la puerta de P02-P06; sigue viva)
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

## Modelo de datos (implementado hasta P09-SaaS)

Nueve tablas en `supabase/migrations`, todas con `organization_id uuid` + `company_id uuid` (uuids del hub),
`created_at`/`updated_at`, PK uuid y RLS default deny **forzada**:

```
tenants (PK = organization_id del hub)
  └── tenant_members (usuario × sociedad × rol de app)
  └── stores (una tienda por sociedad; slug/dominio públicos)
        ├── store_settings (1:1 — branding publicable + config interna)
        ├── categories (árbol dentro de la misma tienda)
        ├── products ──── product_images (ruta en Storage)
        └── orders ────── order_items (snapshot completo; line_total GENERATED)
                     ├── order_events        linea de tiempo de los 4 ejes (P08)
                     ├── order_notes/tags    anotaciones internas (P08)
                     └── order_external_refs como se llama en otros sistemas (P08)
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
- Pendiente de fases siguientes: `payments`, `audit_log`. (`customers` llegó en P05-SaaS; los
  almacenes y las reservas, en P06-SaaS; `carts`, `checkout_intents` y `domain_events`, en P07-SaaS;
  la línea de tiempo del pedido, sus anotaciones y sus referencias externas, en P08-SaaS.)

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

### Carrito persistente y pipeline de checkout (P07-SaaS)

Cuatro tablas más, migraciones `20260828100000`-`20260828100400`. Decisiones completas en
[`adr/007-cart-checkout-pipeline.md`](adr/007-cart-checkout-pipeline.md).

```
EL CARRITO (de una tienda y de UN canal)
  carts ──── cart_items      dueño = sesion O secreto de 256 bits, nunca un id declarado
                             unit_price_snapshot: INFORMATIVO, jamas autoridad de cobro

EL INTENTO DE COMPRA
  checkout_intents           (store_id, idempotency_key) unico + resumen de la peticion

LOS HECHOS
  domain_events              outbox de DOMINIO, sin proveedor: publica aunque el tenant
                             no tenga ni una integracion contratada
```

- **El ancla de la idempotencia es una fila, no el botón deshabilitado.** `checkout_begin` devuelve
  `replay: true` con la respuesta guardada; repetir la misma petición devuelve el MISMO pedido.
  `request_hash` ata la clave a lo que se pidió: adivinar la clave no basta.
- **El orquestador es TypeScript puro** (`supabase/functions/_shared/checkout/pipeline.ts`), once
  etapas en orden, con pila de compensaciones y errores tipados por etapa. Vive en el borde y no en
  PL/pgSQL porque la etapa de cobro es una llamada de red: dentro de una transacción de la base
  bloquearía las filas de existencia mientras un tercero contesta.
- **Las etapas 10 y 11 no ejecutan nada, y eso es la propiedad**: los hechos se escriben DENTRO de la
  transacción del pedido (`checkout_place_order`), así que no existe «pedido creado, nadie enterado».
- **Tres ganchos vacíos con el elemento neutro** —promociones (P10), entrega (P12) y cobro (P09)—,
  para que esas fases sean sustituir un adaptador y no abrir el orquestador. Ningún nombre de
  pasarela, transportista ni ERP aparece en el directorio.
- **La fusión invitado → usuario toma el MÁXIMO, no la suma**, solo absorbe carritos sin dueño y
  exige mismo canal.
- **En la petición de compra no viaja ni un céntimo**: el aviso de cambio de precio lo produce
  `cart_price_drift` comparando la cotización vigente contra el snapshot del propio motor.
- **`domain_events` no es `integration_outbox`**: aquella exige un proveedor ACTIVO y entrega a un
  sistema; esta publica un hecho y funciona en un tenant sin conectores.
- **Ni `anon` ni `authenticated` escriben una sola fila** de las cuatro tablas; el `token` del
  carrito y el `reservation_token` del intento quedan fuera del GRANT por columna del backoffice.

### OMS: cuatro ejes, snapshots inmutables y comandos (P08-SaaS)

Cuatro tablas más, migraciones `20260828110000`-`20260828110600`. Decisiones completas en
[`adr/008-oms-order-axes-snapshots.md`](adr/008-oms-order-axes-snapshots.md).

```
EL PEDIDO CRECE (sin renombrar nada de lo que ya habia)
  orders  + status (comercial, el de siempre)
          + payment_status · fulfillment_status · approval_status
          + source_channel   POR QUE PUERTA entro; distinto de channel_id (canal COMERCIAL)
          + tax_inclusive · billing_address · shipping_address_snapshot · customer_snapshot
  order_items + tax_rate/tax_amount/tax_category_code · discount_amount/discount_snapshot
              + variant_label/variant_attributes · components_snapshot · price_list_code

EL RELATO
  order_events        linea de tiempo de los CUATRO ejes, append-only, un solo escritor

LO QUE ESCRIBE EL EQUIPO
  order_notes         hilo interno; orders.notes sigue siendo la instruccion del COMPRADOR
  order_tags          triage plano, normalizado por CHECK y por trigger

LO QUE ESCRIBEN OTROS SISTEMAS
  order_external_refs (order_id, system_code, ref_type) — atributo, nunca clave
```

- **`status` no cambia de significado.** Se le suman tres ejes porque una columna que responde «¿llegó
  el dinero?», «¿salió la mercancía?» y «¿en qué punto comercial está?» a la vez no puede escribir un
  pedido pagado y no despachado. La compatibilidad la garantiza `ebim.sync_order_axes`, que corre
  ANTES que la máquina de los ejes (orden alfabético de triggers BEFORE) y adelanta lo que la
  sentencia no tocó: el estado «`paid` con `payment_status` en `pending`» es imposible, no
  improbable.
- **Los tres ejes nuevos NO tienen GRANT de escritura.** El GRANT por columna de P02 no se amplía, así
  que la única puerta es `public.order_transition`, que reúne en una operación atómica autorización +
  máquina de estados + línea de tiempo + hecho de dominio. Un test enumera las columnas con `UPDATE`
  para `authenticated` y falla si aparece una cuarta.
- **El motivo del cambio viaja por un ajuste LOCAL de transacción** (`set_config(…, true)`) que lee el
  trigger de la línea de tiempo. Así el escritor de `order_events` sigue siendo único y **no existe un
  cambio de estado sin evento**, ni siquiera si alguien escribe un UPDATE a mano.
- **La inmutabilidad es un trigger, no un comentario**: `ebim.assert_order_item_immutable` y
  `ebim.assert_order_snapshot_immutable` detienen también a `service_role`, que sí tiene GRANT y no
  pasa por ninguna policy. `shipping_address` sigue siendo corregible y su original vive en
  `shipping_address_snapshot`, que no tiene GRANT para nadie.
- **El impuesto se reparte por línea con resto mayor**: el total del grupo de tasa se distribuye en
  proporción al importe y el residuo va a la línea mayor. La suma de las líneas es EXACTAMENTE el
  `tax_total` del pedido por construcción, no por suerte.
- **La aprobación B2B no contamina B2C**: `not_required` es terminal, y con la aprobación pendiente no
  se mueve ningún eje salvo cancelar. El umbral de la CUENTA lo impone la base con la fila delante; el
  límite de la PERSONA lo aporta el borde, que es donde hay sesión — y solo puede AÑADIR aprobación,
  nunca quitarla.
- **`order_status_events` no se retira**: sigue viva y su historial se copió a `order_events`, para
  que un pedido anterior a esta fase no aparezca sin memoria.
- **Pedidos programados, repetición e importación se PREPARAN sin construirse**: capacidad
  `orders.advanced` (`declared`), los tres valores ya en el enum `order_source_channel` y
  `order_external_refs` como lote de origen. `order_schedules` y `order_batches` **no se crean**;
  el ADR escribe el disparador de cada una, igual que P06 con `warehouse_locations`.

### Pagos: contrato de pasarela, comandos y conciliación (P09-SaaS)

Siete tablas más, migraciones `20260828120000`-`120200`. Decisiones completas en
[`adr/009-payments-provider-contract.md`](adr/009-payments-provider-contract.md).

```
payment_methods        QUE puede elegir el comprador. Config PUBLICA; sin credenciales.
  └── payment_intents  LA INTENCION de cobrar. Nace ANTES que el pedido y se ata despues.
        ├── payment_attempts  CADA llamada al proveedor, con su resultado. Append-only.
        ├── payments          EL DINERO cobrado. ── refunds  LA DEVOLUCION, con idempotencia propia.
        └── payment_events    la bitacora del dominio. Append-only, incluso para service_role.
reconciliation_records LO QUE EL PROVEEDOR DICE QUE LIQUIDO. De la SOCIEDAD, no de la tienda.
```

- **El dominio de pedidos no se enteró de nada.** `orders` y `order_items` no ganaron ni una columna:
  el cobro apunta al pedido y el pedido no apunta al cobro. Tres FK en un sentido, cero en el otro, y
  un test que lo comprueba contra `pg_constraint` en vez de contra el diff.
- **`orders.payment_status` es un ESPEJO**, escrito por `ebim.payment_sync_order`. Y **no propaga la
  excepción**: si el eje del pedido no admite la transición —un pedido B2B pendiente de aprobación—
  el cobro se escribe igual y el comando devuelve `order_synced: false`. Perder el registro de un
  dinero que ya se movió, para salvar la coherencia de una etiqueta, es el intercambio equivocado.
- **Nadie con sesión escribe dinero**: seis de las siete tablas sin GRANT de escritura para
  `authenticated` ni `anon`. La séptima, `payment_methods`, es configuración. Mover dinero es un
  comando `SECURITY DEFINER`, igual que los ejes del pedido en P08.
- **Un único punto de entrada**, `public.payment_apply_outcome`, para la respuesta síncrona, el
  webhook y el operador. Ahí viven las tres reglas caras: el retorno del navegador **no decide**
  (`RETORNO_NO_DECIDE`), un webhook sin firma verificada **no mueve dinero**
  (`FIRMA_NO_VERIFICADA`), y un aviso repetido no duplica nada.
- **Idempotencia en tres cerrojos** independientes —evento del proveedor, llamada al proveedor, cobro
  por referencia— más la máquina de estados como cuarto tope: `captured` es terminal para el intento.
- **PCI por delegación es verificable, no una promesa**: `ebim.jsonb_is_card_safe` es un CHECK con
  Luhn que rechaza un PAN a cualquier profundidad **incluso insertado por `service_role`**, y
  `provider_token_ref` solo admite el formato de un nombre de variable del vault.
- **`timeout` es de primera clase**: no dice que no se cobró, dice que no se sabe. Deja el intento en
  `processing` y el checkout devuelve `PAGO_NO_DISPONIBLE` (503, reintentable), nunca «rechazado».
- **La conciliación cruza por referencia externa dentro del tenant**, que sale del JWT. Ningún banco
  aparece nombrado: el proveedor es una fila de `integration_providers`.

El lado TypeScript vive en `supabase/functions/_shared/payments/`: el contrato canónico
(`provider.ts`, con capacidades explícitas porque no toda pasarela implementa todos los modos), el
conector determinista `sandbox.ts`, la verificación de firma (`signature.ts`, HMAC-SHA256 sobre el
cuerpo **crudo** y comparación en tiempo constante), el gancho de la etapa 8 (`gateway.ts`) y la
ingesta de avisos (`webhook.ts`). **`registry.ts` es el único sitio del repositorio donde se escribe
el código de una pasarela**: añadir una real es un archivo y una línea en ese mapa.

La Edge Function `payments-webhook` no usa `serveJson` —necesita el cuerpo crudo para la firma—, no
acepta `Authorization` (quien llama es un servidor, y la autenticación es la firma) y responde 200
casi siempre, porque a un webhook al que se contesta con error se le reintenta para siempre.

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
| `checkout` | ninguna para el pipeline (comprador anónimo); el JWT del llamante **solo** para resolver su cuenta B2B | `service_role` **y** clave publicable + `Authorization` | `my_business_accounts()` no acepta argumentos: sin la sesión del llamante esa pregunta no tiene respuesta |
| `create-order` | ninguna (comprador anónimo) | `service_role` | el pedido no puede insertarse desde el navegador; sigue viva para los clientes de P02-P06 |
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

Desde P08-SaaS hay tres funciones más y un permiso nuevo. `public.order_transition` (el COMANDO de los
tres ejes: `authenticated`, con la autorización dentro y el tenant sacado de la fila del pedido),
`public.order_approval_decide` (decide una compra B2B pendiente; autoriza al aprobador de la cuenta
—vínculo resuelto por el servidor— o al personal de pedidos) y `public.my_business_orders()`
(**sin argumentos**, la puerta del aprobador B2B, que no es miembro del tenant). El permiso es
`orders.export`, en las dos copias de la matriz de roles: exportar no es «ver el listado en un
archivo», es una extracción masiva de datos de contacto y fiscales de todos los compradores, y un
`viewer` no la tiene.

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
  features/orders/      pedidos del backoffice (P08-SaaS: listado paginado en servidor,
                        cuatro ejes de estado con comando de transicion, linea de tiempo,
                        notas internas, etiquetas, referencias externas y aprobacion B2B)
  features/payments/    cobros, medios de pago y conciliacion (P09-SaaS). Escribe UNA
                        tabla —los medios, que son configuracion—; devolver y cuadrar
                        son comandos. Gateada por la capacidad `payments`
  features/storefront/  vitrina pública: resolución por slug, catálogo, ficha, carrito/checkout
                        (P07-SaaS: carrito de servidor con fusión al iniciar sesión y
                         checkout idempotente con etapas)
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
