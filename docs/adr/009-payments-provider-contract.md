# ADR 009 — Pagos: contrato canónico de pasarela, comando único e idempotencia en tres cerrojos

- **Fase**: P09-SaaS
- **Fecha**: 2026-08-28
- **Estado**: aceptada
- **Contexto previo**: [ADR 001](001-domain-boundaries.md) (fronteras y `PaymentProvider` como puerto
  declarado), [ADR 002](002-capabilities-entitlements.md) (la capacidad `payments` y su entitlement),
  [ADR 007](007-cart-checkout-pipeline.md) (el pipeline, su etapa 8 y la compensación),
  [ADR 008](008-oms-order-axes-snapshots.md) (el eje `payment_status` y los comandos del pedido).

---

## El criterio de aceptación, leído literalmente

> PASS si el checkout puede usar un provider fake mediante contrato canónico y **añadir un proveedor
> real no requiere modificar el dominio de pedidos**.

La segunda mitad es una propiedad del esquema, no una promesa: `orders` y `order_items` **no ganaron
ni una columna** en esta fase, y hay un test que lo comprueba contra el catálogo de Postgres —no
contra el diff— más otro que verifica la dirección de las claves ajenas: tres FK van del cobro al
pedido y **cero** del pedido al cobro.

Añadir una pasarela real es, exactamente:

1. escribir un adaptador que implemente `PaymentProvider`;
2. registrarlo en `supabase/functions/_shared/payments/registry.ts`;
3. sembrar su fila en `integration_providers` (dato, no migración de dominio).

Ni el pipeline, ni `orders`, ni `create_order`, ni una policy.

---

## Decisión 1 · El dominio de pagos conoce al pedido; el pedido no conoce al pago

Siete tablas nuevas (`payment_methods`, `payment_intents`, `payment_attempts`, `payments`, `refunds`,
`payment_events`, `reconciliation_records`) y **ninguna columna nueva en `orders`**. El eje
`payment_status` que P08 ya tenía es un **espejo**, escrito desde `ebim.payment_sync_order`.

La alternativa —un `orders.payment_intent_id`— parece más simple y cuesta caro: obliga a que el
dominio de pedidos sepa que existe una pasarela, y convierte cada cambio de modelo de cobro en una
migración sobre la tabla más caliente del sistema.

**El espejo no propaga excepciones.** Si el eje del pedido no admite la transición —caso real: un
pedido B2B pendiente de aprobación, cuyos ejes P08 congela a propósito— el cobro **se escribe igual**
y el comando devuelve `order_synced: false` y lo anota en la bitácora. Hacer fallar la transacción
ahí borraría el registro de un dinero que ya se movió para salvar la coherencia de una etiqueta; es
el intercambio equivocado, y hay un test que fija el comportamiento.

## Decisión 2 · Un único comando de entrada, y nadie con sesión escribe dinero

Seis de las siete tablas no tienen GRANT de escritura para `authenticated` ni para `anon`. La única
que se escribe desde el backoffice es `payment_methods`, que es configuración.

Todo resultado de una pasarela entra por **`public.payment_apply_outcome`**, venga de la respuesta
síncrona, de un webhook o de una persona. Que sea uno solo es la propiedad: con dos, uno de los dos
acabaría sin alguna de las reglas de abajo. Es la misma forma que `order_transition` en P08.

## Decisión 3 · Las tres reglas caras se vuelven imposibles de romper en la base

| Regla de la fase | Dónde vive | Qué pasa si se intenta |
|---|---|---|
| 6 · el navegador no decide | `payment_apply_outcome`, `p_source = 'browser_return'` | `RETORNO_NO_DECIDE` (42501). La vuelta del comprador se **registra**; no mueve el estado |
| 4 · webhook firmado | mismo comando, `p_source = 'provider_webhook'` sin `signature_verified` | `FIRMA_NO_VERIFICADA` (42501) |
| 1 · nunca un PAN | CHECK `ebim.jsonb_is_card_safe` con Luhn | el `INSERT` falla **incluso como `service_role`** |
| 2 · los tokens son referencias | CHECK `^[A-Z][A-Z0-9_]{2,80}$` sobre `provider_token_ref` | un token real no cabe: solo cabe un nombre de variable del vault |

El filtro de Luhn no es adorno: sin él, una marca de tiempo de 13 dígitos o un identificador numérico
del proveedor se leerían como tarjeta, el CHECK rechazaría datos legítimos y alguien acabaría
apagándolo. Hay test de los tres casos.

## Decisión 4 · Idempotencia en tres cerrojos independientes

Basta con que aguante uno, y son de naturalezas distintas a propósito:

1. **`payment_events (provider_code, external_event_id)`** — el evento del proveedor ya se vio.
   Devuelve `replay` sin tocar nada.
2. **`payment_attempts (payment_intent_id, operation, idempotency_key)`** — la misma llamada con la
   misma clave es una fila y un solo efecto.
3. **`payments (provider_code, provider_reference)`** — un cobro por referencia, lo pida quien lo
   pida.

Y encima de los tres, la máquina de estados: `captured` es **terminal** para el intento, así que un
segundo aviso con otro identificador de evento sobre el mismo cobro no repite la aritmética. Los
cinco casos están cubiertos por test contra Postgres real.

Una cuarta unicidad, `payment_intents (provider_code, provider_reference)`, impide que una referencia
del proveedor apunte a dos intentos: si pudiera, «¿cuál de los dos cobró este aviso?» no tendría
respuesta.

## Decisión 5 · `timeout` es un resultado de primera clase

