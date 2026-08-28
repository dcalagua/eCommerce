# ADR 008 — OMS: cuatro ejes de estado, snapshots inmutables y comandos de transición

- **Fase**: P08-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 003](003-pim-variantes-uom-kits.md) (variantes, unidades y kits),
  [ADR 004](004-pricing-engine.md) (la única autoridad de precio), [ADR 005](005-customers-b2b.md)
  (el vínculo servidor de la cuenta B2B y `purchase_approval`),
  [ADR 006](006-inventory-atp-reservations.md) (reserva idempotente con secreto),
  [ADR 007](007-cart-checkout-pipeline.md) (el pipeline, el outbox de dominio y la transacción que
  cierra la compra).

---

## El criterio de aceptación, y por qué el modelo anterior no lo cumplía

> PASS si el historial de un pedido sigue siendo correcto aunque cambien producto, precio, impuestos
> o configuración después de comprar.

`order_items` era un snapshot **parcial** desde P02: guardaba `sku`, `name` y `unit_price`, y desde
P03 la unidad de venta. Con eso, un pedido sobrevive a que suba el precio. No sobrevive a lo demás:

- **el impuesto no estaba en la línea.** Solo el `tax_total` agregado del pedido. Cambiar la tasa de
  una categoría —o reasignar el producto a otra— dejaba el pedido cuadrando en el total y sin forma
  de reconstruir su desglose. Una factura que no se puede rehacer desde el pedido es una factura que
  depende de la configuración de hoy.
- **`tax_inclusive` vivía en `store_settings`.** Un tenant que cambia de régimen recalcula al revés
  el desglose de todos sus pedidos anteriores.
- **la variante estaba dentro del texto** `«Producto · Talla M»`: se lee, no se consulta, y
  desaparece del análisis en cuanto se borra la variante.
- **la receta del kit no estaba en ninguna parte.** Un `kind = 'bundle'` no tiene existencia propia;
  cambiar la receta borra el registro de qué se despachó.
- **la dirección era editable** y no había copia de lo que escribió el comprador.
- **el cliente era un correo suelto.** Sin razón social ni documento fiscal congelados.

Y encima de eso, un problema de modelo que no es de historial sino de presente: **`order_status`
mezclaba tres preguntas** —¿llegó el dinero?, ¿salió la mercancía?, ¿en qué punto comercial está?—.
Mientras la tienda cobraba contra entrega, se sostenía. Deja de sostenerse con un pedido pagado y no
despachado, uno despachado a crédito o uno reembolsado en parte: tres estados normales del comercio
real que no se pueden escribir con una sola palabra.

---

## Decisión 1 · Cuatro ejes, y `status` conserva su significado

`orders` gana `payment_status`, `fulfillment_status` y `approval_status`. `status` **no se renombra
ni cambia de semántica**: sigue siendo el ciclo comercial, sigue teniendo su trigger, su policy, su
GRANT por columna y su Edge Function.

La alternativa —ampliar el enum con `paid_unfulfilled`, `fulfilled_unpaid`, …— multiplica el producto
cartesiano de los tres ejes y convierte la máquina de estados en una tabla de veinte entradas que
nadie mantiene. Separar los ejes es lo mismo que hizo P05 al negarse a poner `user_id` en
`customers`: cuando una columna tiene que expresar dos cosas, el arreglo es la segunda columna.

**La compatibilidad la garantiza un trigger, no la disciplina.** `ebim.sync_order_axes` se dispara
antes que la máquina de los ejes nuevos —el orden de los triggers BEFORE es alfabético y
`orders_axes_sync` < `orders_axes_transition`— y adelanta los ejes que la sentencia no tocó cuando
`status` se mueve por el camino de siempre. Así el estado «marcado `paid` con `payment_status`
diciendo `pending`» no es improbable: es imposible. Y como la deducción sigue pasando por la máquina
de los ejes, no es una puerta trasera.

Dos reglas del sincronizador que son decisiones de negocio y no detalles:

