# ADR 012 — Logística: la entrega es del pedido, el transporte no

- **Fase**: P12-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 001](001-domain-boundaries.md) (fronteras y
  `FulfillmentProvider` como puerto declarado), [ADR 002](002-capabilities-entitlements.md)
  (la capacidad `fulfillment` y su entitlement), [ADR 006](006-inventory-atp-reservations.md)
  (almacenes, `serving_warehouses` y el motor de existencia),
  [ADR 007](007-cart-checkout-pipeline.md) (el pipeline y su etapa 7 vacía),
  [ADR 008](008-oms-order-axes-snapshots.md) (el eje `fulfillment_status` y los
  comandos del pedido), [ADR 009](009-payments-provider-contract.md) (el
  contrato canónico de proveedor y la idempotencia de webhooks).

---

## El criterio de aceptación, leído literalmente

> PASS si se puede conectar un operador logístico nuevo mediante adapter y el
> ciclo de entrega/devolución conserva trazabilidad.

Las dos mitades se comprueban por separado y ninguna es una promesa:

- **«Conectar un operador nuevo mediante adapter»** es
  `supabase/tests/fulfillment-provider.test.ts`, que registra un transportista
  que no existe en ninguna otra parte del repositorio y recorre con él el ciclo
  entero —guía, seguimiento, webhook firmado—. Lo único que hace falta para eso
  son dos cosas: una implementación de `ShippingProvider` y una línea en
  `_shared/fulfillment/registry.ts`. Ni una migración, ni un cambio en el
  pipeline, ni un `if` en ninguna pantalla.
- **«El ciclo conserva trazabilidad»** es `supabase/tests/fulfillment.test.ts` y
  `returns.test.ts`, contra Postgres real: la línea de tiempo del pedido cuenta
  el despacho entero, el seguimiento es append-only incluso para `service_role`
  y la devolución deja su bitácora y su hecho canónico.

---

## Decisión 1 · Un pedido no es un fulfillment

Es la primera regla del encargo y la que ordena el resto del modelo. La
diferencia se ve en cuanto un pedido de tres líneas sale en dos cajas, desde dos
almacenes, en dos días distintos: eso es **un pedido y dos entregas**, cada una
con su origen, su ventana, su estado y su transportista. Modelarlo como un
estado más en `orders` obliga a elegir cuál de los dos es «el» estado, y no hay
respuesta correcta.

De ahí la dirección de las claves, que es la misma que P09 eligió para los
cobros y por la misma razón:

```
fulfillment ──► order          (tres FK del despacho al pedido)
order       ─X─► fulfillment   (CERO columnas nuevas de logística en `orders`)
```

Hay un test que lo comprueba contra el catálogo de Postgres —no contra el
diff—: `orders` no tiene ni una columna que contenga `carrier`, `tracking`,
`shipment`, `delivery` ni `pickup`, y no existe una sola FK que vaya del pedido
al despacho.

`orders.fulfillment_status` sigue existiendo, y es un **espejo**: lo deriva
`ebim.fulfillment_sync_order` de las cantidades entregadas, igual que
`payment_status` se deriva desde `ebim.payment_sync_order`. Solo AVANZA —el
ranking `unfulfilled < in_progress < partially_fulfilled < fulfilled` coincide
exactamente con los caminos que permite `ebim.assert_order_axes`—, así que
anular una entrega no hace retroceder el relato de un pedido que ya salió.

## Decisión 2 · La única columna del pedido que sí cambia es el dinero

`orders.shipping_total` existía desde P02 y valía **siempre cero**. Aquí se
llena, y esa es la única concesión: el transporte es dinero DEL PEDIDO, no del
operador, igual que el impuesto lo es aunque lo cobre el estado.

La alternativa —dejar el coste solo en `fulfillments.shipping_cost` y no tocar
el pedido— era más limpia sobre el papel y falsa en la práctica: un comercio que
cobra S/15 de envío no lo cobraría, porque `grand_total` no lo incluiría. Un
dominio de entregas que calcula un coste que nadie cobra está a medio construir.

