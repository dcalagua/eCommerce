import { z } from 'zod'
import { appRoleSchema } from '@/shared/lib/roles'

/**
 * Nota P05: el shape de branding homologado (`brand_slug`/`accent_color`/
 * `white_label`, contrato §4.3) sigue vivo como la vista `public_store_branding`
 * de la base — es la interfaz que consumen las otras apps de la suite. Lo que
 * ya no existe aquí es un segundo lector de esa vista en el cliente: la vitrina
 * resuelve la tienda contra `public_stores`, que trae eso y además el banner,
 * el contacto y el `store_id` que el catálogo necesita.
 */

/**
 * `companies[]` del hub llega como `[{id, role}]` (forma del contrato §2.2) o
 * como `["uuid"]` (forma degradada). Se normaliza a uuid antes de validar; lo
 * que no sea uuid se descarta, y un `company_code` como "1000" no pasa: la
 * sociedad se identifica por uuid, el código es atributo.
 */
const companiesSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) return value
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'id' in item) {
        const id = (item as { id: unknown }).id
        return typeof id === 'string' ? id : null
      }
      return null
    })
    .filter((id): id is string => id !== null)
}, z.array(z.string().uuid()))

/**
 * Contexto de tenant del backoffice. `organization_id` y `company_id` son los
 * uuid del hub y SIEMPRE provienen del JWT — nunca del body, query o localStorage.
 */
export const tenantContextSchema = z.object({
  organization_id: z.string().uuid(),
  active_company: z.string().uuid(),
  companies: companiesSchema,
  apps: z.array(z.string()).default([]),
})

export type TenantContext = z.infer<typeof tenantContextSchema>

// ---------------------------------------------------------------------------
// Espacio de trabajo: lo que el backoffice sabe del tenant DESPUÉS de que la
// RLS respondió. Ninguna de estas filas se pide filtrando por tenant desde el
// cliente: llegan ya filtradas por las policies a partir del JWT.
// ---------------------------------------------------------------------------

/** Nombres reales de las tablas. Fuente unica: `shared/lib/db-schema.ts`. */
export { TENANTS_TABLE, TENANT_MEMBERS_TABLE, STORES_TABLE } from '@/shared/lib/db-schema'

export const tenantSummarySchema = z.object({
  organization_id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['active', 'suspended', 'closed']),
})
export type TenantSummary = z.infer<typeof tenantSummarySchema>

export const membershipSchema = z.object({
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: appRoleSchema,
  status: z.enum(['active', 'invited', 'revoked']),
})
export type Membership = z.infer<typeof membershipSchema>

export const storeSummarySchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['draft', 'active', 'suspended']),
  currency: z.string().length(3),
})
export type StoreSummary = z.infer<typeof storeSummarySchema>

export interface Workspace {
  tenant: TenantSummary | null
  memberships: Membership[]
  stores: StoreSummary[]
}