- **cancelar un pedido ya cobrado no anula el cobro.** Deja el dinero donde está y espera una
  devolución, que es una decisión aparte y de otra persona.
- **las marcas de tiempo se estampan una vez.** `paid_at` es cuándo se cobró, no cuándo se tocó la
  fila.

### Los ejes nuevos no tienen GRANT de escritura

El GRANT por columna de P02 (`status, notes, customer_name, customer_phone, shipping_address`) **no
se amplía**. `authenticated` lee las columnas nuevas y no escribe ninguna. La única puerta es
`public.order_transition`. No es que se recomiende usar el comando: es que no hay otra. Un test
enumera las columnas con `UPDATE` para `authenticated` y falla si aparece una cuarta.

---

## Decisión 2 · El comando reúne cuatro cosas que no se pueden separar

`public.order_transition(order_id, axis, to, reason)` hace, en una sola operación atómica:

```
autorización  +  máquina de estados  +  línea de tiempo  +  hecho de dominio
```

Un `UPDATE` bajo RLS deja pasar todo lo que el trigger no prohíba explícitamente y —lo importante—
deja que el motivo, el evento y la publicación dependan de que el llamante se acuerde. El día que
alguien escriba un `UPDATE` a mano, el pedido cambia de estado sin que nadie se entere.

**Ni un `organization_id` en la firma.** El tenant sale de la fila del pedido, que lo tiene amarrado
por FK compuesta contra `stores`. No hay forma de pedir una transición sobre un pedido ajeno: el rol
se comprueba sobre el tenant de *ese* pedido, no sobre el que declare quien llama. Y el guard del
super admin de suite vive **aquí y no solo en el borde**, porque un guard que solo está en la Edge
Function se salta llamando a la función por PostgREST.

### El motivo viaja por un ajuste local de transacción

`set_config('ebim.order_event_reason', …, true)` justo antes del UPDATE; lo lee el trigger de la
línea de tiempo y se olvida al terminar la transacción. La alternativa —que el comando inserte su
propio evento— reabre el hueco: un UPDATE por otro camino dejaría el pedido movido y la bitácora
muda. Con el trigger como escritor único, **no existe un cambio de estado sin evento**.

`orders.status` conserva su UPDATE directo porque hay código vivo que depende de él (la Edge
Function `update-order-status`, sus tests, la policy). Ese camino sigue pasando por sus dos triggers
y por la línea de tiempo, así que no es un agujero: es la misma garantía por otra puerta. Lo que el
comando añade sobre ese eje es el motivo y el hecho de dominio, y por eso la pantalla nueva lo usa
también para él.

---

## Decisión 3 · Una línea de tiempo, cuatro ejes, un solo relato

`order_events` reemplaza a `order_status_events` **como fuente de la pantalla**, y no la retira:
aquella sigue viva, sigue escribiéndose por su trigger y sigue siendo lo que leen las consultas
existentes. La migración `20260828110200` **trae su historial** a la tabla nueva, para que un pedido
anterior a esta fase no aparezca sin memoria — que es la clase de mentira que hace desconfiar de una
bitácora entera.

Propiedades, las mismas tres de toda bitácora de este repositorio (regla de `CLAUDE.md`, lección
`esupplier-030`):

1. **un solo escritor**, un trigger `SECURITY DEFINER`, sin GRANT de INSERT/UPDATE/DELETE para
   `anon` ni `authenticated`;
2. **el actor sale del JWT**, nunca de un parámetro: sin JWT el actor es NULL y la fuente es
   `storefront`, que es la verdad;
3. **se escribe en la misma transacción** que el cambio.

Emite **una fila por eje movido**: aprobar y cobrar en la misma transacción son dos hechos, no uno.

---

## Decisión 4 · Aprobación B2B sin contaminar B2C

