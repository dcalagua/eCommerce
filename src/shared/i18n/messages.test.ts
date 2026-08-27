/**
 * Paridad ES/EN del diccionario.
 *
 * `translate` cae al español cuando falta una clave en inglés: es la decisión
 * correcta en tiempo de ejecución (mejor un texto en español que una clave
 * cruda en pantalla), pero significa que una traducción olvidada NO rompe nada
 * y se cuela hasta producción disfrazada de idioma equivocado. Este test es el
 * que la caza.
 */
import { describe, expect, it } from 'vitest'
import { LOCALES, MESSAGES, type Locale } from './messages'
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

  it('translate devuelve el idioma pedido y nunca la clave cruda', () => {
    for (const locale of LOCALES) {
      for (const key of esKeys) {
        const value = translate(locale as Locale, key as keyof typeof MESSAGES.es)
        expect(value, `${locale}:${key}`).not.toBe(key)
        expect(value.length, `${locale}:${key}`).toBeGreaterThan(0)
      }
    }
  })
})
