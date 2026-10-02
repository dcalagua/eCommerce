import { describe, expect, it } from 'vitest'
import { businessDaysSince } from '@/features/complaints/api'
import { sanitizeSocialLinks, whatsappHref } from './identity'

describe('redes de la tienda', () => {
  it('solo https, red de la lista, sin repetir y como mucho seis', () => {
    expect(
      sanitizeSocialLinks([
        { network: 'instagram', url: 'https://instagram.com/porta' },
        { network: 'instagram', url: 'https://instagram.com/otra' },
        { network: 'facebook', url: 'javascript:alert(1)' },
        { network: 'myspace', url: 'https://myspace.com/x' },
        { network: 'tiktok', url: 'https://tiktok.com/@porta' },
        'basura',
      ]),
    ).toEqual([
      { network: 'instagram', url: 'https://instagram.com/porta' },
      { network: 'tiktok', url: 'https://tiktok.com/@porta' },
    ])
    expect(sanitizeSocialLinks(null)).toEqual([])
  })

  it('WhatsApp se vuelve wa.me con solo dígitos', () => {
    expect(whatsappHref('+51 970 510 698')).toBe('https://wa.me/51970510698')
    expect(whatsappHref('abc')).toBeNull()
  })
})

describe('plazo del Libro de Reclamaciones', () => {
  it('cuenta días hábiles (sin sábados ni domingos)', () => {
    // Lunes 5 → lunes 12 de octubre de 2026: cinco días hábiles.
    expect(businessDaysSince('2026-10-05T10:00:00', new Date('2026-10-12T09:00:00'))).toBe(5)
    expect(businessDaysSince('2026-10-05T10:00:00', new Date('2026-10-05T18:00:00'))).toBe(0)
  })
})
