import { describe, expect, it } from 'vitest'
import { baseName, candidateSkus, matchFiles, nameCandidates } from './match'

const f = (name: string) => ({ name })

describe('qué SKU nombra un archivo', () => {
  it('sin número es la foto 1', () => {
    expect(nameCandidates('FMX-0158.jpg')).toContainEqual({ sku: 'FMX-0158', order: 1 })
  })

  it('con guion, guion bajo o paréntesis detrás es el orden de la foto', () => {
    expect(nameCandidates('FMX-0158-2.jpg')).toContainEqual({ sku: 'FMX-0158', order: 2 })
    expect(nameCandidates('FMX-0158_3.webp')).toContainEqual({ sku: 'FMX-0158', order: 3 })
    expect(nameCandidates('FMX-0158 (4).png')).toContainEqual({ sku: 'FMX-0158', order: 4 })
  })

  it('no distingue mayúsculas ni se fija en la carpeta', () => {
    expect(baseName('fotos\\Pinturas/fmx-0158.JPG')).toBe('fmx-0158')
    expect(nameCandidates('fotos/fmx-0158.JPG')[0]).toEqual({ sku: 'FMX-0158', order: 1 })
  })

  it('tres cifras detrás no son un orden: son parte del SKU', () => {
    expect(nameCandidates('TAL-100.jpg')).toEqual([{ sku: 'TAL-100', order: 1 }])
  })
})

describe('emparejar con los productos', () => {
  const productos = new Map([
    ['FMX-0158', 'p-158'],
    ['FMX-0', 'p-0'],
    ['TAL-100', 'p-talad'],
  ])

  it('el nombre entero gana: «FMX-0158» es FMX-0158 y no «FMX-0» foto 158', () => {
    const [match] = matchFiles([f('FMX-0158.jpg')], productos)
    expect(match).toMatchObject({ productId: 'p-158', sku: 'FMX-0158', order: 1 })
  })

  it('ordena por SKU y por número, y deja al final lo que no tiene producto', () => {
    const resultado = matchFiles(
      [f('FMX-0158-3.jpg'), f('sin-sku.jpg'), f('FMX-0158.jpg'), f('TAL-100.png'), f('FMX-0158-2.jpg')],
      productos,
    )
    expect(resultado.map((m) => m.file.name)).toEqual([
      'FMX-0158.jpg',
      'FMX-0158-2.jpg',
      'FMX-0158-3.jpg',
      'TAL-100.png',
      'sin-sku.jpg',
    ])
    expect(resultado.at(-1)).toMatchObject({ productId: null, sku: null })
  })

  it('lista los SKU que hay que buscar, sin repetir', () => {
    expect(candidateSkus([f('FMX-0158.jpg'), f('FMX-0158-2.jpg')]).sort()).toEqual([
      'FMX-0158',
      'FMX-0158-2',
    ])
  })
})