`approval_status` nace `not_required` en todo pedido, y ese valor es **terminal**: un pedido B2C no
se puede meter a posteriori en un circuito de aprobación, porque no hay quien lo apruebe y porque
permitirlo convertiría un estado terminal en una puerta trasera para congelar cualquier pedido.

Lo que hace útil el estado es que **frena**: `ebim.assert_order_axes` rechaza mover cualquier eje
mientras la aprobación esté pendiente, salvo cancelar. Sin eso, `approval_status` sería una etiqueta
decorativa que la operación ignora.

### Dónde se decide qué, y por qué está repartido

| Pregunta | Quién responde | Por qué ahí |
|---|---|---|
| ¿la cuenta exige firma desde X importe? | `create_order`, con la fila delante | no depende de que ningún llamante se acuerde |
| ¿la persona pasó su límite? | el borde, con el JWT del comprador | `service_role` no tiene sesión de la que sacarlo |
| ¿quién puede firmar? | `order_approval_decide`, sobre `ebim.user_id()` | el vínculo lo resuelve el servidor (regla de P05) |

`p_approval` —lo que el borde averiguó— **solo puede AÑADIR una aprobación, nunca quitarla**. Un
payload manipulado no convierte una compra que necesita firma en una que no.

**El aprobador no es miembro del tenant.** `can_access` es falso para él y PostgREST no le devuelve
ni una fila de `orders`. Por eso existe `public.my_business_orders()`, **sin parámetro de cuenta**,
exactamente igual que `my_business_accounts()` en P05: no hay id que el navegador pueda declarar. Su
proyección es segura — ni uuids de tenant, ni notas internas, ni etiquetas, ni el token del
comprador—: quien firma necesita saber qué se compró y cuánto cuesta, no la operativa del comercio.

**Rechazar cancela el pedido**, y exige motivo. Dejarlo «rechazado y vivo» crearía un pedido que
nadie va a servir y que sigue contando en los indicadores.

> **Deuda declarada, con dueño.** Cancelar **no** devuelve la existencia al almacén. Es el
> comportamiento que `status = 'cancelled'` ya tenía desde P02 y cambiarlo aquí sería decidir de
> pasada la política de devoluciones. Es trabajo de **P12** (fulfillment y devoluciones).

> **Decisión conservada, no revisada.** El límite personal (`spending_limit`) sigue siendo un tope
> DURO en el pipeline (`LIMITE_DE_AUTORIZACION`, P07) y no una ruta hacia la aprobación. Convertirlo
> en «pedido pendiente de firma» es defendible y cambia una garantía ya probada; se deja escrito
> aquí para que la próxima fase que toque pagos lo decida a propósito y no de refilón.

---

## Decisión 5 · El impuesto se reparte por línea con resto mayor

`tax_total` se redondea **por grupo de tasa** desde P02 —es la única forma de que la cotización y el
pedido den el mismo céntimo—. Guardar en cada línea `round(importe × tasa, 2)` daría una suma que
puede diferir del total en unos céntimos: la factura no cuadraría consigo misma y nadie sabría cuál
de los dos números es el bueno.

Lo que hace `create_order` es repartir el total del GRUPO entre sus líneas en proporción al importe y
dar el residuo del redondeo a la línea más grande del grupo. **La suma de las líneas es exactamente
el `tax_total` del pedido por construcción**, y hay un test que lo compra con tres importes que no se
dividen bien.

`amount_after_discount` es una columna GENERATED, y **no se llama `net_amount` a propósito**: en el
vocabulario del motor de precios (P04) «neto» significa «sin impuesto», y con `tax_inclusive` las dos
lecturas dan números distintos. La base imponible queda escrita en el `comment on column` y no en un
nombre que cada lector interpretaría a su manera.

---

## Decisión 6 · La inmutabilidad es un trigger, no un comentario

