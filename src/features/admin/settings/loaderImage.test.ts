import { describe, expect, it } from 'vitest'
import { evaluateLoaderImage, type LoaderImageFacts } from './loaderImage'

const transparente = Array.from({ length: 100 }, () => 0)
const buena: LoaderImageFacts = { type: 'image/png', bytes: 40_000, width: 256, height: 256, borderAlphas: transparente }

describe('requisitos del indicador de carga', () => {
  it('un PNG cuadrado, transparente y ligero pasa', () => {
    expect(evaluateLoaderImage(buena)).toEqual([])
    expect(evaluateLoaderImage({ ...buena, type: 'image/webp' })).toEqual([])
  })

  it('JPG y SVG no: no guardan transparencia o pueden llevar script', () => {
    expect(evaluateLoaderImage({ ...buena, type: 'image/jpeg' })).toContain('type')
    expect(evaluateLoaderImage({ ...buena, type: 'image/svg+xml' })).toContain('type')
  })

  it('pide cuadrada, con un 2 % de tolerancia', () => {
    expect(evaluateLoaderImage({ ...buena, width: 256, height: 252 })).toEqual([])
    expect(evaluateLoaderImage({ ...buena, width: 300, height: 200 })).toContain('square')
  })

  it('ni muy pequeña ni muy grande ni muy pesada', () => {
    expect(evaluateLoaderImage({ ...buena, width: 64, height: 64 })).toContain('small')
    expect(evaluateLoaderImage({ ...buena, width: 2048, height: 2048 })).toContain('large')
    expect(evaluateLoaderImage({ ...buena, bytes: 300 * 1024 })).toContain('weight')
  })

  it('fondo opaco en el borde: no es transparente', () => {
    const blanco = Array.from({ length: 100 }, () => 255)
    expect(evaluateLoaderImage({ ...buena, borderAlphas: blanco })).toContain('background')
    // Un poco de producto tocando el borde no cuenta como fondo.
    const casi = [...Array.from({ length: 95 }, () => 0), ...Array.from({ length: 5 }, () => 255)]
    expect(evaluateLoaderImage({ ...buena, borderAlphas: casi })).toEqual([])
  })
})
