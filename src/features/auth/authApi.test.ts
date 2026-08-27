import { describe, expect, it } from 'vitest'
import { mapAuthError } from './authApi'

/**
 * Los mensajes del SDK describen el mecanismo, no lo que el usuario tiene que
 * hacer. Este mapeo es lo único que separa "Invalid login credentials" de una
 * frase accionable, así que se prueba.
 */
describe('mapAuthError', () => {
  it('traduce credenciales inválidas', () => {
    expect(mapAuthError({ message: 'Invalid login credentials', status: 400 })).toBe(
      'auth.error.invalidCredentials',
    )
  })

  it('un 429 es límite de intentos aunque el mensaje no lo diga', () => {
    expect(mapAuthError({ message: 'whatever', status: 429 })).toBe('auth.error.rateLimited')
  })

  it('reconoce el correo sin confirmar', () => {
    expect(mapAuthError({ message: 'Email not confirmed', status: 400 })).toBe(
      'auth.error.emailNotConfirmed',
    )
  })

  it('reconoce un enlace de recuperación caducado', () => {
    expect(mapAuthError({ message: 'Token has expired or is invalid', status: 401 })).toBe(
      'auth.error.linkExpired',
    )
  })

  it('reconoce una contraseña demasiado corta', () => {
    expect(
      mapAuthError({ message: 'Password should be at least 8 characters', status: 422 }),
    ).toBe('auth.error.weakPassword')
  })

  it('un fallo de red no se presenta como credenciales malas', () => {
    expect(mapAuthError({ message: 'Failed to fetch' })).toBe('auth.error.network')
  })

  it('lo desconocido cae en el genérico, sin filtrar el texto del proveedor', () => {
    expect(mapAuthError({ message: 'pgrst: relation "x" does not exist', status: 500 })).toBe(
      'auth.error.generic',
    )
  })
})
