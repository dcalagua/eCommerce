# ADR 004 — Motor de precios: listas, escalas, vigencias y precedencia

- **Estado:** aceptada
- **Fecha:** 2026-08-27
- **Fase:** P04-SaaS (productización)
- **Contexto previo:** [`ADR 001`](001-domain-boundaries.md) §2 (`PricingPort` ya declarado),
  [`ADR 002`](002-capabilities-entitlements.md) §2 (`pricing.lists` era `declared`),
  [`ADR 003`](003-pim-variantes-uom-kits.md) §3 (variantes y unidades de venta),
  [`SAAS_ROADMAP.md`](../SAAS_ROADMAP.md) §2
- **Contrato EBIM:** §0.2 (personalización = configuración, nunca código por cliente), §2.6 (nadie se
  autoasigna su precio), §3 (jerarquía `organization` → `company` → datos), §8 (tabs centrados, un
  buscador general)

---

## Contexto

Hasta P03 el precio de este producto era `products.price`: una columna escalar, más
`product_uoms.price` para la caja y la herencia de la variante. Responde bien a «cuánto cuesta
esto» y **no responde en absoluto** a la pregunta que hace cualquier negocio B2B:

> ¿cuánto cuesta esto **para este cliente**, **por este canal**, **en esta cantidad**, **hoy**?

Con una columna, las dos únicas salidas son duplicar el producto por canal —que es lo que la fase de
canales prohibió al no darle tienda propia a cada canal— o cablear un `if` por cliente, que es lo
que prohíbe el principio 2 del contrato. Las dos acaban en el mismo sitio: el mismo binario deja de
servir a dos clientes.

Además, `create_order` era la **autoridad de precio**: la regla vivía dentro de la función que crea
pedidos, así que la vitrina la reimplementaba por su cuenta leyendo `products.price` y el carrito la
reimplementaba otra vez en JavaScript. Tres copias de la misma regla en dos lenguajes.

## Decisión

### 1. Una sola autoridad de precio, y no es el pedido

`ebim.resolve_prices` es la única función que decide cuánto cuesta una línea. `create_order` deja de
calcular y pasa a **preguntar**; la vitrina pública lee un precio ya resuelto; el carrito cotiza
contra la misma función. La propiedad que esto compra es la que decide si el motor sirve para algo:
**lo que se muestra, lo que se cotiza y lo que se cobra son el mismo número, porque salen del mismo
sitio.**

Hay un test que compra exactamente esa propiedad (`pricing-checkout.test.ts`): cotiza un carrito,
lo compra, y compara los tres totales.

### 2. El contexto es explícito y ninguna parte de él viene del navegador

`resolve_prices(store, channel, líneas, moneda, momento, segmento, cliente)`. Todo lo que puede
cambiar un precio entra por parámetro y nada se adivina. Y ninguno de esos parámetros lo pone el
cliente:

- la **tienda** sale del slug de la URL resuelto en el servidor;
- el **canal** sale de la tienda (el público por defecto, que no exige sesión);
- el **segmento** y el **cliente** solo existen si un llamante de servidor los pone — el checkout
  público es anónimo y pasa `null` en los dos.

La lista negra del payload crece con `segment_id`, `customer_id`, `price_list_id`, `price_source` y
`channel_id`, en el borde (`_shared/orders.ts`) y en la base. Un comprador que pudiera declarar
`segment_id` se estaría asignando el acuerdo comercial de otro; con `price_list_id` se saltaría la
precedencia entera.

### 3. La precedencia es TOTAL, documentada y no configurable en su parte importante

Cuando varias listas alcanzan la misma línea, gana la primera de este orden:

| # | Criterio | Configurable |
|---|---|---|
| 1 | Especificidad del alcance: cliente (40) > segmento (30) > canal (20) > tienda (10) | **No** |
| 2 | `price_lists.priority`, descendente (0–1000) | Sí |
| 3 | `valid_from` más reciente | — |
| 4 | `id` de la lista | — |

La especificidad **no** es configurable a propósito. Si lo fuera, un precio negociado con un cliente
podría quedar por debajo del precio general por haber tecleado mal una prioridad, y nadie lo vería
venir hasta la factura.

