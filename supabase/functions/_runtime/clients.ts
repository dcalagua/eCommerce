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
import { traceHeaders, type Trace } from '../_shared/observability/index.ts'

/**
 * El HILO, cosido a TODAS las llamadas que salen de esta funcion (P13-SaaS).
 *
 * Va como cabecera global del cliente y no como argumento de cada `rpc`, y esa
 * es la decision entera: PostgREST publica las cabeceras de la peticion en
 * `request.headers`, y de ahi las lee `ebim.correlation_id()`, que es el DEFAULT
 * de la columna `correlation_id` de ocho tablas. Resultado: cada fila escrita
 * durante esta peticion —el intento de checkout, el pedido, el cobro, el hecho
 * de dominio, el mensaje al exterior— queda colgada del mismo hilo sin que
 * `create_order` ni ninguna otra funcion de dominio acepte un parametro nuevo.
 *
 * Es opcional para no romper a ningun llamante existente: sin hilo, el
 * comportamiento es exactamente el de antes de P13.
 */
function withTrace(trace?: Trace): Record<string, string> {
  return trace ? traceHeaders(trace) : {}
}

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
export function userClient(request: Request, trace?: Trace): SupabaseClient {
  const authorization = request.headers.get('authorization') ?? ''
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization, ...withTrace(trace) } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Cliente anónimo puro, para lo público del storefront. */
export function anonClient(trace?: Trace): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: withTrace(trace) },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Cliente con `service_role`: SALTA RLS. Solo para las dos operaciones que no
 * pueden hacerse con la sesión del llamante (alta de tenant, alta de pedido
 * anónimo), y siempre delegando la lógica en una función SECURITY DEFINER de
 * la base, que es donde vive la autorización.
 */
export function serviceClient(trace?: Trace): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    global: { headers: withTrace(trace) },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
