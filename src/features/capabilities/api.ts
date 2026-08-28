import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'
import { codeFromInvokeError } from '@/shared/lib/edgeError'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EFFECTIVE_CAPABILITIES_RPC,
  PLATFORM_CONTEXT_FUNCTION,
  TENANT_FEATURE_FLAGS_TABLE,
  effectiveCapabilitiesSchema,
  toPlatformContext,
  type PlatformContext,
} from './types'

/**
 * Lectura de la configuración efectiva de módulos.
 *
 * Ninguna consulta lleva filtro de tenant: `effective_capabilities` deriva la
 * organización del JWT y comprueba `ebim.can_access` antes de devolver nada. La
 * sociedad SÍ viaja como parámetro, y no es una excepción a la regla: es
 * ALCANCE —el selector del backoffice puede estar en otra sociedad del mismo
 * usuario— y la función la valida contra `companies[]` del token. Una sociedad
 * ajena no devuelve lista vacía: levanta `SIN_PERMISO`, porque una lista vacía
 * la UI la pintaría como «no contrataste nada».
 */

export class CapabilitiesError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'entitlements', key, code })
    this.name = 'CapabilitiesError'
  }
}

export function mapCapabilitiesCode(code: string): MessageKey {
  switch (code) {
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'capabilities.error.forbidden'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    case 'HUB_NO_CONFIGURADO':
      return 'capabilities.error.hubMissing'
    case 'HUB_NO_DISPONIBLE':
      return 'capabilities.error.hubUnreachable'
    default:
      return 'capabilities.error.generic'
  }
}

function errorFromDb(error: PostgrestLike): CapabilitiesError {
  const code = codeFromDbError(error)
  return new CapabilitiesError(mapCapabilitiesCode(code), code)
}

function client(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new CapabilitiesError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

export const capabilitiesKey = (organizationId: string, companyId: string) =>
  ['capabilities', organizationId, companyId] as const

export async function fetchEffectiveCapabilities(companyId: string): Promise<PlatformContext> {
  const { data, error } = await client().rpc(EFFECTIVE_CAPABILITIES_RPC, {
    p_company_id: companyId,
  })
  if (error) throw errorFromDb(error)
  return toPlatformContext(effectiveCapabilitiesSchema.parse(data))
}

/**
 * Fuerza una relectura contra el hub (contrato §5) y refresca la cache local.
 *
 * El navegador NUNCA habla con el hub: lo hace la Edge Function, que es la
 * única que tiene la credencial de servicio. Aquí solo se dispara y se traduce
 * el fallo — `HUB_NO_CONFIGURADO` incluido, que hoy es la respuesta esperada
 * mientras `ecommerce` no esté dado de alta en la suite.
 */
export async function refreshPlatformContext(): Promise<void> {
  const { error } = await client().functions.invoke(PLATFORM_CONTEXT_FUNCTION, {
    body: { action: 'refresh' },
  })
  if (!error) return
  const code = await codeFromInvokeError(error)
  throw new CapabilitiesError(mapCapabilitiesCode(code), code)
}

/**
 * Enciende o apaga un flag técnico de la sociedad activa.
 *
 * El tenant es el del token: la fila lleva `organization_id`/`company_id`
 * porque la tabla los exige, y la policy de escritura vuelve a comprobarlos
 * contra el JWT. Escribir los del usuario de al lado no inserta nada, devuelve
 * un 42501.
 *
 * Un flag no concede: si el módulo no está contratado, encender esto no cambia
 * nada, ni en la pantalla ni en la base. Es intencional (`domain/flags.ts`).
 */
export async function setFeatureFlag(input: {
  organizationId: string
  companyId: string
  flagKey: string
  enabled: boolean
}): Promise<void> {
  const { error } = await client()
    .from(TENANT_FEATURE_FLAGS_TABLE)
    .upsert(
      {
        organization_id: input.organizationId,
        company_id: input.companyId,
        flag_key: input.flagKey,
        is_enabled: input.enabled,
      },
      { onConflict: 'organization_id,company_id,flag_key' },
    )
    .select('id')
    .maybeSingle()

  if (error) throw errorFromDb(error)
}
