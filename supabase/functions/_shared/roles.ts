/**
 * Matriz de PERMISOS por rol de eCommerce.
 *
 * Espejo de lo que hacen cumplir las policies RLS. La base es la autoridad;
 * esto solo permite devolver un 403 con mensaje útil sin ir a la base. Un test
 * compara esta matriz contra los roles que aparecen en las migraciones.
 *
 * `Permission` y no `Capability` desde P02-SaaS: la capacidad es el otro eje
 * —lo que la cuenta contrató— y la comprueba `ebim.has_capability` en la base.
 */

export const APP_ROLES = ['owner', 'admin', 'catalog', 'orders', 'viewer'] as const
export type AppRole = (typeof APP_ROLES)[number]

export type Permission = 'tenant.manage' | 'store.manage' | 'catalog.write' | 'orders.write'

export const ROLE_PERMISSIONS: Record<Permission, AppRole[]> = {
  'tenant.manage': ['owner', 'admin'],
  'store.manage': ['owner', 'admin'],
  'catalog.write': ['owner', 'admin', 'catalog'],
  'orders.write': ['owner', 'admin', 'orders'],
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value)
}

export function can(role: AppRole | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return ROLE_PERMISSIONS[permission].includes(role)
}
