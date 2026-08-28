# ADR 013 — El hilo: analítica sin PII, auditoría que no se reescribe y salud que no se cuenta sola

- **Fase**: P13-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 001](001-domain-boundaries.md) (fronteras; la de
  `analytics` estaba `partial` y la observabilidad no existía como área),
  [ADR 002](002-capabilities-entitlements.md) (`analytics.basic` baseline y
  `analytics.advanced` declarada), [ADR 007](007-cart-checkout-pipeline.md)
  (`checkout_intents` y `domain_events`), [ADR 008](008-oms-order-axes-snapshots.md)
  (`order_events`, la línea de tiempo del pedido), [ADR 009](009-payments-provider-contract.md)
  (las guardas PCI: `sensitive_json_keys`, `looks_like_pan`, `redact_sensitive`),
  [ADR 010](010-promotions-engine.md) (`promotion_events` y el código de tarjeta
  regalo sin GRANT de lectura), [ADR 012](012-fulfillment-returns.md)
  (`tracking_events` append-only y el patrón de bitácora inmutable).

---

## El criterio de aceptación, leído literalmente

> PASS si un incidente de checkout/integración puede rastrearse end-to-end con
> correlation id y los KPIs mostrados tienen datos reales.

Las dos mitades se comprueban por separado y ninguna es una promesa:

- **«Rastrearse end-to-end»** es el último bloque de
  `supabase/tests/observability.test.ts`, contra Postgres real: una petición con
  un hilo recorre intento de compra → pedido → cobro rechazado → hecho de
  dominio muerto → mensaje al exterior muerto → intento cerrado en fallo, y
  `public.trace_by_correlation` devuelve los **siete dominios en orden
  cronológico y en una sola consulta**. Ninguna función de dominio tuvo que
  aceptar un parámetro nuevo para que eso funcione.
- **«KPIs con datos reales»** es `supabase/tests/analytics.test.ts`: las ventas,
  el ticket, la conversión, el abandono, los productos más vendidos y el canal
  salen de `orders`, `order_items`, `checkout_intents` y `carts` —filas que ya
  existían antes de esta fase— y no de un evento que el navegador consiga
  mandar. Y toda razón sin denominador devuelve `NULL`, nunca `0 %`.

---

## Decisión 1 · El correlation id es un DEFAULT de columna, no un parámetro

Es la decisión que sostiene la fase entera y la que más cuesta revertir.

La alternativa era añadir un argumento `p_correlation_id` a `create_order`,
`checkout_place_order`, `payment_intent_open`, `payment_apply_outcome`,
`integration_enqueue`, `fulfillment_create`, `shipment_track_ingest` y otras
seis, y hacer que cada una se lo fuera pasando a la siguiente. Tres razones
para no hacerlo, y la tercera decide:

1. Reescribir veinte funciones ya aplicadas es exactamente el cambio que la
   regla 4 del contrato de ejecución prohíbe.
2. La veintiuna se olvida. Y la que se olvida es siempre la que hace falta el
   día del incidente.
3. **Un DEFAULT no se puede olvidar.** Cose la fila la escriba quien la escriba:
   un comando, un `update` directo del backoffice, `service_role` desde el
   borde o una consola.

`ebim.correlation_id()` lee el contexto de la **petición** y no un argumento:
`set_config('ebim.correlation_id', …)` para el servidor, y la cabecera
`x-correlation-id` que PostgREST publica en `request.headers` para todo lo que
entra por HTTP. Puesta como DEFAULT en ocho tablas —`checkout_intents`,
`orders`, `payment_intents`, `payment_events`, `fulfillments`, `domain_events`,
`integration_outbox`, `integration_inbox`—, cada fila escrita durante esa
petición queda colgada del mismo hilo sin que ninguna función de dominio se
entere. **Ni una línea de `create_order` cambia.**

Lo que NO hace, y es deliberado: **no lo inventa**. Sin cabecera y sin
`set_config`, la columna queda en `NULL`. Un identificador generado dentro de la
función sería distinto en cada fila y daría la ilusión de trazabilidad sin
trazar nada.

En el borde, `serveJson` respeta el hilo que llega y abre uno si no viene, y lo
**devuelve en la respuesta** —también en la de error y en la del preflight—.
Sin devolverlo, el rastro existiría y nadie sabría cuál pedir: quien abre una
incidencia pega un identificador en vez de una hora aproximada.

### Coste asumido

