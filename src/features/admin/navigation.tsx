import AccountBalanceRoundedIcon from '@mui/icons-material/AccountBalanceRounded'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import HealthAndSafetyRoundedIcon from '@mui/icons-material/HealthAndSafetyRounded'
import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded'
import PeopleAltRoundedIcon from '@mui/icons-material/PeopleAltRounded'
import ArticleRoundedIcon from '@mui/icons-material/ArticleRounded'
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded'
import RequestQuoteRoundedIcon from '@mui/icons-material/RequestQuoteRounded'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded'
import PriceChangeRoundedIcon from '@mui/icons-material/PriceChangeRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded'
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import SpaceDashboardRoundedIcon from '@mui/icons-material/SpaceDashboardRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import WarehouseRoundedIcon from '@mui/icons-material/WarehouseRounded'
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
    icon: <SpaceDashboardRoundedIcon fontSize="small" />,
    end: true,
    capability: 'analytics.basic',
  },
  {
    to: '/app/products',
    label: 'nav.products',
    icon: <Inventory2RoundedIcon fontSize="small" />,
    capability: 'catalog',
  },
  {
    to: '/app/categories',
    label: 'nav.categories',
    icon: <CategoryRoundedIcon fontSize="small" />,
    capability: 'catalog',
  },
  {
    to: '/app/pim',
    label: 'nav.pim',
    icon: <TuneRoundedIcon fontSize="small" />,
    capability: 'catalog.advanced',
  },
  {
    to: '/app/pricing',
    label: 'nav.pricing',
    icon: <PriceChangeRoundedIcon fontSize="small" />,
    capability: 'pricing.lists',
  },
  {
    to: '/app/inventory',
    label: 'nav.inventory',
    icon: <WarehouseRoundedIcon fontSize="small" />,
    capability: 'inventory.multiwarehouse',
  },
  {
    to: '/app/customers',
    label: 'nav.customers',
    icon: <PeopleAltRoundedIcon fontSize="small" />,
    capability: 'customers',
  },
  {
    to: '/app/sales',
    label: 'nav.sales',
    icon: <BadgeRoundedIcon fontSize="small" />,
    capability: 'sales.force',
  },
  {
    to: '/app/planning',
    label: 'nav.planning',
    icon: <QueryStatsRoundedIcon fontSize="small" />,
    capability: 'planning.demand',
  },
  {
    to: '/app/quotes',
    label: 'nav.quotes',
    icon: <RequestQuoteRoundedIcon fontSize="small" />,
    capability: 'trade.quotes',
  },
  {
    to: '/app/assortments',
    label: 'nav.assortments',
    icon: <FactCheckRoundedIcon fontSize="small" />,
    capability: 'trade.assortments',
  },
  {
    to: '/app/credit',
    label: 'nav.credit',
    icon: <AccountBalanceRoundedIcon fontSize="small" />,
    capability: 'credit.management',
  },
  {
    to: '/app/orders',
    label: 'nav.orders',
    icon: <ReceiptLongRoundedIcon fontSize="small" />,
    capability: 'orders',
  },
  {
    to: '/app/payments',
    label: 'nav.payments',
    icon: <PaymentsRoundedIcon fontSize="small" />,
    capability: 'payments',
  },
  {
    // P12: entregas, devoluciones y la red de reparto. Va DESPUES de pedidos y
    // pagos porque ese es el orden real de la operacion: primero se vende, se
    // cobra, y despues se despacha.
    to: '/app/fulfillment',
    label: 'nav.fulfillment',
    icon: <LocalShippingRoundedIcon fontSize="small" />,
    capability: 'fulfillment',
  },
  {
    to: '/app/promotions',
    label: 'nav.promotions',
    icon: <LocalOfferRoundedIcon fontSize="small" />,
    capability: 'promotions',
  },
  {
    // P13: ventas, embudo y búsquedas. Va DESPUÉS del contenido porque se mira
    // cuando ya hay algo que medir, y su capacidad es baseline: la entrada se
    // ve siempre.
    to: '/app/analytics',
    label: 'nav.analytics',
    icon: <InsightsRoundedIcon fontSize="small" />,
    capability: 'analytics.basic',
  },
  {
    to: '/app/content',
    label: 'nav.content',
    icon: <ArticleRoundedIcon fontSize="small" />,
    capability: 'content.cms',
  },
  { to: '/app/settings', label: 'nav.settings', icon: <SettingsRoundedIcon fontSize="small" /> },
  {
    // P13: salud, incidentes, rastro y auditoría. SIN capacidad —igual que
    // Ajustes— y CON permiso: quien no administra el tenant no tiene nada que
    // hacer en la bitácora de operaciones, que lleva dentro el correo de cada
    // operador.
    to: '/app/operations',
    label: 'nav.operations',
    icon: <HealthAndSafetyRoundedIcon fontSize="small" />,
    permission: 'tenant.manage',
  },
  {
    // P14: monitor de integraciones, webhooks y credenciales de la API de
    // socio. SIN capacidad y CON permiso, exactamente igual que Operación:
    // la observabilidad de las integraciones no se vende, y quien no
    // administra el tenant no tiene nada que hacer entre sus credenciales.
    to: '/app/integrations',
    label: 'nav.integrations',
    icon: <HubRoundedIcon fontSize="small" />,
    permission: 'tenant.manage',
  },
  {
    to: '/app/diagnostics',
    label: 'nav.diagnostics',
    icon: <MonitorHeartRoundedIcon fontSize="small" />,
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
