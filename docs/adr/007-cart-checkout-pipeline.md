# ADR 007 — Carrito persistente y checkout como pipeline idempotente

- **Fase**: P07-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 001](001-domain-boundaries.md) (puertos), [ADR 004](004-pricing-engine.md)
  (la única autoridad de precio), [ADR 005](005-customers-b2b.md) (el vínculo servidor de la cuenta
  B2B), [ADR 006](006-inventory-atp-reservations.md) (reserva con caducidad, idempotente y con
  secreto).

---

## El problema, dicho sin adornos

Hasta P06 el checkout era **una llamada**: `create-order` recibía el carrito, y dentro de una sola
función de la base se resolvía el precio, se descontaba la existencia y se escribía el pedido. Eso
es correcto en lo que hace —ni un céntimo lo pone el navegador— y tiene dos agujeros que ninguna
cantidad de cuidado dentro de esa función podía cerrar:

1. **No hay ancla.** La petición llega, el pedido se crea, la respuesta se pierde por el camino y el
   navegador reintenta. Eso son **dos pedidos**, dos descuentos de existencia y dos correos. El
   botón deshabilitado del frontend no lo evita: no se ejecuta si la petición la manda otra cosa, y
   tampoco si el móvil cambia de red a mitad. Estaba anotado desde la auditoría de P00.
2. **No hay sitio donde meter lo que viene.** Cobro (P09), promociones (P10), reglas de entrega
   (P12) y aprobación B2B (P05) son pasos del checkout. Sin un orquestador, cada uno se habría
   añadido dentro de la misma función de PL/pgSQL, y el día que uno de ellos necesitara una llamada
   HTTP —autorizar un cobro tarda segundos— esa llamada habría quedado **dentro de la transacción
   que bloquea las filas de existencia**.

---

## Decisión 1 · El intento de compra es una fila, y su clave la pone el cliente

`checkout_intents (store_id, idempotency_key)` con índice único. El navegador genera 32 bytes del
generador criptográfico; el servidor los ancla. Repetir la petición devuelve **el mismo pedido**.

Lo que hace que esto no sea solo una tabla más:

- **La clave sola no basta: hay `request_hash`.** El resumen SHA-256 y canónico de lo que se pidió.
  Sin él, (a) un cliente con un error de programación podría reusar la clave para otra compra y
  recibir el pedido anterior como si fuera el suyo, y (b) quien adivinara una clave ajena obtendría
  el resultado guardado — que lleva dentro el **token de acceso al pedido**. Con él, las dos cosas
  exigen además reproducir exactamente lo que se pidió. Reusar la clave con otra petición es
  `IDEMPOTENCIA_EN_CONFLICTO`, un error explícito, nunca una segunda compra silenciosa.
- **El resumen es canónico** —claves ordenadas, líneas ordenadas por su terna—, porque el reintento
  del navegador reserializa el JSON y con otro orden se leería como una petición distinta: crearía
  justo el segundo pedido que todo esto existe para impedir.
- **`accept_price_changes` NO entra en el resumen.** Aceptar el precio nuevo es la misma compra.
- **Un intento vivo no se atiende dos veces**: el segundo recibe `CHECKOUT_EN_CURSO` (409). Solo se
  retoma pasados dos minutos sin progreso, que es la única manera de que un proceso muerto no deje
  al comprador sin poder comprar nunca más con esa clave. Al retomarlo, **se suelta la reserva del
  intento anterior**: si no, el reintento competiría contra su propia reserva y diría «no hay stock»
  sobre unidades que ya eran suyas.
- **La clave se exige de al menos 24 caracteres** seguros para URL. Una clave corta es una clave
  adivinable, y adivinarla es la mitad del camino hacia el resultado de otro.

---

## Decisión 2 · El orquestador es TypeScript puro, y vive en el borde

Once etapas, en orden, en `supabase/functions/_shared/checkout/pipeline.ts`. No importa el SDK de
Supabase, no lee variables de entorno y no sabe qué base hay detrás: recibe `CheckoutPorts`.

**Por qué no en PL/pgSQL, que es donde vive el resto de la lógica de este proyecto.** Por una razón
concreta y no por gusto: la etapa 8 autoriza un cobro, que es una llamada de red a un tercero.
Dentro de una función de la base, esa llamada ocurriría **dentro de la transacción** que ya tiene
bloqueadas las filas de existencia, y una caída ajena de quince segundos se convertiría en una
tienda parada. El pipeline llama fuera; lo que entra en la transacción es el *resultado*.

