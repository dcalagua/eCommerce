import { describe, expect, it } from 'vitest'
import { campanaQueTerminaAntes, mayorDescuento, partesRestantes } from './feria'
import type { StorePromotion } from './promotions'
import type { PublicProduct } from './types'

const AHORA = Date.parse('2026-09-27T12:00:00Z')

function promo(parcial: Partial<StorePromotion>): StorePromotion {
  return {
    id: 'p',
    name: 'Campaña',
    description: null,
    kind: 'percentage',
    percentOff: null,
    amountOff: null,
    buyQuantity: null,
    freeQuantity: null,
    minSubtotal: null,
    endsAt: null,
    imageUrl: null,
    categorySlug: null,
    brandCode: null,
    ...parcial,
  }
}

const producto = (price: string, compare: string | null) =>
  ({ price, compare_at_price: compare }) as unknown as PublicProduct

describe('la feria no inventa urgencia', () => {
  it('el reloj es de la campaña que ANTES termina, dentro de una semana', () => {
    const elegida = campanaQueTerminaAntes(
      [
        promo({ id: 'lejos', endsAt: '2026-09-30T12:00:00Z' }),
        promo({ id: 'pronto', endsAt: '2026-09-27T18:00:00Z' }),
        promo({ id: 'sin-fin' }),
      ],
      AHORA,
    )
    expect(elegida?.id).toBe('pronto')
  })

  it('sin fecha de fin, ya vencida o a más de una semana: no hay reloj', () => {
    expect(campanaQueTerminaAntes([promo({})], AHORA)).toBeNull()
    expect(campanaQueTerminaAntes([promo({ endsAt: '2026-09-26T12:00:00Z' })], AHORA)).toBeNull()
    expect(campanaQueTerminaAntes([promo({ endsAt: '2026-10-20T12:00:00Z' })], AHORA)).toBeNull()
  })

  it('«hasta −N %» es el mayor descuento REAL, de productos o de campañas en porcentaje', () => {
    expect(mayorDescuento([producto('60.00', '100.00'), producto('90.00', '100.00')])).toBe(40)
    expect(mayorDescuento([producto('90.00', '100.00')], [promo({ percentOff: 25 })])).toBe(25)
    // Un importe fijo no es un porcentaje: no cuenta para «hasta −N %».
    expect(mayorDescuento([], [promo({ kind: 'fixed_amount', percentOff: 80 })])).toBe(0)
  })

  it('el reloj se parte en días, horas, minutos y segundos, y desaparece al llegar a cero', () => {
    expect(partesRestantes('2026-09-28T13:02:03Z', AHORA)).toEqual({ dias: 1, horas: 1, minutos: 2, segundos: 3 })
    expect(partesRestantes('2026-09-27T12:00:00Z', AHORA)).toBeNull()
  })
})
