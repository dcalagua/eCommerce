import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import { ProtectedArea } from '@/features/auth/ProtectedArea'
import { LoadingState } from '@/shared/ui/states'
import { NotFoundPage } from './NotFoundPage'
import { RootErrorRoute } from './RootErrorRoute'

/**
 * Dos áreas separadas que comparten design system pero no rutas ni guards:
 *   `/app/*`        backoffice del tenant (sesión + membresía + sociedad activa)
 *   `/onboarding`   alta del espacio para quien tiene sesión y todavía no tiene tenant
 *   `/s/:storeSlug` vitrina pública (tenant resuelto por slug, solo lectura)
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
const OrdersPage = lazy(() =>
  import('@/features/orders/OrdersPage').then((m) => ({ default: m.OrdersPage })),
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
  import('@/features/storefront/pages').then((m) => ({ default: m.StoreCartPage })),
)
const StoreCheckoutPage = lazy(() =>
  import('@/features/storefront/pages').then((m) => ({ default: m.StoreCheckoutPage })),
)
const LandingPage = lazy(() =>
  import('@/features/storefront/pages').then((m) => ({ default: m.LandingPage })),
)

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<LoadingState />}>{node}</Suspense>
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
          { index: true, element: withSuspense(<DashboardPage />) },
          { path: 'products', element: withSuspense(<ProductsPage />) },
          { path: 'categories', element: withSuspense(<CategoriesPage />) },
          { path: 'orders', element: withSuspense(<OrdersPage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
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
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]

export const router = createBrowserRouter(routes)
