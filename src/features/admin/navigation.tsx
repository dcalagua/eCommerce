import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined'
import type { ReactNode } from 'react'
import type { MessageKey } from '@/shared/i18n/messages'
import type { Crumb } from '@/shared/ui/AppBreadcrumbs'

export interface NavItem {
  to: string
  label: MessageKey
  icon: ReactNode
  end?: boolean
}

/** Navegación del backoffice. Fuente única del sidebar y de las migas. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'nav.dashboard', icon: <SpaceDashboardOutlinedIcon fontSize="small" />, end: true },
  { to: '/app/products', label: 'nav.products', icon: <Inventory2OutlinedIcon fontSize="small" /> },
  { to: '/app/orders', label: 'nav.orders', icon: <ReceiptLongOutlinedIcon fontSize="small" /> },
  { to: '/app/settings', label: 'nav.settings', icon: <SettingsOutlinedIcon fontSize="small" /> },
]

/**
 * Migas a partir de la ruta: raíz del backoffice + sección actual. Se derivan
 * de `NAV_ITEMS` para que agregar una sección no obligue a tocar dos sitios.
 */
export function crumbsForPath(pathname: string, label: (key: MessageKey) => string): Crumb[] {
  const match = NAV_ITEMS.find((item) => !item.end && pathname.startsWith(item.to))
  if (!match) return [{ label: label('nav.dashboard') }]
  return [{ label: label('nav.dashboard'), to: '/app' }, { label: label(match.label) }]
}
