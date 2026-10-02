import { describe, expect, it } from 'vitest'
import { isColorAxis, isLightSwatch, swatchOf, swatchesFor } from './colorSwatch'

describe('el color sale del nombre del valor', () => {
  it('reconoce el eje de color por código o nombre', () => {
    expect(isColorAxis({ code: 'color', name: 'Color' })).toBe(true)
    expect(isColorAxis({ code: 'tono', name: 'Tono' })).toBe(true)
    expect(isColorAxis({ code: 'colour', name: 'Colour' })).toBe(true)
    expect(isColorAxis({ code: 'talla', name: 'Talla' })).toBe(false)
  })

  it('traduce nombres con tildes, mayúsculas y compuestos', () => {
    expect(swatchOf('Negro')).toBe('#111111')
    expect(swatchOf('Azul Marino')).toBe('#1B2A4A')
    expect(swatchOf('Café')).toBe('#6B4423')
    expect(swatchOf('Negro/Rojo')).toContain('linear-gradient')
    expect(swatchOf('Negro con gris')).toContain('linear-gradient')
  })

  it('no inventa: un nombre desconocido deja el eje en texto', () => {
    expect(swatchOf('Edición Pikachu')).toBeNull()
    expect(swatchesFor(['Negro', 'Edición Pikachu'])).toBeNull()
    expect(swatchesFor(['Negro', 'Guinda'])).toEqual(['#111111', '#6E1E2B'])
  })

  it('marca los tonos claros para darles borde', () => {
    expect(isLightSwatch('#FFFFFF')).toBe(true)
    expect(isLightSwatch('#111111')).toBe(false)
  })
})
