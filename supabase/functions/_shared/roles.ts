/**
 * Matriz de capacidades por rol de eCommerce.
 *
 * Espejo de lo que hacen cumplir las policies RLS. La base es la autoridad;
 * esto solo permite devolver un 403 con mensaje útil sin ir a la base. Un test
 * compara esta matriz contra los roles que aparecen en las migraciones.
 */

export const APP_ROLES = ['owner', 'admin', 'catalog', 'orders', 'viewer'] as const
export type AppRole = (typeof APP_ROLES)[number]

export type Capability = 'tenant.manage' | 'store.manage' | 'catalog.write' | 'orders.write'

export const ROLE_CAPABILITIES: Record<Capability, AppRole[]> = {
  'tenant.manage': ['owner', 'admin'],
  'store.manage': ['owner', 'admin'],
  'catalog.write': ['owner', 'admin', 'catalog'],
  'orders.write': ['owner', 'admin', 'orders'],
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value)
}

export function can(role: AppRole | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return ROLE_CAPABILITIES[capability].includes(role)
}
