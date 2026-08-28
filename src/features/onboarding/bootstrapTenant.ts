import type { MessageKey } from '@/shared/i18n/messages'
import { UiError } from '@/shared/lib/appError'
import { BOOTSTRAP_FUNCTION } from '@/shared/lib/db-schema'
import { codeFromInvokeError } from '@/shared/lib/edgeError'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

export { BOOTSTRAP_FUNCTION }

/** Slug de tienda: minúsculas, guiones, 3–62 (mismo CHECK que la base). */
export const STORE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/

export interface BootstrapInput {
  /** Nombre del negocio: nombra el espacio y su primera tienda. */
  tenant_name: string
  store_slug: string
  currency: string
}

export interface BootstrapResult {
  organization_id: string
  company_id: string
  tenant_slug: string
  store_id: string
  store_slug: string
  admin_email: string
}

export class BootstrapError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'provisioning', key, code })
    this.name = 'BootstrapError'
  }
}

/** Códigos que devuelve la Edge Function traducidos a algo accionable. */
export function mapBootstrapCode(code: string): MessageKey {
  switch (code) {
    case 'TENANT_YA_EXISTE':
      return 'onboarding.error.tenantExists'
    case 'DUPLICADO':
      return 'onboarding.error.slugTaken'
    case 'ADMIN_EMAIL_INVALIDO':
      return 'onboarding.error.operatorEmail'
    case 'ADMIN_EMAIL_REQUERIDO':
      return 'onboarding.error.noEmail'
    case 'NO_AUTENTICADO':
    case 'SIN_PERMISO':
      return 'onboarding.error.unauthorized'
    case 'CAMPO_INVALIDO':
    case 'CAMPO_NO_PERMITIDO':
    case 'TENANT_NO_ADMITIDO':
      return 'onboarding.error.invalidData'
    default:
      return 'onboarding.error.generic'
  }
}

/**
 * Alta del espacio del usuario.
 *
 * El cuerpo NO lleva `organization_id` ni `company_id`: la Edge Function los
 * saca del token verificado y rechaza con 400 cualquier intento de declararlos.
 * Enviarlos "por comodidad" desde aquí sería exactamente el vector que el
 * contrato §2.6 prohíbe.
 */
export async function bootstrapTenant(input: BootstrapInput): Promise<BootstrapResult> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new BootstrapError('auth.notConfigured', 'CONFIG_INCOMPLETA')

  const { data, error } = await supabase.functions.invoke<{ data: BootstrapResult }>(
    BOOTSTRAP_FUNCTION,
    {
      body: {
        tenant_name: input.tenant_name.trim(),
        store_slug: input.store_slug.trim().toLowerCase(),
        currency: input.currency,
      },
    },
  )

  if (error) {
    const code = await codeFromInvokeError(error)
    throw new BootstrapError(mapBootstrapCode(code), code)
  }
  if (!data?.data) throw new BootstrapError('onboarding.error.generic', 'RESPUESTA_VACIA')
  return data.data
}

/** Reexportado desde `shared/lib/slug`: lo usan también los cajones de catálogo. */
export { slugify } from '@/shared/lib/slug'
