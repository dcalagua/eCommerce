import { describe, expect, it } from 'vitest'
import type { PublicVariant } from './types'
import { galleryForVariant, galleryKey } from './variantGallery'

const COLOR = { code: 'color', name: 'Color', position: 0 }
const TALLA = { code: 'tamano', name: 'Tamaño', position: 1 }

function variante(id: string, color: string | null, talla?: string): PublicVariant {
  return {
    variant_id: id,
    product_id: 'p',
    store_id: 's',
    name: [color, talla].filter(Boolean).join(' / ') || id,
    position: 0,
    is_default: false,
    in_stock: true,
    price: '10.00',
    compare_at_price: null,
    currency: 'PEN',
    options: [
      ...(color ? [{ ...COLOR, value_code: color.toLowerCase(), label: color, value_position: 0 }] : []),
      ...(talla ? [{ ...TALLA, value_code: talla, label: talla, value_position: 0 }] : []),
    ],
  }
}

const foto = (id: string, variant_id: string | null) => ({ id, variant_id })

const negra20 = variante('n20', 'Negro', '20')
const negra28 = variante('n28', 'Negro', '28')
const azul20 = variante('a20', 'Azul', '20')
const roja20 = variante('r20', 'Rojo', '20')
const VARIANTES = [negra20, negra28, azul20, roja20]

describe('galleryForVariant — la galería sigue al color elegido', () => {
  const fotos = [foto('n-1', 'n20'), foto('n-2', 'n20'), foto('n-3', 'n28'), foto('a-1', 'a20'), foto('a-2', 'a20')]

  it('enseña solo las del color elegido', () => {
    expect(galleryForVariant(fotos, VARIANTES, azul20).map((f) => f.id)).toEqual(['a-1', 'a-2'])
  })

  it('otra talla del mismo color comparte las fotos', () => {
    expect(galleryForVariant(fotos, VARIANTES, negra28).map((f) => f.id)).toEqual(['n-1', 'n-2', 'n-3'])
  })

  it('un color sin fotos enseña solo la principal', () => {
    expect(galleryForVariant(fotos, VARIANTES, roja20).map((f) => f.id)).toEqual(['n-1'])
  })

  it('las del producto van detrás de las del color, y cubren al color sin fotos', () => {
    const conGenerales = [...fotos, foto('g-1', null)]
    expect(galleryForVariant(conGenerales, VARIANTES, azul20).map((f) => f.id)).toEqual(['a-1', 'a-2', 'g-1'])
    expect(galleryForVariant(conGenerales, VARIANTES, roja20).map((f) => f.id)).toEqual(['g-1'])
  })

  it('sin ninguna foto por variante, todas como siempre', () => {
    const generales = [foto('g-1', null), foto('g-2', null)]
    expect(galleryForVariant(generales, VARIANTES, azul20)).toEqual(generales)
  })

  it('sin eje de color, cada variante tiene las suyas', () => {
    const a = variante('a', null, 'S')
    const b = variante('b', null, 'M')
    const propias = [foto('a-1', 'a'), foto('b-1', 'b')]
    expect(galleryForVariant(propias, [a, b], b).map((f) => f.id)).toEqual(['b-1'])
  })
})

describe('galleryKey', () => {
  it('es el color, no la talla', () => {
    expect(galleryKey(negra20)).toBe(galleryKey(negra28))
    expect(galleryKey(negra20)).not.toBe(galleryKey(azul20))
    expect(galleryKey(null)).toBe('')
  })
})
