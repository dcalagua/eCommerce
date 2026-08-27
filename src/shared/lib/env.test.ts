import { describe, expect, it } from 'vitest'
import { assertNoServiceKey } from './env'

/**
 * Guard de seguridad bloqueante: una clave de servicio en el bundle del frontend
 * es un incidente, no un detalle de configuración (contrato EBIM).
 */
describe('assertNoServiceKey', () => {
  it('acepta un entorno con solo claves publicables', () => {
    expect(() =>
      assertNoServiceKey({
        VITE_SUPABASE_URL: 'https://demo.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123',
      }),
    ).not.toThrow()
  })

  it('rechaza una variable con nombre de service_role', () => {
    expect(() =>
      assertNoServiceKey({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'lo-que-sea' }),
    ).toThrow(/service_role/i)
  })

  it('rechaza un secreto camuflado en una variable de nombre inocente', () => {
    expect(() => assertNoServiceKey({ VITE_API_TOKEN: 'sb_secret_xyz' })).toThrow(
      /Claves de servicio expuestas/,
    )
  })

  it('ignora variables que no llegan al bundle del cliente', () => {
    expect(() => assertNoServiceKey({ SUPABASE_SERVICE_ROLE_KEY: 'solo-servidor' })).not.toThrow()
  })
})
