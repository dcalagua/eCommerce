/**
 * Paridad ES/EN del diccionario.
 *
 * `translate` cae al español cuando falta una clave en inglés: es la decisión
 * correcta en tiempo de ejecución (mejor un texto en español que una clave
 * cruda en pantalla), pero significa que una traducción olvidada NO rompe nada
 * y se cuela hasta producción disfrazada de idioma equivocado. Este test es el
 * que la caza.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  dictionary,
  es,
  loadDictionary,
  loadedDictionary,
  LOCALES,
  type Locale,
  type MessageKey,
} from './messages'
import { MESSAGES } from './messages.all'
import { translate } from './i18n-context'

const esKeys = Object.keys(MESSAGES.es).sort()

describe('diccionario ES/EN', () => {
  it('los dos idiomas tienen exactamente las mismas claves', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort(), locale).toEqual(esKeys)
    }
  })

  /**
   * Solo se comprueba que el texto exista. Un filtro de «palabras de relleno»
   * (TODO / PENDIENTE / XXX) no sirve en un diccionario español: «Todo» es la
   * traducción de `store.categories.all` y «Pendiente» la de
   * `orders.status.pending`. Daría falsos positivos hasta que alguien apagara
   * el test, que es peor que no tenerlo.
   */
  it('ninguna traduccion esta vacia', () => {
    const vacias: string[] = []
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value !== 'string' || value.trim().length === 0) vacias.push(`${locale}:${key}`)
      }
    }
    expect(vacias).toEqual([])
  })

  it('el ingles no es una copia literal del espanol', () => {
    // No todas difieren (`SKU`, `EBIM`, siglas), pero si la mayoría coincide es
    // que el diccionario inglés se rellenó copiando y pegando.
    const iguales = esKeys.filter(
      (key) =>
        MESSAGES.en[key as keyof typeof MESSAGES.en] === MESSAGES.es[key as keyof typeof MESSAGES.es],
    )
    expect(iguales.length / esKeys.length).toBeLessThan(0.2)
  })

  /**
   * Desde P15-SaaS el inglés llega por `import()`, así que `translate` solo
   * puede devolver inglés DESPUÉS de que el módulo esté cargado. Se carga aquí
   * a propósito, en vez de rebajar la aserción: lo que este test defiende —que
   * ningún idioma acaba enseñando la clave cruda— sigue comprobándose sobre las
   * dos listas enteras.
   */
  it('translate devuelve el idioma pedido y nunca la clave cruda', async () => {
    for (const locale of LOCALES) await loadDictionary(locale as Locale)

    for (const locale of LOCALES) {
      for (const key of esKeys) {
        const value = translate(locale as Locale, key as keyof typeof MESSAGES.es)
        expect(value, `${locale}:${key}`).toBe(MESSAGES[locale as Locale][key as MessageKey])
        expect(value, `${locale}:${key}`).not.toBe(key)
        expect(value.length, `${locale}:${key}`).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * La carga diferida, con sus dos propiedades: que ES no la necesita y que hasta
 * que el otro idioma llega se ve ESPAÑOL, no una clave cruda ni un hueco.
 *
 * Es el precio explícito de no meter los dos diccionarios en el bundle de
 * entrada (61,76 kB gzip, la mitad de un idioma que no se lee). Escrito como
 * test para que sea una decisión y no una sorpresa.
 */
describe('carga diferida del diccionario', () => {
  it('el español está disponible sin esperar a nada', () => {
    expect(loadedDictionary('es')).toBe(es)
    expect(dictionary('es')['common.retry']).toBe('Reintentar')
  })

  it('un idioma que todavía no llegó se traduce en español, no con la clave', async () => {
    vi.resetModules()
    const fresh = await import('./messages')

    expect(fresh.loadedDictionary('en')).toBeUndefined()
    expect(fresh.dictionary('en')['common.retry']).toBe('Reintentar')

    await fresh.loadDictionary('en')
    expect(fresh.dictionary('en')['common.retry']).toBe('Try again')
  })

  it('cargar dos veces el mismo idioma devuelve el mismo objeto', async () => {
    const first = await loadDictionary('en')
    const second = await loadDictionary('en')
    expect(second).toBe(first)
  })
})

/**
 * El ahorro solo existe mientras nadie importe los dos diccionarios desde el
 * código que SÍ se descarga. `messages.all.ts` es para tests; si un módulo de
 * `app`/`features`/`shared` lo importara, Rollup volvería a meter los dos en el
 * bundle de entrada y el número de arriba se perdería sin que nadie lo notara.
 */
describe('el bundle no se lleva los dos idiomas', () => {
  it('solo los tests importan messages.all', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
        // Un `import`, no una mención: los comentarios de `messages.ts` hablan
        // de este módulo a propósito y no meten nada en el bundle.
        if (/from\s+'[^']*messages\.all'/.test(readFileSync(full, 'utf8'))) offenders.push(full)
      }
    }
    walk('src')

    expect(offenders).toEqual([])
  })
})