`order_items` nunca tuvo GRANT de escritura para `authenticated`, así que desde el navegador ya era
imposible. Lo que añaden `ebim.assert_order_item_immutable` y
`ebim.assert_order_snapshot_immutable` es la **segunda línea**: la que también detiene a
`service_role`, que sí tiene GRANT y no pasa por ninguna policy. El snapshot es el fundamento del
criterio de aceptación y no puede depender de que ninguna Edge Function futura se acuerde. Es la
misma idea que el CHECK de sobreventa de P06.

La excepción son las FK con `on delete set null`: borrar el producto, la variante o la lista **anula
el enlace y conserva el snapshot**. Ese UPDATE lo hace Postgres, no una aplicación, y es justo lo que
se quiere.

`shipping_address` **sigue siendo editable** —corregir un portal equivocado antes de despachar es una
necesidad real— y su original vive en `shipping_address_snapshot`, que no tiene GRANT para nadie. Las
dos cosas a la vez, en vez de elegir una.

---

## Decisión 7 · `source_channel` no es `channel_id`

`channels` (P10 histórico) es el canal **comercial**: decide precio, catálogo y si exige sesión.
`source_channel` es el **origen técnico**: por qué puerta entró la petición. Un mismo canal comercial
recibe pedidos de la vitrina, de una importación masiva y de una repetición programada, y cuando algo
sale mal la pregunta operativa siempre es «¿de dónde salió esto?». Lo pone la función de borde que
atiende cada puerta; nunca el navegador.

---

## Decisión 8 · Tres tablas de anotación, ninguna «por si acaso»

- **`order_notes`** — `orders.notes` la escribe `create_order` con lo que puso el COMPRADOR («dejar
  con el portero») y la reescribía el backoffice al cambiar de estado. Son dos cosas compartiendo una
  columna: cada anotación del equipo borraba la instrucción de entrega del cliente. Y nace como HILO,
  porque una sola columna obliga a que el segundo que anota borre al primero.
- **`order_tags`** — triage, no taxonomía. Etiquetas planas sin catálogo previo: un tag que hay que
  dar de alta antes de usarlo no se usa el día que hace falta. Normalizadas a minúsculas **por CHECK
  y por trigger**, no «por convención en la app».
- **`order_external_refs`** — copia exacta del patrón de `customer_external_ids` (P05): **el
  identificador externo es atributo, nunca clave**. Por eso no hay una columna `erp_order_id` en
  `orders`: la primera integración la llenaría y la segunda tendría que inventarse otra. `ref_type`
  es TEXTO y no un enum porque la lista no se puede cerrar —factura, guía, cobro, picking, nota de
  crédito— sin obligar a una migración por cada sistema nuevo.

**El tenant y el autor se derivan de la fila del pedido y del JWT** (`ebim.stamp_order_annotation`).
Aunque alguien mande los tres uuids en el cuerpo, se sobreescriben antes de tocar disco, y la policy
`with check` evalúa sobre los valores ya estampados.

Ninguna de las tres tiene un solo GRANT para `anon`, y `order_by_token` no las lee ni debe leerlas:
«cliente moroso» y «revisar por fraude» son anotaciones del comercio, no del comprador.

---

## Decisión 9 · Programados, repetición e importación: la capacidad sí, las tablas no

El encargo pide «preparar» las tres «sin implementar todo si excede el alcance». Hay precedente
explícito de qué significa preparar en este repositorio: P06 declaró que `warehouse_locations` y
`reservation_events` **no se creaban** y dejó escrito el disparador de cada una.

Crear hoy `order_schedules` y `order_batches` vacías sería peor que no crearlas: dos tablas con RLS,
índices y tests que nadie escribe ni lee, y que el día que exista el caso de uso real habría que
rehacer porque se diseñaron sin él.

Lo que **sí** queda puesto, porque cuesta poco y sin ello habría que migrar datos después:

