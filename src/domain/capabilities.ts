/**
 * Capacidades del producto y su resolución efectiva (P02-SaaS).
 *
 * Tres ejes que hasta P02 compartían la palabra «capability» y por eso se
 * confundían. Ahora cada uno tiene su nombre y su dueño:
 *
 * | Eje | Pregunta | Quién manda | Dónde vive |
 * |---|---|---|---|
 * | **Permiso** (`Permission`) | ¿este ROL puede hacerlo? | la app | `shared/lib/roles.ts` |
 * | **Entitlement** | ¿la cuenta CONTRATÓ el módulo? | el **hub** (contrato §5/§6) | cache local |
 * | **Flag** (`FeatureFlags`) | ¿está encendido técnicamente? | el tenant | `tenant_feature_flags` |
 *
 * `Capability` es la unidad TÉCNICA que gatea: un módulo del producto. El
 * `Capability` de los roles pasó a llamarse `Permission` en esta fase, que es
 * lo que siempre fue; el ADR 001 §«alternativas descartadas» dejó ese
 * renombrado asignado aquí, a la fase que introduce el tercer eje.
 *
 * Este archivo es DOMINIO: no sabe de Supabase, de React ni de qué addon
 * cuesta cuánto. El catálogo comercial —planes, precios, nombres de venta— es
 * del hub y no se replica (principio 2 del contrato). Lo que sí es de esta app
 * es saber QUÉ SABE HACER: eso es el registro de abajo.
 */
import type { BoundaryId } from './boundaries'

/**
 * Capacidades BASELINE: vienen con el producto. Un tenant con eCommerce activo
 * las tiene siempre, no se venden aparte y ningún flag las apaga.
 */
export const BASELINE_CAPABILITY_IDS = [
  'analytics.basic',
  'catalog',
  'checkout',
  'customers',
  'orders',
  'storefront',
] as const

/** Capacidades VENDIBLES: exigen un entitlement activo del hub. */
export const SELLABLE_CAPABILITY_IDS = [
  'analytics.advanced',
  'catalog.advanced',
  'content.cms',
  'content.white_label',
  'customers.b2b',
  'fulfillment',
  'integrations.enterprise',
  'inventory.multiwarehouse',
  'orders.advanced',
  'payments',
  'pricing.lists',
  'promotions',
] as const

export const CAPABILITY_IDS = [
  ...BASELINE_CAPABILITY_IDS,
  ...SELLABLE_CAPABILITY_IDS,
] as const

export type BaselineCapabilityId = (typeof BASELINE_CAPABILITY_IDS)[number]
export type SellableCapabilityId = (typeof SELLABLE_CAPABILITY_IDS)[number]
export type CapabilityId = BaselineCapabilityId | SellableCapabilityId

/**
 * Un código de addon del hub. Deliberadamente `string` y no una unión: el hub
 * es el dueño del catálogo y puede devolver códigos que esta app no conoce
 * —de otra app de la suite, o de un módulo que aún no implementa—. Tiparlo
 * cerrado obligaría a esta app a declarar el catálogo ajeno, que es justo lo
 * que el contrato §6 prohíbe.
 */
export type EntitlementCode = string

/** Estado REAL de la capacidad en el producto, no la intención. */
export type CapabilityState = 'implemented' | 'partial' | 'declared'

export interface Capability {
  readonly id: CapabilityId
  /** Frontera de `boundaries.ts` que la implementa. */
  readonly boundary: BoundaryId
  /** `null` = baseline: viene con el producto y no se vende aparte. */
  readonly entitlement: EntitlementCode | null
  readonly state: CapabilityState
  /** Qué deja de poder hacer el tenant si no la tiene. */
  readonly grants: string
}

/**
 * Prefijo propuesto para los códigos de addon de esta app en el hub.
 *
 * **Provisional.** El alta de `ecommerce` en la suite y su catálogo de addons
 * los hace el operador (SAAS_ROADMAP §5.1); hasta entonces estos son los
 * códigos que esta app ESPERA, no los que el hub confirma. Cuando el catálogo
 * exista y no coincida, lo que cambia es esta constante y la columna
 * `entitlement_code` de `app_capabilities` — ni una línea de gating.
 */