Para llenarlo hubo que volver a escribir `create_order`, `create_order_for_slug`
y `checkout_place_order` enteras —Postgres no sabe añadir un parámetro a una
función—, que es lo que ya hicieron P03, P04, P06, P08 y P10. La diferencia es
que esta vez **la copia la hace un script**
(`scripts/build-p12-create-order.mjs`): parte de la versión vigente, aplica
parches con anclas exactas y falla si un ancla no aparece exactamente una vez.
Copiar setecientas líneas a mano es donde se cuelan las diferencias silenciosas.

Y el reparto de ese importe entre entregas es **estructural, no recordado**:

```
coste de la entrega = shipping_total − (lo ya asignado a entregas no anuladas)
```

Con una sola entrega da el total; con la segunda da cero. Partir un despacho no
cobra transporte de más, y la suma de las entregas siempre es el total del
pedido. Hay un test que lo comprueba después de partir un pedido en dos.

## Decisión 3 · El coste y la cobertura se resuelven en el servidor, y no por convención

`delivery_rates` **no tiene GRANT de SELECT para `anon`**. El navegador no puede
leer una tarifa aunque quiera; lo único que puede hacer es preguntar «¿cuánto me
cuesta llevar esto aquí?» y recibir un importe ya calculado.

Falta la otra mitad, que es la que casi siempre se olvida: **el subtotal con el
que se evalúa el umbral de envío gratis tampoco viaja en la pregunta**.
`delivery_options_for_slug` lo recalcula llamando a `ebim.build_quote`, el mismo
motor que cotiza el carrito. Si el subtotal llegara en la petición, el envío
gratis lo decidiría el comprador.

La autoridad es una sola función, `ebim.delivery_options`, para la vitrina, el
checkout y el backoffice — la misma forma que `ebim.resolve_prices` tiene desde
P04. Dos implementaciones del mismo cálculo se separan el día que una se
corrige.

Tres reglas menores del motor que sí merecen quedar escritas:

1. **La zona gana por especificidad, no por orden de creación**: prefijo postal
   más largo, luego región declarada, luego `priority`. Sin esto, una zona
   «Perú» creada después taparía a «Lima 15001» y la tarifa nacional se cobraría
   dentro de la ciudad.
2. **`null` de peso no es cero.** Una tarifa por kilo sobre un catálogo que no
   declara pesos NO se aplica: se descarta con motivo (`PESO_NO_DECLARADO`, que
   se distingue de `SIN_TARIFA` porque las acciones son distintas — una la
   arregla el catálogo y la otra la configuración). Tratarlo como cero regalaría
   el transporte de un palet.
3. **Un método sin tarifa aplicable no es un método gratis**: es un método no
   disponible. Cobrar cero convertiría cada agujero de configuración en una
   pérdida silenciosa; el backoffice además lo avisa en la propia tabla.

## Decisión 4 · Recojo, reparto y envío son ESTRATEGIAS del mismo checkout

La regla 7 del encargo, tomada en serio. `delivery_strategy` tiene cuatro
valores y los cuatro son opciones de la misma lista del mismo formulario:
comparten dirección, resumen, validación y botón de comprar. Un «checkout de
recojo» aparte duplicaría las tres cosas que peor envejecen duplicadas.

Lo que sí cambia por estrategia es lo que la base impone con CHECKs, no la
pantalla:

- solo `ship` admite transportista —nadie transporta lo que el comprador va a
  buscar ni una descarga—;
- `pickup` exige punto de recojo: una promesa sin sitio al que ir no la puede
  cumplir nadie;
- y una entrega en punto de recojo congela **la dirección del punto**, no la del
  comprador: guardar la suya diría que se le entregó en casa algo que fue a
  buscar.

## Decisión 5 · El punto de recojo manda sobre la regla de abastecimiento

`ebim.select_warehouse` tiene una precedencia y está escrita:

1. si el punto de recojo cuelga de un almacén, sale de ahí;
2. si no, la estrategia configurada del método (`store_priority` o
   `single_warehouse_atp`).

El orden importa. Que una regla de abastecimiento eligiera otro almacén produce
el caso peor del comercio físico: el comprador va a la tienda y la mercancía se
descontó del depósito. Y la regla es **configuración del método**, no una
constante del producto, que es lo que pedía la regla 4 del encargo.

Cuando ningún almacén lo tiene todo, `single_warehouse_atp` cae al primero del
orden declarado en vez de partir el pedido: partirlo cuesta dos envíos y esa es
una decisión de operación que toma una persona desde la cola, no una función.