| Seam | Dónde está ya | Disparador para construir lo demás |
|---|---|---|
| origen del pedido | los tres valores en el enum `order_source_channel` | el primer pedido que no venga de la vitrina |
| lote de importación | `order_external_refs` con `ref_type = 'import_batch'` | cuando el lote tenga estado y errores por fila |
| idempotencia de la carga | `checkout_intents` (P07): mil pedidos son mil claves | ninguno: ya sirve |
| repetición | las líneas del pedido son un snapshot con la forma que acepta `cart_replace_lines` | falta la pantalla, no la tabla |

Y nace la **capacidad** `orders.advanced` (`declared`, entitlement `ecommerce.orders.advanced`): una
capacidad que aparece el mismo día que su código obliga a desplegar las dos cosas a la vez;
declararla antes deja que el operador dé de alta el addon en el hub cuando quiera. `orders` sigue
siendo **baseline**: cobrar aparte por «la versión del pedido que no miente» no sería vender un
módulo.

---

## Decisión 10 · El listado pagina en el servidor y la exportación es un permiso

`range()` + `count: 'exact'`, con orden TOTAL (`placed_at desc, id desc`): sin el desempate, dos
pedidos del mismo instante se reparten mal entre páginas y el operador ve uno dos veces y otro
ninguna. Traerse todo y cortar en el navegador es una consulta que crece con el negocio del cliente
hasta que un día no vuelve — y hasta ese día no da ninguna señal.

Desde que hay paginación, **exportar «lo que se ve» exportaría 25 filas** y nadie lo notaría hasta
abrir el archivo. La exportación repite la consulta con los mismos filtros, sin `range` y con tope.

Y nace el permiso **`orders.export`** (`owner`/`admin`/`orders`, no `viewer`). Exportar no es «ver el
listado en un archivo»: es una extracción masiva de correos, teléfonos, direcciones y documentos
fiscales de todos los compradores del tenant. El tenant lo sigue poniendo la RLS —la consulta no
lleva `organization_id`—; el permiso decide quién puede llevárselo entero.

---

## Alternativas descartadas

- **Renombrar `order_status` a un vocabulario más «moderno»** (`confirmed`/`preparing`/`ready`).
  Tocaría la mitad del esquema, el trigger, las policies, `create_order`, la Edge Function y los
  tests de aislamiento para no ganar nada. Mismo criterio que las decisiones 14 (`tenant_id`) y 31
  (`stock_qty`).
- **Una tabla `order_status_history` genérica con `column_name`/`old`/`new`.** Un diseño que se
  aplica a cualquier tabla no sabe nada de ninguna: no puede tener el CHECK que exige un destino, ni
  el enum de ejes, ni distinguir «se corrigió la dirección» de «se cobró».
- **Quitar `order_status_events`.** Está viva, la leen consultas existentes y retirarla no aporta
  nada. Su historial se copia; su tabla se queda.
- **Poner el `customer_id` en `orders`.** Sigue siendo lo que P05 decidió que no: en una compra
  anónima esa columna solo la podría rellenar el navegador. El snapshot lleva los datos del cliente
  sin abrir esa puerta, porque es una foto y no una referencia viva.
- **Un enum cerrado para `ref_type`.** Obligaría a una migración cada vez que un cliente conecta un
  sistema nuevo. `system_code` sí lo tiene con formato cerrado, porque identifica al sistema, que es
  un conjunto que esta app conoce.
- **`SectionTabs` dentro del panel de detalle.** Ese componente escribe el `#hash` de la URL para que
  la pestaña sea compartible, y un panel lateral no es una ruta: el hash se quedaría pegado al
  cerrar el panel.

---

## Lo que esta fase NO hizo, y quién lo tiene

| Pendiente | Dueño |
|---|---|
| Devolver la existencia al cancelar o rechazar | P12 (fulfillment y devoluciones) |
| Motor de descuentos que llene `discount_snapshot` y recalcule la base imponible | P10 |
| Estados de pago movidos por la pasarela y no a mano | P09 |
| Pantalla del portal B2B sobre `my_business_orders()` | P11/P16, cuando el portal tenga su propia área |
| Tablas de programación y de lotes de importación | cuando exista el primer caso real (§9) |