Ya dentro de la lista ganadora: variante concreta antes que precio para todas las variantes,
presentación concreta antes que precio por unidad base, y la escala **mayor alcanzada**.

**La lista de mayor precedencia gana aunque su renglón sea menos concreto que el de una lista
inferior.** Primero se elige el acuerdo, después el renglón dentro del acuerdo. Al revés, un precio
de catálogo por variante podría ganarle a un precio negociado por producto, que es lo contrario de
lo que espera cualquier comercial.

El paso 4 existe para que el precio no dependa del plan de ejecución. Que exista no es excusa para
llegar hasta él: `price_list_conflicts` denuncia como **error** las combinaciones que dependen de
ese desempate, y la pantalla de diagnóstico las separa de las cuatro que solo dejan una lista sin
efecto (moneda distinta, vigencia agotada, sin asignar, vacía).

### 4. La escala se mide en unidades base, siempre

`price_list_items.min_quantity` se compara contra `cantidad × factor de la presentación`. Medirla en
unidades de venta haría que comprar 10 cajas de 12 no alcanzara una escala de 100, y que cambiar de
presentación cambiara el descuento sin que nadie lo hubiera decidido.

### 5. El fallback al precio de catálogo es la regla, no la excepción

Si ninguna lista alcanza —porque no hay, porque no están vigentes, porque la moneda no coincide, o
porque la sociedad **no tiene el módulo contratado**— la respuesta es el precio de catálogo
calculado exactamente como antes de esta fase: `product_uoms.price` si la presentación tiene el
suyo, y si no `coalesce(variante.price, producto.price) × factor`. `source` lo dice, y hay un test
para cada uno de esos cuatro casos.

Esto es lo que permite que **ningún test de pedido de P02 ni de P03 haya cambiado una línea**: sin
listas, el importe es idéntico.

### 6. La entitlement se comprueba con un JOIN, no con `has_capability`

`ebim.active_price_lists` filtra por `tenant_entitlements` mediante un join, y no llamando a
`ebim.company_is_entitled`. La razón no es de estilo: una función invocada dentro de una vista
`SECURITY DEFINER` corre como el usuario que **pregunta**, así que `has_capability` devolvería «no»
para el comprador anónimo y **ninguna lista se aplicaría jamás en la vitrina**. El join sí corre con
los permisos de la vista. La composición es la misma: app activa Y addon activo Y flag técnico que
no lo apague.

La consecuencia comercial es deliberada y tiene test: si un tenant deja de pagar `pricing.lists`,
sus precios vuelven al catálogo. Sus listas siguen **viéndose** en el backoffice —la policy de
SELECT no exige capacidad— porque esconderlas convertiría una baja comercial en una pérdida de datos
aparente.

### 7. La vitrina muestra el precio resuelto, no `products.price`

`public_products.price` y `public_product_variants.price` pasan a salir de `ebim.public_unit_prices`,
una vista definer restringida a **alcances tienda y canal público**, cantidad 1 y unidad base. Un
precio de segmento o de cliente no sale por ahí nunca: quien mira la vitrina anónima no es ninguno
de los dos.

Sin esto, el catálogo pintaría 10 y el carrito cobraría 8 —o 12—. Un escaparate que miente sobre el
precio no es un detalle de UX.

`compare_at_price` **no** se hereda del catálogo cuando manda una lista: el tachado del catálogo
sobre un precio de lista anuncia un descuento que nadie declaró. Es la misma regla que P03 aplicó a
la variante con precio propio.

### 8. `customer_segments` nace aquí, aunque `customers` sea P05

El segmento es antes una **dimensión de precio** que una ficha de cliente, y sin él P04 no podría
demostrar la precedencia que tiene que fijar. Es vocabulario de la sociedad, sin `store_id`, igual
que marcas y unidades.