## Decisión 6 · El seguimiento se normaliza, y la jerga del operador se guarda al lado

`tracking_status` es un enum de diez valores y es a lo que traduce el adaptador.
El estado del operador —«EN RUTA», `OUT_FOR_DEL`, código 47— entra en
`provider_status` **tal cual, sin normalizar**, y no decide nada: está para
poder llamar al call center citando su propio vocabulario. Sin esa separación,
la pantalla del backoffice acabaría con un `switch` por transportista.

`info` es un estado de primera clase: un operador avisa de muchas cosas que no
mueven nada, y traducirlas a algo para tener un valor que poner marcaría como
movido un envío que sigue donde estaba.

## Decisión 7 · La ingesta de seguimiento es idempotente, auditada y tolerante al desorden

Las tres propiedades de la regla 6, convertidas en estructura y no en cuidado:

1. **Un aviso repetido no duplica nada.** El índice único
   `(shipment_id, external_event_id)` es el cerrojo, y está en la BASE: no
   depende de que el borde recuerde comprobarlo antes. `external_event_id` es
   NOT NULL a propósito — un operador que no manda identificador obliga al
   adaptador a sintetizarlo de forma determinista, que es mejor que dejar la
   columna vacía y perder la deduplicación justo con el operador que peor se
   porta.
2. **Un aviso sin firma verificada NO mueve un envío.** Se registra —queda
   constancia del intento, que es lo que «auditado» significa— y no cambia ni un
   estado. Misma decisión que P09 con las pasarelas.
3. **Un aviso desordenado no rompe la ingesta.** Un operador puede mandar
   «entregado» y después «en tránsito»; el segundo se guarda como hecho y no se
   intenta aplicar, porque `ebim.shipment_allowed_next` dice que no se puede.
   Que la ingesta fallara ahí condenaría el aviso a reintentarse para siempre.

Esa consulta —«¿se puede mover de aquí a allá?»— es la razón de que las tablas
de transiciones vivan en una función (`ebim.fulfillment_allowed_next`,
`ebim.shipment_allowed_next`) y no dentro del trigger: tienen dos lectores, el
que PROHÍBE y el que PREGUNTA, y escritas dos veces se separan.

## Decisión 8 · La máquina de estados admite saltarse pasos hacia delante

`picking`, `packed` y `ready` son opcionales en el camino. No es laxitud: un
comercio pequeño no ficha cada paso y el aviso del operador —«recogido»— llega
igual. Si `allocated` solo pudiera ir a `picking`, ese aviso legítimo se
descartaría y la entrega se quedaría parada mientras el paquete ya va en camino.
Lo que la máquina sigue impidiendo es lo que existe para impedir: saltar hacia
atrás y salir de un estado terminal.

## Decisión 9 · Una devolución no es un pedido negativo

Es la tentación clásica y sale cara: un pedido negativo no tiene estado propio
—no existe «pendiente de recibir»—, no tiene motivo por línea, no distingue
«llegó roto» de «no lo quiero», no admite aprobar dos de tres unidades y, sobre
todo, reescribe la historia del pedido original.

La devolución es una entidad con su ciclo, que **apunta** al pedido. Es la
tercera vez que este repositorio toma la misma decisión —cobros, entregas y
ahora devoluciones— y por la misma razón.

Dos detalles del modelo que costaría corregir después:

- **`received_quantity` es distinta de `quantity`.** El comprador manda dos de
  tres, o mete otra cosa en la caja. Sin la distinción, el reembolso se
  calcularía sobre lo prometido y no sobre lo recibido.
- **`refund_amount` lo decide el comercio**, no la suma de las líneas. Hay
  portes no reembolsables y hay acuerdos; la suma es un defecto razonable y no
  la autoridad. La pantalla la propone y se puede cambiar.

La reposición al almacén pasa por el motor de inventario de P06 y no por un
`UPDATE`: `ebim.expand_stock_lines` traduce el kit a componentes —una sola vez
en todo el repositorio— y `ebim.apply_movement` deja el asiento con su
referencia externa, que es lo que hace la operación **idempotente**:
inspeccionar dos veces no repone el doble. Y lo que no llegó vendible no se
repone, lo pida quien lo pida: `return_items_restock_shape` es un CHECK.

