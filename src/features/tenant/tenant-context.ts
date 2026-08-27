import { createContext, useContext } from 'react'
import type { Capability } from '@/shared/lib/roles'
import type { TenantSelection } from './workspace'

export interface TenantContextValue extends TenantSelection {
  error: Error | null
  /** Correo del usuario, para el menú de cuenta. Sale del token. */
  email: string
  /** Cambia la sociedad activa entre las que el usuario ya tiene por JWT. */
  setActiveCompany: (companyId: string) => void
  /** Selector de tienda: preparado para varias tiendas por sociedad. */
  setActiveStore: (storeId: string) => void
  /** Gating de UI. La autoridad sigue siendo la RLS. */
  can: (capability: Capability) => boolean
  refetch: () => void
}

export const TenantCtx = createContext<TenantContextValue | null>(null)

export function useTenant(): TenantContextValue {
  const value = useContext(TenantCtx)
  if (!value) throw new Error('useTenant debe usarse dentro de <TenantProvider>')
  return value
}
