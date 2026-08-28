import { z } from 'zod'

/**
 * Roles funcionales de eCommerce (enum `public.app_role`) y la matriz de
 * PERMISOS que la UI usa para decidir qué muestra.
 *
 * Esto NO es la frontera de seguridad: la autoridad son las policies RLS y los
 * guards del servidor. Ocultar un botón evita un 403 innecesario, no impide un
 * PATCH directo a PostgREST. Un test compara esta matriz contra la del borde
 * (`supabase/functions/_shared/roles.ts`) para que no se separen.
 *
 * **`Permission`, no `Capability` (P02-SaaS).** El permiso responde «¿este ROL
 * puede hacerlo?» y depende de la membresía; la capacidad responde «¿la cuenta
 * CONTRATÓ el módulo?» y depende del hub (`domain/capabilities.ts`). Los dos
 * ejes se componen —un `admin` sin el addon no puede, y un tenant con el addon
 * pero rol `viewer` tampoco— y hasta P02 compartían nombre, que es la forma
 * más barata de acabar concediendo uno creyendo comprobar el otro.
 */
export const APP_ROLES = ['owner', 'admin', 'catalog', 'orders', 'viewer'] as const
export type AppRole = (typeof APP_ROLES)[number]

export const appRoleSchema = z.enum(APP_ROLES)

export type Permission =
  | 'tenant.manage'
  | 'store.manage'
  | 'catalog.write'
  | 'orders.write'
  | 'orders.export'

export const ROLE_PERMISSIONS: Record<Permission, readonly AppRole[]> = {
  'tenant.manage': ['owner', 'admin'],
  'store.manage': ['owner', 'admin'],
  'catalog.write': ['owner', 'admin', 'catalog'],
  'orders.write': ['owner', 'admin', 'orders'],
  // P08-SaaS. Exportar NO es «ver el listado en un archivo»: es una extracción
  // masiva de correos, teléfonos, direcciones y documentos fiscales de todos
  // los compradores del tenant. Un `viewer` —el rol de consulta— puede leer un
  // pedido y no puede llevarse la base de clientes entera; los tres roles que
  // sí responden por esos datos, sí.
  'orders.export': ['owner', 'admin', 'orders'],
}

/** Sin rol no hay permiso: la ausencia de membresía nunca se lee como permiso. */
export function can(role: AppRole | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return ROLE_PERMISSIONS[permission].includes(role)
}
