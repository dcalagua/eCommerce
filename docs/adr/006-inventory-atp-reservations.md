# ADR 006 — Inventario multi-almacén, ATP y reservas sin sobreventa

- **Estado:** aceptada
- **Fecha:** 2026-08-28
- **Fase:** P06-SaaS (productización)
- **Contexto previo:** [`ADR 001`](001-domain-boundaries.md) §2 (`InventoryPort` declarado y sin
  implementación), [`ADR 002`](002-capabilities-entitlements.md) §2 (`inventory.multiwarehouse` era
  `declared`), [`ADR 003`](003-pim-variantes-uom-kits.md) §7 (`products.stock` se conserva y
  «retirarlo es trabajo de P06»), [`ADR 004`](004-pricing-engine.md) (el precedente de mover una
  decisión de una columna a una función)
- **Contrato EBIM:** §0.2 (personalización = configuración), §0.5 (ninguna app decide en el vacío),
  §3 (jerarquía `organization` → `company` → datos), §6 (los addons los declara el hub), §8 (tabs
  centrados, un buscador general)

---

## Contexto

Hasta P05, «el inventario» de eCommerce eran dos columnas —`products.stock` y
`product_variants.stock`— y un `update ... set stock = stock - n` dentro de `create_order`. Es
suficiente para una tienda que despacha desde su trastienda y no alcanza para nada más:

- no hay dónde decir que hay 10 en Lima y 2 en Arequipa;
- no hay forma de responder por qué hoy hay 8 si ayer había 12;
- no hay nada que impida que dos compradores simultáneos se lleven la misma unidad mientras el
  carrito de uno todavía está abierto;
- y la disponibilidad de un tenant que lleva el stock en su ERP no se puede representar, porque la
  única respuesta posible sería una cifra local que nadie mantiene.

El baseline lo tenía anotado como riesgo (`SAAS_BASELINE` §3, fila 10: «placeholder»), el roadmap lo
marcaba como camino crítico junto a P07, y el `InventoryPort` de P01 ya había escrito el contrato que
faltaba implementar: **consultar disponibilidad no es reservarla**.

## Decisión

### 1. Seis tablas, y las dos que NO se crearon

```
warehouses ──── store_warehouses          qué tienda se sirve de cuál, y en qué orden
           └─── inventory_levels          cuánto hay de qué, en qué almacén
                inventory_movements       el libro mayor: por qué cambió
                inventory_reservations ── inventory_reservation_items
```

**`warehouse_locations` no se creó.** Se escribió y se retiró. Una ubicación (pasillo, estante,
posición) no cambia ni una respuesta de este dominio: el ATP de un SKU es el mismo lo tenga en A-01 o
en B-14, y la reserva se hace sobre el almacén porque es el almacén el que despacha. Lo que sí
necesita ubicaciones es la ola de picking, que es **WMS** —una app distinta de esta misma suite,
incorporada formalmente en `gmao-033`— y fulfillment (P12). Una tabla que hoy no lee nadie no es
preparación: es una segunda verdad esperando a que alguien la rellene a medias.
**Disparador para crearla:** el día que P12 tenga que decir de qué posición sale una línea, o que WMS
declare una operación de ubicación en `integration_providers`.

**`reservation_events` tampoco.** El historial de una reserva son cuatro estados y tres marcas de
tiempo en la propia fila (`held` → `committed` | `released` | `expired`), y no hay transición
intermedia que perder porque la reserva es **atómica sobre todas sus líneas**: o entran todas o no
entra ninguna. Lo que sí tiene historial es la existencia, y ese libro es `inventory_movements`,
donde la confirmación de una reserva deja su asiento.

La tabla que sí se añadió y no estaba en la lista de la fase es `store_warehouses`, porque sin ella
«qué almacén abastece a qué tienda» solo se podría expresar duplicando el almacén por tienda.

### 2. El almacén es de la SOCIEDAD, no de la tienda

Igual que las marcas, las unidades de medida, los segmentos y los clientes. Un centro de
distribución sirve a todas las tiendas de la sociedad; darle `store_id` obligaría a duplicar el
almacén —y con él sus existencias— cada vez que se abre un canal, y a partir de ahí habría dos
verdades sobre las mismas cajas.

