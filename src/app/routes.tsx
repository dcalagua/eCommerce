import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import type { CapabilityId } from '@/domain'
import { ProtectedArea } from '@/features/auth/ProtectedArea'
import { CapabilityGate } from '@/features/capabilities/CapabilityGate'
import { LoadingState } from '@/shared/ui/states'
import { NotFoundPage } from './NotFoundPage'
import { RootErrorRoute } from './RootErrorRoute'

/**
 * Dos áreas separadas que comparten design system pero no rutas ni guards:
 *   `/app/*`        backoffice del tenant (sesión + membresía + sociedad activa)
 *   `/onboarding`   alta del espacio para quien tiene sesión y todavía no tiene tenant
 *   `/s/:storeSlug` vitrina pública (tenant resuelto por slug; el pedido lo
 *                   crea el servidor, que también resuelve la tienda)
 */

const LoginPage = lazy(() => import('@/features/auth/LoginPage').then((m) => ({ default: m.LoginPage })))
const ForgotPasswordPage = lazy(() =>
  import('@/features/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
)
const ResetPasswordPage = lazy(() =>
  import('@/features/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
)
const OnboardingPage = lazy(() =>
  import('@/features/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })),
)
const AdminLayout = lazy(() =>
  import('@/features/admin/AdminLayout').then((m) => ({ default: m.AdminLayout })),
)
const DashboardPage = lazy(() =>
  import('@/features/admin/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
const SettingsPage = lazy(() =>
  import('@/features/admin/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)
const ProductsPage = lazy(() =>
  import('@/features/catalog/ProductsPage').then((m) => ({ default: m.ProductsPage })),
)
const CategoriesPage = lazy(() =>
  import('@/features/catalog/CategoriesPage').then((m) => ({ default: m.CategoriesPage })),
)
const PimPage = lazy(() =>
  import('@/features/catalog/pim/PimPage').then((m) => ({ default: m.PimPage })),
)
const PricingPage = lazy(() =>
  import('@/features/pricing/PricingPage').then((m) => ({ default: m.PricingPage })),
)
const OrdersPage = lazy(() =>
  import('@/features/orders/OrdersPage').then((m) => ({ default: m.OrdersPage })),
)
const DiagnosticsPage = lazy(() =>
  import('@/features/capabilities/DiagnosticsPage').then((m) => ({ default: m.DiagnosticsPage })),
)
const StorefrontLayout = lazy(() =>
  import('@/features/storefront/StorefrontLayout').then((m) => ({ default: m.StorefrontLayout })),
)
const StoreHomePage = lazy(() =>
  import('@/features/storefront/StoreHomePage').then((m) => ({ default: m.StoreHomePage })),
)
const StoreProductPage = lazy(() =>
  import('@/features/storefront/StoreProductPage').then((m) => ({ default: m.StoreProductPage })),
)
const StoreCartPage = lazy(() =>
  import('@/features/storefront/StoreCartPage').then((m) => ({ default: m.StoreCartPage })),
)
const StoreCheckoutPage = lazy(() =>
  import('@/features/storefront/StoreCheckoutPage').then((m) => ({ default: m.StoreCheckoutPage })),
)
const StoreOrderPage = lazy(() =>
  import('@/features/storefront/StoreOrderPage').then((m) => ({ default: m.StoreOrderPage })),
)
const LandingPage = lazy(() =>
  import('@/features/storefront/pages').then((m) => ({ default: m.LandingPage })),
)

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<LoadingState />}>{node}</Suspense>
}

/**
 * Ruta gateada por capacidad (P02-SaaS).
 *
 * Esconder la entrada del menú no basta: una URL se escribe a mano y se comparte
 * por correo. Con esto, entrar directo a `/app/products` sin el módulo enseña
 * «no contratado» en vez de un listado vacío, que es lo que hoy parecería un
 * fallo de la aplicación. Sigue sin ser seguridad: la autoridad es la RLS.
 */
function gated(capability: CapabilityId, node: ReactNode): ReactNode {
  return <CapabilityGate capability={capability}>{withSuspense(node)}</CapabilityGate>
}

export const routes: RouteObject[] = [
  { path: '/', element: withSuspense(<LandingPage />), errorElement: <RootErrorRoute /> },
  { path: '/login', element: withSuspense(<LoginPage />), errorElement: <RootErrorRoute /> },
  { path: '/recuperar', element: withSuspense(<ForgotPasswordPage />), errorElement: <RootErrorRoute /> },
  { path: '/nueva-clave', element: withSuspense(<ResetPasswordPage />), errorElement: <RootErrorRoute /> },
  {
    // Ruta sin path: agrupa TODO lo que exige sesión bajo un mismo guard y un
    // mismo `TenantProvider`, para que el alta de espacio y el backoffice
    // compartan el estado de tenant en vez de resolverlo dos veces.
    element: <ProtectedArea />,
    errorElement: <RootErrorRoute />,
    children: [
      { path: '/onboarding', element: withSuspense(<OnboardingPage />) },
      {
        path: '/app',
        element: withSuspense(<AdminLayout />),
        children: [
          { index: true, element: gated('analytics.basic', <DashboardPage />) },
          { path: 'products', element: gated('catalog', <ProductsPage />) },
          { path: 'categories', element: gated('catalog', <CategoriesPage />) },
          // El vocabulario del PIM es del módulo vendible, no del baseline.
          { path: 'pim', element: gated('catalog.advanced', <PimPage />) },
          // El precio por canal, segmento o cliente es el módulo vendible; el
          // precio de catálogo sigue viniendo con el producto.
          { path: 'pricing', element: gated('pricing.lists', <PricingPage />) },
          { path: 'orders', element: gated('orders', <OrdersPage />) },
          // Ajustes y diagnóstico NO se gatean por capacidad: son la salida de
          // un tenant sin nada contratado y el sitio donde se ve por qué.
          { path: 'settings', element: withSuspense(<SettingsPage />) },
          { path: 'diagnostics', element: withSuspense(<DiagnosticsPage />) },
        ],
      },
    ],
  },
  {
    path: '/s/:storeSlug',
    element: withSuspense(<StorefrontLayout />),
    errorElement: <RootErrorRoute />,
    children: [
      { index: true, element: withSuspense(<StoreHomePage />) },
      { path: 'product/:productSlug', element: withSuspense(<StoreProductPage />) },
      { path: 'cart', element: withSuspense(<StoreCartPage />) },
      { path: 'checkout', element: withSuspense(<StoreCheckoutPage />) },
      // Confirmación del pedido. El número va en la URL para que el comprador
      // pueda guardarla o compartirla; el detalle llega por estado de
      // navegación, porque un comprador anónimo no puede releer el pedido.
      { path: 'order/:orderNumber', element: withSuspense(<StoreOrderPage />) },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]

export const router = createBrowserRouter(routes)
