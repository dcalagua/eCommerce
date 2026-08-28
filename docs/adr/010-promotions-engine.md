# ADR 010 — Promociones: motor determinista, stacking explícito y cupones con control transaccional

- **Fase**: P10-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 001](001-domain-boundaries.md) (frontera `promotions`, declarada desde
  P01), [ADR 002](002-capabilities-entitlements.md) (la capacidad `promotions` y su entitlement),
  [ADR 004](004-pricing-engine.md) (el motor de precios, que aquí **no se toca**),
  [ADR 007](007-cart-checkout-pipeline.md) (la etapa 4 del pipeline, reservada vacía para esta fase),
  [ADR 008](008-oms-order-axes-snapshots.md) (`order_items.discount_amount` y `discount_snapshot`,
  que nacieron para esto).

---

## El criterio de aceptación, leído literalmente

> PASS si un comercio puede crear campañas comunes sin deploy y el resultado es determinístico,
> server-side y auditable.

Las cuatro mitades, y dónde se comprueba cada una:

| Exigencia | Cómo se cumple | Dónde se prueba |
|---|---|---|
| **sin deploy** | las nueve capacidades del encargo son **datos**: filas de `promotions`, `promotion_scopes`, `promotion_audiences`, `promotion_tiers` y `coupons`. Ninguna campaña común exige tocar SQL | `promotions.test.ts` monta las cinco clases de campaña desde cero |
| **determinístico** | orden TOTAL de evaluación (`priority desc, created_at, id`) y reglas de combinación explícitas | «el orden lo manda la PRIORIDAD y el resultado es reproducible» |
| **server-side** | el navegador solo manda **códigos de cupón**; ni un importe, ni una campaña, ni un «ya aplicada» | 8 tests, uno por clave prohibida, en `promotions-checkout.test.ts` |
| **auditable** | `promotion_events` (bitácora con el estado que la campaña tenía) + `promotion_redemptions` (quién usó qué y cuánto) + `discount_snapshot` por línea | «cada cambio sobre una campaña viva queda anotado con su estado y su actor» |

---

## Decisión 1 · Precio y promoción son DOS capas, y el orden es una regla

    precio base  →  promociones  →  impuesto  →  total

`ebim.evaluate_promotions` recibe **líneas ya cotizadas** por `ebim.resolve_prices` y les resta. No
lee `price_lists`, no conoce la precedencia de acuerdos y no puede cambiar un precio unitario.

La alternativa —un solo motor que resuelva precio y descuento a la vez— es más rápida de escribir y
deja de ser explicable el día que un importe sale mal, que es exactamente el día en que hay que
explicarlo. Y tiene una consecuencia peor: si el descuento se aplicara **antes** de resolver la
lista, un mismo cupón valdría distinto según el acuerdo comercial del comprador sin que nadie lo
hubiera decidido.

P04 dejó esa frontera escrita en la cabecera de su migración. Esta fase la respeta: **ni una línea de
las cinco tablas de precios cambia**.

---

## Decisión 2 · El alcance va en columnas TIPADAS, no en un mini-DSL

Se diseñó una columna `rules jsonb` con un lenguaje de condiciones y se descartó por tres razones,
en orden de gravedad:

1. **Sin FK, una regla sobrevive a lo que apunta.** Una condición «categoría = X» sobre una categoría
   borrada se queda viva decidiendo dinero. Con `promotion_scopes.category_id` y su FK compuesta
   tenant-safe, borrar la categoría se lleva la regla.
2. **No se puede indexar ni explicar.** Un árbol de condiciones libre obliga a evaluar todas las
   campañas contra todas las líneas, y a que la pantalla renderice un editor de árboles.
3. **El aislamiento deja de ser estructural.** Un uuid dentro de un JSON no lo comprueba nadie.

El coste es real y está asumido: **añadir un tipo de campaña es escribir código**, una rama en
`ebim.evaluate_promotions`. El enum `promotion_kind` tiene cinco valores y no veinte precisamente por
eso: un enum con veinte etiquetas de las que solo cinco se calculan es una promesa que la pantalla
hace y el motor no cumple.

