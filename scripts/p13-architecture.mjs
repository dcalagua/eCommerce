/**
 * Actualiza `docs/architecture.md` con lo que P13-SaaS añade.
 *
 * Script de un solo uso, igual que `p13-state.mjs`. Cuatro inserciones exactas
 * en un documento de 800 líneas en CRLF: hacerlas a mano es como se deja el
 * mapa diciendo «pendiente de fases siguientes: audit_log» un año después de
 * que exista.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'docs/architecture.md'
const raw = readFileSync(path, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'

if (raw.includes('P13-SaaS')) {
  console.log('La arquitectura ya menciona P13. No se toca nada.')
  process.exit(0)
}

/** Reemplazo exacto: si el ancla no está, es que el documento cambió y hay que mirarlo. */
function replace(text, anchor, next) {
  const a = anchor.split('\n').join(eol)
  const b = next.split('\n').join(eol)
  if (!text.includes(a)) throw new Error(`Ancla no encontrada: ${anchor.slice(0, 60)}…`)
  return text.replace(a, b)
}

let out = raw

// 1 · El modelo de datos deja de tener un pendiente que ya no lo es.
out = replace(
  out,
  `- Pendiente de fases siguientes: \`audit_log\`. (\`customers\` llegó en P05-SaaS; los almacenes y las
  reservas, en P06-SaaS; \`carts\`, \`checkout_intents\` y \`domain_events\`, en P07-SaaS; la línea de
  tiempo del pedido, sus anotaciones y sus referencias externas, en P08-SaaS; las siete tablas del
  cobro, en P09-SaaS; las campañas, los cupones y las tarjetas regalo, en P10-SaaS;
  las páginas, los bloques y los sinónimos de búsqueda, en P11-SaaS.)`,
  `- El recorrido de las tablas: \`customers\` llegó en P05-SaaS; los almacenes y las reservas, en
  P06-SaaS; \`carts\`, \`checkout_intents\` y \`domain_events\`, en P07-SaaS; la línea de tiempo del
  pedido, sus anotaciones y sus referencias externas, en P08-SaaS; las siete tablas del cobro, en
  P09-SaaS; las campañas, los cupones y las tarjetas regalo, en P10-SaaS; las páginas, los bloques y
  los sinónimos de búsqueda, en P11-SaaS; las quince de la entrega y la devolución, en P12-SaaS; y
  \`analytics_events\`, \`audit_log\` y \`ops_events\` en P13-SaaS. **\`audit_log\` deja de ser un
  pendiente**: existe desde P13 y es append-only para todos, incluido \`service_role\`.`,
)