`checkout_intents` tenía GRANT **por columna** desde P07, y un GRANT por columna
no crece solo: hizo falta un `grant select (correlation_id)` explícito. Es una
línea, pero es la clase de línea que se olvida y deja invisible justo el hilo
que la Definition of Done nombra. Hay un test que lo comprueba.

---

## Decisión 2 · Seis de los nueve hechos los emite el servidor, no el navegador

`analytics_events` guarda los nueve hechos canónicos del encargo. Solo **tres**
los emite la vitrina —`product_view`, `search`, `add_to_cart`—, que son los tres
que únicamente existen en la pantalla. Los otros seis los emite un **trigger**
sobre la fila que ya se escribe:

| Hecho | Origen |
|---|---|
| `checkout_started` | `insert` en `checkout_intents` |
| `checkout_completed` | `checkout_intents.status` → `succeeded` |
| `order_created` | `insert` en `orders` |
| `order_completed` | `orders.fulfillment_status` → `fulfilled` |
| `cart_abandoned` | `carts.status` → `abandoned` (ya lo hacía `ebim.expire_due_carts`) |
| `promotion_used` | `insert` en `promotion_redemptions` |

Dos consecuencias, y las dos son el motivo:

- **Un embudo que el navegador no puede falsear.** Si el numerador de la
  conversión dependiera de un `checkout_completed` que manda el cliente,
  cualquiera con la consola abierta podría moverlo y —mucho más común— un
  bloqueador o una pestaña cerrada a destiempo lo perdería. Peor todavía: el
  ratio bajaría cuando subiera el uso de bloqueadores, y parecería que la tienda
  empeora.
- **Ninguna función de dominio cambia.** Los seis se derivan de escrituras que
  ya ocurren. Hay un test que crea un pedido con un `insert` directo de
  `service_role` —por la puerta de atrás, sin pasar por `create_order`— y
  comprueba que el hecho se publica igual.

`public.track_events_for_slug` **rechaza** los seis hechos de servidor con
`ANALYTICS_EVENTO_NO_PERMITIDO`: pedirlos desde el navegador es un error
explícito, no un evento duplicado en silencio.

`order_completed` es el eje de **entrega** llegando a `fulfilled`, no el de
cobro. Son dos hechos distintos y colapsarlos haría imposible la pregunta que de
verdad se hace un comercio —«¿cuánto vendí?» frente a «¿cuánto entregué?»—. El
dinero cobrado no necesita evento: está en la fila del pedido.

---

## Decisión 3 · La analítica no puede guardar a una persona

`analytics_events` **no tiene** `customer_email`, ni `customer_name`, ni
`customer_id`; hay un test de esquema que falla si alguna aparece. Lo que
identifica una visita es `session_hash`: el **sha256** del identificador opaco
que manda la vitrina, calculado en el servidor. Sirve para saber que dos vistas
son la misma sesión —que es todo lo que un embudo necesita— y no sirve para
saber quién es.

Del lado del navegador, el identificador vive en `sessionStorage` y no en
`localStorage`: al cerrar la pestaña desaparece, que es exactamente la vida útil
de la pregunta que responde.

`props` y `search_term` pasan por `ebim.redact_pii` **en la puerta** y por un
**CHECK** en la tabla. Dos veces a propósito: la puerta se puede rodear con un
`insert` de `service_role`; el CHECK, no.

La redacción **no rechaza, redacta**. Un comprador que teclea su correo en el
buscador no puede quedarse sin poder buscar: el término se guarda como
`[redactado]` y el `result_count` sigue contando. Es la misma regla que P09
escribió para el sobre de un webhook —perder el hecho es peor que guardarlo
redactado—.

### El detalle que hizo falta ajustar

`ebim.redact_pii` conserva la clave y sustituye el valor (`{"email":
"[redactado]"}`), que es lo que permite saber que ahí había algo. Un
`jsonb_is_pii_free` que prohibiera la clave sin más rechazaría justo lo que la
redacción acaba de dejar limpio. Por eso el CHECK admite una clave prohibida
**cuando su valor es exactamente la marca de redacción**: es un literal, no un
dato, y la guarda no se debilita.

---

## Decisión 4 · Toda razón sin denominador devuelve NULL

«No inventes métricas si faltan datos» no es una recomendación en este
repositorio: es que la conversión, el abandono y el ticket promedio devuelven
`NULL` cuando su denominador es cero, y la pantalla pinta un guion.