No es un `failed` con otro texto. Un tiempo agotado **no dice que no se cobró, dice que no se sabe**,
y de esa diferencia depende si se reintenta o si se consulta el estado. El intento queda en
`processing` y el checkout devuelve `PAGO_NO_DISPONIBLE` (503, reintentable), nunca `PAGO_RECHAZADO`:
decirle al comprador que le rechazaron la tarjeta cuando puede habérsele cobrado es el peor de los
dos errores.

## Decisión 6 · El conector `sandbox` vive en el catálogo global, no en los tests

Un simulador que solo existe en la carpeta de tests demuestra que los tests compilan, no que el
checkout funciona: `payment_methods.provider_code` tiene una FK real y sin fila no hay medio que
crear. `sandbox` es una capacidad del producto —como lo es «hay conector para SAP R/3»— y sirve para
que un tenant pruebe su checkout antes de contratar pasarela, para demos y para que los tests
recorran **el mismo camino** que la producción.

Su comportamiento es determinista y se elige por los **céntimos del importe**, que es como funcionan
los entornos de prueba reales (allí son números de tarjeta; aquí no hay tarjetas que dar):
`.01` rechazo · `.02` tiempo agotado · `.03` 3DS · `.04` captura fallida · `.05` devolución fallida.
Sin reloj, sin azar y sin estado entre llamadas.

## Decisión 7 · La devolución se pide con rol y se ejecuta fuera

`payment_refund_request` es la única función de la fase que llama una persona, y por eso la única con
guarda de rol (`owner`/`admin`/`orders`, con el super admin de suite excluido por contrato). No mueve
dinero: deja la petición, la encola en el `integration_outbox` **que ya existía** —regla 8 de la
fase, nada de una segunda arquitectura— y quien devuelve de verdad es el adaptador.

El único caso sin servidor detrás es la devolución de un medio **offline** (una transferencia que ya
salió del banco). Para eso `payment_refund_settle` está también concedida a `authenticated`, y por
dentro distingue quién llama con `ebim.user_id()` —lo único que sigue diciendo la verdad dentro de un
`SECURITY DEFINER`— para exigir `p_source = 'operator'`, rol, y **negarse** si el medio tiene
pasarela: dar por hecha una devolución que el proveedor no ha ejecutado marca como devuelto un dinero
que no salió.

Nunca un `UPDATE payments SET amount = amount - x`: el cobro conserva su importe y lo devuelto se
acumula aparte, que es lo que permite que la conciliación siga cuadrando meses después.

## Decisión 8 · La conciliación cruza por referencia externa, dentro del tenant

`payment_reconciliation_import` deriva el tenant del **JWT** (`org_id` + `active_company`), nunca de
la firma, y el cruce filtra por tenant **antes** que por referencia. Hay test: el tenant B importa
una referencia que es del tenant A, y no cuadra nada — el cobro de A conserva su liquidación.
Reimportar el mismo extracto sale como «repetidas», no como cuadre doble.

Ningún banco aparece nombrado. `external_reference` y `settlement_date` son el mínimo común de
cualquier liquidación, y el parseo del formato vive en el navegador porque el formato es de quien lo
emite y cambia; lo que la base acepta es una lista de campos con nombre.

---

## Lo que esta fase NO decidió, y por qué

- **Qué pasarela se contrata.** Sigue siendo decisión del operador
  (`docs/SAAS_ROADMAP.md` §5.2.3). El contrato se puede diseñar y validar contra `sandbox`; lo que no
  se puede es inventar el adaptador de un banco que nadie ha elegido.
- **Secreto de webhook POR SOCIEDAD.** Hoy el secreto es por conector y por despliegue
  (`EBIM_PAYMENT_WEBHOOK_SECRET_<CONECTOR>`). Un secreto por sociedad —que es lo deseable, y para lo
  que `tenant_integrations.secret_ref` ya existe— exige que la URL de callback identifique al tenant,
  y esa forma de URL depende de qué pasarela se contrate: la pasarela no puede declararlo, y si lo
  declarara sería un tenant declarado por un tercero. Cuando se cierre la decisión, lo único que
  cambia es de dónde sale `secret` en `payments-webhook/index.ts`.
- **Subir el extracto como fichero.** Exige bucket, política por tenant y antivirus; ninguna de las
  tres decisiones pertenece a pagos. Pegar el extracto resuelve hoy el caso real —cuadrar un día— sin
  comprometer el diseño del día que llegue por integración.
- **Capturar en dos pasos desde la UI.** El modelo lo soporta entero (`capture_mode`, `authorized`
  como estado propio, `payment.capture` como operación) y el comando existe. Lo que no hay es botón:
  un botón de capturar sin pasarela contratada no se puede probar contra nada.
- **`payments.reconciliation` como capacidad vendible aparte.** Sería decidir el empaquetado
  comercial desde el repositorio, y el catálogo comercial es del hub (contrato §5/§6).

## Consecuencias

- El checkout gana un campo opcional en el cuerpo: `payment_method_code`. **No entra en el
  `request_hash`** —el medio es *cómo* se paga, no *qué* se compra— para que un comprador cuya
  tarjeta se rechaza pueda reintentar con transferencia sin que el intento se lea como otra compra.
- `PaymentStatus` del pipeline gana `captured`, y la compensación de la etapa 8 se dispara también
  para él: dinero capturado sin pedido detrás es peor que dinero retenido sin pedido detrás.
- Una tienda sin medios de pago activos sigue funcionando exactamente como antes de P09
  (`not_required`, pedido con el pago pendiente). La capacidad se degrada, no se rompe.
- `src/domain/boundaries.ts` y `app_capabilities` pasan `payments` a `implemented`. La frontera ya
  no está vacía: apunta a `features/payments`.
