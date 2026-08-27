import type { MessageKey } from '@/shared/i18n/messages'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

/**
 * Error de autenticación traducible.
 *
 * Los mensajes del SDK vienen en inglés y describen el mecanismo
 * ("Invalid login credentials"), no lo que el usuario tiene que hacer. Se
 * mapean a claves del diccionario; lo desconocido cae en un mensaje genérico en
 * vez de mostrar texto crudo del proveedor.
 */
export class AuthActionError extends Error {
  readonly key: MessageKey

  constructor(key: MessageKey, cause?: unknown) {
    super(key)
    this.name = 'AuthActionError'
    this.key = key
    if (cause instanceof Error) this.cause = cause
  }
}

export function mapAuthError(error: { message?: string; status?: number }): MessageKey {
  const message = (error.message ?? '').toLowerCase()
  if (error.status === 429 || message.includes('rate limit') || message.includes('too many')) {
    return 'auth.error.rateLimited'
  }
  if (message.includes('invalid login credentials') || message.includes('invalid credentials')) {
    return 'auth.error.invalidCredentials'
  }
  if (message.includes('email not confirmed')) return 'auth.error.emailNotConfirmed'
  if (message.includes('password') && message.includes('should be at least')) {
    return 'auth.error.weakPassword'
  }
  if (message.includes('expired') || message.includes('invalid claim')) {
    return 'auth.error.linkExpired'
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return 'auth.error.network'
  }
  return 'auth.error.generic'
}

function client() {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new AuthActionError('auth.notConfigured')
  return supabase
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await client().auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })
  if (error) throw new AuthActionError(mapAuthError(error), error)
}

/** Ruta a la que apunta el enlace del correo de recuperación. */
export const RESET_PATH = '/nueva-clave'

/**
 * Pide el correo de recuperación. No distingue entre correo existente y no
 * existente ni aquí ni en la pantalla: responder "ese correo no existe" es
 * regalar un enumerador de cuentas.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const redirectTo =
    typeof window === 'undefined' ? undefined : `${window.location.origin}${RESET_PATH}`
  const { error } = await client().auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    ...(redirectTo ? { redirectTo } : {}),
  })
  if (error) throw new AuthActionError(mapAuthError(error), error)
}

export async function updatePassword(password: string): Promise<void> {
  const { error } = await client().auth.updateUser({ password })
  if (error) throw new AuthActionError(mapAuthError(error), error)
}
