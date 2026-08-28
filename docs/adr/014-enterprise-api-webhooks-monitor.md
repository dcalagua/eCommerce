# ADR 014 — La API de socio, los webhooks que son el MISMO outbox y el monitor donde el fallo se ve y se recupera

- **Fase**: P14-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 001](001-domain-boundaries.md) (fronteras; la de
  `integrations` estaba `partial` y su carpeta en `src/` estaba vacía),
  [ADR 002](002-capabilities-entitlements.md) (`integrations.enterprise`
  declarada como vendible y `partial`), [ADR 007](007-cart-checkout-pipeline.md)
  (`domain_events`, el outbox de dominio idempotente por `dedupe_key`),
  [ADR 009](009-payments-provider-contract.md) (firma HMAC sobre el cuerpo
  crudo, comparación en tiempo constante y guardas PCI),
  [ADR 012](012-fulfillment-returns.md) (el contrato canónico de operador y el
  registro de adaptadores), [ADR 013](013-analytics-audit-observability.md) (el
  hilo, `audit_log` append-only, `ops_events` y la decisión de que la
  observabilidad es área de plataforma y **no se vende**).
- **Framework reutilizado**: `20260827150000` y `20260827150100` (P12 histórico):
  catálogo de proveedores, `tenant_integrations`, outbox, inbox, bitácora de
  intentos, idempotencia, backoff con jitter, cola muerta y disyuntor.

---

## El criterio de aceptación, leído literalmente

> PASS si añadir SAP/ERP/pago/logística/mensajería como providers no requiere
> modificar el core y la operación de fallos es visible y recuperable.

Son tres afirmaciones y ninguna se da por buena:

| Exigencia | Dónde se comprueba |
|---|---|
| **añadir un provider no toca el core** | `api-gateway.test.ts` → «conectar un destino nuevo es una fila, no tocar el core»: registra un destino que no existe en ninguna parte del repositorio y recorre con él el ciclo entero —firma, entrega, resultado— sin tocar el despachador. Y `webhooks.test.ts` → un conector nuevo entra como fila de `integration_providers` + un endpoint del tenant, sin migración de dominio |
| **el fallo es VISIBLE** | `integration-monitor.test.ts` → una fila del monitor trae junta estado, intentos, próximo reintento, disyuntor, hilo y destino con nombre; y el detalle del mensaje sale con doble redacción y sin la cadena de consulta de la URL |
| **el fallo es RECUPERABLE** | `integration-monitor.test.ts` → un mensaje muerto se reintenta y un disyuntor se cierra desde la pantalla, con rol, con motivo y con firma en `audit_log`; y la cola **no** se puede reescribir desde el navegador |

---

## 1. Los webhooks NO son una segunda cola

La decisión más grande de la fase, y la que el encargo pedía explícitamente
(«reutiliza el framework actual … no construyas otro sistema paralelo»).

El transporte de P12 ya traía todo lo que un webhook necesita —outbox
transaccional, idempotencia por clave, reintentos con backoff exponencial y
jitter, cola muerta, disyuntor y bitácora append-only de cada intento— salvo
**una** cosa: sabía entregar «al proveedor X», no «al endpoint número 3 del
proveedor X».

Eso se arregló con **una columna**, no con una segunda cola:

```
integration_outbox.target    a QUE destino concreto va este mensaje
integration_circuit.target   el disyuntor pasa a ser POR destino
```

La segunda es la que de verdad importa. Sin ella, un solo endpoint roto abriría
el circuito del proveedor `webhook` entero y dejaría de entregar a los endpoints
**sanos** del mismo tenant: un disyuntor que castiga al inocente es peor que no
tener disyuntor, porque el fallo se vuelve invisible —la cola crece y nadie sabe
cuál de los cinco destinos la está bloqueando—. Hay un test que lo fija:
*«un endpoint roto no corta la entrega a los sanos»*.

`target = ''` (cadena vacía, no NULL) significa «el proveedor entero», que es
exactamente el comportamiento de P12: por eso ni un mensaje de ERP, de pago o de
logística cambia de conducta con esta migración, y los 21 tests del framework
siguen verdes sin tocar una línea.

**Cadena vacía y no NULL** porque el destino entra en una clave UNIQUE, y en
Postgres dos NULL no chocan: con NULL, el disyuntor «del proveedor entero» podría
duplicarse en silencio.

