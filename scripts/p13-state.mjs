/**
 * Inserta el bloque de P13-SaaS en `docs/STATE.md` y degrada P12 a «Fase
 * anterior».
 *
 * Script de un solo uso, como `p13-messages.mjs`. Existe por lo mismo: el
 * archivo está en CRLF y la inserción es en dos puntos exactos —justo antes del
 * `## Fase actual` y justo sobre el primer `## Fase anterior`—; hacerlo a mano
 * en 3.100 líneas es como se rompe el orden cronológico del documento.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'docs/STATE.md'
const raw = readFileSync(path, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'

if (raw.includes('P13-SaaS — Analítica')) {
  console.log('El bloque de P13 ya está puesto. No se toca nada.')
  process.exit(0)
}

const NUEVO = `## Fase actual
**P13-SaaS — Analítica comercial, auditoría y observabilidad operativa. COMPLETA. Gate: PASS.**
Decisiones completas en [\`docs/adr/013-analytics-audit-observability.md\`](adr/013-analytics-audit-observability.md).

### Gates (2026-08-28, partiendo de \`12fdb74\`)

| Comando | Antes de P13 | Después |
|---|---|---|
| \`npm run typecheck\` | PASS | **PASS** |
| \`npm run lint\` | PASS, 0 problemas | **PASS**, 0 problemas |
| \`npm run test\` | 1934 / 86 archivos | **2079 / 93 archivos** |
| \`npm run test:db\` | 1253 / 39 | **1365 / 43** |
| \`npm run build\` | 942,16 kB (275,75 gzip) | **PASS**, 956,58 kB (279,75 gzip) |

145 tests nuevos, repartidos así:

| Dónde | Cuántos | Qué defienden |
|---|---|---|
| \`supabase/tests/analytics.test.ts\` | 35 | contra Postgres real: que la tabla NO tiene columna de correo, nombre ni cliente; que el identificador de visita se guarda hasheado y no crudo; que un CHECK rechaza un correo o un secreto en el payload aunque lo escriba \`service_role\`; que un hecho no se corrige ni se borra; que la vitrina solo puede declarar tres tipos y no un pedido; que un producto de otra tienda se rechaza; que el lote tiene techo; que un término con un correo se REDACTA en vez de rechazarse; los seis hechos de servidor por trigger —incluido un pedido creado por la puerta de atrás—; y los indicadores: ticket sin pedidos anulados, conversión NULL sin intentos, abandono solo sobre carritos con desenlace, top por SKU, canal, serie con días a cero, aislamiento y el gate \`SIN_MODULO\` |
| \`supabase/tests/audit-log.test.ts\` | 26 | que \`bootstrap_tenant\` —de P02, sin tocar una línea— ya deja rastro; que el actor sale del JWT y \`ebim.audit\` no tiene parámetro de actor; que una escritura directa de \`service_role\` queda registrada igual; que un UPDATE registra solo el diff, sin \`updated_at\`, y uno vacío no registra nada; que \`service_role\` no tiene ni permiso de UPDATE y que quien sí lo tiene choca con el trigger; que no hay FK y el registro sobrevive al borrado; que el código de una tarjeta regalo NO entra y el correo de un cliente se redacta; que la lee \`owner\`/\`admin\` y no un \`viewer\`; el hilo cosido; el marcado \`cross_tenant\`; y las once tablas auditadas exactamente |
| \`supabase/tests/observability.test.ts\` | 26 | el DEFAULT de \`correlation_id\` en las ocho tablas y el GRANT por columna de \`checkout_intents\`; los cuatro fallos proyectados a \`ops_events\`; el mismo fallo repetido como UN incidente con contador; la puerta del borde y su guarda de PII; que \`ops_health\` no acepta tenant, que un \`viewer\` recibe 403 y que la cola de un tenant no aparece en la del otro; atender con rol, con motivo y con auditoría; y **la Definition of Done**: un hilo que recorre siete dominios en orden, con el rastro de otro tenant devolviendo vacío |
| \`supabase/tests/observability-edge.test.ts\` | 25 | el borde en TypeScript puro: el hilo que se respeta si viene y se abre si no, la cabecera con basura que se descarta, el request id que NO hereda; las DOS listas de claves prohibidas comparadas contra el SQL —P09 y P13— para que no se separen; Luhn distinguiendo un PAN de una marca de tiempo; que no hay forma de emitir un contexto sin redactar; que un sink roto no tumba la petición; que lo lento es un hecho aparte; y que \`serveJson\` devuelve el hilo también en el error y en el preflight |
| \`src/features/analytics/analytics-ui.test.tsx\` | 12 | la pantalla: dos tabs, los indicadores tal cual los devolvió la base, el **guion** donde no hay denominador y ni un \`0 %\`, el rango único para las dos pestañas, y la segunda pestaña diciendo «no está en tu plan» al reconocer \`SIN_MODULO\` mientras el resumen sigue funcionando |
| \`src/features/ops/ops-ui.test.tsx\` | 13 | cuatro tabs, que NO está gateada por capacidad, la edad de la cola ya calculada en el servidor, el porcentaje solo con denominador, el 403 que se lee «no tienes permiso» y no «no hay datos», atender exigiendo motivo antes de llegar al servidor, y el salto del incidente al RASTRO con su hilo puesto |
| \`src/features/storefront/analytics.test.ts\` | 8 | el identificador de visita opaco, sin nada dentro y en \`sessionStorage\`; el slug que viaja y el tenant que no; el lote recortado; y que un fallo de la analítica no rompe la tienda |

**Ningún test existente se borró ni se debilitó**; dos expectativas se ampliaron
porque el repo cambió de verdad: la lista de rutas de \`/app\` (entran
\`/app/analytics\` y \`/app/operations\`) y la de entradas de menú que sobreviven a
un tenant sin nada contratado (entra Operación, por el mismo motivo que Ajustes
y Diagnóstico). Y el doble de Supabase ganó \`is\`/\`not\`, implementados de
verdad: un filtro que no filtra daría por buena una pestaña «Abiertos» que
enseña los cerrados.

### El criterio de aceptación, comprobado

> «PASS si un incidente de checkout/integración puede rastrearse end-to-end con
> correlation id y los KPIs mostrados tienen datos reales.»

| Exigencia | Dónde se comprueba |
|---|---|
| **rastreo end-to-end** | el último bloque de \`observability.test.ts\`: una petición con un hilo recorre intento de compra → pedido → cobro rechazado → hecho muerto → mensaje muerto → intento cerrado, y \`trace_by_correlation\` devuelve los **siete dominios en orden cronológico y en una sola consulta**. Sin que ninguna función de dominio acepte un parámetro nuevo |
| **KPIs con datos reales** | \`analytics.test.ts\`: ventas, pedidos, ticket, unidades, conversión, abandono, top de productos y canal salen de \`orders\`, \`order_items\`, \`checkout_intents\` y \`carts\` —filas que ya existían— y no de un evento que el navegador consiga mandar |
| **sin métricas inventadas** | toda razón devuelve NULL sin denominador, y hay un test de interfaz que comprueba que la pantalla pinta guiones y ningún \`0 %\` |
| **sin PII en analítica** | la tabla no tiene columna de identidad, el identificador de visita se guarda en sha256 y el payload pasa por redacción Y por un CHECK |

### Qué se construyó

**Seis migraciones, todas nuevas (ninguna aplicada se tocó):**

| Migración | Qué trae |
|---|---|
| \`160000_observability_correlation\` | el HILO: \`ebim.correlation_id\`, \`ebim.request_id\`, \`ebim.hash_token\`; las guardas de PII (\`pii_json_keys\`, \`looks_like_email\`, \`jsonb_is_pii_free\`, \`redact_pii\`, \`redact_text\`); y \`correlation_id\` como DEFAULT en las OCHO tablas del camino de una compra |
| \`160100_analytics_events\` | los nueve hechos canónicos, append-only y sin PII; \`ebim.record_analytics_event\`; los SEIS triggers de servidor; y \`public.track_events_for_slug\`, la puerta anónima que solo admite tres tipos |
| \`160200_analytics_kpis\` | \`analytics_kpis\`, \`analytics_top_products\`, \`analytics_channel_performance\`, \`analytics_timeseries\` (baseline) y \`analytics_funnel\` + \`analytics_search_terms\` (gateadas por \`ebim.assert_analytics_advanced\`) |
| \`160300_audit_log\` | \`audit_log\` sin FK y append-only para todos; \`ebim.audit\` con el actor derivado del JWT; \`ebim.audit_row\` con columnas tapadas por instalación; \`public.audit_record\` para el borde; y los once triggers |
| \`160400_observability_ops\` | \`ops_events\` y sus cuatro triggers de proyección; \`ops_record_event\`, \`ops_resolve_event\`, \`ops_health\` y \`trace_by_correlation\` |
| \`160500_analytics_capability\` | \`analytics.advanced\` → \`implemented\` y la vista \`ops_incident_overview\` con la edad y las repeticiones ya calculadas |

**Borde**: \`supabase/functions/_shared/observability\` —correlación, redacción,
logger con sinks y el puente con \`ops_events\`—, \`serveJson\` devolviendo el hilo
en toda respuesta, y los clientes de Supabase pasándolo como cabecera global,
que es lo que hace que el DEFAULT de la base lo recoja.

**Backoffice**: \`/app/analytics\` (gateada por \`analytics.basic\`, baseline) con
resumen y comportamiento, y \`/app/operations\` (SIN capacidad, con permiso de
rol) con salud, incidentes, rastro y auditoría.

**Vitrina**: los tres hechos que solo existen en la pantalla —vista de ficha,
búsqueda con su número de resultados y añadido al carrito—, con un identificador
de visita opaco que el servidor hashea antes de guardar.

### Las decisiones que más cuesta revertir

1. **El correlation id es un DEFAULT de columna, no un parámetro.** Ni una línea
   de \`create_order\` cambia y aun así toda fila escrita durante la petición
   queda cosida al mismo hilo. Un DEFAULT no se puede olvidar; el argumento
   número veintiuno, sí.
2. **Seis de los nueve hechos los emite un TRIGGER del servidor.** Un embudo
   cuyo numerador dependa de que el navegador consiga mandar un evento baja
   cuando sube el uso de bloqueadores, y entonces parece que la tienda empeora.
3. **La analítica no tiene columna de identidad y guarda el sha256 de la
   visita.** Sirve para agrupar, no para identificar. Y el payload pasa por
   redacción en la puerta y por un CHECK en la tabla: la puerta se puede rodear,
   el CHECK no.
4. **Toda razón sin denominador devuelve NULL.** Un \`0 %\` de conversión se lee
   como «la tienda no vende»; un guion, como «todavía no hay con qué
   calcularlo», que es lo que pasa de verdad.
5. **La auditoría son triggers y el actor sale del JWT.** Un trigger registra la
   escritura venga de donde venga; una llamada dentro del comando solo registra
   a quien pasa por el comando. Y un actor que fuera parámetro sería un campo de
   texto que rellena quien opera.
6. **\`audit_log\` y \`analytics_events\` son append-only para TODOS**, incluido
   \`service_role\`. La consecuencia se asume: no hay purga, y la retención será
   una migración propia con su propia autorización.
7. **El código de una tarjeta regalo no entra en la bitácora**, por un tercer
   argumento del trigger y no ampliando la lista global: \`code\` es dato de
   negocio en media docena de tablas.
8. **Los logs técnicos NO viven en \`analytics_events\`.** Un pico de reintentos
   de un conector no puede ensuciar una tasa de conversión ni compartir
   retención con ella.
9. **La observabilidad es área de PLATAFORMA y no se vende.** Quien no puede ver
   por qué le fallan los cobros acaba llamando por teléfono. Lo vendible es el
   comportamiento del comprador (\`analytics.advanced\`), y su gate vive en la
   base, no en la pantalla.
10. **\`ops_health\` no acepta tenant.** No existe el parámetro que habría que
    validar: lo deriva del JWT y filtra cada rama por él.

### Lo que NO se hizo, y por qué

- **Cohortes.** \`capabilities.ts\` las prometía y no se fingen: exigirían seguir a
  un comprador identificado en el tiempo, y esta analítica se guarda sin PII a
  propósito. Escrito en el ADR en vez de dejar una función vacía.
- **Percentiles de latencia.** \`ops_health\` da el número de operaciones lentas y
  la peor, no un p95: con cuatro muestras, un percentil es un número con aspecto
  de estadística.
- **Purga y retención.** Es una decisión de negocio y de cumplimiento, y se toma
  con su propia migración y su propia autorización.
- **Incidentes de webhook sin tenant.** Un aviso cuya firma no valida no se puede
  atribuir a ninguna sociedad —justamente porque no se pudo verificar— y
  \`ops_events\` es tenant-scoped. Se queda en el log estructurado, con su hilo;
  escribirlo en un tenant adivinado sería peor.
- **Un consumidor del outbox.** \`ops_health\` mide la profundidad de las colas;
  quién las vacía sigue siendo trabajo de P14, igual que después de P07.

- **Buzón EBIM**: revisado el 2026-08-28. Sin mensajes \`to: ecommerce\` ni
  \`to: all\` nuevos desde el 2026-08-20, y sigue sin poderse responder:
  \`ecommerce\` no es todavía un \`from\` válido del \`PROTOCOLO.md\` (§5.1 del
  roadmap, bloqueo del operador).

Siguiente: **P14-SaaS**.

---

## Fase anterior
**P12-SaaS — Fulfillment, logística, ventanas de entrega y devoluciones. COMPLETA. Gate: PASS.**`

const out = raw
  .replace(
    `## Fase actual${eol}**P12-SaaS — Fulfillment, logística, ventanas de entrega y devoluciones. COMPLETA. Gate: PASS.**`,
    NUEVO.split('\n').join(eol),
  )
  .replace(
    `Última actualización: 2026-08-28 (P12-SaaS: fulfillment, logística y devoluciones)`,
    `Última actualización: 2026-08-28 (P13-SaaS: analítica, auditoría y observabilidad)`,
  )

if (out === raw) throw new Error('No se encontró el bloque de P12 que había que degradar')
writeFileSync(path, out, 'utf8')
console.log('STATE.md actualizado con P13-SaaS.')
