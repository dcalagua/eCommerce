/**
 * Autorización y armado del alta de tenant.
 *
 * `bootstrap-tenant` tiene DOS llamadores legítimos y ninguno se parece al otro:
 *
 *   1. **Aprovisionamiento** (consola del operador / alta desde el hub): no hay
 *      usuario todavía, así que la credencial es la clave dedicada en cabecera
 *      y los uuid del tenant vienen en el cuerpo. Es el único sitio del proyecto
 *      donde eso es correcto, precisamente porque el tenant aún no existe.
 *
 *   2. **Alta de sí mismo** (P03): un usuario ya autenticado por el hub que
 *      todavía no tiene espacio en eCommerce. Aquí SÍ hay token, así que se
 *      aplica la regla de siempre: `organization_id`/`company_id` salen del JWT
 *      y un identificador de tenant en el cuerpo se rechaza con 400.
 *
 * La lógica de decisión vive aquí, en TypeScript puro, para que se pueda probar
 * sin levantar Deno. La verificación de firma vive en `_runtime/verify.ts`.
 */
import {
  assertNoTenantInPayload,
  assertNotSuiteOperator,
  tenantContext,
  type HubClaims,
} from './auth.ts'
import { badRequest, unauthorized } from './errors.ts'
import {
  optionalCurrency,
  rejectUnknownFields,
  requireEmail,
  requireSlug,
  requireText,
  requireUuid,
} from './validation.ts'

export const PROVISIONING_HEADER = 'x-ebim-provisioning-key'

/** Campos admitidos en el alta desde el operador. */
export const PROVISIONING_FIELDS = [
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

/**
 * Campos admitidos en el alta de sí mismo. Deliberadamente cortos: el nombre
 * del negocio, el slug de su tienda y la moneda. Todo lo demás —quién es, a qué
 * cuenta pertenece, con qué correo— lo dice el token, no el formulario.
 */
export const SELF_SERVICE_FIELDS = ['tenant_name', 'store_name', 'store_slug', 'currency'] as const

export type BootstrapMode = 'provisioning' | 'self-service'

export interface BootstrapPayload {
  p_organization_id: string
  p_company_id: string
  p_tenant_slug: string
  p_tenant_name: string
  p_admin_email: string
  p_owner_user_id: string
  p_store_slug: string
  p_store_name: string
  p_currency: string
}

/**
 * Decide con qué credencial se está llamando. La clave de aprovisionamiento
 * manda: si viene, el camino es el del operador aunque además haya sesión.
 * Sin ninguna de las dos, 401 — nunca un alta anónima.
 */
export function bootstrapMode(request: Request): BootstrapMode {
  if (request.headers.get(PROVISIONING_HEADER)) return 'provisioning'
  if (request.headers.get('authorization')) return 'self-service'
  throw unauthorized(
    'El alta exige la clave de aprovisionamiento o la sesion del usuario que crea su espacio',
  )
}

export function buildProvisioningPayload(body: Record<string, unknown>): BootstrapPayload {
  rejectUnknownFields(body, PROVISIONING_FIELDS)

  // Aquí `organization_id`/`company_id` SÍ vienen en el cuerpo, y es correcto:
  // esta es la operación que da de alta ese tenant, así que no existe todavía
  // un token del que derivarlo. La credencial que autoriza es la clave.
  return {
    p_organization_id: requireUuid(body, 'organization_id'),
    p_company_id: requireUuid(body, 'company_id'),
    p_tenant_slug: requireSlug(body, 'tenant_slug'),
    p_tenant_name: requireText(body, 'tenant_name', { min: 2, max: 200 }),
    p_admin_email: requireEmail(body, 'admin_email'),
    p_owner_user_id: requireUuid(body, 'owner_user_id'),
    p_store_slug: requireSlug(body, 'store_slug'),
    p_store_name: requireText(body, 'store_name', { min: 2, max: 200 }),
    p_currency: optionalCurrency(body, 'currency'),
  }
}

/**
 * Alta de sí mismo. El orden de las comprobaciones importa:
 * primero se rechaza un tenant declarado (mensaje específico), luego se cierra
 * el resto del cuerpo, y solo después se lee el token.
 */
export function buildSelfServicePayload(
  body: Record<string, unknown>,
  claims: HubClaims,
): BootstrapPayload {
  assertNoTenantInPayload(body)
  rejectUnknownFields(body, SELF_SERVICE_FIELDS)

  const context = tenantContext(claims)

  // Contrato §13: un `@ebim.pe` no es actor de negocio de un tenant, así que
  // tampoco puede crearse uno. La base lo repite; esto solo da mejor mensaje.
  assertNotSuiteOperator(context.email)

  // Contrato §3.2: sin correo de administrador no hay alta. En este camino el
  // correo es el del propio dueño, y si el token no lo trae, el alta falla aquí
  // en vez de inventar uno.
  if (!context.email) {
    throw badRequest('ADMIN_EMAIL_REQUERIDO', 'El token no trae el correo del administrador')
  }

  const storeSlug = requireSlug(body, 'store_slug')
  const tenantName = requireText(body, 'tenant_name', { min: 2, max: 200 })
  const storeName =
    body.store_name === undefined || body.store_name === null
      ? tenantName
      : requireText(body, 'store_name', { min: 2, max: 200 })

  return {
    p_organization_id: context.organizationId,
    p_company_id: context.companyId,
    // El espacio y su primera tienda comparten slug: son tablas distintas con
    // unicidad propia, y pedirle dos slugs a quien está dando de alta su
    // negocio es pedirle que decida algo que todavía no sabe.
    p_tenant_slug: storeSlug,
    p_tenant_name: tenantName,
    p_admin_email: context.email,
    p_owner_user_id: context.userId,
    p_store_slug: storeSlug,
    p_store_name: storeName,
    p_currency: optionalCurrency(body, 'currency'),
  }
}