### Lo que las tres tablas nuevas SÍ aportan

`webhook_endpoints` (a dónde, con qué secreto y con qué versión),
`webhook_subscriptions` (qué eventos quiere) y `webhook_deliveries` (la
**identidad** de lo entregado y la cadena de reproducciones). Ninguna guarda el
payload ni el resultado: eso ya vive en `integration_outbox` y en
`integration_messages`, y duplicarlo crearía una segunda verdad que se
desincroniza el primer día.

---

## 2. La identidad del evento es la del hecho de dominio

`webhook_deliveries.event_id` es `domain_events.id`. No es un uuid nuevo, y eso
es lo que hace que la deduplicación del receptor funcione **por construcción** y
no por disciplina:

- `domain_events` ya es idempotente por `dedupe_key` (P07): republicar el mismo
  hecho devuelve la fila que existe y no inserta otra;
- si el id del webhook fuera nuevo en cada publicación, un reintento del checkout
  entregaría «pedido creado» dos veces con dos identidades distintas y el
  receptor no tendría forma de saber que es el mismo hecho.

Y por eso **la reproducción conserva el `event_id`**: reproducir es «vuelve a
intentar entregarme ESTE hecho», no «invéntate uno nuevo». El receptor que
deduplica bien lo descarta; el que lo perdió lo procesa. Las dos son la respuesta
correcta y ninguna depende de nosotros — que es justo lo que permite ofrecer el
botón sin miedo a duplicar pedidos en el sistema del cliente.

El sobre publicado está tipado en `src/domain/ports/webhook.ts`
(`WebhookEnvelope` + `isWebhookEnvelope`) y el banco de pruebas comprueba que lo
que de verdad sale por la cola tiene esa forma: sin eso, el contrato con el
tercero sería un comentario.

---

## 3. El fan-out NO puede levantar una excepción

Cuelga de un trigger `after insert` sobre `domain_events`, y `domain_events` se
escribe **dentro de la transacción del pedido** (P07). Una excepción ahí tumbaría
la venta.

Un webhook no entregado es un incidente; una venta perdida porque el endpoint del
cliente estaba mal escrito es un desastre. Cada encolado va en su propio bloque
de excepción y lo que falla se registra en `ops_events` con código
`WEBHOOK_NO_ENCOLADO`, que es donde el monitor lo enseña. Hay un test que
retira al conector su operación declarada, publica un hecho y comprueba las dos
mitades: **el hecho se publica igual** y **queda un incidente**.

Es la misma lección que P07 dejó escrita al decidir que `domain_events` no
reusara `integration_outbox`: «alguien pondría un `exception when others then
null` alrededor y el evento se perdería en silencio». Aquí la excepción se
captura, pero **no en silencio**.

---

## 4. Tres APIs distintas, y esta es la tercera

| Superficie | Quién llama | Autoridad | Contrato |
|---|---|---|---|
| Navegador | el usuario del backoffice | RLS + JWT del hub | el ESQUEMA |
| Vitrina pública | un comprador anónimo | RLS `to anon` | vistas `public_*` |
| **Socio / empresarial** | **el sistema de un tercero** | **token + scope** | **`/v1`, estable** |

La tercera **no puede** tener por contrato el esquema. Es lo que el encargo pide
literalmente: «no expongas Supabase como contrato empresarial directo si eso
acopla a clientes externos». Un socio que integra contra `GET /rest/v1/orders`
queda atado a nuestros nombres de columna, a nuestros enums y a nuestro dialecto
de filtros; renombrar `grand_total` deja de ser un refactor y pasa a ser un
incidente con un tercero.

Por eso hay **versión en la ruta** (`/v1/...`, no una cabecera que se puede
omitir), **recursos** en vez de tablas, **importes como cadena decimal**
(`118.0` se lee como `double` al otro lado y descuadra facturas), **el pedido
identificado por su NÚMERO** y **el producto por su SKU** —la traducción a
nuestros uuid la hace el servidor, que es exactamente el trabajo de un
adaptador—, **paginación por cursor** (con `offset`, insertar mientras se pagina
duplica o salta registros) y **errores con código estable**.

### El vocabulario de scopes es el que ya existía

