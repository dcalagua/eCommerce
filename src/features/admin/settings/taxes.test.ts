/**
 * Conversión porcentaje ↔ tasa.
 *
 * Parece trivial y es justo donde un error pasa desapercibido: la pantalla
 * habla en porcentaje (13) y la base guarda una fracción `numeric(6,4)`
 * (0.1300). Si la conversión pierde precisión, todos los pedidos del tenant
 * salen mal por una cantidad pequeña y constante, que es la peor forma de estar
 * mal porque nadie la nota hasta la auditoría.
 */
import { describe, expect, it } from 'vitest'
import { percentToRate, rateToPercent } from './taxes'

describe('porcentaje → tasa', () => {
  it('convierte los tipos habituales de la región', () => {
    expect(percentToRate(13)).toBe(0.13) // Bolivia
    expect(percentToRate(18)).toBe(0.18) // Perú
    expect(percentToRate(19)).toBe(0.19) // Chile
    expect(percentToRate(0)).toBe(0) // exento
  })

  it('respeta los cuatro decimales de numeric(6,4) y no más', () => {
    // 10.5 % existe como tipo reducido en varios países.
    expect(percentToRate(10.5)).toBe(0.105)
    // Un quinto decimal no cabe en la columna: se redondea aquí, no en la base,
    // para que lo que se guarda sea lo que se vio en pantalla.
    expect(percentToRate(1.23456)).toBe(0.0123)
  })

  it('no arrastra el error binario del float', () => {
    // 0.29 / 100 en coma flotante da 0.0028999999999999998.
    expect(percentToRate(0.29)).toBe(0.0029)
  })
})

describe('tasa → porcentaje', () => {
  it('deshace la conversión sin desviarse', () => {
    for (const percent of [0, 5, 10.5, 13, 18, 19, 21]) {
      expect(rateToPercent(String(percentToRate(percent).toFixed(4)))).toBe(percent)
    }
  })

  it('una categoría sin tasa vigente devuelve null, no cero', () => {
    // Cero es una tasa válida (exento). Confundirla con "sin configurar" haría
    // que un catálogo a medio configurar cobrara 0 % en silencio.
    expect(rateToPercent(null)).toBeNull()
    expect(rateToPercent('0.0000')).toBe(0)
  })
})