Un `0 %` de conversión se lee como «la tienda no vende»; un guion se lee como
«todavía no hay con qué calcularlo», que es lo que pasa de verdad el primer día
de un tenant. Es la misma decisión que `dashboard_kpis` tomó en P03 con la
moneda mezclada, y hay un test de interfaz que comprueba que en una pantalla sin
datos aparecen guiones y **ningún** `0 %`.

De dónde sale cada número, y por qué no todos del mismo sitio:

| Indicador | Fuente | Por qué esa |
|---|---|---|
| ventas, pedidos, ticket, unidades | `orders` + `order_items` | es el dinero; la serie de eventos no cobra |
| conversión | `checkout_intents` | numerador y denominador de la MISMA fila |
| abandono | `carts` | el estado `abandoned` ya existía desde P07 |
| productos más vendidos | `order_items` | lo vendido, no lo mirado |
| rendimiento por canal | `orders` × `channels` | el canal es del pedido, no de la sesión |
| embudo y búsquedas | `analytics_events` | son los únicos que solo existen ahí |

El abandono cuenta solo carritos que llegaron a un **desenlace** (abandonado o
convertido) y que tenían algo dentro: un carrito todavía activo no es ni lo uno
ni lo otro, y meterlo en el denominador haría que la tasa bajara sola con el
tráfico del día en curso.

---

## Decisión 5 · La auditoría son triggers, y el actor sale del JWT

La alternativa era llamar a `ebim.audit(...)` dentro de cada comando sensible.
La razón para no hacerlo es la misma que en la decisión 1 más una tercera que
decide: **un trigger no se puede rodear**. Registra la escritura venga de donde
venga —de un comando, de un `update` directo, de `service_role` desde el borde o
de una consola—; una llamada dentro del comando solo registra a quien pasa por
el comando. Hay un test que lo comprueba con `bootstrap_tenant`, que es de P02 y
no se ha tocado ni una línea: el alta de un tenant queda auditada igual.

`ebim.audit_actor()` deriva el actor del JWT (`sub`, `email`) exactamente igual
que se deriva el tenant. **No hay ningún parámetro de actor** —hay un test que
lee la firma de la función para comprobarlo—: si lo hubiera, la bitácora sería
un campo de texto que rellena quien opera, que es lo contrario de una bitácora.
El `actor_role`, además, sale de `tenant_members` y no del claim: la membresía
real manda sobre lo que el token diga de sí mismo.

`actor_email` es la **única PII deliberada** de esta base de datos, y está
justificada por la definición misma de auditoría: un uuid no sirve para atender
un incidente a las tres de la mañana. La guarda de PII se aplica entera al
*payload*, que es donde un dato personal entraría sin que nadie lo hubiera
decidido.

### Las once tablas, y las que quedan fuera

Entra una tabla cuando tocarla cambia **quién puede**, **cuánto cuesta** o **qué
se lleva**: `tenant_members`, `tenant_entitlements`, `tenant_feature_flags`,
`tenant_integrations`, `payment_methods`, `refunds`, `gift_cards`,
`delivery_rates`, `customers`, `stores`, `store_settings`.

Fuera, y por escrito, porque su dominio ya lleva su propia bitácora y tres
relatos del mismo hecho se separan en la primera discrepancia: `orders`
(`order_events`, P08), `price_lists` (`price_change_events`, P04),
`promotions`/`coupons` (`promotion_events`, P10 — de hecho el trigger
`coupons_audit` ya existía ahí), `fulfillments` (`tracking_events`, P12),
`return_requests` (`return_events`, P12) y `payment_intents` (`payment_events`,
P09). Un test compara la lista contra el catálogo de Postgres.

### Un secreto que casi se cuela, y cómo se cierra

`gift_cards.code` es un secreto de portador —quien lo tiene, gasta el saldo— y
por eso P10 no le dio GRANT de lectura a nadie. Un diff genérico lo habría
copiado a `audit_log`, que sí leen `owner` y `admin`: la bitácora se habría
convertido en la puerta trasera del secreto que la tabla protege.

No se resuelve ampliando `ebim.sensitive_json_keys()`, porque `code` es un
nombre legítimo en media docena de tablas donde es dato de negocio. Se resuelve
con un **tercer argumento del trigger**: columnas tapadas por instalación. Hay
un test que crea una tarjeta y comprueba que su código no aparece —y que los
cuatro últimos sí, porque es lo único que P10 deja enseñar y es lo que permite
reconocerla al atender una queja—.

### Append-only, y el coste que se asume