Las cuatro reglas de forma que el modelo hace **imposibles** —y no «desaconsejadas»—:

| Estado imposible | Cómo |
|---|---|
| campaña de porcentaje sin porcentaje | `promotions_kind_shape`, un CHECK por tipo |
| un 3x2 que regala tanto como cobra | `promotions_free_below_buy` |
| una escala colgada de una campaña que no es de volumen | FK compuesta contra `promotions (id, kind)` |
| un combo cuyo componente no dice cuántas unidades | `promotion_scopes_bundle_shape`, sobre la misma FK |

Es la técnica del PIM (ADR 003): columna denormalizada + CHECK + FK a una clave de apoyo del padre
con `on update cascade`. Es lo que permite que un CHECK mire otra tabla sin un trigger que alguien
puede desactivar.

---

## Decisión 3 · Las reglas de combinación son explícitas y se recorren en un orden total

El encargo lo pide por su nombre (regla 4: «no depende del orden accidental de consultas»). El
recorrido es `priority desc, created_at, id` —los tres, porque los dos primeros empatan— y en cada
candidata se decide en este orden:

1. si ya se aplicó una **exclusiva** → ninguna más entra;
2. si esta es exclusiva y ya se aplicó algo → no entra;
3. si su **`stack_group`** ya lo ganó otra → no entra;
4. si no, se aplica **sobre lo que QUEDA** de cada línea.

Los dos ejes de combinación son distintos y hacían falta los dos: `is_exclusive` es «esta va sola» y
`stack_group` es «de este grupo solo gana una». Con solo el primero no se puede expresar «dos rebajas
de temporada no se suman, pero una rebaja y un cupón de bienvenida sí», que es la política más común
que existe.

Que cada campaña se aplique sobre el **remanente** es lo que impide que dos del 60 % sumen 120 % y
dejen el pedido en negativo. No hace falta un CHECK para eso: el modelo no puede expresarlo.

---

## Decisión 4 · Los límites de uso se cuentan con la fila BLOQUEADA

`promotions.usage_count` es una columna y no un `count(*)` sobre `promotion_redemptions`. La razón es
que un `count(*)` no se puede bloquear, y dos compras simultáneas gastarían el mismo último uso.

El circuito completo:

1. `ebim.evaluate_promotions(..., p_lock := true)` toma `select … for update` sobre **solo** las
   campañas y cupones que tienen tope —una campaña sin límite no necesita cerrojo, y bloquearla
   serializaría todos los checkouts de la tienda sin proteger nada—, en orden de `id` ascendente para
   que dos transacciones no se abracen;
2. evalúa con los contadores ya bloqueados;
3. `create_order` escribe el pedido;
4. `ebim.redeem_promotions` apunta el canje y sube el contador, **en la misma transacción**.

Entre contar y gastar no cabe otra compra. Eso es lo que hace que «máximo 100 usos» sean 100 y no
101.

El canje es además idempotente por `(order_id, promotion_id)`: un reintento del alta no cuenta dos
usos del mismo cupón para la misma compra.

---

## Decisión 5 · La normalización del cupón es un DATO, no una convención

`coupons.code_normalized` es una **columna GENERADA** (`upper(regexp_replace(code, '[^A-Za-z0-9]',
'', 'g'))`) y el índice único está sobre ella.

Si la normalización viviera en el código que consulta habría tres sitios donde acordarse —la vitrina,
el backoffice y la importación— y el día que uno se olvide, el cupón «no existe» para ese comprador y
sí para el de al lado. Con la columna generada, «Verano 25» y «verano-25» son el **mismo** cupón y
dar de alta el segundo falla con una clave duplicada.

`ebim.normalize_promo_code` existe para poder **buscar** por esa columna; es `IMMUTABLE` por la misma
razón que la columna lo es, porque si no el índice no serviría y cada cupón tecleado costaría un
recorrido de tabla.

