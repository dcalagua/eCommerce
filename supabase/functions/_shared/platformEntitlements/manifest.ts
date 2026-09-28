/**
 * Manifiesto `ebim.capabilities/v1` de eCommerce: lo que ESTE receptor sabe
 * hacer cumplir. Lo importa MasterAdmin (`platform.import_capability_manifest`)
 * y lo sirve `GET /platform-provisioning/entitlements/manifest`, byte a byte
 * igual que `docs/platform-provisioning/ENTITLEMENTS_MANIFEST.json` (test).
 *
 * Códigos canónicos = los `entitlement_code` que eCommerce ya esperaba del hub
 * (`public.app_capabilities`), sin renombrar: ya estaban en dot-notation con el
 * prefijo del producto. Lo baseline no se lista (el snapshot tampoco lo trae).
 *
 * `scopeLevel: TENANT` en todo, a propósito: un tenant de MasterAdmin es UNA
 * organización con UNA sociedad en eCommerce (alta GENERIC v1), y el receptor no
 * tiene cómo traducir ids de compañía de MasterAdmin. Una concesión con lista
 * explícita de compañías no se concede (fail-closed) y queda en la auditoría.
 *
 * Sin precios, sin cuotas, sin valores comerciales: solo QUÉ existe.
 */

export interface ManifestCapability {
  code: string
  name: string
  kind: 'FEATURE' | 'LIMIT' | 'ALLOWANCE' | 'AI_FEATURE'
  scopeLevel: 'TENANT' | 'COMPANY'
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED'
  unit?: string
  combineRule?: 'MAX' | 'SUM'
  meterCode?: string
  introducedInContract: string
}

export interface CapabilityManifest {
  schema: 'ebim.capabilities/v1'
  productCode: 'ecommerce'
  manifestVersion: string
  capabilities: ManifestCapability[]
}

const feature = (code: string, name: string, kind: 'FEATURE' | 'AI_FEATURE' = 'FEATURE'): ManifestCapability => ({
  code,
  name,
  kind,
  scopeLevel: 'TENANT',
  status: 'ACTIVE',
  introducedInContract: 'entitlements.v1',
})

export const ECOMMERCE_ENTITLEMENTS_MANIFEST: CapabilityManifest = {
  schema: 'ebim.capabilities/v1',
  productCode: 'ecommerce',
  manifestVersion: '2026-10-01.1',
  capabilities: [
    feature('ecommerce.ai.assist', 'Asistente IA', 'AI_FEATURE'),
    feature('ecommerce.ai.catalog.copy', 'IA · textos de catálogo', 'AI_FEATURE'),
    feature('ecommerce.ai.content', 'IA · contenido', 'AI_FEATURE'),
    {
      code: 'ecommerce.ai.credits',
      name: 'Créditos IA incluidos',
      kind: 'ALLOWANCE',
      scopeLevel: 'TENANT',
      status: 'ACTIVE',
      unit: 'credit',
      combineRule: 'SUM',
      meterCode: 'ai.credits',
      introducedInContract: 'entitlements.v1',
    },
    feature('ecommerce.ai.insights', 'IA · insights', 'AI_FEATURE'),
    feature('ecommerce.analytics.advanced', 'Analítica avanzada'),
    feature('ecommerce.catalog.advanced', 'Catálogo avanzado (PIM)'),
    feature('ecommerce.content.cms', 'CMS'),
    feature('ecommerce.content.white_label', 'Marca blanca'),
    feature('ecommerce.credit.management', 'Gestión de crédito'),
    feature('ecommerce.customers.b2b', 'Clientes B2B'),
    feature('ecommerce.fulfillment', 'Entregas'),
    feature('ecommerce.fulfillment.routing', 'Ruteo de entregas'),
    feature('ecommerce.integrations.enterprise', 'Integraciones enterprise'),
    feature('ecommerce.inventory.multiwarehouse', 'Multi-almacén'),
    feature('ecommerce.invoicing', 'Facturación a clientes'),
    feature('ecommerce.orders.advanced', 'Pedidos avanzados'),
    feature('ecommerce.payments', 'Cobros'),
    feature('ecommerce.planning.demand', 'Planificación de demanda'),
    feature('ecommerce.pricing.lists', 'Listas de precios'),
    feature('ecommerce.promotions', 'Promociones'),
    feature('ecommerce.sales.force', 'Fuerza de ventas'),
    feature('ecommerce.sales.performance', 'Desempeño comercial'),
    feature('ecommerce.sales.territory', 'Territorios de venta'),
    feature('ecommerce.trade.assortments', 'Surtidos B2B'),
    feature('ecommerce.trade.quotes', 'Cotizaciones B2B'),
  ],
}

/** Cuerpo EXACTO de `GET /entitlements/manifest` y del archivo versionado. */
export function manifestJson(): string {
  return `${JSON.stringify(ECOMMERCE_ENTITLEMENTS_MANIFEST, null, 2)}\n`
}