Ni UPDATE ni DELETE, ni siquiera para `service_role`: un trigger los rechaza,
igual que en `tracking_events` (P12) y `payment_events` (P09). Una bitácora que
el propio sistema puede reescribir no es prueba de nada. Los tests tienen que
apagar el trigger para poder limpiar entre casos, lo cual es —en sí mismo— la
prueba más fuerte del invariante.

**La consecuencia se asume a sabiendas: no hay purga.** Establecer una política
de retención es una decisión de negocio y de cumplimiento, no un efecto
colateral de un `delete`; el día que exista será una migración propia con su
propia autorización, y quedará escrita.

Corolario técnico: `audit_log` **no tiene FK**. Una con `on delete cascade`
borraría el registro de una baja justo cuando se produce la baja, y una con
`restrict` haría imposible dar de baja nada. Es la misma decisión, y por el
mismo motivo, que `price_change_events` en P04.

---

## Decisión 6 · `ops_events` es una proyección, no una segunda verdad

Los hechos ya estaban: un checkout fallido en `checkout_intents.status`, un
cobro rechazado en `payment_intents`, un mensaje muerto en `integration_outbox`,
un aviso no entregado en `domain_events`. Lo que no existía es **un sitio con la
misma forma para los cuatro**, y esa es toda la diferencia entre «se puede
averiguar» y «se ve».

Sin eso, atender un incidente son cuatro consultas contra cuatro esquemas, cada
uno con su nombre para «fallo» y su nombre para «cuándo». Además hay dos señales
que no tienen tabla ninguna y no la pueden tener —una operación lenta y un
webhook con firma inválida ocurren en el **borde**, donde no hay fila que
mirar—, y esas son justo las que se pierden.

La fila que manda sigue siendo la del dominio: `entity_type`/`entity_id` apuntan
a ella y `ops_events` se alimenta por trigger, no por copia manual.

Y **no va en `analytics_events`**, porque el requisito lo prohíbe con todas las
letras: «sin acoplar analítica comercial a logs técnicos». Un pico de reintentos
de un conector no puede aparecer en el mismo sitio del que sale la tasa de
conversión, ni compartir retención con ella.

El mismo fallo repetido es **un** incidente con contador (`on conflict do
update`, `context.repeats`), no cien filas: descartarlo haría que un incidente
que lleva tres días repitiéndose pareciera de hace tres días.

---

## Decisión 7 · La observabilidad es un ÁREA DE PLATAFORMA y no se vende

Se añade `observability` a `PLATFORM_AREA_IDS` —no a los doce dominios de
negocio— y **no** se crea ninguna capacidad nueva. Las dos cosas importan:

- La salud operativa sostiene a los doce dominios, así que no cabe dentro de
  ninguno.
- Un tenant que no pudiera ver por qué le fallan los cobros porque no pagó el
  addon de observabilidad es un tenant que llama por teléfono. Es exactamente el
  mismo argumento por el que Ajustes y Diagnóstico no se gatean desde P02, y la
  ruta `/app/operations` sigue esa regla: sin `CapabilityGate`, con permiso de
  rol.

Lo que **sí** se vende es el **comportamiento del comprador**:
`analytics.advanced` pasa de `declared` a `implemented` y gatea el embudo y los
términos de búsqueda. El gate vive en la base (`ebim.assert_analytics_advanced`
levanta `SIN_MODULO`), no en la pantalla: así el comportamiento es el mismo si
alguien llama a la función desde fuera de la aplicación. Y levanta en vez de
devolver una lista vacía, porque «no hay datos» y «no lo tienes contratado» son
dos incidencias distintas para quien da soporte —el mismo argumento que P02
escribió para `sin-contexto`—.

---

## Decisión 8 · Vendor-neutral por contrato, no por intención

«No dependas de un vendor único: crea puntos de integración.» Los puntos son
tres y ninguno nombra a nadie:

- `public.ops_record_event` — por donde el borde escribe (`service_role`).
- `public.ops_health` — la foto que cualquier tablero puede consultar.
- `supabase/functions/_shared/observability` — un logger que **no escribe**:
  emite a una lista de **sinks**. La consola es un sink; el incidente es otro; el
  día que se contrate un proveedor, ese proveedor es un tercer sink de veinte
  líneas y ni una Edge Function cambia.

Es el mismo patrón —contrato canónico + registro de adaptadores— que P09 usó
para las pasarelas y P12 para los transportistas, y funciona por la misma razón:
el nombre propio vive en el registro, nunca en el llamante. No hay SDK de nadie,
ni variable de entorno con nombre de producto, ni formato propietario.

