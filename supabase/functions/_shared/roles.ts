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

/**
 * `sales_rep` — el vendedor de campo (recorrido B2B, fase 02).
 *
 * Es personal DEL TENANT, no del cliente: por eso entra en `app_role` y no en
 * `business_role`, donde vive el comprador de una cuenta B2B. Meterlo alli
 * habria sido un error categorico.
 *
 * Y no se le da el rol `orders`, que seria lo comodo: ese rol abre el listado
 * completo de pedidos del tenant y `orders.export`, que es la extraccion masiva
 * de correos, telefonos y documentos fiscales de TODOS los compradores. Un
 * preventista responde por SU cartera, no por la base entera.
 */
export const APP_ROLES = ['owner', 'admin', 'catalog', 'orders', 'viewer', 'sales_rep'] as const
export type AppRole = (typeof APP_ROLES)[number]

export type Permission =
  | 'tenant.manage'
  | 'store.manage'
  | 'catalog.write'
  | 'orders.write'
  | 'orders.export'
  | 'sales.manage'
  | 'sales.operate'

export const ROLE_PERMISSIONS: Record<Permission, AppRole[]> = {
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
  // Recorrido B2B, fase 02. Dar de alta vendedores, jerarquia y cartera es
  // administracion: decide quien ve los datos de que clientes.
  'sales.manage': ['owner', 'admin'],
  // La operacion de campo: tomar el pedido de un cliente de SU cartera y
  // registrar la visita. El alcance —que clientes— no lo pone este permiso,
  // lo pone la RLS contra `sales_rep_customers`.
  'sales.operate': ['owner', 'admin', 'sales_rep'],
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value)
}

export function can(role: AppRole | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return ROLE_PERMISSIONS[permission].includes(role)
}
