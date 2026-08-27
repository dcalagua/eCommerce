import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, assertNoServiceKey, isSupabaseConfigured } from './env'

let client: SupabaseClient | null = null

/**
 * Cliente Supabase del navegador. Usa únicamente la clave publicable:
 * el aislamiento lo hace RLS con `organization_id`/`company_id` del JWT,
 * nunca un filtro que declare el cliente.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase no está configurado. Copia `.env.example` a `.env` y define ' +
        'VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.',
    )
  }
  if (!client) {
    assertNoServiceKey()
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'ecommerce-auth',
      },
    })
  }
  return client
}

/** Para pantallas que deben degradar a estado vacío en vez de reventar. */
export function tryGetSupabaseClient(): SupabaseClient | null {
  return isSupabaseConfigured ? getSupabaseClient() : null
}
