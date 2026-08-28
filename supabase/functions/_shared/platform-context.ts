/**
 * Platform Context API del hub (contrato EBIM §5) — parte PURA.
 *
 * Aquí solo hay lectura y validación de formas: ni `fetch`, ni cliente de
 * Supabase, ni `Deno`. Por eso lo compila el `tsc` del repo y lo cubren los
 * tests, que es la única manera de comprobar sin desplegar que una respuesta
 * rara del hub no termina escribiendo entitlements inventados.
 *
 * La forma que se acepta es LA DEL CONTRATO, tal cual:
 *
 *     GET platform.context(org_id)
 *     → { organization: { id, name, plan },
 *         companies:    [ { id, name, country, config } ],
 *         addons:       { "company-uuid": ["licitaciones", ...] },
 *         app_active:   true }
 *
 * Lo que NO se hace: inventar campos que el contrato no declara. Si el hub
 * responde otra cosa, esto falla con `HUB_RESPUESTA_INVALIDA` en vez de
 * adivinar, porque adivinar mal aquí significa apagarle módulos a un cliente
 * que sí los pagó.
 */
import { AppError, badRequest } from './errors.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Misma expresión que el CHECK `tenant_entitlements_code_fmt` de la base. */
const ENTITLEMENT_RE = /^[a-z][a-z0-9._-]{2,60}$/

export type EntitlementSource = 'hub' | 'provisioning'

/** Una fila de sincronización: todo lo que `sync_platform_context` necesita. */
export interface ContextSync {
  organizationId: string
  companyId: string
  appActive: boolean
  plan: string | null
  entitlements: string[]
  source: EntitlementSource
}

export function hubUnavailable(message: string): AppError {
  return new AppError('HUB_NO_DISPONIBLE', message, 503)
}

export function hubNotConfigured(): AppError {
  return new AppError(
    'HUB_NO_CONFIGURADO',
    'El Platform Context API del hub no esta configurado para esta instalacion',
    503,
  )
}

function invalidHubResponse(detail: string): AppError {
  return new AppError('HUB_RESPUESTA_INVALIDA', `Respuesta del hub no valida: ${detail}`, 502)
}

function normalizeEntitlements(value: unknown, onInvalid: (code: string) => never): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) onInvalid('addons no es una lista')
  const out: string[] = []
  for (const item of value) {
    const code = typeof item === 'string' ? item.trim().toLowerCase() : ''
    if (!ENTITLEMENT_RE.test(code)) onInvalid(String(item))
    if (!out.includes(code)) out.push(code)
  }
  return out.sort()
}

/**
 * Traduce la respuesta del hub a las filas que hay que sincronizar.
 *
 * `expectedOrganizationId` no es una formalidad: es el JWT del usuario que
 * pidió el refresco. Si el hub responde con OTRA organización —por una URL mal
 * configurada, por una caché intermedia, por un error del propio hub— esto
 * corta. Escribir esa respuesta sería darle a un tenant los módulos de otro.
 */
