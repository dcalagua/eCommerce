/**
 * Fábricas de cliente Supabase para el borde (Deno).
 *
 * Vive fuera de `_shared` a propósito: `_shared` es TypeScript puro que el
 * `tsc` y los tests del repo compilan; esto importa el SDK con especificador
 * `npm:` y solo tiene sentido dentro de Deno.
 *
 * Regla bloqueante: `service_role` SOLO aquí dentro, nunca en el bundle del
 * front. `serviceClient()` falla ruidosamente si falta el secreto, en vez de
 * degradar silenciosamente a la clave publicable.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.48.0'
import { AppError } from '../_shared/errors.ts'

function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    throw new AppError('CONFIG_INCOMPLETA', `Falta la variable de entorno ${name}`, 500)
  }
  return value
}

/**
 * Cliente que actúa COMO EL USUARIO: clave publicable + su Authorization.
 * La RLS decide. Es el cliente por defecto de todo lo que toque datos de un
 * tenant desde el backoffice.
 */
export function userClient(request: Request): SupabaseClient {
  const authorization = request.headers.get('authorization') ?? ''
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Cliente anónimo puro, para lo público del storefront. */
export function anonClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Cliente con `service_role`: SALTA RLS. Solo para las dos operaciones que no
 * pueden hacerse con la sesión del llamante (alta de tenant, alta de pedido
 * anónimo), y siempre delegando la lógica en una función SECURITY DEFINER de
 * la base, que es donde vive la autorización.
 */
export function serviceClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
