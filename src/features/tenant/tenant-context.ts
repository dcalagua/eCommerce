import { createContext, useContext } from 'react'
import type { Permission } from '@/shared/lib/roles'
import type { TenantSelection } from './workspace'

export interface TenantContextValue extends TenantSelection {
  error: Error | null
  /** Correo del usuario, para el menú de cuenta. Sale del token. */
  email: string
  /** Cambia la sociedad activa entre las que el usuario ya tiene por JWT. */
  setActiveCompany: (companyId: string) => void
  /** Selector de tienda: preparado para varias tiendas por sociedad. */
  setActiveStore: (storeId: string) => void
  /**
   * Gating por PERMISO de rol. La autoridad sigue siendo la RLS.
   * Lo que la cuenta CONTRATÓ es el otro eje y se pregunta con
   * `useCapabilities().has(...)` (P02-SaaS).
   */
  can: (permission: Permission) => boolean
  refetch: () => void
}

export const TenantCtx = createContext<TenantContextValue | null>(null)

export function useTenant(): TenantContextValue {
  const value = useContext(TenantCtx)
  if (!value) throw new Error('useTenant debe usarse dentro de <TenantProvider>')
  return value
}
