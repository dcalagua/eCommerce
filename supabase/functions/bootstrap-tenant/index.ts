/**
 * bootstrap-tenant — alta de un tenant de eCommerce.
 *
 * Crea tenant + membresía `owner` + tienda + settings de forma ATÓMICA: todo
 * ocurre dentro de `ebim.bootstrap_tenant`, una sola función y por tanto una
 * sola transacción. Si algo falla, no queda un tenant a medias.
 *
 * Autorización: clave de aprovisionamiento en CABECERA (`x-ebim-provisioning-key`),
 * nunca en la URL — patrón del contrato §2.6. Es una operación de servidor
 * (consola del operador / alta desde el hub), no una acción de un usuario final.
 *
 * Contrato §3.2: sin `admin_email` no hay alta. Se valida aquí Y en la base.
 */
import { requireProvisioningKey } from '../_shared/auth.ts'
import { fromDatabaseError } from '../_shared/errors.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { serveJson } from '../_shared/http.ts'
import {
  requireEmail,
  requireSlug,
  requireText,
  requireUuid,
  rejectUnknownFields,
} from '../_shared/validation.ts'
import { serviceClient } from '../_runtime/clients.ts'

const ALLOWED_FIELDS = [
  'organization_id',
  'company_id',
  'tenant_slug',
  'tenant_name',
  'admin_email',
  'owner_user_id',
  'store_slug',
  'store_name',
  'currency',
] as const

const handler = serveJson(
  { allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_ADMIN_ORIGINS')) },
  async ({ request, body }) => {
    requireProvisioningKey(request, Deno.env.get('EBIM_PROVISIONING_KEY'))
    rejectUnknownFields(body, ALLOWED_FIELDS)

    // Aquí `organization_id`/`company_id` SÍ vienen en el cuerpo, y es correcto:
    // esta es la operación que da de alta ese tenant, así que no existe todavía
    // un token del que derivarlo. La credencial que autoriza es la clave de
    // aprovisionamiento; el resto de funciones deriva el tenant del JWT.
    const payload = {
      p_organization_id: requireUuid(body, 'organization_id'),
      p_company_id: requireUuid(body, 'company_id'),
      p_tenant_slug: requireSlug(body, 'tenant_slug'),
      p_tenant_name: requireText(body, 'tenant_name', { min: 2, max: 200 }),
      p_admin_email: requireEmail(body, 'admin_email'),
      p_owner_user_id: requireUuid(body, 'owner_user_id'),
      p_store_slug: requireSlug(body, 'store_slug'),
      p_store_name: requireText(body, 'store_name', { min: 2, max: 200 }),
      p_currency: (requireText(body, 'currency', { min: 3, max: 3 }) || 'PEN').toUpperCase(),
    }

    const { data, error } = await serviceClient().rpc('bootstrap_tenant', payload)

    if (error) throw fromDatabaseError(error)

    return { status: 201, body: { data } }
  },
)

Deno.serve(handler)