`order.read`, `order.create`, `stock.read`… son las **mismas** operaciones
canónicas que declara `integration_providers.capabilities` y que viajan en
`integration_outbox.operation`. Un socio que PIDE `stock.read` y un conector que
OFRECE `stock.read` hablan del mismo hecho de negocio en dos direcciones.
Inventar un segundo vocabulario (`read:inventory`, `INVENTORY_READ`) habría
creado dos glosarios que divergen en la primera revisión.

Está escrito tres veces —`ebim.api_scope_catalog()`, `src/domain/api.ts` y
`_shared/api/contract.ts`— porque son tres tiempos de ejecución que no pueden
importarse entre sí, y lo que impide que se separen no es la disciplina: es un
test que compara las tres contra Postgres real.

**Solo están los scopes que tienen recurso detrás.** `invoice.get` sería el
nombre canónico correcto el día que exista emisión de facturas; declararlo hoy
dejaría en el contrato público una promesa que nadie cumple, y un socio la
integraría.

---

## 5. La propiedad que hace imposible el cruce de tenants

**Ninguna función de recurso acepta `organization_id` ni `company_id`.** Aceptan
el id del cliente de API y derivan el tenant de **su fila**
(`ebim.api_authorize`). No es que el parámetro se valide: **no existe el
parámetro**.

Es la misma técnica que `public.my_business_accounts()` llevó al extremo en P05
—una función sin argumentos— y es la regla 6 del contrato de ejecución en su
forma más fuerte. Un borde mal escrito no puede cruzar tenants porque no hay
forma de pedírselo. Hay un test que lo comprueba **estructuralmente**,
consultando `pg_proc.proargnames`: si alguna función `api_*` declarara un
parámetro de tenant, la suite se pone roja.

Consecuencia asumida: la Edge Function `api` usa `service_role` y salta RLS.
No hay alternativa —quien llama es un sistema, no hay JWT ni sesión que la RLS
pueda mirar— y por eso la autorización entera vive en la base y se repite dentro
de cada recurso.

---

## 6. El orden de las comprobaciones es una decisión de seguridad

Está escrito una vez, en `_shared/api/gateway.ts`, y tiene tests propios:

1. **versión** → una `/v2` inventada no llega a tocar la base;
2. **token y scope** → antes de mirar el cuerpo;
3. **límite de tasa** → **después** de autenticar, porque el contador es por
   credencial: contarlo antes permitiría agotar el cupo de un socio desde fuera
   con solo conocer su `client_id`;
4. **idempotencia** → reservar la clave **antes** de operar;
5. **la operación** → una función de la base, que deriva el tenant;
6. **cerrar** → guardar la respuesta idempotente y el estado de la petición.

### Idempotencia con huella del contenido

`Idempotency-Key` es **obligatoria** en las escrituras, y no opcional: un cliente
HTTP que reintenta solo es el caso normal, no el raro. La reserva es un
`insert … on conflict do nothing` y no un «mira si existe y si no, escribe»,
porque entre mirar y escribir caben dos reintentos simultáneos del mismo socio —
que es exactamente cuando esto importa.

`request_hash` no es decoración: sin él, reusar la misma clave con otro cuerpo
devolvería la respuesta del cuerpo **anterior** y el socio creería que creó el
pedido que acaba de mandar. Con él, eso es un 409 explícito. Y la huella se
calcula sobre el cuerpo **reordenado por clave**: dos envíos con las mismas
claves en otro orden son la misma petición.

---

## 7. Los secretos

Tres decisiones, y las tres tienen test:

- **El secreto de una credencial se guarda en sha256 y se devuelve UNA vez**, al
  crear o al rotar. No existe la consulta que lo devuelva. Lo que sí se ve
  siempre es la PISTA (los seis últimos caracteres), que permite reconocer cuál
  de las tres credenciales es sin poder reconstruir ninguna — misma técnica que
  `gift_cards.code_last4` (P10).
- **El GRANT es por COLUMNA, en los dos sentidos.** `secret_hash` no sale ni a
  un `owner` (la RLS filtra filas, nunca columnas), y tampoco se puede
  **escribir**: poder escribirlo es poder elegir el secreto, que es justo lo que
  `api_client_create` existe para impedir.
- **El secreto de firma de un webhook no vive en la base**: allí está
  `secret_ref`, el nombre de la variable del vault. Lo resuelve el despliegue.
  Es el patrón que `tenant_integrations.secret_ref` estableció en P12.

