import type { Session } from '@supabase/supabase-js'
import { tenantContextSchema, type TenantContext } from '@/features/tenant/types'

/** Payload de un JWT, sin verificar la firma (la verifica el servidor). */
function decodeTokenClaims(token: string | undefined): Record<string, unknown> {
  if (!token) return {}
  const payload = token.split('.')[1]
  if (!payload) return {}
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((char) => `%${`00${char.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join(''),
    )
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Claims efectivos de la sesión.
 *
 * Se miran los dos sitios a propósito: en Modo A (Third-Party Auth contra el
 * JWKS del hub) la jerarquía viaja como claims de primer nivel del token,
 * mientras que en Modo B (handoff `/sso?token=`) acaba en `app_metadata` del
 * usuario del proyecto. Leer solo uno deja la app ciega en el otro modo.
 */
export function sessionClaims(session: Session | null): Record<string, unknown> {
  if (!session) return {}
  return {
    ...decodeTokenClaims(session.access_token),
    ...((session.user?.app_metadata ?? {}) as Record<string, unknown>),
  }
}

/**
 * Deriva el tenant EXCLUSIVAMENTE de los claims del JWT (contrato §2.2/§8).
 * Devuelve `null` si el token no trae la jerarquía completa: sin tenant válido
 * no se consulta nada, en vez de asumir un valor por defecto.
 */
export function tenantFromSession(session: Session | null): TenantContext | null {
  if (!session) return null
  const claims = sessionClaims(session)
  const parsed = tenantContextSchema.safeParse({
    organization_id: claims.org_id,
    active_company: claims.active_company,
    companies: claims.companies,
    apps: claims.apps ?? [],
  })
  return parsed.success ? parsed.data : null
}

/** Correo del usuario de la sesión, normalizado. Vacío si el token no lo trae. */
export function emailFromSession(session: Session | null): string {
  const claims = sessionClaims(session)
  const email = session?.user?.email ?? claims.email
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}