export const ENTITLEMENT_PREFIX = 'ecommerce.'

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'catalog',
    boundary: 'catalog',
    entitlement: null,
    state: 'implemented',
    grants: 'Productos, categorías e imágenes con publicación por tienda.',
  },
  {
    id: 'storefront',
    boundary: 'content',
    entitlement: null,
    state: 'implemented',
    grants: 'Vitrina pública por slug con catálogo, ficha y marca del tenant.',
  },
  {
    id: 'checkout',
    boundary: 'checkout',
    entitlement: null,
    state: 'implemented',
    grants: 'Carrito y creación de pedido por un comprador anónimo.',
  },
  {
    id: 'orders',
    boundary: 'orders',
    entitlement: null,
    // BASELINE, y sigue siéndolo tras P08-SaaS. Los cuatro ejes de estado, la
    // línea de tiempo, los snapshots inmutables y las referencias externas no
    // son un módulo aparte: son lo que un pedido tiene que ser para que su
    // historial resista que cambie el catálogo. Cobrar por «la versión que no
    // miente» no sería vender un módulo.
    state: 'implemented',
    grants:
      'Gestión del pedido: estados de pedido, pago y entrega, línea de tiempo, ' +
      'snapshots inmutables, referencias externas y consulta por el comprador.',
  },
  {
    // VENDIBLE y `declared` (P08-SaaS). Lo que se vende no es gestionar el
    // pedido, es que los pedidos se creen SOLOS: programados, repetidos e
    // importados en masa. La capacidad se registra ahora —y las tablas NO— para
    // que el operador pueda dar de alta el addon en el hub sin esperar al
    // código; el ADR 008 escribe el disparador de cada una de las tres.
    id: 'orders.advanced',
    boundary: 'orders',
    entitlement: `${ENTITLEMENT_PREFIX}orders.advanced`,
    state: 'declared',
    grants: 'Pedidos programados, repetición de pedido e importación masiva.',
  },
  {
    id: 'analytics.basic',
    boundary: 'analytics',
    entitlement: null,
    state: 'implemented',
    grants: 'Indicadores agregados del panel de inicio.',
  },
  {
    id: 'customers',
    boundary: 'customers',
    // BASELINE (P05-SaaS). Guardar a quién le vendiste viene con el producto:
    // cobrar aparte por poder anotar el correo del comprador no sería un
    // módulo, sería un peaje, y dejaría a un tenant sin plan sin poder atender
    // una devolución. Lo vendible es la CUENTA B2B, no la ficha.
    entitlement: null,
    state: 'implemented',
    grants: 'Ficha de cliente con contactos, direcciones, segmento e identificadores externos.',
  },
  {
    id: 'catalog.advanced',
    boundary: 'catalog',
    entitlement: `${ENTITLEMENT_PREFIX}catalog.advanced`,
    // La primera vendible que deja de ser `declared` (P03-SaaS): tiene esquema,
    // pantalla y pedido detras. El `state` dice la verdad sobre el producto HOY,
    // y un test de paridad lo compara contra la fila de `app_capabilities`.
    state: 'implemented',
    grants: 'Variantes, atributos, unidades de venta y kits sobre un producto maestro unico.',
  },
  {
    id: 'pricing.lists',
    boundary: 'pricing',
    entitlement: `${ENTITLEMENT_PREFIX}pricing.lists`,
    // La segunda vendible que deja de ser `declared` (P04-SaaS): tiene esquema,
    // motor determinista, pantalla y pedido detras. Sin ella, la resolucion
    // devuelve el precio de catalogo — no falla, se degrada.
    state: 'implemented',
    grants:
      'Listas de precio por canal, segmento, cliente, cantidad, moneda y vigencia, con precedencia documentada.',
  },
  {
    id: 'customers.b2b',
    boundary: 'customers',
    entitlement: `${ENTITLEMENT_PREFIX}customers.b2b`,
    // La tercera vendible que deja de ser `declared` (P05-SaaS): cuentas con
    // varios usuarios, sucursales, roles y límites de autorización, con su
    // enforcement en las policies. El crédito NO entra: es lógica de ERP.
    state: 'implemented',
    grants:
      'Cuentas de empresa con varios usuarios, sucursales, roles y límites de autorización por monto.',
  },
  {
    id: 'inventory.multiwarehouse',
    boundary: 'inventory',
    entitlement: `${ENTITLEMENT_PREFIX}inventory.multiwarehouse`,
    // La cuarta vendible que deja de ser `declared` (P06-SaaS): almacenes,
    // movimientos trazables, reservas con caducidad y ATP por almacén, con su
    // enforcement en las policies. Sin ella el tenant sigue vendiendo contra
    // `products.stock` — no falla, se degrada, igual que el motor de precios.
    state: 'implemented',
    grants:
      'Existencias por almacén y variante, movimientos trazables, reservas con caducidad y disponibilidad prometida (ATP).',
  },
  {
    id: 'payments',
    boundary: 'payments',
    entitlement: `${ENTITLEMENT_PREFIX}payments`,
    // P09-SaaS: el dominio existe entero —intento, intentos de llamada, cobro,
    // devolución, bitácora y conciliación—, con su contrato canónico de
    // pasarela y el conector `sandbox` desplegado. Lo que falta para cobrar de
    // verdad es una decisión del operador (qué pasarela), no código.
    state: 'implemented',
    grants: 'Cobro en línea: autorización, captura, devolución y conciliación (P09).',
  },
  {
    id: 'promotions',
    boundary: 'promotions',
    entitlement: `${ENTITLEMENT_PREFIX}promotions`,
    state: 'implemented',
    grants:
      'Campañas con prioridad y combinación explícitas, cupones, tarjetas regalo y desglose de descuento sobre el precio base (P10).',
  },
  {
    id: 'content.cms',
    boundary: 'content',
    entitlement: `${ENTITLEMENT_PREFIX}content.cms`,
    // La sexta vendible que deja de ser `declared` (P11-SaaS): páginas, bloques
    // con vigencia/canal/segmento, colecciones con FK de verdad, editor con
    // vista previa y búsqueda con sinónimos. Sin ella la vitrina cae a lo que
    // pintaba antes —hero de `store_settings` y catálogo— no falla: se degrada,
    // igual que el motor de precios, el inventario y las promociones.
    state: 'implemented',
    grants:
      'Páginas, colecciones y bloques editables de la vitrina, con vigencia, canal y segmento, más los sinónimos de búsqueda (P11).',
  },
  {
    id: 'content.white_label',
    boundary: 'content',
    entitlement: `${ENTITLEMENT_PREFIX}content.white_label`,
    // Estaba `implemented` desde P02 con un solo interruptor (`white_label`).
    // P11 no cambia su estado —ya estaba hecha— sino CUÁNTO cubre: tipografía,
    // identidad de correo y dominio propio. Lo que NO gatea sigue siendo el
    // acento, el logo, el favicon, el radio y la densidad: eso es tematización
    // y el lockup de la suite sigue puesto.
    state: 'implemented',
    grants:
      'Vitrina y correo sin la firma de la suite: tipografía de la whitelist, identidad de correo y dominio propio. El contrato §4.3 ya lo declara addon premium.',
  },
  {
    id: 'fulfillment',
    boundary: 'fulfillment',
    entitlement: `${ENTITLEMENT_PREFIX}fulfillment`,
    // La séptima vendible que deja de ser `declared` (P12-SaaS). Sin ella el
    // comercio sigue vendiendo exactamente como antes: `create_order` sin
    // `p_delivery` cobra transporte cero y no planifica entrega, así que el
    // pedido nace igual que en P11 y el backoffice lo mueve a mano por
    // `orders.status`. Se degrada, no se rompe — el mismo trato que el motor de
    // precios, el inventario, las promociones y el CMS.
    state: 'implemented',
    grants:
      'Zonas y métodos de entrega con tarifa server-side, ventanas, puntos de recojo, cola de preparación, seguimiento normalizado y devoluciones con reposición (P12).',
  },
  {
    id: 'analytics.advanced',
    boundary: 'analytics',
    entitlement: `${ENTITLEMENT_PREFIX}analytics.advanced`,
    // La séptima vendible que deja de ser `declared` (P13-SaaS): embudo de los
    // nueve hechos canónicos y términos de búsqueda, con su gate en la base
    // (`ebim.assert_analytics_advanced`) y no solo en la pantalla. Sin ella el
    // tenant conserva ventas, pedidos, ticket, productos y canal, que salen de
    // `orders` y son baseline: se degrada, no se rompe.
    //
    // Las COHORTES no entran y no se fingen: exigirían seguir a un comprador
    // identificado en el tiempo, y la analítica de esta app se guarda SIN PII a
    // propósito. Queda escrito en el ADR 013 en vez de dejar una función vacía
    // para que la casilla quede marcada.
    state: 'implemented',
    grants:
      'Embudo de conversión sobre los nueve hechos canónicos y términos de ' +
      'búsqueda con resultados vacíos, exportables.',
  },
  {
    id: 'integrations.enterprise',
    boundary: 'integrations',
    entitlement: `${ENTITLEMENT_PREFIX}integrations.enterprise`,
    // P14-SaaS. Deja de ser `partial`: hasta aquí existía el transporte —outbox,
    // reintentos, disyuntor— y no existía forma de que un tercero lo usara. Lo
    // que faltaba no era más SQL: eran credenciales con permisos, una API
    // versionada, suscripciones a eventos y una pantalla para operar los fallos.
    //
    // El addon cubre PUBLICAR. **No** cubre mirar: el monitor de integraciones
    // está fuera, igual que `/app/operations` en P13 — quien no puede ver por
    // qué le fallan las integraciones acaba llamando por teléfono.
    state: 'implemented',
    grants:
      'Habilitar conectores, credenciales de la API de socio con permisos por ' +
      'operación y suscripciones de webhook por evento.',
  },
]

