/**
 * Acceso a base de datos del receptor: SOLO las RPC de la migración
 * `20261001100000_masteradmin_entitlements` (service_role).
 *
 * Mismo cliente mínimo `{ rpc }` que provisioning: la lógica se prueba sin red
 * y `platform-provisioning/index.ts` es el único lugar que conoce la service-role.
 */
import type { RpcClient } from '../platformProvisioning/repository.ts'
import type { AppliedStatus, EnforcementMode, EntitlementSnapshot } from './contract.ts'

export interface ApplyMeta {
  correlationId: string
  m2mSubject: string
  m2mJti: string
  actorId: string | null
  actorRole: string | null
}

export interface ApplyResult {
  httpStatus: number
  body: Record<string, unknown>
}

export interface AppliedState {
  appliedVersion: number | null
  appliedChecksum: string | null
  appliedAt: string | null
  status: AppliedStatus
  unknownCapabilities: string[]
  enforcementMode: EnforcementMode
}

export interface EntitlementsRepository {
  /** `true` = primer uso del `jti`; `false` = reutilizado. */
  useJti(issuer: string, jti: string, expiresAt: string): Promise<boolean>
  apply(controlPlaneTenantId: string, snapshot: EntitlementSnapshot, meta: ApplyMeta): Promise<ApplyResult>
  /** null = tenant sin provisioning local. */
  getApplied(controlPlaneTenantId: string): Promise<AppliedState | null>
}

export class EntitlementsRepositoryError extends Error {}

export function createEntitlementsRpcRepository(client: RpcClient): EntitlementsRepository {
  return {
    async useJti(issuer, jti, expiresAt) {
      const { data, error } = await client.rpc('platform_entitlements_use_jti', {
        p_issuer: issuer,
        p_jti: jti,
        p_expires_at: expiresAt,
      })
      if (error || typeof data !== 'boolean') throw new EntitlementsRepositoryError(error?.message ?? 'empty result')
      return data
    },
    async apply(controlPlaneTenantId, snapshot, meta) {
      const { data, error } = await client.rpc('platform_apply_entitlements', {
        p_control_plane_tenant_id: controlPlaneTenantId,
        p_snapshot: snapshot,
        p_meta: meta,
      })
      // El mensaje de Postgres NO sale hacia MasterAdmin (describiría el esquema).
      const result = data as ApplyResult | null
      if (error || !result || typeof result.httpStatus !== 'number' || typeof result.body !== 'object') {
        throw new EntitlementsRepositoryError(error?.message ?? 'empty result')
      }
      return result
    },
    async getApplied(controlPlaneTenantId) {
      const { data, error } = await client.rpc('platform_get_entitlements', {
        p_control_plane_tenant_id: controlPlaneTenantId,
      })
      if (error) throw new EntitlementsRepositoryError(error.message)
      return (data as AppliedState | null) ?? null
    },
  }
}
