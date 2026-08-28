import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined'
import PeopleAltOutlinedIcon from '@mui/icons-material/PeopleAltOutlined'
import PriceChangeOutlinedIcon from '@mui/icons-material/PriceChangeOutlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined'
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined'
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined'
import type { ReactNode } from 'react'
import type { CapabilityId } from '@/domain'
import type { MessageKey } from '@/shared/i18n/messages'
import type { Permission } from '@/shared/lib/roles'
import type { Crumb } from '@/shared/ui/AppBreadcrumbs'

export interface NavItem {
  to: string
  label: MessageKey
  icon: ReactNode
  end?: boolean
  /** Módulo que la sociedad tiene que tener contratado y activo (P02-SaaS). */
  capability?: CapabilityId
  /** Permiso de rol. Ortogonal a la capacidad: hacen falta los dos. */
  permission?: Permission
}

/**
 * Navegación del backoffice. Fuente única del sidebar y de las migas.
 *
 * `capability` no es decoración: si el hub declara que la cuenta no tiene
 * eCommerce activo (`app_active: false`), estos módulos dejan de listarse y su
 * ruta pinta el estado «no contratado» en vez de un listado vacío que parece
 * un fallo. Configuración se queda SIN capacidad a propósito: hay que poder
 * llegar a los ajustes aunque no haya un solo módulo contratado, si no la
 * única salida de un tenant mal configurado sería llamar por teléfono.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    to: '/app',
    label: 'nav.dashboard',
    icon: <SpaceDashboardOutlinedIcon fontSize="small" />,
    end: true,
    capability: 'analytics.basic',
  },
  {
    to: '/app/products',
    label: 'nav.products',
    icon: <Inventory2OutlinedIcon fontSize="small" />,
    capability: 'catalog',
  },
  {
    to: '/app/categories',
    label: 'nav.categories',
    icon: <CategoryOutlinedIcon fontSize="small" />,
    capability: 'catalog',
  },
  {
    to: '/app/pim',
    label: 'nav.pim',
    icon: <TuneOutlinedIcon fontSize="small" />,
    capability: 'catalog.advanced',
  },
  {
    to: '/app/pricing',
    label: 'nav.pricing',
    icon: <PriceChangeOutlinedIcon fontSize="small" />,
    capability: 'pricing.lists',
  },
  {
    to: '/app/inventory',
    label: 'nav.inventory',
    icon: <WarehouseOutlinedIcon fontSize="small" />,
    capability: 'inventory.multiwarehouse',
  },
  {
    to: '/app/customers',
    label: 'nav.customers',
    icon: <PeopleAltOutlinedIcon fontSize="small" />,
    capability: 'customers',
  },
  {
    to: '/app/orders',
    label: 'nav.orders',
    icon: <ReceiptLongOutlinedIcon fontSize="small" />,
    capability: 'orders',
  },
  { to: '/app/settings', label: 'nav.settings', icon: <SettingsOutlinedIcon fontSize="small" /> },
  {
    to: '/app/diagnostics',
    label: 'nav.diagnostics',
    icon: <MonitorHeartOutlinedIcon fontSize="small" />,
    permission: 'tenant.manage',
  },
]

/**
 * Qué entradas se pintan. Función PURA para poder probarla sin montar el árbol.
 *
 * Mientras las capacidades cargan (`capabilitiesReady: false`) NO se esconde
 * nada: un menú que se vacía y se rellena en cada navegación se lee como un
 * error de la app, y esconder de más aquí no protege nada —la autoridad es la
 * RLS, y la ruta vuelve a comprobarlo con su propio gate—.
 */
export function visibleNavItems(
  items: readonly NavItem[],
  access: {
    can: (permission: Permission) => boolean
    has: (capability: CapabilityId) => boolean
    capabilitiesReady: boolean
  },
): NavItem[] {
  return items.filter((item) => {
    if (item.permission && !access.can(item.permission)) return false
    if (item.capability && access.capabilitiesReady && !access.has(item.capability)) return false
    return true
  })
}

/**
 * Migas a partir de la ruta: raíz del backoffice + sección actual. Se derivan
 * de `NAV_ITEMS` para que agregar una sección no obligue a tocar dos sitios.
 */
export function crumbsForPath(pathname: string, label: (key: MessageKey) => string): Crumb[] {
  const match = NAV_ITEMS.find((item) => !item.end && pathname.startsWith(item.to))
  if (!match) return [{ label: label('nav.dashboard') }]
  return [{ label: label('nav.dashboard'), to: '/app' }, { label: label(match.label) }]
}