export function syncFromHubContext(payload: unknown, expectedOrganizationId: string): ContextSync[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidHubResponse('el cuerpo no es un objeto')
  }
  const body = payload as Record<string, unknown>

  const organization = body.organization as Record<string, unknown> | undefined
  const organizationId = typeof organization?.id === 'string' ? organization.id : ''
  if (!UUID_RE.test(organizationId)) throw invalidHubResponse('`organization.id` ausente o no es uuid')
  if (organizationId.toLowerCase() !== expectedOrganizationId.toLowerCase()) {
    throw invalidHubResponse('la organizacion devuelta no es la del token')
  }

  const plan = typeof organization?.plan === 'string' && organization.plan.trim() !== ''
    ? organization.plan.trim().slice(0, 60)
    : null

  // `app_active` ausente se lee como FALSE. Es lo contrario del criterio de la
  // base para «nunca sincronizamos», y a propósito: aquí SÍ hablamos con el
  // hub, así que un silencio sobre si la app está activa es una respuesta
  // incompleta, no un permiso.
  const appActive = body.app_active === true

  const companies = Array.isArray(body.companies) ? body.companies : []
  const addons = (body.addons ?? {}) as Record<string, unknown>
  if (typeof addons !== 'object' || Array.isArray(addons)) {
    throw invalidHubResponse('`addons` no es un objeto por sociedad')
  }

  const companyIds = new Set<string>()
  for (const item of companies) {
    const id = typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : ''
    if (UUID_RE.test(id)) companyIds.add(id.toLowerCase())
  }
  // Una sociedad que aparece en `addons` y no en `companies` cuenta igual: es
  // la señal de que el hub le activó algo, y perderla dejaría al tenant sin un
  // módulo que sí compró.
  for (const id of Object.keys(addons)) {
    if (UUID_RE.test(id)) companyIds.add(id.toLowerCase())
  }

  return [...companyIds].sort().map((companyId) => ({
    organizationId: organizationId.toLowerCase(),
    companyId,
    appActive,
    plan,
    entitlements: normalizeEntitlements(addons[companyId] ?? findCaseInsensitive(addons, companyId), (code) => {
      throw invalidHubResponse(`codigo de addon invalido: ${code}`)
    }),
    source: 'hub' as const,
  }))
}

function findCaseInsensitive(map: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(map).find((candidate) => candidate.toLowerCase() === key)
  return found === undefined ? [] : map[found]
}

/**
 * Camino de aprovisionamiento: el operador escribe el contexto a mano.
 *
 * Existe porque `ecommerce` todavía no está dado de alta en el hub
 * (SAAS_ROADMAP §5.1) y sin esto no habría forma de activar un módulo sin tocar
 * código, que es justo lo que esta fase tiene que demostrar. Se marca
 * `source: 'provisioning'` para que el diagnóstico no lo confunda nunca con una
 * respuesta del hub, y se retira en cuanto el hub responda.
 *
 * El tenant SÍ viene en el cuerpo, igual que en `bootstrap-tenant` y por la
 * misma razón: no hay token de usuario del que derivarlo. Lo que autoriza es la
 * clave de aprovisionamiento en cabecera, no el cuerpo.
 */
export function parseProvisioningSync(body: Record<string, unknown>): ContextSync {
  const organizationId = requireUuidField(body, 'organization_id')
  const companyId = requireUuidField(body, 'company_id')

  const appActive = body.app_active === undefined ? true : body.app_active
  if (typeof appActive !== 'boolean') {
    throw badRequest('CAMPO_INVALIDO', '`app_active` debe ser booleano')
  }

  const plan = body.plan === undefined || body.plan === null ? null : body.plan
  if (plan !== null && (typeof plan !== 'string' || plan.trim().length > 60)) {
    throw badRequest('CAMPO_INVALIDO', '`plan` debe ser texto de hasta 60 caracteres')
  }

  const entitlements = normalizeEntitlements(body.entitlements ?? [], (code) => {
    throw badRequest('ENTITLEMENT_INVALIDO', `\`${code}\` no tiene forma de codigo de addon`)
  })

  return {
    organizationId,
    companyId,
    appActive,
    plan: plan === null ? null : plan.trim() || null,
    entitlements,
    source: 'provisioning',
  }
}

function requireUuidField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest('CAMPO_INVALIDO', `\`${field}\` debe ser un uuid`)
  }
  return value.toLowerCase()
}

/** ¿Este request viene del operador o de un usuario con sesión? */
export function contextMode(request: Request): 'provisioning' | 'session' {
  return request.headers.get('x-ebim-provisioning-key') ? 'provisioning' : 'session'
}

/**
 * URL del contexto para una organización. El `org_id` va en la QUERY porque el
 * contrato §5 declara la operación como `GET platform.context(org_id)`; la
 * credencial va en cabecera y nunca en la URL, que queda en logs y en `Referer`.
 */
export function hubContextUrl(base: string, organizationId: string, app: string): string {
  const url = new URL(base)
  url.searchParams.set('org_id', organizationId)
  url.searchParams.set('app', app)
  return url.toString()
}
