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
      'Qué se vende y qué ES: producto, variantes, atributos, unidades de venta, kits, categoría, imágenes y su publicación. No decide precio ni disponibilidad.',
    paths: ['features/catalog'],
    serverSide: [
      'supabase/functions/catalog-product',
      'migraciones 090300, 091100, 091200',
      'PIM: 170000 (once tablas), 170100 (lectura pública), 170300 (P03-SaaS)',
    ],
  },
  {
    id: 'pricing',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'Cuánto cuesta una línea antes de promociones: listas por canal, segmento y cliente, escalas, vigencia, moneda e impuesto aplicable.',
    paths: ['features/pricing'],
    port: 'PricingPort',
    serverSide: [
      'ebim.resolve_prices y ebim.resolve_price — la ÚNICA autoridad de precio (180100)',
      'price_lists, price_list_items, price_list_assignments (180000)',
      'price_quote_for_slug (vitrina) y price_quote (backoffice) (180100)',
      'ebim.effective_tax_rate (091700, 091800, 091900)',
      'create_order pide el precio al motor, ya no lo calcula (180200)',
    ],
  },
  {
    id: 'customers',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'Quién compra, separado de quién se autentica: ficha, contactos, direcciones, segmento, identificadores externos y la cuenta B2B con sus usuarios, sucursales y límites.',
    // El segmento comercial nace en P04 porque es una dimensión de PRECIO antes
    // que una ficha de cliente; la ficha y la cuenta B2B son P05.
    paths: ['features/customers', 'features/storefront/StoreAccountPage.tsx'],
    serverSide: [
      'customer_segments — vocabulario comercial de la sociedad (180000)',
      'customers, customer_addresses, customer_contacts, customer_external_ids (190000)',
      'business_accounts, business_locations, business_account_users, approval_rules (190100)',
      'my_business_accounts y purchase_approval — contexto y autorización sin id del navegador (190100)',
      'price_quote deriva el segmento del cliente; customer_orders enlaza por correo (190200)',
      'contacto desnormalizado en orders: sigue siendo la verdad del pedido anónimo (090400)',
    ],
  },
  {
    id: 'inventory',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'Cuánto hay y cuánto se puede prometer: existencias por almacén, movimientos trazables, reservas con caducidad y disponibilidad publicable.',
    paths: ['features/inventory'],
    port: 'InventoryPort',
    serverSide: [
      'warehouses, store_warehouses, inventory_levels, inventory_movements y las dos de reserva (200000)',
      'ebim.atp — la única autoridad de disponibilidad (200100)',
      'ebim.take_units — el reparto decide DENTRO de la sentencia que escribe (200100)',
      'ebim.hold_stock / close_reservation — reserva atómica e idempotente (200100)',
      'reserve_inventory, adjust_inventory, sync_inventory_level y sus autorizaciones (200200)',
      'in_stock de la vitrina calculado por ATP (200300)',
      'create_order consume por ebim.consume_stock y acepta una reserva (200400)',
      'products.stock sigue siendo el camino de fallback sin almacenes (090300)',
    ],
  },
  {
    id: 'checkout',
    kind: 'domain',
    state: 'implemented',
    responsibility:
      'Del carrito al pedido: carrito persistente, intención de compra idempotente y el pipeline server-side que la convierte en pedido.',
    paths: [
      'features/storefront/cart',
      'features/storefront/checkout.ts',
      'features/storefront/StoreCartPage.tsx',
      'features/storefront/StoreCheckoutPage.tsx',
    ],
    serverSide: [
      'supabase/functions/checkout — el pipeline de once etapas (P07-SaaS)',
      'supabase/functions/_shared/checkout — orquestador puro, puertos y ganchos',
      'supabase/functions/create-order — la puerta de P02-P06, que sigue viva',
      'carts + cart_items, y la fusion invitado -> usuario (100000, 100100)',
      'checkout_intents — una compra por clave de idempotencia y tienda (100300)',
      'checkout_place_order — pedido + intento + carrito + hechos, en UNA transaccion (100400)',
      'domain_events — el outbox de dominio, sin proveedor (100200)',
      'create_order (091300, 130300, 180200, 200400)',
    ],
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
    // P09-SaaS. El dominio existe entero y no toca el de pedidos: un cobro
    // apunta al pedido y el pedido no apunta al cobro. Añadir una pasarela real
    // es registrar un adaptador en `_shared/payments/registry.ts`.
    state: 'implemented',
    responsibility:
      'Cobro y su conciliación: intento de pago, autorización, captura, devolución y webhooks.',
    paths: ['features/payments'],
    port: 'PaymentProvider',
    serverSide: [
      'catálogo de proveedores en integration_providers (150000) y conector `sandbox` (120200)',
      'siete tablas del dominio, guardas PCI y RLS default deny (120000)',
      'comandos: intent_open, apply_outcome, refund_request/settle y conciliación (120100)',
      'contrato canónico y adaptadores: supabase/functions/_shared/payments',
      'Edge Function payments-webhook: firma verificada e ingesta idempotente',
    ],
  },
  {
    id: 'promotions',
    kind: 'domain',
    // P10-SaaS. El motor existe entero y **no toca el de precios**: recibe
    // líneas ya cotizadas por `ebim.resolve_prices` y les resta. Añadir un tipo
    // de campaña es una rama en `ebim.evaluate_promotions`, no un cambio en
    // ninguna de las cinco tablas de P04.
    state: 'implemented',
    responsibility:
      'Descuento sobre el precio base ya resuelto: campañas, cupones, tarjetas regalo y su desglose.',
    paths: ['features/promotions'],
    serverSide: [
      'siete tablas del dominio con RLS default deny y bitácora DEFINER (130000)',
      'motor determinista con orden total y stacking explícito: evaluate_promotions (130100)',
      'tarjetas regalo: saldo, libro mayor y caducidad (130200)',
      'create_order evalúa con los cerrojos puestos y apunta el canje (130300)',
    ],
  },
  {
    id: 'content',
    kind: 'domain',
    // P11-SaaS. Deja de ser `partial`: la vitrina ya no es solo un lector del
    // catálogo, tiene páginas y bloques que el comercio escribe, con vigencia,
    // canal y segmento, y un buscador con índice propio. Lo que faltaba para
    // dejar de ser parcial no era código de pantalla, era que el CONTENIDO
    // fuera un dato del tenant en vez de una plantilla.
    state: 'implemented',
    responsibility:
      'Cómo se presenta la tienda al comprador y cómo la encuentra: vitrina, contenido administrable, navegación, ficha, marca publicable y búsqueda del catálogo.',
    paths: ['features/storefront', 'features/content'],
    port: 'SearchPort',
    serverSide: [
      'public_stores y public_products (090500, 091200)',
      'store_settings + tokens de white-label (091500, 140200)',
      'content_pages, content_blocks, content_block_items con RLS default deny (140000)',
      'ebim.resolve_content — una sola autoridad para la vitrina y la vista previa (140100)',
      'store_page_for_slug (anónimo) y content_preview (backoffice) (140100)',
      'products.search_vector, pg_trgm, search_synonyms y ebim.search_catalog (140300)',
    ],
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