El código de un cupón **no es un secreto**: se imprime en un folleto. Lo que protege de que alguien lo
adivine no es esconderlo, son los límites de uso.

---

## Decisión 6 · Una sola autoridad fiscal, y la identidad que hace cuadrar el pedido

Hasta P09 el reparto del impuesto por grupo de tasa estaba escrito **dos veces** (en
`ebim.build_quote` y en `create_order`). Con descuentos aparece una pregunta nueva —¿sobre qué base se
calcula el impuesto?— y mantener dos copias de la respuesta habría garantizado que un día discrepen.

`ebim.promotion_totals` es esa única copia. Y la respuesta a la pregunta nueva es la única
defendible: **sobre lo que se paga**. Cobrar impuesto sobre un importe que el comprador no paga es
cobrar de más.

`orders_total_consistent` (P02) exige `grand_total = subtotal + tax_total + shipping_total −
discount_total`. No se esquiva: se construye.

- **Impuesto excluido**: `subtotal` = bruto, `discount_total` = descuento bruto, impuesto sobre
  `bruto − descuento`. La identidad da `pagadero + impuesto`. ✔
- **Impuesto incluido**: `discount_total` es la parte **no fiscal** del descuento —rebajar 118 con un
  IVA del 18 % rebaja 100 de base y 18 de impuesto—, y `subtotal` es el bruto menos el impuesto de lo
  pagadero menos el impuesto del descuento. La identidad da `pagadero`. ✔

Con descuento cero las dos ramas devuelven **exactamente** los mismos números que P09 devolvía. Es lo
que permite que ningún test de P02 a P09 cambie una línea, y hay un test que compara
`price_quote_for_slug` con `promotion_quote_for_slug` sobre el mismo carrito.

El impuesto por línea se reparte por resto mayor **en proporción a lo pagadero**, no al bruto:
repartir por el bruto daría más impuesto a una línea con descuento que a una sin él, para el mismo
importe cobrado.

Y el pipeline **comprueba la identidad antes de cobrar** (`TOTALES_INCOHERENTES`, 500). Es el último
punto entre el cálculo y la pasarela donde un descuadre se puede parar; pararlo cuesta un error,
no pararlo cuesta un cargo mal hecho.

---

## Decisión 7 · La respuesta trae lo que NO se aplicó, y por qué

Casi ningún motor devuelve esa mitad, y es la que resuelve el ticket de soporte de verdad: «¿por qué
mi cupón no hace nada?». Cada campaña descartada sale con un motivo estable
(`fuera_de_publico`, `minimo_no_alcanzado`, `limite_por_cliente_agotado`, `exclusiva_previa`,
`no_combina`, `grupo_excluyente`, `sin_alcance`, `sin_efecto`, `combo_incompleto`, `sin_identidad`).

Con **una excepción deliberada**: una campaña que exige cupón y no lo trae **no se reporta**.
Enumerarlas convertiría la respuesta pública del carrito en el folleto de todas las campañas secretas
de la tienda.

---

## Decisión 8 · La tarjeta regalo NO es una promoción

Una promoción cambia el **precio**: baja la base imponible, baja el impuesto y baja el ingreso. Una
tarjeta regalo no cambia el precio de nada: es un **medio de pago** con saldo, como pagar la mitad en
efectivo.

Tratarla como descuento —el atajo habitual— falsea tres cosas a la vez: el ingreso (la venta sí se
produjo por su importe completo), el impuesto (que se devengó entero) y la deuda (el saldo emitido es
un pasivo del comercio hasta que se gasta).

De ahí sale todo el diseño del submódulo:

- no toca `orders.discount_total` ni `order_items.discount_amount`;
- el canje se apunta contra el **pedido**, no contra la línea;
- vive en la etapa **8a** del pipeline, junto al cobro y antes de la pasarela: lo que se le pide a la
  pasarela es el **resto**. Al revés —cobrar el total y devolver la diferencia— sería un movimiento de
  dinero de más y una comisión de más en cada compra;
