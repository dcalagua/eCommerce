import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStorePreferences, writeStorePreference } from './store-preference'

/**
 * La preferencia de tienda, en el navegador.
 *
 * Es una comodidad, no una autorización, y por eso lo que más importa aquí es
 * cómo FALLA: `localStorage` lanza en navegación privada y con cookies
 * bloqueadas, y lo que hay guardado puede venir de otra versión o de alguien
 * escribiendo a mano. En los tres casos el backoffice tiene que seguir
 * entrando; quedarse sin recordar la tienda es un incordio, quedarse sin entrar
 * es un incidente.
 */
const KEY = 'ecommerce-active-store'
const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STORE = 'ssssssss-ssss-4sss-8sss-ssssssssssss'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('la tienda recordada por sociedad', () => {
  it('guarda y devuelve la elección', () => {
    writeStorePreference(COMPANY, STORE)

    expect(readStorePreferences()).toEqual({ [COMPANY]: STORE })
  })

  it('recuerda una tienda POR sociedad, no la última a secas', () => {
    writeStorePreference(COMPANY, STORE)
    writeStorePreference('otra-sociedad', 'otra-tienda')

    // Quien trabaja en dos sociedades tiene dos tiendas habituales: recordar
    // solo la última le devolvería la de la otra sociedad en cada cambio.
    expect(readStorePreferences()).toEqual({
      [COMPANY]: STORE,
      'otra-sociedad': 'otra-tienda',
    })
  })

  it('sin sociedad no guarda nada: una tienda sin dueño no se puede recuperar', () => {
    writeStorePreference(null, STORE)

    expect(readStorePreferences()).toEqual({})
  })

  it('lo que no son pares de cadenas se descarta', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ [COMPANY]: STORE, roto: 42, nulo: null, objeto: { id: 'x' } }),
    )

    expect(readStorePreferences()).toEqual({ [COMPANY]: STORE })
  })

  it('un contenido que no es JSON no rompe: se empieza de cero', () => {
    window.localStorage.setItem(KEY, 'esto no es json')

    expect(readStorePreferences()).toEqual({})
  })

  it('un almacenamiento bloqueado no tumba el backoffice', () => {
    const roto = () => {
      throw new Error('storage bloqueado')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(roto)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(roto)

    expect(readStorePreferences()).toEqual({})
    expect(() => writeStorePreference(COMPANY, STORE)).not.toThrow()
  })
})
