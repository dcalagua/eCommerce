import { z } from 'zod'
import {
  isCapabilityId,
  parseFeatureFlags,
  type CapabilityId,
  type EntitlementCode,
  type FeatureFlags,
} from '@/domain'

/** Nombres reales de tabla y RPC. Fuente única: `shared/lib/db-schema.ts`. */
export {
  APP_CAPABILITIES_TABLE,
  EFFECTIVE_CAPABILITIES_RPC,
  PLATFORM_CONTEXT_FUNCTION,
  TENANT_ENTITLEMENTS_TABLE,
  TENANT_FEATURE_FLAGS_TABLE,
  TENANT_PLATFORM_CONTEXT_TABLE,
} from '@/shared/lib/db-schema'

/**
 * De dónde salió la configuración efectiva. Se pinta en diagnóstico y no es
 * cosmético: distinguir «el hub dice que no tienes el módulo» de «nunca
 * hablamos con el hub» son dos incidencias distintas para quien da soporte, y
 * la segunda no se arregla vendiendo nada.
 */
export const CONTEXT_SOURCES = ['hub', 'provisioning', 'sin-contexto'] as const
export type ContextSource = (typeof CONTEXT_SOURCES)[number]

/**
 * Respuesta de `public.effective_capabilities()`.
 *
 * `capabilities` la calcula LA BASE con la misma composición que
 * `resolveCapabilities`. Se leen las dos cosas —el resultado y la materia
 * prima— porque el diagnóstico tiene que poder enseñar por qué un módulo está
 * apagado, y para eso hacen falta los entitlements y los flags, no solo el
 * veredicto.
 */
export const effectiveCapabilitiesSchema = z.object({
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  source: z.enum(CONTEXT_SOURCES).catch('sin-contexto'),
  app_active: z.boolean(),
  plan: z.string().nullable().default(null),
  synced_at: z.string().nullable().default(null),
  entitlements: z.array(z.string()).default([]),
  // Lo que no sea booleano se descarta: un `"false"` en texto es `true` para
  // JavaScript, y un flag de apagado leído al revés es el fallo que un flag
  // existe para evitar.
  flags: z.unknown().transform(parseFeatureFlags),
  // Un código que esta versión de la app no conoce NO invalida la respuesta:
  // se filtra aquí y se enseña aparte. El hub puede ir por delante.
  capabilities: z
    .array(z.string())
    .default([])
    .transform((list) => list.filter(isCapabilityId)),
})

export type EffectiveCapabilitiesRow = z.infer<typeof effectiveCapabilitiesSchema>

export interface PlatformContext {
  readonly organizationId: string
  readonly companyId: string
  readonly source: ContextSource
  readonly appActive: boolean
  readonly plan: string | null
  readonly syncedAt: string | null
  readonly entitlements: readonly EntitlementCode[]
  readonly flags: FeatureFlags
  /** Lo que la BASE resolvió. Es la lista que manda para pintar. */
  readonly capabilities: readonly CapabilityId[]
}

export function toPlatformContext(row: EffectiveCapabilitiesRow): PlatformContext {
  return {
    organizationId: row.organization_id,
    companyId: row.company_id,
    source: row.source,
    appActive: row.app_active,
    plan: row.plan,
    syncedAt: row.synced_at,
    entitlements: row.entitlements,
    flags: row.flags,
    capabilities: row.capabilities,
  }
}