// 2 · La sección nueva, justo antes de la de capacidades.
out = replace(
  out,
  `### Capacidades y entitlements (P02-SaaS)`,
  `### Analítica, auditoría y observabilidad (P13-SaaS)

Tres tablas más, migraciones \`20260828160000\`–\`20260828160500\`. Decisiones completas en
[\`adr/013-analytics-audit-observability.md\`](adr/013-analytics-audit-observability.md).

\`\`\`
EL HILO (ninguna tabla nueva: una COLUMNA en las ocho del camino de una compra)
  checkout_intents · orders · payment_intents · payment_events · fulfillments
  domain_events · integration_outbox · integration_inbox
        └── correlation_id  default ebim.correlation_id()

LO QUE PASA (comercio)
  analytics_events        los nueve hechos canónicos, append-only y SIN PII

QUIÉN LO HIZO (transversal)
  audit_log               actor, acción, entidad, momento, tenant e hilo. Sin FK

QUÉ SE ROMPIÓ (operación)
  ops_events ──── ops_incident_overview   edad y repeticiones ya calculadas
\`\`\`

- **El \`correlation_id\` es un DEFAULT de columna, no un parámetro.** Es lo que permite coser una
  petición entera sin tocar \`create_order\` ni ninguna de las otras once funciones de dominio.
  \`ebim.correlation_id()\` lo lee de \`set_config\` o de la cabecera \`x-correlation-id\` que PostgREST
  publica en \`request.headers\`; **no lo inventa**: sin hilo, la columna queda en NULL.
- **Seis de los nueve hechos los emite un TRIGGER del servidor** —checkout iniciado y completado,
  pedido creado y entregado, carrito abandonado y campaña canjeada—; la vitrina solo puede declarar
  \`product_view\`, \`search\` y \`add_to_cart\`, y \`public.track_events_for_slug\` rechaza el resto con
  \`ANALYTICS_EVENTO_NO_PERMITIDO\`. Un embudo que el navegador puede falsear no sirve para decidir.
- **La analítica no puede guardar a una persona**: sin columna de correo, nombre ni cliente; lo que
  identifica una visita es el **sha256** de un identificador opaco. \`props\` y \`search_term\` pasan por
  \`ebim.redact_pii\` en la puerta Y por un CHECK en la tabla.
- **Toda razón devuelve NULL sin denominador**, nunca \`0 %\`: conversión (sobre \`checkout_intents\`),
  abandono (sobre \`carts\` con desenlace) y ticket promedio. Misma regla que la moneda mezclada de
  \`dashboard_kpis\` desde P03.
- **La auditoría son triggers sobre once tablas sensibles**, no llamadas dentro de cada comando: un
  trigger registra la escritura venga de donde venga. El actor sale del JWT y \`ebim.audit\` no tiene
  parámetro de actor. Quedan fuera —y por escrito— los dominios que ya llevan su propia bitácora.
- **\`ops_events\` es una proyección**, no una segunda verdad: la fila que manda sigue siendo la del
  dominio. Existe para que los cuatro fallos tengan la MISMA forma y para dar sitio a las dos señales
  que solo ocurren en el borde —operación lenta y webhook rechazado—.
- **\`ops_health\` no acepta tenant**: lo deriva del JWT, así que no hay parámetro que validar. La
  lectura exige \`owner\`/\`admin\`, igual que \`audit_log\` y \`ops_events\`.
- **\`public.trace_by_correlation\`** une once tablas y siete dominios en una consulta, filtrando cada
  rama por \`ebim.can_access\`. Es la Definition of Done de la fase escrita como función.

### Capacidades y entitlements (P02-SaaS)`,
)

// 3 · Las dos carpetas nuevas del frontend.
out = replace(
  out,
  `  features/storefront/  vitrina pública: resolución por slug, catálogo, ficha, carrito/checkout`,
  `  features/analytics/   el cuadro de mando (P13-SaaS): ventas, pedidos, ticket, conversión,
                        abandono, productos y canal —todo de \`orders\`, baseline— y el embudo
                        con los términos de búsqueda, gateados por \`analytics.advanced\` DESDE
                        LA BASE. No escribe ninguna tabla: la analítica se lee
  features/ops/         la operación (P13-SaaS): salud del tenant, incidentes con su edad ya
                        calculada, RASTRO por correlation id y auditoría. SIN capacidad —igual
                        que Ajustes y Diagnóstico— y con permiso de rol. Lo único que escribe
                        es atender un incidente, y no es un \`update\`: es un comando
  features/storefront/  vitrina pública: resolución por slug, catálogo, ficha, carrito/checkout`,
)

// 4 · El emisor de los tres hechos de vitrina.
out = replace(
  out,
  `                        + delivery.ts / DeliveryPicker (P12-SaaS): envío, recojo, reparto`,
  `                        + analytics.ts (P13-SaaS): los TRES hechos que solo existen en la
                          pantalla —vista de ficha, búsqueda con su número de resultados y
                          añadido al carrito—, con un identificador de visita opaco en
                          \`sessionStorage\` que el servidor hashea antes de guardar. Dispara y
                          olvida: si la analítica falla, la tienda no se entera
                        + delivery.ts / DeliveryPicker (P12-SaaS): envío, recojo, reparto`,
)

// 5 · El módulo de observabilidad del borde.
out = replace(
  out,
  `  functions/   Edge Functions (Deno) + _shared/`,
  `  functions/   Edge Functions (Deno) + _shared/
               _shared/observability: el hilo, la redacción, el logger con SINKS y el
               puente con \`ops_events\`. Sin un solo vendor dentro: cambiar de
               proveedor es registrar un sink más`,
)

// 6 · El encabezado del modelo de datos.
out = replace(
  out,
  `## Modelo de datos (implementado hasta P12-SaaS)`,
  `## Modelo de datos (implementado hasta P13-SaaS)`,
)

writeFileSync(path, out, 'utf8')
console.log('architecture.md actualizado con P13-SaaS.')
