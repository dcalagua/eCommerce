import { z } from 'zod'

/**
 * Roles funcionales de eCommerce (enum `public.app_role`) y la matriz de
 * capacidades que la UI usa para decidir qué muestra.
 *
 * Esto NO es la frontera de seguridad: la autoridad son las policies RLS y los
 * guards del servidor. Ocultar un botón evita un 403 innecesario, no impide un
 * PATCH directo a PostgREST. Un test compara esta matriz contra la del borde
 * (`supabase/functions/_shared/roles.ts`) para que no se separen.
 */
export const APP_ROLES = ['owner', 'admin', 'catalog', 'orders', 'viewer'] as const
export type AppRole = (typeof APP_ROLES)[number]

export const appRoleSchema = z.enum(APP_ROLES)

export type Capability = 'tenant.manage' | 'store.manage' | 'catalog.write' | 'orders.write'

export const ROLE_CAPABILITIES: Record<Capability, readonly AppRole[]> = {
  'tenant.manage': ['owner', 'admin'],
  'store.manage': ['owner', 'admin'],
  'catalog.write': ['owner', 'admin', 'catalog'],
  'orders.write': ['owner', 'admin', 'orders'],
}

/** Sin rol no hay capacidad: la ausencia de membresía nunca se lee como permiso. */
export function can(role: AppRole | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return ROLE_CAPABILITIES[capability].includes(role)
}
