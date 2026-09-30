/**
 * Configuración del receptor de entitlements. FAIL-CLOSED como la de
 * provisioning: si falta algo, no hay configuración y las rutas responden 503.
 *
 * Reutiliza la verificación M2M de provisioning (misma clave pública, emisor,
 * audiencia y sujeto) y AÑADE sus propios scopes: una credencial que solo sabe
 * dar de alta tenants no puede escribir entitlements.
 *
 * Secretos nuevos (solo NOMBRES; los valores viven en `supabase secrets`):
 *   EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE   ecommerce:entitlements:write
 *   EBIM_MASTERADMIN_M2M_ENTITLEMENTS_READ_SCOPE    ecommerce:entitlements:read
 *   EBIM_ENTITLEMENTS_ENVIRONMENT                   DEV | QAS | DEMO | PRD (el de ESTE proyecto)
 *   EBIM_ENTITLEMENTS_PRODUCT_CODE                  opcional, `ecommerce` por defecto
 */
import type { EntitlementEnvironment } from './contract.ts'
import { loadM2MConfig, type M2MConfig } from '../platformProvisioning/m2m.ts'

type Env = { get(key: string): string | undefined }

export interface EntitlementsConfig {
  m2m: M2MConfig
  writeScope: string
  readScope: string
  environment: EntitlementEnvironment
  productCode: string
}

const ENVIRONMENTS: EntitlementEnvironment[] = ['DEV', 'QAS', 'DEMO', 'PRD']
const SCOPE_RE = /^[a-z0-9]+:entitlements:(write|read)$/

export function loadEntitlementsConfig(env: Env): EntitlementsConfig | null {
  const m2m = loadM2MConfig(env)
  if (!m2m) return null

  const writeScope = (env.get('EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE') || '').trim()
  const readScope = (env.get('EBIM_MASTERADMIN_M2M_ENTITLEMENTS_READ_SCOPE') || '').trim()
  const environment = (env.get('EBIM_ENTITLEMENTS_ENVIRONMENT') || '').trim() as EntitlementEnvironment
  const productCode = (env.get('EBIM_ENTITLEMENTS_PRODUCT_CODE') || 'ecommerce').trim()

  if (!SCOPE_RE.test(writeScope) || !SCOPE_RE.test(readScope) || writeScope === readScope) return null
  // Un scope de provisioning reutilizado aquí sería un permiso silencioso.
  if ([m2m.createScope, m2m.readScope].some((s) => s === writeScope || s === readScope)) return null
  if (!ENVIRONMENTS.includes(environment)) return null
  if (!/^[a-z0-9]+$/.test(productCode)) return null

  return { m2m, writeScope, readScope, environment, productCode }
}
