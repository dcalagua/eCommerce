/**
 * platform-context — proxy del Platform Context API del hub (contrato §5).
 *
 * Es la ÚNICA pieza que habla con el hub. El navegador nunca lo hace: la
 * credencial servicio-a-servicio vive aquí y en ningún otro sitio, y por eso
 * también es aquí donde se escribe la cache de entitlements que la app lee
 * después bajo RLS (§7: «Lectura de addons/config (cache del context)»).
 *
 * Dos llamadores, dos credenciales — mismo patrón que `bootstrap-tenant`:
 *
 *  · **usuario con sesión** → su JWT. Pide `{ action: 'refresh' }` y la función
 *    consulta el hub para SU organización. El tenant sale del token, nunca del
 *    cuerpo.
 *  · **operador** → clave de aprovisionamiento en CABECERA. Escribe el contexto
 *    a mano, con `source: 'provisioning'`. Existe porque `ecommerce` todavía no
 *    está dado de alta en la suite (SAAS_ROADMAP §5.1) y sin ese camino no
 *    habría forma de activar un módulo sin tocar código. Se retira cuando el
 *    hub responda.
 *
 * La escritura NO es un upsert suelto: pasa por `public.sync_platform_context`,
 * que reemplaza el conjunto entero en una transacción. Un addon que el hub deja
 * de devolver se apaga, que es la mitad que se olvida y produce el tenant que
 * sigue usando lo que ya no paga.
 */
import { assertNotSuiteOperator, requireProvisioningKey, requireTenantContext } from '../_shared/auth.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { fromDatabaseError } from '../_shared/errors.ts'
import { serveJson } from '../_shared/http.ts'
import type { Trace } from '../_shared/observability/index.ts'
import {
  contextMode,
  hubContextUrl,
  hubNotConfigured,
  hubUnavailable,
  parseProvisioningSync,
  syncFromHubContext,
  type ContextSync,
} from '../_shared/platform-context.ts'
import { serviceClient } from '../_runtime/clients.ts'

/** 8 s: un hub lento no puede dejar colgado el arranque del backoffice. */
const HUB_TIMEOUT_MS = 8_000

async function readHubContext(organizationId: string): Promise<unknown> {
  const base = Deno.env.get('EBIM_HUB_CONTEXT_URL')
  const key = Deno.env.get('EBIM_HUB_SERVICE_KEY')
  if (!base || !key) throw hubNotConfigured()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HUB_TIMEOUT_MS)
  try {
    const response = await fetch(
      hubContextUrl(base, organizationId, Deno.env.get('EBIM_APP_SLUG') ?? 'ecommerce'),
      {
        method: 'GET',
        // La credencial en CABECERA, jamás en la URL: la URL queda en logs,
        // en el `Referer` y en cualquier proxy por el que pase.
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
      },
    )
    if (!response.ok) {
      throw hubUnavailable(`El hub respondio ${response.status}`)
    }
    return await response.json()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw hubUnavailable('El hub no respondio a tiempo')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function applySync(rows: ContextSync[], trace?: Trace): Promise<void> {
  const client = serviceClient(trace)
  for (const row of rows) {
    const { error } = await client.rpc('sync_platform_context', {
      p_organization_id: row.organizationId,
      p_company_id: row.companyId,
      p_app_active: row.appActive,
      p_entitlements: row.entitlements,
      p_source: row.source,
      p_plan: row.plan,
    })
    if (error) throw fromDatabaseError(error)
  }
}

const handler = serveJson(
  {
    allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_ADMIN_ORIGINS')),
    service: 'platform-context',
  },
  async ({ request, body, trace }) => {
    if (contextMode(request) === 'provisioning') {
      requireProvisioningKey(request, Deno.env.get('EBIM_PROVISIONING_KEY'))
      const row = parseProvisioningSync(body)
      await applySync([row], trace)
      return {
        status: 200,
        body: {
          data: {
            source: row.source,
            organization_id: row.organizationId,
            company_id: row.companyId,
            app_active: row.appActive,
            entitlements: row.entitlements,
          },
        },
      }
    }

    const { context } = requireTenantContext(request)
    // Una cuenta @ebim.pe no opera datos de negocio de un tenant (contrato §13),
    // y refrescar entitlements de un cliente lo es.
    assertNotSuiteOperator(context.email)

    const payload = await readHubContext(context.organizationId)
    const rows = syncFromHubContext(payload, context.organizationId)
    await applySync(rows, trace)

    return {
      status: 200,
      body: {
        data: {
          source: 'hub',
          organization_id: context.organizationId,
          companies: rows.length,
        },
      },
    }
  },
)

Deno.serve(handler)