const BY_ID = new Map<CapabilityId, Capability>(CAPABILITIES.map((c) => [c.id, c]))

export function capability(id: CapabilityId): Capability {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`Capacidad no declarada: ${id}`)
  return found
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && BY_ID.has(value as CapabilityId)
}

export function isBaselineCapability(id: CapabilityId): boolean {
  return capability(id).entitlement === null
}

/** Código de addon que concede la capacidad, o `null` si es baseline. */
export function entitlementFor(id: CapabilityId): EntitlementCode | null {
  return capability(id).entitlement
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

/** Contexto tal y como lo devuelve el hub (§5) o la cache local. */
export interface PlatformContextInput {
  /** ¿La cuenta tiene eCommerce activo? `app_active` del contrato §5. */
  readonly appActive: boolean
  /** Códigos de addon ACTIVOS. Los que esta app no conoce se ignoran. */
  readonly entitlements: readonly EntitlementCode[]
  /** Interruptores técnicos del tenant. Solo restan. */
  readonly flags?: Readonly<Record<string, boolean>>
}

export interface CapabilityResolution {
  /** Lo que el tenant puede usar ahora mismo. */
  readonly capabilities: readonly CapabilityId[]
  /** Lo contratado, antes de aplicar flags. */
  readonly entitled: readonly CapabilityId[]
  /** Contratado pero apagado por un flag técnico. */
  readonly disabledByFlag: readonly CapabilityId[]
  /** Códigos que el hub devolvió y esta versión de la app no reconoce. */
  readonly unknownEntitlements: readonly EntitlementCode[]
}

/**
 * Capacidad efectiva = app activa AND (baseline OR entitlement) AND flag ≠ false.
 *
 * Tres decisiones que no son obvias y que un test fija:
 *
 * 1. **`appActive: false` no deja ni lo baseline.** Si el hub dice que la
 *    cuenta no tiene esta app, no hay nada que gatear: no es un tenant con
 *    plan mínimo, es un tenant que no es cliente de eCommerce.
 * 2. **Un flag jamás concede.** `flags['payments'] = true` sin el addon no
 *    enciende nada. Si pudiera, la pantalla de ajustes del propio cliente
 *    sería un sistema de facturación en la sombra.
 * 3. **Un flag no apaga lo baseline.** Un interruptor capaz de dejar la tienda
 *    sin catálogo desde los ajustes del tenant es un botón de caída.
 *
 * Función PURA: no consulta nada. La autoridad real es `ebim.has_capability`
 * en la base, que aplica exactamente esta misma composición dentro de las
 * policies; esto es lo que permite que la UI no pida permiso por cada botón.
 */
export function resolveCapabilities(input: PlatformContextInput): CapabilityResolution {
  const flags = input.flags ?? {}

  if (!input.appActive) {
    return {
      capabilities: [],
      entitled: [],
      disabledByFlag: [],
      unknownEntitlements: [...input.entitlements].sort(),
    }
  }

  const active = new Set(input.entitlements)
  const known = new Set(
    CAPABILITIES.map((c) => c.entitlement).filter((code): code is string => code !== null),
  )

  const entitled: CapabilityId[] = []
  const capabilities: CapabilityId[] = []
  const disabledByFlag: CapabilityId[] = []

  for (const item of CAPABILITIES) {
    const isBaseline = item.entitlement === null
    if (!isBaseline && !active.has(item.entitlement as string)) continue

    entitled.push(item.id)
    if (!isBaseline && flags[item.id] === false) disabledByFlag.push(item.id)
    else capabilities.push(item.id)
  }

  const unknownEntitlements = [...active].filter((code) => !known.has(code)).sort()

  return {
    capabilities: capabilities.sort(),
    entitled: entitled.sort(),
    disabledByFlag: disabledByFlag.sort(),
    unknownEntitlements,
  }
}

/** Atajo de lectura. Sin capacidad resuelta no hay módulo: la duda es «no». */
export function hasCapability(
  resolution: Pick<CapabilityResolution, 'capabilities'> | null | undefined,
  id: CapabilityId,
): boolean {
  if (!resolution) return false
  return resolution.capabilities.includes(id)
}