Y una cuarta que es de higiene operativa: **`api_authenticate` recibe el HASH del
token, no el token**. Así el secreto de portador no entra jamás en el registro de
sentencias de Postgres, que es donde acaban los parámetros el día que alguien
sube el nivel de log para diagnosticar otra cosa.

### Desactivar y rotar revocan EN EL ACTO

Un trigger `after update of is_active` revoca todos los tokens vivos de una
credencial desactivada, y `api_client_rotate_secret` hace lo mismo. Va en trigger
y no dentro de un comando para que valga para todos los caminos: sin esto,
«desactivar» dejaría al socio operando hasta una hora más — que es justo el rato
en el que importa.

---

## 8. HTTPS: lo que se asume y lo que se hace cumplir

La terminación TLS la hace la plataforma: una Edge Function no escucha en texto
claro y no hay forma de desplegarla en `http`. Por eso **no hay** una
comprobación de esquema en el borde — sería teatro: la petición ya llegó cifrada
o no llegó.

Lo que sí depende de nosotros y sí está implementado es la mitad opuesta: **toda
URL a la que NOSOTROS llamamos está obligada a `https` por un CHECK**, y ese
mismo CHECK rechaza `localhost`, el bucle local, el enlace-local (de donde
cuelgan los metadatos de instancia de todo proveedor de nube) y los tres rangos
privados de RFC 1918. Es defensa contra SSRF: el trabajador entrega con
credenciales de servidor y desde dentro de la red del proyecto, así que un
endpoint apuntando a `https://169.254.169.254/` sería pedirnos que leamos
metadatos y se los mandemos **firmados**. Vive en la base y no solo en el borde
porque el borde se puede desplegar mal; un CHECK, no.

### La firma lleva un instante dentro

El texto firmado es `<instante>.<cuerpo crudo>`, y el instante viaja en la misma
cabecera. Sin él, una firma válida lo es **para siempre**: quien capture una
entrega —en un proxy, en un log del receptor, en una red mal segmentada— puede
reproducirla contra el endpoint del cliente meses después y su sistema la
aceptará como legítima. Con el instante dentro de lo firmado, el receptor rechaza
lo que llega demasiado tarde y no puede moverse el reloj sin invalidar la firma.

`verifyWebhookSignature` vive en el repositorio junto a `signWebhook` y no solo
en la documentación: una firma que solo se sabe generar no se puede probar, y así
la promesa que le hacemos al suscriptor está comprobada en las dos direcciones.

---

## 9. El monitor: lo que se enseña y lo que no

**Visible.** `integration_monitor` es una fila por mensaje con todo lo que hay
que mirar junto —estado, intentos, próximo reintento, hilo, disyuntor y destino
con **nombre legible**, no un uuid—. La EDAD se calcula en el servidor, nunca en
el navegador: con el reloj del portátil mal puesto, un mensaje de hace diez
minutos aparece como de hace dos horas, y la respuesta a un incidente se decide
justo por eso (la misma decisión que `fulfillment_overview.is_late` en P12 y que
`ops_incident_overview.age_seconds` en P13).

**Sanitizado.** El contenido de un mensaje es lo único de todo esto que puede
llevar datos delicados, y una columna en una vista se lleva en un `select *` —a
un CSV, a una captura, a un ticket—. Por eso el detalle es una **función**: se
pide de uno en uno, pasa por `ebim.redact_sensitive` (tarjeta, P09) **y** por
`ebim.redact_pii` (correo, teléfono, documento, P13), la URL del destino sale sin
su cadena de consulta —un `?token=` dentro es el secreto que esta pantalla existe
para no enseñar— y **queda registrada en `audit_log`**: mirar el contenido de un
mensaje es un acto con autor.

**Lo que NO se guarda**, y por tanto no se puede enseñar: el CUERPO de la
respuesta del destino. Se guarda el código HTTP y un texto **nuestro**. Un cuerpo
de respuesta lo escribe un tercero y acaba trayendo dentro el correo del
comprador, un token de su propia API o una traza con datos de otro cliente suyo.
Hay un test que lo fija incluso para los fallos de red: lo que se guarda es
`No se pudo entregar (AbortError)`, no el mensaje de la excepción — que puede
llevar la URL entera con su cadena de consulta.