**Por qué no en la Edge Function directamente.** Porque entonces no se podría probar: hay 23 tests
del orquestador que ejercitan idempotencia, cambio de precio, stock insuficiente, canal inválido,
reintento, fallo del efecto externo y las compensaciones **sin levantar nada**.

Las once etapas y qué hace cada una:

| # | Etapa | Qué decide | Hoy |
|---|---|---|---|
| 1 | `resolve_context` | tienda, canal, moneda, impuesto | `checkout_context(slug)` |
| 2 | `validate_account` | sesión, cuenta B2B, canal compatible | `my_business_accounts()` (sin argumentos) |
| 3 | `resolve_prices` | cuánto cuesta | `price_quote_for_slug` + `cart_price_drift` |
| 4 | `resolve_promotions` | descuentos | **gancho estable**: cero (P10) |
| 5 | `calculate_taxes` | impuesto por grupo de tasa | lo trae la base; aquí se comprueba |
| 6 | `reserve_inventory` | apartar con caducidad | `reserve_inventory_for_slug` (P06) |
| 7 | `validate_delivery` | ¿se puede entregar? | **gancho estable**: sí (P12) |
| 8 | `authorize_payment` | cobro + límite de la persona | **gancho estable**: `not_required` (P09) |
| 9 | `create_order` | LA transacción | `checkout_place_order` |
| 10 | `publish_events` | los hechos | ya salieron dentro de la 9 |
| 11 | `notify` | el aviso | nada síncrono: lo entrega el outbox |

**Las etapas 10 y 11 no hacen nada, y eso es la propiedad, no una carencia.** Los dos eventos se
escriben DENTRO de la transacción de la etapa 9; si la 10 publicara por su cuenta existiría el
estado «pedido creado, nadie enterado», que es exactamente lo que el patrón outbox elimina. Y la 11
no espera a ningún proveedor de mensajería: bloquear la respuesta del comprador hasta que un tercero
conteste sería regalarle la disponibilidad de la tienda.

### Los tres ganchos vacíos, y por qué existen vacíos

Promociones, entrega y cobro no tienen motor todavía. Se podían omitir —y entonces P09, P10 y P12
tendrían que abrir el orquestador, meter una etapa en medio y recolocar las compensaciones— o dejar
el asiento hecho con una implementación que devuelve **el elemento neutro**. El elemento neutro no
es «no hacer nada»: es un valor con la forma completa (cero descuentos, entregable, cobro no
requerido) que las etapas siguientes consumen sin ramas especiales.

`not_required` es un estado de primera clase y no un `null`: «esta tienda todavía no cobra en línea»
es una decisión del comercio, no la ausencia de un dato.

### Compensaciones: declaradas donde se produce el efecto

No hay un `catch` gigante al final que intente adivinar qué había pasado. Cada etapa que deja rastro
empuja su deshacer a una pila y el fallo la vacía **en orden inverso**, cada una en su propio `try`:
si soltar la reserva falla, anular el cobro tiene que intentarse igual, y ninguna de las dos puede
reemplazar al error original. Lo compensado se escribe en `checkout_intents.error_detail`, no en un
log que nadie mira.

**Creado el pedido, la pila se vacía.** Deshacer un pedido no es «soltar una reserva»: es cancelar
una venta, y eso lo decide una persona desde el backoffice (P08), no un `catch`.

---

## Decisión 3 · El carrito de servidor nace cuando hace falta, no por visita

`carts` + `cart_items`. El invitado **sigue comprando desde `localStorage`**; la fila nace en dos
momentos, y los dos son momentos en los que hace falta de verdad: al iniciar sesión (el carrito tiene
que viajar con la persona) y al empezar el checkout (hace falta un ancla para la reserva y para
marcar el carrito como convertido).

Un carrito de servidor por cada visita sería una tabla de basura con un índice caro y un dato
personal más que custodiar. El carrito vacío de un invitado dura **dos horas**; en cuanto recibe
líneas —o sea, cuando hay intención de compra— pasa a una semana.

