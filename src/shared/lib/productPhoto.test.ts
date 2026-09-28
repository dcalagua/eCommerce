import { describe, expect, it } from 'vitest'
import {
  PHOTO_MARGIN,
  PHOTO_MAX_SIDE,
  contentBox,
  hasLightBackground,
  squareLayout,
  type Pixels,
} from './productPhoto'

type Rgba = readonly [number, number, number, number]
const BLANCO: Rgba = [255, 255, 255, 255]
const CASI_BLANCO: Rgba = [244, 243, 246, 255]
const TRANSPARENTE: Rgba = [0, 0, 0, 0]
const PRODUCTO: Rgba = [40, 60, 90, 255]
const MADERA: Rgba = [150, 110, 70, 255]

/** Un lienzo de `fondo` con un rectángulo de `pieza` en `caja`. */
function lienzo(
  width: number,
  height: number,
  fondo: Rgba,
  caja?: { x: number; y: number; width: number; height: number },
  pieza: Rgba = PRODUCTO,
): Pixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dentro = caja && x >= caja.x && x < caja.x + caja.width && y >= caja.y && y < caja.y + caja.height
      data.set(dentro ? pieza : fondo, (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

describe('¿el fondo es blanco?', () => {
  it('sí, con el producto en el centro', () => {
    expect(hasLightBackground(lienzo(100, 100, BLANCO, { x: 20, y: 20, width: 60, height: 60 }))).toBe(true)
  })

  it('sí, con el blanco «de estudio» que no llega a 255', () => {
    expect(hasLightBackground(lienzo(100, 100, CASI_BLANCO, { x: 20, y: 20, width: 60, height: 60 }))).toBe(true)
  })

  it('sí, con un PNG recortado sin fondo', () => {
    expect(hasLightBackground(lienzo(100, 100, TRANSPARENTE, { x: 10, y: 10, width: 80, height: 80 }))).toBe(true)
  })

  it('no, con el producto sobre una mesa de madera', () => {
    expect(hasLightBackground(lienzo(100, 100, MADERA, { x: 20, y: 20, width: 60, height: 60 }))).toBe(false)
  })

  it('una pieza que roza un borde no descalifica la foto', () => {
    // El producto toca el borde inferior: es una fracción pequeña del marco.
    expect(hasLightBackground(lienzo(100, 100, BLANCO, { x: 40, y: 50, width: 20, height: 50 }))).toBe(true)
  })

  it('una imagen vacía no es «fondo blanco»', () => {
    expect(hasLightBackground({ width: 0, height: 0, data: [] })).toBe(false)
  })
})

describe('dónde está el producto', () => {
  it('encuentra el rectángulo exacto que no es fondo', () => {
    expect(contentBox(lienzo(100, 80, BLANCO, { x: 10, y: 5, width: 30, height: 60 }))).toEqual({
      x: 10,
      y: 5,
      width: 30,
      height: 60,
    })
  })

  it('ignora la transparencia alrededor', () => {
    expect(contentBox(lienzo(50, 50, TRANSPARENTE, { x: 5, y: 10, width: 20, height: 20 }))).toEqual({
      x: 5,
      y: 10,
      width: 20,
      height: 20,
    })
  })

  it('con una imagen toda en blanco no recorta a nada: devuelve la imagen entera', () => {
    expect(contentBox(lienzo(40, 30, BLANCO))).toEqual({ x: 0, y: 0, width: 40, height: 30 })
  })
})

describe('el encuadre en el cuadrado', () => {
  it('centra un producto apaisado con el mismo margen en el lado mayor', () => {
    const plan = squareLayout({ width: 840, height: 420 })
    expect(plan.side).toBe(1000)
    expect(plan.drawWidth).toBe(840)
    expect(plan.drawHeight).toBe(420)
    expect(plan.drawX).toBe(Math.round(1000 * PHOTO_MARGIN))
    expect(plan.drawY).toBe(290)
  })

  it('nunca amplía una foto pequeña: el cuadrado sale de su tamaño', () => {
    const plan = squareLayout({ width: 300, height: 300 })
    expect(plan.drawWidth).toBe(300)
    expect(plan.side).toBeLessThan(400)
  })

  it('una foto enorme se reduce hasta el lado máximo', () => {
    const plan = squareLayout({ width: 6000, height: 4000 })
    expect(plan.side).toBe(PHOTO_MAX_SIDE)
    expect(plan.drawWidth).toBe(Math.round(PHOTO_MAX_SIDE * (1 - PHOTO_MARGIN * 2)))
    expect(plan.drawX).toBe(plan.side - plan.drawWidth - plan.drawX)
  })
})