**Recuperable, y con nombre.** Reintentar y reproducir son comandos y no
`UPDATE` con policy: `integration_outbox` no tiene —ni tendrá— GRANT de escritura
para `authenticated`, porque con un `UPDATE` se podría poner `attempts = 0` en un
mensaje muerto y reintentarlo infinitas veces, o marcarlo `succeeded` sin haberlo
entregado. El comando hace las tres cosas que van juntas —autorizar, mover el
estado y firmar quién lo hizo— y no deja omitir ninguna.

**Reintentar CONSERVA los intentos gastados.** Ponerlos a cero sería borrar la
única prueba de que ese mensaje ya falló seis veces, que es justo el dato con el
que se decide si el problema es el destino o el contenido. Lo que hace el
reintento manual es dar **un** intento más por encima del techo. Y cierra el
disyuntor de ese destino, porque quien reintenta a mano está afirmando que el
destino ya responde; si no responde, volverá a abrirse solo.

---

## 10. Lo vendible es PUBLICAR; MIRAR no se vende

`integrations.enterprise` pasa de `partial` a `implemented`, y su gate cubre
crear credenciales, endpoints y suscripciones. **No** cubre el monitor:
`integration_monitor`, `webhook_monitor` e `integration_health` están fuera del
addon, igual que `/app/operations` desde P13 y por el mismo motivo — un tenant
que no puede ver por qué fallan sus integraciones acaba llamando por teléfono, y
la observabilidad es área de plataforma.

Quien decide **quién** entra es el ROL (`owner`/`admin`), y lo decide la base: la
policy de las tablas y la comprobación dentro de `integration_health`. La
pantalla lo reconoce y pinta tres estados distintos —«no tienes permiso», «no
contratado» y «no hay datos»— porque son tres incidencias distintas para quien da
soporte.

---

## Lo que NO se hizo, y por qué

- **Un endpoint `/v1/invoices`.** Esta app no emite facturas. `invoice.get` es el
  nombre canónico correcto y por eso aparece en este ADR, pero declarar el scope
  sin recurso detrás dejaría una promesa que un socio integraría.
- **Gestión de webhooks por la API de socio.** Un token de integración que
  pudiera darse de alta a sí mismo nuevos destinos de datos es una escalada con
  pasos extra. Los endpoints se administran desde el backoffice, con sesión de
  persona y con auditoría.
- **Un `openapi.json` en el repositorio.** Se genera desde la tabla de rutas —la
  MISMA que despacha— porque una especificación escrita a mano describe la API
  del día que se escribió. Hay un test que compara las dos listas.
- **Percentiles de latencia del socio.** Igual que en P13: con cuatro muestras,
  un percentil es un número con aspecto de estadística. Se da el último éxito, el
  último fallo y los recuentos de 24 h.
- **Levantar el límite anti-bot del checkout para la API.** `POST /v1/orders`
  reusa `public.create_order`, la MISMA función que la vitrina, y por tanto pasa
  por `ebim.assert_checkout_allowed` (P10: 5 pedidos por correo y hora, 20 por
  tienda y hora **por defecto**). Para un socio que vuelca pedidos ese techo se
  queda corto, y es configurable por tienda en
  `store_settings.config -> checkout_rate_limit` **sin migración**. Se deja así a
  propósito en vez de abrir un camino de alta sin límite: dos caminos con dos
  políticas es como se acaba entrando por el que no mira.
- **Planificar el trabajador.** `integration-worker` existe, se autentica con una
  clave dedicada en cabecera y vacía la cola; **quién lo llama cada minuto** es
  configuración del proyecto Supabase y esta fase no despliega (contrato de
  ejecución §11).

---

## Consecuencias

**Buenas.**
Conectar un sistema nuevo es una fila y un adaptador, y hay un test que lo
demuestra con un destino inventado. El primer consumidor real del outbox existe
por fin —hasta P13 el marco estaba completo y sin usar—. El hilo de P13 llega
ahora a dos dominios más (la entrega del aviso y la petición del socio), así que
un pedido creado por un ERP ya no aparece en el rastro «nacido solo».

**A vigilar.**
`api_requests` y `api_idempotency` crecen con el uso y **hay que purgarlas**:
`purge_api_requests`, `purge_api_idempotency` y `purge_api_tokens` existen, pero
quien las llama periódicamente es configuración del proyecto, igual que
`purge_checkout_attempts` desde P10.

**Asumido.**
La Edge Function `api` corre con `service_role`. Es inevitable —no hay sesión que
la RLS pueda mirar— y la mitigación es estructural, no de disciplina: las
funciones de recurso no aceptan el tenant.