**Sin filas en `store_warehouses`, todos los almacenes activos abastecen a la tienda.** Es lo que
hace que dar de alta el primero no deje la tienda sin vender. En cuanto la tienda declara uno, deja
de servirse de los demás: **declarar es restringir**, que es la única lectura segura de una
configuración vacía.

### 3. `available_qty` es una columna generada; la sobreventa la impide un CHECK

Dos decisiones que hacen que la corrección no dependa de que el código siga siendo correcto:

```sql
available_qty numeric(18,6) generated always as (on_hand_qty - reserved_qty) stored,

constraint inventory_levels_no_oversell
  check (allow_backorder or (on_hand_qty >= 0 and reserved_qty <= on_hand_qty))
```

Un disponible mantenido por la aplicación se separa de sus dos sumandos el primer día que una
excepción salta entre las dos escrituras. Generado, no puede.

Y el CHECK es la **última línea**: aunque un día alguien escriba un `update` sin guarda, o dos
transacciones se solapen de la peor forma imaginable, la transacción aborta. Hay un test que lo
comprueba intentando sobrevender como `service_role`, que es el rol que se salta la RLS y aun así no
se salta esto.

El backorder es la única excepción y es **explícita**: una política del almacén, denormalizada en el
nivel con una FK a la clave de apoyo del padre (`warehouses (id, allows_backorder)`) y
`on update cascade`. Es la técnica del PIM: un CHECK puede mirar una política que vive en otra tabla
sin triggers y sin poder desincronizarse. Cambiarla en el almacén la propaga sola; escribir en el
nivel un valor que el almacén no tiene es una violación de clave foránea.

### 4. El reparto decide DENTRO de la sentencia que escribe

Es el corazón de la fase. El patrón que **no** se usa es el de P02:

```sql
select stock into v_disponible from products where id = ... for update;
if v_disponible < v_pedido then raise; end if;
update products set stock = stock - v_pedido where id = ...;
```

Funciona —el `for update` bloquea— pero solo porque las tres sentencias caben en una transacción
corta. En cuanto entra un carrito con reserva previa o un reparto entre varios almacenes, la
distancia entre la lectura y la escritura crece; y sobre todo, la garantía queda depositada en que
quien escriba la siguiente función se acuerde del `for update`.

Lo que se usa (`ebim.take_units`):

```sql
with locked as (
  select id, least(<lo que falta>, <lo que hay libre>) as take
    from public.inventory_levels where id = ... for update
)
update public.inventory_levels l
   set reserved_qty = l.reserved_qty + k.take
  from locked k where l.id = k.id and k.take > 0
returning k.take;
```

La CTE toma el bloqueo **y relee la fila ya bloqueada** —en `READ COMMITTED`, `SELECT ... FOR UPDATE`
devuelve la versión más reciente confirmada después de esperar al que iba delante—, así que `take` se
calcula sobre la cifra verdadera y no sobre una foto vieja. Dos checkouts simultáneos sobre el mismo
nivel se serializan en esa espera. No hay bucle de reintento porque no hay conflicto que reintentar.

El test que compra esta propiedad reproduce la carrera clásica de forma determinista: un llamante lee
la disponibilidad (5), otro consume 3, y el primero intenta tomar las 5 «que había». Si el reparto
decidiera con la lectura previa vendería 5 de 2; como decide dentro de la sentencia que escribe, no
puede.

### 5. «No se sabe» no es «no hay»

Un almacén cuyo sistema de registro es un ERP (`source = 'erp'`) y cuya cifra caducó (`stale_after`)
no aporta cero: aporta *nada*, y la respuesta pasa a ser desconocida. Cero vaciaría la tienda entera
durante una caída ajena —el escenario que el `InventoryPort` describe desde P01—; inventarse la
última cifra sin decirlo sería prometer lo que no se puede cumplir. Las dos salidas honestas son las
dos políticas del almacén, y **la elige el tenant**:

