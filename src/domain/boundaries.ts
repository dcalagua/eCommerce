/**
 * Mapa de fronteras de dominio de eCommerce (P01-SaaS).
 *
 * Esto NO es documentación decorativa: `src/architecture.test.ts` lo usa para
 * exigir que todo archivo de `src/features` pertenezca a una frontera
 * declarada. Una carpeta nueva sin dominio declarado rompe la suite, que es la
 * única forma conocida de que un mapa de arquitectura siga siendo cierto un año
 * después de escribirlo.
 *
 * `state` dice la verdad sobre cada frontera hoy, no la intención:
 *  - `implemented` — hay código de producto y está en uso.
 *  - `partial`     — existe una parte (a menudo solo en la base) sin superficie.
 *  - `declared`    — la frontera está reconocida y su contrato escrito, pero no
 *                    hay implementación. Es el estado honesto para lo que
 *                    construyen P03-P14; declararlo `implemented` sería mentir.
 */

/** Dominios de NEGOCIO. Son los doce que ordena el recorrido SaaS. */
export const DOMAIN_IDS = [
  'catalog',
  'pricing',
  'customers',
  'inventory',
  'checkout',
  'orders',
  'payments',
  'promotions',
  'content',
  'fulfillment',
  'analytics',
  'integrations',
] as const
export type DomainId = (typeof DOMAIN_IDS)[number]

/**
 * Áreas de PLATAFORMA. No son dominios de comercio y por eso no están en la
 * lista de doce: son las que sostienen a todas las demás. Separarlas evita el
 * error de tratar «identidad» como si fuera un módulo vendible más.
 */
export const PLATFORM_AREA_IDS = [
  'identity',
  'tenancy',
  'entitlements',
  'provisioning',
  'configuration',
  'shell',
] as const
export type PlatformAreaId = (typeof PLATFORM_AREA_IDS)[number]

export type BoundaryId = DomainId | PlatformAreaId

export type BoundaryState = 'implemented' | 'partial' | 'declared'

export interface Boundary {
  readonly id: BoundaryId
  readonly kind: 'domain' | 'platform'
  readonly state: BoundaryState
  /** Qué decide esta frontera y, por tanto, qué NO decide ninguna otra. */
  readonly responsibility: string
  /**
   * Prefijos de ruta bajo `src/` que pertenecen a esta frontera. Gana el
   * prefijo más largo, así que un archivo suelto puede sacarse de la carpeta
   * que lo contiene sin partir la carpeta en dos.
   */
  readonly paths: readonly string[]
  /** Puerto que gobierna la frontera hacia fuera, si lo tiene. */
  readonly port?: string
  /** Dónde vive hoy lo que ya existe y no está en `src/` (base o borde). */
  readonly serverSide?: readonly string[]
}