- **El dueño es una sesión O un secreto, nunca un id declarado.** `user_id` es el `sub` del JWT y
  solo lo escribe el servidor; `token` son 256 bits (patrón de `order_tokens`). Un carrito CON dueño
  exige la sesión de ese dueño **además** del token: el token viaja en una llamada y podría acabar en
  un registro; la sesión, no.
- **Un carrito es de UNA tienda y de UN canal**, las dos columnas NOT NULL y con FK compuesta.
  Mezclar tiendas ya lo impedía el navegador; mezclar canales no lo impedía nadie, y es peor: el
  canal decide el precio y si hace falta sesión.
- **Ni `anon` ni `authenticated` tienen un solo GRANT de escritura** sobre las dos tablas. Toda
  escritura pasa por funciones que validan contra el catálogo real con los **mismos códigos de error
  que `create_order`**, para que el comprador no descubra en la caja algo que ya se sabía en el
  carrito.
- **El token no sale en el GRANT del backoffice**: `revoke select (columna)` no anula un
  `grant select` de tabla entera (lección de 140000), así que el grant se hace por columna.

### La fusión al iniciar sesión, con sus tres reglas

1. **Solo se absorbe un carrito SIN dueño.** La dirección es única: invitado → usuario.
2. **Misma tienda y mismo canal**, o no se fusiona.
3. **Gana el MÁXIMO de cada línea, no la suma.** Es la decisión incómoda: quien puso 2 unidades en
   el móvil y 2 en el portátil **no pidió 4**. Sumar inventa unidades que nadie eligió y se descubre
   en la caja; el máximo conserva la intención más alta y siempre se puede subir a mano.

Al reconciliar en el navegador, **sin sesión gana lo local** (es donde el invitado ha estado
comprando ahora mismo) y **con sesión gana lo del servidor** (que ya incluye lo local, recién
fusionado, más lo del otro dispositivo).

---

## Decisión 4 · El precio guardado es un snapshot, y el aviso lo produce el servidor

`cart_items.unit_price_snapshot` **no es autoridad de cobro**, y la columna lo dice en su nombre:
llamarla `unit_price` habría sido invitar a que alguien la sumara. Existe para pintar la línea y
para poder DECIR «esto subió».

La alternativa que se descartó era aceptar del cliente una lista de «esto es lo que yo creía que
costaba». Aunque no se cobrara con ella —no se cobraría—, sería **el primer campo con un importe
dentro de la petición de compra**, y el día que alguien añadiera el segundo ya no habría una regla
que citar. `cart_price_drift(slug, token)` compara la cotización vigente contra el snapshot que
escribió el propio motor, así que en el cuerpo del checkout no viaja ni un céntimo — y hay un test
de la vitrina que recorre **las claves del cuerpo entero, a cualquier profundidad**, para comprobarlo.

Sin carrito de servidor no hay comparación posible, y entonces no se inventa una: la lista de
cambios viene vacía.

---

## Decisión 5 · `domain_events`, y por qué NO se reusó `integration_outbox`

Ya había un outbox en este repositorio (migración 150000, framework de integraciones). No se reusó,
y la firma de `public.integration_enqueue` explica por qué sin ambigüedad: **exige un `provider_code`
con la integración ACTIVA en esa sociedad** y que ese proveedor declare la operación.

Es correcto para lo que hace —entregar a un sistema externo concreto— y es exactamente lo que un
evento de dominio no puede aceptar: «se creó el pedido EC-…» tiene que quedar registrado en un tenant
que no ha contratado ni un solo conector. Encolándolo ahí, la primera tienda sin integraciones vería
fallar su checkout con `INTEGRACION_NO_ACTIVA`; o —peor— alguien pondría un `exception when others
then null` alrededor y el evento se perdería en silencio. Hay un test que lo compra explícitamente:
publica con cero filas en `tenant_integrations`.

Son dos colas con dos destinatarios: `integration_outbox` entrega **a un sistema**; `domain_events`
publica **un hecho**. Un consumidor del hecho puede ser después un `integration_enqueue` —y ese es el
puente natural con P14—, un correo, o nada en absoluto.

La mecánica es la ya probada de 150100: `for update skip locked` para que dos trabajadores no
entreguen el mismo hecho, backoff exponencial con jitter, cola muerta al agotar intentos y rescate
de huérfanos (un worker que muere deja el hecho `in_flight` para siempre, y el aviso no sale nunca
sin que nadie se entere). `dedupe_key` se deriva de la clave de idempotencia: un reintento no publica
el hecho dos veces.

