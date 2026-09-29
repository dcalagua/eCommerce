import { describe, expect, it } from 'vitest'
import { zonasCambiadas } from './changes'

describe('qué cambió, por zonas (Resumen v2)', () => {
  it('agrupa los campos en la zona que tienen en pantalla, sin repetir', () => {
    expect(
      zonasCambiadas({ theme_preset: true, logo_url: true, banner_url: true, contact_phone: true }),
    ).toEqual(['settings.changes.theme', 'settings.changes.images', 'settings.changes.contact'])
  })

  it('respeta el orden de la pantalla, no el del formulario', () => {
    expect(zonasCambiadas({ contact_phone: true, theme_preset: true })).toEqual([
      'settings.changes.theme',
      'settings.changes.contact',
    ])
  })

  it('un campo sin zona conocida no se pierde: sale como «otros»', () => {
    expect(zonasCambiadas({ tax_rate: true })).toEqual(['settings.changes.other'])
  })

  it('lo que no está sucio no cuenta', () => {
    expect(zonasCambiadas({ theme_preset: false })).toEqual([])
  })
})
