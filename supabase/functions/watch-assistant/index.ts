/**
 * watch-assistant — «Ejecutar análisis» del centro de vigilancia.
 *
 * El panel funciona sin esta función: los avisos y sus cifras los calcula
 * `public.watch_findings` con reglas de SQL y el JWT de quien mira. Esto añade
 * lo único que SQL no sabe hacer —en qué orden atacarlos y por qué— y por eso
 * es un botón, no un automatismo: cada análisis gasta una consulta de IA de la
 * sociedad.
 *
 * Lo que ve el modelo: la clave, el módulo y la severidad de cada aviso. Ni una
 * cifra, ni un número de pedido, ni un nombre de cliente. Lo que puede
 * devolver: un orden que es permutación exacta de esas claves y una frase por
 * aviso, sin dígitos (`revisarAnalisis`).
 *
 * Se degrada como el resto: sin clave, sin contratar, sin cuota o con el
 * proveedor caído responde 200 con `data: null` y un motivo tipado; la lista
 * determinista se queda como estaba.
 */
import { assertNotSuiteOperator, requireTenantContext } from '../_shared/auth.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { fromDatabaseError } from '../_shared/errors.ts'
import { serveJson } from '../_shared/http.ts'
import { optionalUuid, rejectUnknownFields, requireEnum } from '../_shared/validation.ts'
import { userClient } from '../_runtime/clients.ts'
import { hayProveedorIA, pedirJson } from '../_runtime/anthropic.ts'
import { medidorDeUsuario } from '../_runtime/aiMeter.ts'
import { sistemaConFrontera } from '../_shared/aiCore.ts'
import { cuerpoIA, ejecutarIA } from '../_shared/aiPipeline.ts'
import {
  ESQUEMA_ANALISIS,
  MAX_HALLAZGOS,
  SISTEMA_ANALISIS,
  datosParaModelo,
  revisarAnalisis,
  type AnalisisRevisado,
  type HallazgoParaModelo,
  type RespuestaModeloAnalisis,
} from '../_shared/aiWatch.ts'

const FEATURE = 'insights'
const ALLOWED_FIELDS = ['store_id', 'locale'] as const
const LOCALES = ['es', 'en'] as const

const handler = serveJson(
  {
    allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_ADMIN_ORIGINS')),
    service: 'watch-assistant',
  },
  async ({ request, body, trace }) => {
    const { context } = requireTenantContext(request)
    assertNotSuiteOperator(context.email)

    rejectUnknownFields(body, ALLOWED_FIELDS)
    const storeId = optionalUuid(body, 'store_id')
    const locale = body.locale === undefined ? 'es' : requireEnum(body, 'locale', LOCALES)

    const client = userClient(request, trace)

    // Los avisos salen de la MISMA función que pinta el panel, con el JWT del
    // usuario: rol, módulo contratado y RLS ya decidieron qué existe para él.
    const { data: raw, error } = await client.rpc('watch_findings', { p_store_id: storeId })
    if (error) throw fromDatabaseError(error)

    const items = Array.isArray((raw as { items?: unknown })?.items)
      ? ((raw as { items: unknown[] }).items as Array<Record<string, unknown>>)
      : []
    const hallazgos: HallazgoParaModelo[] = items
      .slice(0, MAX_HALLAZGOS)
      .filter((item) => typeof item.key === 'string')
      .map((item) => ({
        key: String(item.key),
        module: String(item.module ?? ''),
        severity: String(item.severity ?? ''),
      }))

    // Nada que ordenar no es una pregunta para un modelo: no se gasta cuota.
    if (hallazgos.length === 0) {
      return { status: 200, body: { data: { data: null, motivo: 'vacia', interaction_id: null } } }
    }

    const medidor = medidorDeUsuario(client)
    const resultado = await ejecutarIA<RespuestaModeloAnalisis, AnalisisRevisado>(
      {
        feature: FEATURE,
        prompt: `vigilancia · ${hallazgos.map((h) => h.key).join(',')}`,
        revisar: (data) => {
          const revision = revisarAnalisis(data, hallazgos)
          if (!revision.ok) return { ok: false, motivo: revision.motivo }
          return { ok: true, value: revision.value, reply: revision.value.headline }
        },
      },
      {
        hayProveedor: hayProveedorIA,
        consumir: medidor.consumir,
        registrar: medidor.registrar,
        llamar: () =>
          pedirJson<RespuestaModeloAnalisis>({
            feature: FEATURE,
            system: sistemaConFrontera(SISTEMA_ANALISIS),
            user: datosParaModelo(hallazgos, locale),
            schema: ESQUEMA_ANALISIS,
          }),
      },
    )

    return { status: 200, body: { data: cuerpoIA(resultado) } }
  },
)

Deno.serve(handler)