| `stale_policy` | Qué hace | Cuándo se elige |
|---|---|---|
| `unknown` (defecto) | el almacén deja de aportar cifra; `ebim.atp` devuelve `unknown: true` | cuando no se puede permitir prometer de más |
| `trust_last_known` | se sigue usando la última cifra sincronizada | cuando parar la venta cuesta más que el riesgo acotado |

Con `unknown`, **el checkout se niega** con un código propio —`DISPONIBILIDAD_DESCONOCIDA`, distinto
de `STOCK_INSUFICIENTE`— y **la vitrina sigue mostrando el producto**. Es la decisión incómoda de la
fase, y está razonada: se pierde un carrito, no se pierde la tienda. Un almacén `local` no puede
declararse caducable (CHECK `warehouses_local_never_stale`): esta base *es* su verdad, así que no
habría nada que lo refrescara.

### 6. La reserva tiene caducidad obligatoria, idempotencia de negocio y un secreto

- **`expires_at` es NOT NULL.** Una reserva sin caducidad es stock perdido: el carrito que nadie
  cerró se queda con las unidades para siempre y nadie sabe por qué la tienda dice «agotado» con el
  almacén lleno. Quien reserva elige cuánto dura, pero no elige no elegir.
- **`reference_key`** es la idempotencia: reservar dos veces para el mismo carrito —un reintento de
  red, un doble clic— devuelve la MISMA reserva, no el doble de unidades. El índice único es parcial
  sobre `held` para que una reserva ya cerrada no impida que el mismo carrito vuelva a reservar.
- **`token`**, 256 bits, misma construcción que `order_tokens`. Es lo que permite al checkout decir
  «esta reserva es mía» sin que el identificador de una reserva ajena —un uuid, enumerable— sirva
  para llevarse sus unidades.
- **La caducidad se aplica sola**, al principio de cada reserva y de cada pedido de la tienda, y no
  solo desde un planificador. Este proyecto no tiene cron garantizado, y una caducidad que depende de
  un job que puede no existir es una caducidad que no existe. El coste es un `update` sobre un índice
  parcial que casi nunca toca una fila.

**Al reclamar la reserva, el checkout devuelve sus unidades y las vuelve a consumir**, en la misma
transacción y con las filas ya bloqueadas. Se eligió esto en vez de casar línea a línea porque el
carrito pudo cambiar entre reservar y pagar: casando, media diferencia dejaría unidades comprometidas
sin dueño; devolviendo, el pedido toma lo que necesita y lo que sobra vuelve a estar a la venta al
instante. Nadie puede colarse en medio porque el bloqueo dura hasta el `commit`.

### 7. Ninguna existencia se escribe con un `UPDATE`

`inventory_levels`, `inventory_movements` y las dos de reserva **no tienen ni un GRANT de escritura**
para `authenticated` ni para `anon`. No es prolijidad: un `PATCH /inventory_levels?id=eq.…` desde
PostgREST cambiaría la existencia sin dejar asiento en el libro mayor, y a partir de ese momento el
saldo y su historia dirían cosas distintas. Es la regla de bitácora de `CLAUDE.md` aplicada a
existencias.

Lo que sí se escribe por PostgREST son los maestros —almacenes y su vínculo con la tienda—, porque
ahí no hay saldo que descuadrar, y exigen `owner`/`admin` **y** la capacidad.

Consecuencia: hay más funciones de las habituales, y cada una tiene **su propio llamante y su propia
autorización** (el precedente de las tres puertas de P04 y de `my_business_accounts` de P05):

| Puerta | Quién la abre | Cómo se autoriza |
|---|---|---|
| `reserve_inventory` | backoffice con sesión | rol + capacidad, tenant de la TIENDA |
| `reserve_inventory_for_slug` | servidor (carrito anónimo) | `service_role`; tienda por slug |
| `release_inventory_reservation` / `commit_…` | backoffice con sesión | rol + capacidad |
| `release_inventory_by_token` | servidor (carrito abandonado) | `service_role` + secreto de 256 bits |
| `expire_inventory_reservations` | servidor (barrido) | `service_role` |
| `adjust_inventory` / `set_inventory_policy` / `seed_inventory_from_catalog` | backoffice | rol + capacidad |
| `sync_inventory_level` | servidor (ERP) | `service_role` |
| `inventory_availability` | backoffice con sesión | membresía; devuelve la cifra |
| `availability_for_slug` | comprador anónimo | ninguna; devuelve el semáforo, **nunca la cifra** |