`price_list_assignments.customer_id` va **sin FK** y es la única de las cuatro columnas de alcance
que lo está. Es deuda declarada, no descuido: el aislamiento no depende de ella (lo garantiza
`store_id` vía `stores`), ninguna resolución la inventa —solo aplica si un llamante de servidor pasa
un cliente concreto, y el storefront anónimo nunca pasa ninguno— y P05 añade la FK con su migración.

### 9. La bitácora se escribe por trigger DEFINER y sobrevive al borrado de la lista

`price_change_events` no tiene policy de INSERT para nadie ni GRANT de escritura: la única escritura
posible es `ebim.log_price_change`, que deriva el tenant de la fila que ya pasó por la RLS de
`price_list_items` y el actor del JWT. No acepta parámetros, así que no hay forma de usarla para
escribir en el tenant de al lado.

**Sin FK hacia `price_lists`** a propósito: la bitácora tiene que sobrevivir al borrado de la lista,
que es precisamente el caso en que hace falta.

En `UPDATE` se compara antes de anotar. Un update que no toca precio ni escala no es un cambio de
precio, y anotarlo llenaría la bitácora de ruido hasta hacerla inútil — que es la forma habitual de
perder una bitácora.

### 10. El lote es la unidad de resolución

`resolve_prices` recibe N líneas y devuelve N filas en **una** consulta, con `distinct on` sobre un
join indexado. Línea a línea sería el N+1 clásico y con miles de SKU y varias listas se nota en la
primera campaña. `ebim.resolve_price` (singular) es azúcar sobre ella para `create_order`, que ya
recorre línea a línea porque tiene que bloquear existencias.

En el backoffice, el selector de producto busca **en el servidor con límite 20** y la carga masiva
va por CSV: un selector que se trae los 3.000 SKU de la tienda para filtrarlos en memoria rompe justo
en el cliente que más lo necesita.

## Alternativas descartadas

**Una tabla `price_list_items` con la moneda por renglón.** Obligaría a resolver «qué renglón vale»
con una regla más y permitiría una lista incoherente. Con la moneda en la lista, una lista en USD
simplemente no aplica a una tienda en PEN — y el diagnóstico lo dice en vez de dejarlo pasar.

**Vigencia por renglón además de por lista.** Multiplica la detección de solapamientos por el número
de renglones y no compra nada que no compre una segunda lista con más prioridad. Es una limitación
consciente, no un olvido.

**Alcance genérico `(scope_kind, target_id)`.** Sin FK posible: una asignación que apunta a un canal
borrado se queda viva decidiendo precios. Con columnas tipadas hay FK real en tres de los cuatro
alcances y un CHECK que obliga a que la columna rellenada sea la que corresponde.

**Resolver el precio del catálogo público con una función por fila.** Se descartó frente a la vista
`distinct on`: una llamada por producto en un listado de miles es exactamente el patrón que la
regla 11 de la fase prohíbe.

**Mezclar promociones.** Un descuento por campaña o por cupón es otra capa (P10) que recibe este
resultado. Mezclarlas produce un motor que nadie sabe explicar cuando un precio sale mal, que es
justo el momento en que hay que explicarlo.

## Consecuencias

- `pricing.lists` deja de ser `declared`: es la segunda capacidad vendible con superficie real.
- La frontera `pricing` pasa a `implemented` y gana `src/features/pricing`; `customers` pasa a
  `partial` porque el segmento comercial ya existe.
- `PricingPort` gana su primera implementación (`serverPricing`), y el carrito la usa. El día que un
  tenant tarifique en su ERP, lo que cambia es qué implementación se inyecta.
- `order_items` gana `price_source` y `price_list_id`: la línea del pedido puede explicar **por qué**
  costó lo que costó. `price_source` sobrevive al borrado de la lista; `price_list_id` no.
- `products.price` sigue siendo el precio de catálogo y el fallback. Retirarlo obligaría a dar de
  alta una lista antes de poder vender nada, y convertiría el alta de un tenant en un proyecto.
- Queda pendiente para P05: la FK de `price_list_assignments.customer_id` y pasar el segmento y la
  cuenta del comprador autenticado al motor. La costura ya existe: son dos argumentos de
  `resolve_price` que hoy van a `null` desde `create_order`.