## Decisión 10 · La integración financiera es un HECHO, no una nota de crédito

La regla 9 del encargo, escrita como estructura. Cuando una devolución se
completa **no se emite ningún documento y no se llama a ningún sistema**: se
publica un hecho canónico en el outbox de dominio (`domain_events`, P07):

```
return.completed  { rma, order, resolution, amount, currency, lines }
```

Quien lo convierta en nota de crédito, en abono de tarjeta o en saldo de tienda
es un consumidor —un adaptador de `ErpProvider` o `InvoicingProvider`, puertos
declarados desde P01— y no este esquema. La diferencia práctica: conectar un ERP
nuevo es escribir un consumidor; no es migrar el dominio de devoluciones. Hay un
test que comprueba que en ese payload no aparece la palabra «credit_note» ni
ninguna equivalente.

**Y no se mueve dinero solo.** Completar una devolución NO dispara un
`payment_refund_request`. Devolver dinero es un acto autorizado con su propia
pantalla y su propio rol (P09), y encadenarlo aquí significaría que aprobar una
devolución abona una tarjeta sin que nadie más lo mire. El importe queda
decidido, publicado y visible; quien lo abona pulsa otro botón. Hay un test que
comprueba que cerrar una devolución no crea ni una fila en `refunds`.

## Decisión 11 · La evidencia es opcional y privada, y `anon` no escribe en Storage

El bucket `return-evidence` es **privado**, la ruta lleva el tenant
(`{organization_id}/{store_id}/…`) y un trigger comprueba que la ruta escrita
coincide con el tenant de la fila — sin esa comprobación, la ruta sería un dato
declarado por quien sube.

Lo que NO se hizo, y conviene que quede dicho: **el comprador anónimo no puede
subir archivos**. Un `anon` con INSERT sobre `storage.objects` es un punto de
subida abierto a internet. La foto la adjunta el comercio —que es quien la
recibe por su canal— con rol de pedidos. Darle al comprador una subida directa
exige una URL firmada emitida por una Edge Function que valide el token de su
pedido; es la forma correcta y no se improvisa en esta fase.

## Decisión 12 · El peso es un atributo del catálogo, y `null` no es cero

`products.shipping_weight` y `product_variants.shipping_weight` nacen aquí
porque sin peso no hay tarifa por kilo, y una tarifa por kilo es la mitad de las
tarifas reales de esta región. Va en el catálogo porque es una propiedad de lo
que se vende: el mismo producto pesa lo mismo lo lleve quien lo lleve. Está en
la variante además de en el producto porque dos tallas de la misma prenda no
pesan igual, y con una sola columna habría que elegir entre mentir en una o
duplicar el producto.

`null` es «no declarado» y nunca cero, en las dos direcciones: la cotización
descarta las tarifas que dependen del peso y `ebim.basket_weight` devuelve
`known: false` en cuanto UNA línea no lo declara — un total parcial es peor que
no tenerlo, porque parece una cifra.

---

## Lo que esta fase NO decidió

- **Secreto de webhook por sociedad.** Sigue siendo por conector y por
  despliegue (`EBIM_SHIPPING_WEBHOOK_SECRET_<CONECTOR>`), exactamente como lo
  dejó P09 para las pasarelas y por el mismo motivo: un secreto por sociedad
  exige que la URL de callback identifique al tenant, y el operador no puede
  decirlo sin que sea un tenant declarado por un tercero.
- **Partir un pedido entre almacenes automáticamente.** `single_warehouse_atp`
  cae al primero cuando ninguno lo tiene todo. Repartir cuesta dos envíos y es
  una decisión de operación.
- **Calendario de feriados.** El plazo prometido se resuelve en días naturales.
  Los hábiles dependen del calendario de cada país y ese calendario no existe
  todavía en este producto; la aproximación cae del lado seguro —prometer de más
  es peor que prometer de menos— y está anotada en el código.
- **Cotización en vivo contra el operador.** El contrato tiene `create`, `track`
  y `cancel`; una operación `quote` contra el transportista tendría sentido el
  día que se contrate uno que la ofrezca, y hasta entonces sería una interfaz
  sin implementación. La tarifa que se cobra es la del comercio, que es lo que
  el comercio controla.
