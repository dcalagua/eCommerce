/**
 * Derivación de tenant. Regla única y no negociable del contrato EBIM §2.2/§3:
 * `organization_id` y `company_id` salen del JWT. Nunca del body, del header,
 * de la query ni de localStorage.
 */
import { AppError, badRequest, forbidden, unauthorized } from './errors.ts'

export type HubCompany = { id: string; role?: string }

export type HubClaims = {
  sub: string
  email?: string
  org_id: string
  companies: HubCompany[]
  active_company?: string
  apps?: string[]
  exp?: number
}

export type TenantContext = {
  userId: string
  email: string
  organizationId: string
  companyId: string
  companies: string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Campos que jamás pueden llegar del cliente: el tenant no se declara. */
export const TENANT_FIELDS = [
  'organization_id',
  'organizationId',
  'company_id',
  'companyId',
  'tenant_id',
  'tenantId',
  'org_id',
  'orgId',
  'active_company',
] as const

/**
 * Si el cuerpo trae un identificador de tenant, se RECHAZA con 400. No se
 * ignora en silencio: ignorar deja a quien llama creyendo que su valor se usó
 * y el error aparece en producción (contrato §2.6).
 */
export function assertNoTenantInPayload(body: Record<string, unknown>): void {
  const offenders = TENANT_FIELDS.filter((field) => field in body)
  if (offenders.length > 0) {
    throw badRequest(
      'TENANT_NO_ADMITIDO',
      `El tenant se deriva del token, no del cuerpo. Campos rechazados: ${offenders.join(', ')}`,
    )
  }
}

export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match || !match[1]) throw unauthorized('Falta la cabecera Authorization: Bearer')
  return match[1].trim()
}

function decodeSegment(segment: string): unknown {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * Lee los claims de un JWT ya verificado por Supabase.
 *
 * IMPORTANTE: esto NO verifica la firma. Es válido únicamente en el camino en
 * el que la consulta viaja después con el mismo token y la RLS vuelve a
 * decidir (cliente con clave publicable + Authorization del usuario). En el
 * camino `service_role`, que salta RLS, no se usa esta función como
 * autorización — ver `requireProvisioningKey`.
 */
export function decodeClaims(token: string): HubClaims {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) throw unauthorized('El token no es un JWT')

  let payload: unknown
  try {
    payload = decodeSegment(parts[1])
  } catch {
    throw unauthorized('El token no se puede leer')
  }

  if (!payload || typeof payload !== 'object') throw unauthorized('Claims vacios')
  const claims = payload as Partial<HubClaims>

  if (typeof claims.sub !== 'string' || !UUID_RE.test(claims.sub)) {
    throw unauthorized('El token no trae un `sub` valido')
  }
  if (typeof claims.org_id !== 'string' || !UUID_RE.test(claims.org_id)) {
    throw forbidden('El token no trae `org_id`: el usuario no pertenece a ninguna cuenta')
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
    throw unauthorized('El token esta expirado')
  }

  const companies = Array.isArray(claims.companies)
    ? claims.companies
        .map((item) => (typeof item === 'string' ? { id: item } : item))
        .filter((item): item is HubCompany => Boolean(item && UUID_RE.test(String(item.id))))
    : []

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined,
    org_id: claims.org_id,
    companies,
    active_company: typeof claims.active_company === 'string' ? claims.active_company : undefined,
    apps: Array.isArray(claims.apps) ? claims.apps.filter((a) => typeof a === 'string') : [],
  }
}

/**
 * Contexto de tenant efectivo. La sociedad activa tiene que estar en
 * `companies[]`: un `active_company` suelto no vale nada.
 */
export function tenantContext(claims: HubClaims): TenantContext {
  const companies = claims.companies.map((c) => c.id)
  if (companies.length === 0) {
    throw forbidden('El usuario no tiene sociedades asignadas')
  }

  const active = claims.active_company ?? companies[0]
  if (!active || !companies.includes(active)) {
    throw forbidden('La sociedad activa no esta entre las sociedades del usuario')
  }

  return {
    userId: claims.sub,
    email: claims.email ?? '',
    organizationId: claims.org_id,
    companyId: active,
    companies,
  }
}

/** Atajo del camino habitual: token → claims → contexto. */
export function requireTenantContext(request: Request): {
  token: string
  context: TenantContext
} {
  const token = bearerToken(request)
  return { token, context: tenantContext(decodeClaims(token)) }
}

/**
 * Aprovisionamiento (`bootstrap-tenant`): clave dedicada en CABECERA, nunca en
 * la URL (queda en logs y en `Referer`) — patrón del contrato §2.6.
 * Comparación en tiempo constante para no filtrar el prefijo correcto.
 */
export function requireProvisioningKey(request: Request, expected: string | undefined): void {
  if (!expected || expected.length < 32) {
    throw new AppError(
      'PROVISIONING_NO_CONFIGURADO',
      'La funcion no tiene configurada la clave de aprovisionamiento',
      500,
    )
  }
  const provided = request.headers.get('x-ebim-provisioning-key') ?? ''
  if (!timingSafeEqual(provided, expected)) {
    throw unauthorized('Clave de aprovisionamiento invalida')
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/**
 * Contrato §13: `dcalagua@ebim.pe` es el único super admin de suite y NO es
 * actor de negocio de un tenant. Un `@ebim.pe` no opera datos de un cliente
 * aunque venga forzado en el cuerpo.
 */
export function assertNotSuiteOperator(email: string | undefined): void {
  if (email && email.toLowerCase().endsWith('@ebim.pe')) {
    throw forbidden('Una cuenta @ebim.pe no puede operar datos de negocio de un tenant')
  }
}
