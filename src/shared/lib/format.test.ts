import { describe, expect, it } from 'vitest'
import { formatDate } from './format'

/**
 * Se corre con la zona de Lima (UTC−5) forzada en el propio test: es donde se
 * vio el fallo, y con la zona del equipo que lo ejecuta (a menudo UTC) pasaría
 * aunque estuviera roto.
 */
describe('formatDate', () => {
  const original = process.env.TZ
  const conZona = <T,>(tz: string, fn: () => T): T => {
    process.env.TZ = tz
    try {
      return fn()
    } finally {
      process.env.TZ = original
    }
  }

  it('una fecha de calendario no retrocede un día al oeste de UTC', () => {
    const texto = conZona('America/Lima', () => formatDate('2026-09-30'))
    expect(texto).toMatch(/30/)
    expect(texto).not.toMatch(/29/)
  })

  it('un instante con zona se sigue leyendo como instante', () => {
    const texto = conZona('America/Lima', () => formatDate('2026-09-30T03:00:00Z'))
    // 03:00 UTC es aún el 29 en Lima.
    expect(texto).toMatch(/29/)
  })

  it('texto que no es fecha → raya', () => {
    expect(formatDate('no-es-fecha')).toBe('—')
  })
})
