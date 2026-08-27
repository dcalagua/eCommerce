/**
 * bootstrap-tenant — alta de un tenant de eCommerce.
 *
 * Crea tenant + membresía `owner` + tienda + settings de forma ATÓMICA: todo
 * ocurre dentro de `public.bootstrap_tenant`, una sola función y por tanto una
 * sola transacción. Si algo falla, no queda un tenant a medias.
 *
 * Dos llamadores, dos credenciales (ver `_shared/bootstrap.ts`):
 *   · operador → clave de aprovisionamiento en CABECERA (nunca en la URL,
 *     patrón del contrato §2.6); los uuid del tenant vienen en el cuerpo porque
 *     todavía no existe token del que derivarlos.
 *   · usuario que crea su propio espacio (P03) → su JWT del hub, con la firma
 *     VERIFICADA antes de tocar `service_role`; el tenant sale de los claims.
 *
 * Contrato §3.2: sin `admin_email` no hay alta. Se valida en los dos caminos Y
 * en la base.
 */
import { requireProvisioningKey } from '../_shared/auth.ts'
import {
  bootstrapMode,
  buildProvisioningPayload,
  buildSelfServicePayload,
} from '../_shared/bootstrap.ts'
import { fromDatabaseError } from '../_shared/errors.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { serveJson } from '../_shared/http.ts'
import { serviceClient } from '../_runtime/clients.ts'
import { verifyHubToken } from '../_runtime/verify.ts'

const handler = serveJson(
  { allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_ADMIN_ORIGINS')) },
  async ({ request, body }) => {
    let payload
    if (bootstrapMode(request) === 'provisioning') {
      requireProvisioningKey(request, Deno.env.get('EBIM_PROVISIONING_KEY'))
      payload = buildProvisioningPayload(body)
    } else {
      payload = buildSelfServicePayload(body, await verifyHubToken(request))
    }

    const { data, error } = await serviceClient().rpc('bootstrap_tenant', payload)

    if (error) throw fromDatabaseError(error)

    return { status: 201, body: { data } }
  },
)

Deno.serve(handler)