- y como deja rastro **fuera** de la transacción del pedido, tiene compensación, igual que la reserva
  de existencia y que el cobro. Saldo gastado sin pedido detrás es el único de los tres efectos que
  el comprador **no puede reclamar por su cuenta**: una reserva caduca sola y un cobro se ve en el
  extracto, pero un saldo perdido no deja rastro que el comprador pueda enseñar.

El código es un **instrumento al portador**: 96 bits, sin GRANT de lectura para nadie —ni para
`owner`—, y sale de la base **una sola vez**, en la respuesta de `gift_card_issue`. Después solo hay
`code_last4`. Si se pierde, se anula y se emite otra, que es lo que hace cualquier emisor serio.

El saldo **no se escribe, se mueve**: ni un GRANT de escritura, y `ebim.gift_card_move` bloquea la
fila, comprueba y escribe el asiento y el saldo en la misma sentencia. Es la decisión de P06 con la
existencia y la de P09 con el dinero.

La caducidad se comprueba **al mover** y no por un proceso periódico: este proyecto no tiene cron
garantizado, y una tarjeta que caducó ayer no puede pagar hoy porque nadie pasó a marcarla.
`public.expire_gift_cards` existe, pero es contabilidad —pasar el saldo caducado de pasivo a
ingreso—, no la garantía.

---

## Lo que NO se hizo, y el disparador de cada cosa

- **Envío gratis como tipo de campaña.** No hay motor de coste de envío hasta P12: una promoción que
  descuenta un importe que nadie calcula todavía sería una casilla que no hace nada. El enum
  `promotion_kind` crece el día que exista el sumando.
- **Reglas por «usuario».** La identidad la emite el hub y un descuento por `sub` sería un `if` por
  persona dentro del core, que es lo que el principio 2 del contrato prohíbe. El eje comercial es el
  **segmento**; el caso individual es el **cliente** o la **cuenta B2B**, que son filas de negocio.
- **`promotions.gift_cards` como capacidad vendible aparte.** El catálogo comercial es del hub
  (contrato §6): esta app no puede inventar un SKU que el hub no conoce. Si el operador decide
  venderlas por separado, lo que cambia es una fila de `app_capabilities` y el `has_capability` de
  tres comandos — ni una línea de motor.
- **Cupón «cheapest unit free» en un 3x2 que cruza líneas.** El 3x2 se calcula **por línea**: si se
  mezclaran líneas de precios distintos habría que elegir cuál sale gratis, y esa elección no la puede
  tomar el motor sin que el comercio la haya escrito. Cuando haga falta, es un `promotion_kind` nuevo
  con su regla explícita, no un cambio silencioso del que ya existe.
- **Un selector de producto con buscador en el editor de alcance.** Hoy se pega el identificador. El
  disparador es el mismo que en las demás pantallas: un componente de búsqueda de catálogo reutilizable
  que todavía no existe, y hacerlo aquí crearía el cuarto buscador de producto del repositorio.

---

## Consecuencias

**Buenas.** El comercio monta las nueve clases de campaña del encargo sin tocar código. Cualquier
importe se puede explicar hacia atrás —qué campaña, cuánto, sobre qué línea y con qué cupón— incluso
después de borrar la campaña. Los límites de uso son ciertos bajo concurrencia. Y el tenant que no
contrata el módulo sigue vendiendo exactamente igual que antes de esta fase.

**Costes asumidos.** Añadir un tipo de campaña es escribir SQL, no configurar. El editor de alcance
pide identificadores en vez de ofrecer un buscador. Y `evaluate_promotions` es una función larga: el
precio de que todo el reparto de céntimos ocurra en un solo sitio.

**Lo que queda amarrado para después.** P12 (fulfillment) trae el coste de envío y con él el tipo de
campaña que falta. El día que el hub dé de alta el catálogo de addons, `ecommerce.promotions` ya está
declarado y no hay que tocar el gating.