### 8. El libro mayor es idempotente por referencia externa

`inventory_movements` guarda un **delta con signo** y el **saldo resultante**, escrito bajo el mismo
bloqueo que el cambio. El índice único parcial sobre
`(organization_id, company_id, warehouse_id, external_ref)` hace que un evento del ERP reintentado
—un webhook que se reenvía, una cola que reparte dos veces— no descuente dos veces: la segunda
escritura choca con la clave y `ebim.apply_movement` devuelve el asiento que ya existía. No hay
carrera entre dos reintentos simultáneos porque la garantía es el índice, no una comprobación previa.

`sync_inventory_level` recibe **saldos absolutos**, no deltas: un ERP no manda diferencias, manda
saldos. La diferencia se calcula aquí y se anota como `count`, que es lo que es.

### 9. La transición desde `products.stock` se hace por debajo

`products.stock` y `product_variants.stock` **no se retiran**. Lo que cambia es su significado, y
está escrito donde se lee (`comment on column`): desde P06 son el **camino de fallback**, y mandan
solo mientras ninguna tienda de la sociedad tenga almacenes que la sirvan.

`ebim.consume_stock` tiene los dos caminos dentro, y `create_order` llama a uno solo:

- con almacenes que sirvan a la tienda → reparte, descuenta y deja asiento;
- sin ellos → descuenta `products.stock` **exactamente como antes**, con las mismas excepciones y el
  mismo texto.

Es la prueba de que la transición está hecha por debajo: ni uno solo de los tests de pedido de P02,
P03 y P04 cambió una línea. Y `public.seed_inventory_from_catalog` copia la existencia del catálogo
al almacén como recuento inicial, de forma idempotente (el asiento lleva `external_ref` derivado del
almacén y de la referencia), para que un tenant que ya vendía no pase ni un minuto diciendo
«agotado».

### 10. La vitrina deja de leer una columna y pasa a preguntar

Mismo movimiento que P03 hizo con el kit y P04 con el precio. `public_products.in_stock` y
`public_product_variants.in_stock` salen ahora de `ebim.product_is_available`, `SECURITY DEFINER` con
la autorización dentro: solo responde por un producto que quien pregunta **ya podía ver**
—publicado, con fecha, en tienda activa— y solo un booleano. De ahí no se puede sacar una cantidad,
ni un almacén, ni un tenant.

`ebim.bundle_is_available` pasa a calcular contra el ATP de los componentes, con la misma firma y la
misma autorización. Los dos casos que hacen inarmable un kit —sin componentes, o con un componente en
una unidad sin configurar— se comprueban **antes** de preguntar, porque `ebim.expand_stock_lines`
levanta excepción en ambos y una excepción dentro de una vista tumbaría la consulta entera de la
vitrina, no una fila.

### 11. El puerto gana su segunda implementación, y por eso existía

`src/features/inventory/serverInventory.ts` trae **dos** adaptadores de `InventoryPort`, que no son
dos capas de lo mismo: responden a dos preguntas hechas por dos actores con dos autorizaciones.

| | `backofficeInventory` | `storefrontInventory` |
|---|---|---|
| Quién pregunta | miembro de la sociedad | comprador anónimo |
| Cómo se resuelve la tienda | por `store_id` + membresía | por el slug de la URL |
| Qué recibe | la cifra exacta | solo el semáforo |
| Puede reservar | sí (venta asistida) | no desde el navegador |