Dos detalles del logger que son decisiones y no estilo:

- **El contexto se redacta siempre y no hay forma de saltárselo**: `emit`
  construye el registro, no lo acepta hecho. El destino de estos registros es la
  salida estándar del proveedor de hosting, fuera de esta base y de sus
  policies: ahí es donde de verdad se filtran los correos y los tokens.
- **La lentitud es un hecho aparte** (`operation.slow`) y no una propiedad de
  `operation.completed`. Los sinks deciden qué escriben mirando `event`; si el
  umbral viviera dentro del registro, cada sink tendría que repetirlo y dos
  sinks acabarían con umbrales distintos.

Las dos listas de claves prohibidas están **duplicadas** entre TypeScript y SQL
—el borde no puede consultar la base para decidir si algo se puede escribir en
un log— y un test las compara y falla si se separan. Es la misma técnica que
`CHECKOUT_STAGES` en P07.

---

## Decisión 9 · `ops_health` no acepta tenant

«Health relevante al tenant sin revelar datos de otros tenants» se cumple de
forma **estructural** y no por acuerdo: la función no tiene parámetro de
organización ni de sociedad —hay un test que lee su firma—, los deriva del JWT y
filtra cada rama por ellos. No existe el parámetro que habría que validar.

`p_store_id` es alcance dentro de lo ya autorizado, igual que en
`effective_capabilities`: acota, no concede.

La lectura exige `owner`/`admin`, no cualquier miembro: un incidente lleva
dentro el código de error del proveedor de cobro y la operación que no salió. Un
`viewer` recibe `SIN_PERMISO` y la pantalla lo lee como «no tienes permiso», no
como «no hay datos» —lo segundo le haría creer que su tienda está sana—.

Y atender un incidente **no es un `update`**: `ops_events` no tiene GRANT de
UPDATE. Resolver son tres cosas que pasan juntas (autorización, fecha y firma de
quien lo hizo) y un GRANT de UPDATE permite hacer una sin las otras — la misma
decisión que P08 tomó con los ejes del pedido y P12 con las entregas. Además
exige un motivo: cerrar un incidente sin decir qué se hizo produce el tablero en
el que todo está resuelto y nadie sabe por qué.

---

## Lo que NO se hizo, y por qué

- **Cohortes.** `capabilities.ts` prometía «cohortes, embudo de conversión y
  exportación analítica». Hay embudo y hay exportación; las cohortes no, y no se
  fingen: exigirían seguir a un comprador identificado a lo largo del tiempo, y
  la analítica de esta app se guarda **sin PII a propósito**. Dejar una función
  que devuelva una lista vacía para que la casilla quede marcada sería peor que
  decirlo aquí.
- **Percentiles de latencia.** `ops_health` devuelve el número de operaciones
  lentas y la peor, no un p95: con cuatro muestras, un percentil es un número
  con aspecto de estadística. Cuando haya volumen será una función más sobre la
  misma columna.
- **Purga y retención.** Ver la decisión 5. Es una decisión de negocio y de
  cumplimiento, y se toma con su propia migración.
- **Incidentes de webhook sin tenant.** Un aviso cuya firma no valida no se
  puede atribuir a ninguna sociedad —justamente porque no se pudo verificar—, y
  `ops_events` es tenant-scoped. Se queda en el log estructurado, con su hilo.
  Escribirlo en un tenant adivinado sería peor que no escribirlo.
- **Un consumidor del outbox.** `ops_health` mide la profundidad de las colas;
  quién las vacía sigue siendo trabajo de P14, igual que después de P07.

---

## Lo que rompería esto

1. Quitar el DEFAULT de `correlation_id` de cualquiera de las ocho tablas: el
   rastro se parte justo en el salto que interesa.
2. Emitir `checkout_completed` u `order_created` desde el navegador: la
   conversión pasaría a depender de bloqueadores y de pestañas cerradas.
3. Dar GRANT de UPDATE o DELETE sobre `audit_log` o `analytics_events`: una
   bitácora reescribible no es prueba de nada.
4. Añadir a `analytics_events` una columna con el correo, el nombre o el
   documento del comprador.
5. Traducir `NULL` a `0` en cualquier razón de `analytics_kpis`.
6. Aceptar un `p_organization_id` en `ops_health` o un `p_actor_email` en
   `ebim.audit`.
7. Meter los logs técnicos en `analytics_events` «para tenerlo todo junto».