export const BOUNDARIES: readonly Boundary[] = [
  {
    id: 'catalog',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'Qué se vende: producto, categoría, imágenes y su publicación. No decide precio ni disponibilidad.',
    paths: ['features/catalog'],
    serverSide: ['supabase/functions/catalog-product', 'migraciones 090300, 091100, 091200'],
  },
  {
    id: 'pricing',
    kind: 'domain',
    state: 'partial',
    responsibility:
      'Cuánto cuesta una línea antes de promociones: precio base, moneda e impuesto aplicable.',
    paths: [],
    port: 'PricingPort',
    serverSide: [
      'products.price y compare_at_price (090300)',
      'ebim.effective_tax_rate (091700, 091800, 091900)',
      'create_order es hoy la autoridad de precio (130300)',
    ],
  },
  {
    id: 'customers',
    kind: 'domain',
    state: 'declared',
    responsibility:
      'Quién compra, separado de quién se autentica: cuenta, contacto, segmento y condiciones B2B.',
    paths: [],
    serverSide: ['hoy solo contacto desnormalizado en orders (090400)'],
  },
  {
    id: 'inventory',
    kind: 'domain',
    state: 'partial',
    responsibility:
      'Cuánto hay y cuánto se puede prometer: existencias, reservas y disponibilidad publicable.',
    paths: [],
    port: 'InventoryPort',
    serverSide: [
      'products.stock y products.in_stock generada (090300, 091200)',
      'descuento de stock dentro de create_order (091300)',
    ],
  },
  {
    id: 'checkout',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'Del carrito al pedido: intención de compra, datos de contacto y la llamada que la convierte en pedido.',
    paths: [
      'features/storefront/cart',
      'features/storefront/checkout.ts',
      'features/storefront/StoreCartPage.tsx',
      'features/storefront/StoreCheckoutPage.tsx',
    ],
    serverSide: ['supabase/functions/create-order', 'create_order (091300, 130300)'],
  },
  {
    id: 'orders',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'El pedido una vez existe: estado, historial y consulta por el comprador o por el comercio.',
    paths: ['features/orders', 'features/storefront/StoreOrderPage.tsx'],
    serverSide: [
      'supabase/functions/update-order-status',
      'order_status_events (091400)',
      'order_by_token (140000)',
    ],
  },
  {
    id: 'payments',
    kind: 'domain',
    state: 'declared',
    responsibility:
      'Cobro y su conciliación: intento de pago, autorización, captura, devolución y webhooks.',
    paths: [],
    port: 'PaymentProvider',
    serverSide: ['solo el catálogo de proveedores en integration_providers (150000)'],
  },
  {
    id: 'promotions',
    kind: 'domain',
    state: 'declared',
    responsibility:
      'Descuento sobre el precio base ya resuelto: campañas, cupones y su desglose.',
    paths: [],
    serverSide: ['orders.discount_total existe y vale siempre 0 (090400)'],
  },
  {
    id: 'content',
    kind: 'domain',
    state: 'partial',
    responsibility:
      'Cómo se presenta la tienda al comprador: vitrina, navegación, ficha y marca publicable.',
    paths: ['features/storefront'],
    serverSide: ['public_stores y public_products (090500, 091200)', 'store_settings (091500)'],
  },
  {
    id: 'fulfillment',
    kind: 'domain',
    state: 'declared',
    responsibility: 'Cómo llega el pedido: zonas, métodos, envío, seguimiento y devolución.',
    paths: [],
    port: 'FulfillmentProvider',
    serverSide: ['orders.shipping_total existe y vale siempre 0 (090400)'],
  },
  {
    id: 'analytics',
    kind: 'domain',
    state: 'partial',
    responsibility:
      'Qué está pasando en la tienda: indicadores agregados y, más adelante, la bitácora transversal.',
    paths: ['features/admin/useDashboardKpis.ts', 'features/admin/DashboardPage.tsx'],
    serverSide: ['dashboard_kpis, SECURITY INVOKER (091000)'],
  },
  {
    id: 'integrations',
    kind: 'domain',
    state: 'partial',
    responsibility:
      'Hablar con sistemas de terceros por un contrato canónico: catálogo de proveedores, outbox, inbox y disyuntor.',
    paths: [],
    port: 'ErpProvider · InvoicingProvider · NotificationProvider',
    serverSide: ['integration_* (150000, 150100), sin un solo consumidor en src/'],
  },

  {
    id: 'identity',
    kind: 'platform',
    state: 'implemented',
    responsibility:
      'Quién es el usuario del backoffice y si su sesión sigue viva. El comprador del storefront es anónimo por diseño.',
    paths: ['features/auth'],
    serverSide: ['Supabase Auth y ebim.demo_access_token_hook (120000, 121000)'],
  },
  {
    id: 'tenancy',
    kind: 'platform',
    state: 'implemented',
    responsibility:
      'Qué organización, sociedad y tienda están activas. Siempre derivado del JWT, nunca declarado por el cliente.',
    paths: ['features/tenant'],
    serverSide: ['ebim.can_access y ebim.has_role (090000)', 'tenant_members (090100)'],
  },
  {
    id: 'entitlements',
    kind: 'platform',
    state: 'implemented',
    responsibility:
      'Qué módulos tiene contratados y activos la sociedad. Lo contratado lo decide el hub (contrato §5/§6); esta área lo resuelve, lo cachea y lo hace cumplir. No es un módulo vendible: es el que decide qué módulos hay.',
    paths: ['features/capabilities'],
    serverSide: [
      'app_capabilities, tenant_platform_context, tenant_entitlements, tenant_feature_flags (160000)',
      'ebim.has_capability y public.effective_capabilities (160000)',
      'supabase/functions/platform-context',
    ],
  },
  {
    id: 'provisioning',
    kind: 'platform',
    state: 'implemented',
    responsibility: 'Dar de alta un tenant con su primera sociedad, tienda y administrador.',
    paths: ['features/onboarding'],
    serverSide: ['supabase/functions/bootstrap-tenant', 'bootstrap_tenant (090700)'],
  },
  {
    id: 'configuration',
    kind: 'platform',
    state: 'implemented',
    responsibility:
      'Lo que el tenant activa y personaliza sin tocar código: branding, impuestos y ajustes de tienda.',
    paths: ['features/admin/settings'],
    serverSide: ['store_settings (091500)', 'tax_categories y set_tax_rate (091600, 091800)'],
  },
  {
    id: 'shell',
    kind: 'platform',
    state: 'implemented',
    responsibility:
      'El armazón: router, providers, layout del backoffice, design system, i18n y utilidades compartidas.',
    paths: ['app', 'shared', 'theme', 'features/admin', 'main.tsx'],
  },
]

const BY_ID = new Map<BoundaryId, Boundary>(BOUNDARIES.map((b) => [b.id, b]))

export function boundary(id: BoundaryId): Boundary {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`Frontera no declarada: ${id}`)
  return found
}

/**
 * Frontera a la que pertenece una ruta de `src/`. Gana el prefijo más largo:
 * `features/admin/settings/api.ts` es `configuration` aunque `features/admin`
 * sea `shell`.
 */
export function boundaryForPath(relativePath: string): Boundary | null {
  const path = relativePath.replace(/\\/g, '/')
  let best: Boundary | null = null
  let bestLength = -1

  for (const candidate of BOUNDARIES) {
    for (const prefix of candidate.paths) {
      const matches = path === prefix || path.startsWith(`${prefix}/`)
      if (matches && prefix.length > bestLength) {
        best = candidate
        bestLength = prefix.length
      }
    }
  }
  return best
}
