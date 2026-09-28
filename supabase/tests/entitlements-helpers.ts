/**
 * Utilidades de prueba del receptor `ebim.entitlements/v1` de eCommerce.
 *
 * `ecommerceSnapshot` arma un snapshot COMPLETO como lo emite MasterAdmin:
 * todas las capacidades vendibles del manifiesto con `enabled` explícito (una
 * ausente se deniega), arreglos ordenados por `code`, `idempotencyKey` y
 * `checksum` calculados con la misma JCS que verifica el receptor. Los valores
 * numéricos son ilustrativos: ningún precio, ninguna cuota comercial decidida.
 */
import type { PGlite } from '@electric-sql/pglite'
import { asRole } from './harness.ts'
import { entitlementChecksum, sha256Hex } from '../functions/_shared/platformEntitlements/jcs.ts'
import { ECOMMERCE_ENTITLEMENTS_MANIFEST } from '../functions/_shared/platformEntitlements/manifest.ts'
import type { EntitlementSnapshot } from '../functions/_shared/platformEntitlements/contract.ts'

type Row = Record<string, unknown>

export const SELLABLE_CODES = ECOMMERCE_ENTITLEMENTS_MANIFEST.capabilities
  .filter((c) => c.kind === 'FEATURE' || c.kind === 'AI_FEATURE')
  .map((c) => c.code)
  .sort()

export interface SnapshotOptions {
  tenant: string
  version: number
  enabled?: string[]
  appActive?: boolean
  planCode?: string | null
  aiCredits?: number | null
  extraCapabilities?: string[]
  /** Capacidades con alcance COMPANY y lista explícita de compañías de MasterAdmin. */
  companyScoped?: string[]
  environment?: 'DEV' | 'QAS' | 'DEMO' | 'PRD'
  organizationId?: string
  companyId?: string
}

export async function ecommerceSnapshot(o: SnapshotOptions): Promise<EntitlementSnapshot> {
  const enabled = new Set([...(o.enabled ?? []), ...(o.companyScoped ?? [])])
  const codes = [...new Set([...SELLABLE_CODES, ...(o.extraCapabilities ?? [])])].sort()
  const n = String(o.version).padStart(4, '0')
  const doc: Omit<EntitlementSnapshot, 'checksum'> & { checksum?: string } = {
    schema: 'ebim.entitlements/v1',
    environment: o.environment ?? 'DEV',
    controlPlaneTenantId: o.tenant,
    productCode: 'ecommerce',
    external: {
      tenantId: o.organizationId ?? 'ecommerce-ext',
      organizationId: o.organizationId ?? null,
      companyIds: o.companyId ? [o.companyId] : [],
    },
    snapshotVersion: o.version,
    previousVersion: o.version > 1 ? o.version - 1 : null,
    effectiveAt: '2026-10-01T00:00:00Z',
    issuedAt: '2026-10-01T00:00:05Z',
    appActive: o.appActive ?? true,
    planCode: o.planCode === undefined ? 'ecommerce-shared-standard' : o.planCode,
    capabilities: codes.map((code) => ({
      code,
      enabled: enabled.has(code) || (o.extraCapabilities ?? []).includes(code),
      scope: (o.companyScoped ?? []).includes(code)
        ? { level: 'COMPANY' as const, companyIds: ['00000000-0000-4ccc-8000-00000000c001'] }
        : { level: 'TENANT' as const },
      sources: enabled.has(code) ? (['PLAN'] as const).slice() : [],
    })),
    limits: [],
    allowances:
      o.aiCredits === null || o.aiCredits === undefined
        ? []
        : [
            {
              code: 'ecommerce.ai.credits',
              meterCode: 'ai.credits',
              included: o.aiCredits,
              unit: 'credit',
              period: { start: '2026-10-01', end: '2026-10-31' },
              overageMode: 'BLOCK' as const,
              sources: ['PLAN' as const],
            },
          ],
    aiCredits: { weights: [], weightsVersion: 0 },
    correlationId: `00000000-0000-4ccc-8000-00000000${n}`.slice(0, 36),
    idempotencyKey: `ma-ent-v1-${await sha256Hex(`${o.tenant}:ecommerce:${o.version}`)}`,
  }
  doc.checksum = await entitlementChecksum(doc as Record<string, unknown>)
  return doc as EntitlementSnapshot
}

/** Alta M2M real (misma RPC que usa `platform-provisioning`). */
export async function provisionTenant(
  db: PGlite,
  ids: { cpt: string; org: string; company: string; slug: string },
): Promise<void> {
  await asRole(db, 'service_role', null, async () => {
    await db.query('select public.platform_provision_tenant($1::jsonb, $2::jsonb)', [
      JSON.stringify({
        controlPlaneTenantId: ids.cpt,
        organization: { id: ids.org, slug: ids.slug, name: `Tienda ${ids.slug}` },
        company: { id: ids.company },
        admin: { email: `owner@${ids.slug}.test` },
        deploymentMode: 'SHARED',
        context: {},
      }),
      JSON.stringify({
        idempotencyKey: `ent-test-${ids.slug}`,
        requestHash: 'b'.repeat(64),
        correlationId: ids.cpt,
        m2mSubject: 'masteradmin-provisioning',
        m2mJti: `jti-${ids.slug}`,
        actorId: null,
        actorRole: null,
      }),
    ])
  })
}

export function applyMeta(overrides: Row = {}): Row {
  return {
    correlationId: '00000000-0000-4ccc-8000-0000000000aa',
    m2mSubject: 'masteradmin-provisioning',
    m2mJti: crypto.randomUUID(),
    actorId: null,
    actorRole: null,
    ...overrides,
  }
}