El puerto se retocó con lo que la implementación demostró que faltaba, y solo con eso:
`ReservationRequest.referenceKey` (sin idempotencia de negocio, un reintento vacía el almacén),
`Reservation.claimToken` (sin secreto, una reserva ajena se puede consumir), `variantId`/`uomCode` en
la línea, y un campo `unknown` en `Availability` para separar «la fuente no lo sabe» de «esta
implementación no publica la cifra» — dos cosas que antes eran el mismo `null` y que **ninguna de las
dos se lee como cero**.

## Alternativas descartadas

- **Mantener `products.stock` como caché agregada de los almacenes, actualizada por trigger.** Es
  cómodo —la vitrina no cambia— y es exactamente la segunda verdad que este repositorio se prohíbe:
  el día que el trigger falle o alguien escriba la columna a mano, el semáforo y el almacén dirán
  cosas distintas y nadie sabrá cuál creer.
- **Cantidades `integer`.** Media caja de tornillos no existe, pero medio kilo de pintura sí, y un
  tipo entero obliga a elegir entre no venderlo o inventarse un redondeo. `numeric(18,6)`, la misma
  precisión que `product_uoms.factor`. La regla de `create_order` —una conversión que no da unidades
  base enteras se rechaza— **no** se relajó: es una garantía existente y aflojarla no es trabajo de
  inventario.
- **Bucle de reintento con `serializable`.** Habría funcionado, y habría metido en el checkout un
  camino que solo se ejercita bajo carga —o sea, el que nunca se prueba—. El bloqueo dentro de la
  sentencia da la misma garantía sin rama nueva.
- **Un `assert_available` que levante excepción dentro de `ebim.take_units`.** Se descartó: quien
  llama sabe qué error de negocio corresponde (el checkout dice `STOCK_INSUFICIENTE`, la reserva dice
  otra cosa), y decidir el mensaje de una pantalla desde el motor es la clase de acoplamiento que
  después obliga a traducir dos veces.
- **Un `updated_at` y policies de UPDATE en `inventory_movements`.** Un libro mayor que se puede
  editar no es un libro mayor. Las correcciones son asientos nuevos.
- **Reservar automáticamente al añadir al carrito.** Es P07 y no P06 a propósito: sin idempotencia
  demostrada y sin caducidad probada, una reserva por clic es una forma de vaciar una tienda sin
  comprar nada. La puerta anónima (`reserve_inventory_for_slug`) queda construida y probada; quién la
  llama y cuándo lo decide el pipeline del carrito.

## Consecuencias

**Lo que ahora es imposible:**

- vender la misma unidad dos veces, ni por una carrera, ni por un `update` mal escrito, ni con
  `service_role`;
- dejar un almacén en negativo sin haber declarado explícitamente el backorder;
- cambiar una existencia sin dejar asiento;
- que un evento externo reintentado descuente dos veces;
- que el navegador elija de qué almacén sale su pedido, o nombre una reserva o un nivel;
- que un ERP caído se lea como «agotado» —ni como una cifra inventada—.

**Lo que esta fase NO resuelve, y queda dicho:**

- **El carrito no reserva todavía.** La puerta existe (`reserve_inventory_for_slug`) y está probada,
  pero nadie la llama desde la vitrina: eso es P07, que es donde se define el pipeline
  `resolve prices → reserve inventory → validate account`.
- **No hay traslados entre almacenes como operación.** Los dos motivos existen en el libro mayor
  (`transfer_in`/`transfer_out`) y se registran a mano; una operación que mueva los dos lados en una
  transacción con su documento es trabajo de fulfillment (P12).
- **No hay ubicaciones ni olas de picking.** Es WMS y P12, y el disparador está escrito arriba.
- **No hay reposición automática ni previsión.** `reorder_point` solo alimenta una alerta: comprar es
  una decisión, no un cálculo.
- **La vitrina paga una llamada `SECURITY DEFINER` por fila.** Es el mismo coste que
  `bundle_is_available` desde P03 y es aceptable al tamaño de catálogo de hoy; materializarlo es
  trabajo de P11, cuando la vitrina pagine sobre decenas de miles de referencias.
- **`inventory_reservations` no llega a `orders` por FK obligatoria.** El enlace es
  `order_id` con `on delete set null`: el pedido puede existir sin reserva, que es el caso normal
  hoy.