---

## Decisión 6 · Una transacción que hace cuatro cosas, y ninguna llamada externa dentro

`checkout_place_order` hace, en una sola transacción de Postgres:

```
pedido creado + intento marcado como exitoso + carrito convertido + hechos publicados
```

Si cualquiera falla, no ocurre ninguna. Esa es toda la razón de que exista esta función en vez de
cuatro llamadas seguidas desde el orquestador: entre dos llamadas cabe un despliegue, un timeout y un
proceso muerto, y el estado que dejan —«pedido creado, nadie enterado»— es el que este proyecto no
puede tener.

Y vuelve a comprobar el estado del intento con **la fila bloqueada**, aunque `checkout_begin` ya haya
filtrado el reintento. Es la última línea, la misma idea que el CHECK de sobreventa de P06: la
corrección no depende de que el llamante se acuerde.

El rastro del cobro se recompone clave a clave (`status`, `provider_reference`, `provider_code`):
lo que no está en la lista no entra, y por eso un número de tarjeta no puede colarse al outbox
aunque alguien lo mande. Hay un test que lo intenta.

---

## Decisión 7 · Dos clientes en la Edge Function, y no es un descuido

`service_role` para lo que el comprador anónimo no puede hacer por su cuenta (reclamar el intento,
reservar, crear el pedido) y **el cliente del llamante** —clave publicable + su `Authorization`— para
la única pregunta que depende de su sesión: de qué cuenta B2B es miembro.

Con `service_role` esa pregunta no tendría respuesta posible: `my_business_accounts()` **no acepta
argumentos** desde P05, precisamente para que la cuenta salga de la sesión y no de un id. Es el mismo
patrón que `catalog-product` usa desde P02: «decide la RLS, no la función».

Y si el portal B2B no contesta, la compra sigue como si no hubiera cuenta: un fallo del módulo
vendible no puede impedir una compra normal.

---

## Decisión 8 · El límite de gasto se comprueba en la etapa 8, no en la 2

«¿Puede esta persona comprometer este importe?» es una **autorización de compra** y necesita el
total, que no existe hasta después de precios e impuestos. Ponerla en `validate_account` habría
obligado a partir la etapa en dos o a arrastrar el importe hacia atrás.

La etapa 2 hace lo que sí puede hacer sin total: resolver la cuenta y rechazar un canal que exige
sesión cuando no la hay — con `CANAL_EXIGE_SESION`, que dice qué hacer (entrar), en vez del
`CANAL_NO_PUBLICO` de la base, que solo dice que no se puede.

---

## Lo que NO se hizo, y el disparador de cada cosa

- **No hay pasarela de pago.** El pedido sigue naciendo en `pending`. Lo que cambia es que esa
  decisión ahora tiene un nombre (`not_required`) y un puerto. Disparador: P09.
- **No hay motor de promociones.** La etapa 4 devuelve cero y `calculate_taxes` **se para** si
  alguna vez devolviera otra cosa sin que el impuesto sepa recalcular la base. Disparador: P10.
- **No hay reglas de entrega.** La etapa 7 acepta cualquier dirección con el formato de P06.
  Disparador: P12.
- **El carrito de la vitrina no vende por presentación (UoM).** No hay selector y ninguna línea sale
  del navegador con `uom_code`; el modelo del servidor sí la admite porque comparte la terna con
  `create_order`. `applyServerLines` es donde se añade el día que la vitrina venda cajas.
- **`create-order` no se retira.** Sigue desplegada, sigue funcionando y sus tests siguen pasando:
  es la puerta de P02–P06 y ningún cliente antiguo se rompe. Lo que usa la vitrina desde P07 es
  `checkout`. Retirarla es trabajo de una fase que pueda comprobar que nadie la llama.
- **No hay pantalla de carritos abandonados en el backoffice.** La tabla ya se lee con RLS y con el
  token fuera del grant; la recuperación de venta es contenido de marketing (P11) y no de esta fase.
- **No hay consumidor del outbox desplegado.** `claim_domain_events` / `complete_domain_event` /
  `fail_domain_event` están escritas y probadas; el trabajador que las llame es del framework de
  integraciones (P14) o de notificaciones. Hasta entonces los hechos se acumulan `pending`, que es
  el estado correcto: existen y esperan.
