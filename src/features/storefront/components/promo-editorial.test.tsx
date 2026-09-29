import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { StorePromotion } from '../promotions'
import { PromoEditorial } from './PromoEditorial'

/**
 * Premium · el banner editorial de campañas (lámina 33).
 *
 * Lo que no puede volver: la caja con un icono de etiqueta cuando la campaña no
 * trae foto, y tres puntitos que no dicen cuántas campañas hay.
 */

function campana(extra: Partial<StorePromotion> = {}): StorePromotion {
  return {
    id: 'p-1',
    name: 'Gorros y guantes: lleva 3, paga 2',
    description: 'En gorros, chullos, guantes y mitones.',
    kind: 'buy_x_get_y',
    percentOff: null,
    amountOff: null,
    buyQuantity: 2,
    freeQuantity: 1,
    minSubtotal: null,
    endsAt: null,
    imageUrl: null,
    categorySlug: 'gorros-y-guantes',
    brandCode: null,
    ...extra,
  }
}

function pintar(promotions: StorePromotion[]) {
  renderWithProviders(<PromoEditorial promotions={promotions} storeSlug="alma" currency="PEN" />, {
    route: '/s/alma',
  })
  return document.querySelector('[data-promotions-presentation="editorial"]') as HTMLElement
}

describe('PromoEditorial', () => {
  it('sin foto no pinta ninguna imagen: la campaña se lee con su nombre y su enlace', () => {
    const banner = pintar([campana()])
    expect(banner.getAttribute('data-promo-photo')).toBe('no')
    expect(banner.querySelector('img')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Gorros y guantes: lleva 3, paga 2' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Ver los productos/ })).toHaveAttribute(
      'href',
      '/s/alma?c=gorros-y-guantes',
    )
  })

  it('con foto externa la pinta a sangre', () => {
    const banner = pintar([campana({ imageUrl: 'https://cdn.example.com/campana.jpg' })])
    expect(banner.getAttribute('data-promo-photo')).toBe('yes')
    expect(banner.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/campana.jpg')
  })

  it('con una sola campaña no hay paginador', () => {
    pintar([campana()])
    expect(screen.queryByRole('button', { name: /siguiente|next/i })).toBeNull()
    expect(screen.queryByText('01 / 01')).toBeNull()
  })

  it('con varias dice cuál se ve y cuántas hay, y pasa con las flechas', () => {
    pintar([campana(), campana({ id: 'p-2', name: 'Chalinas: 2.ª unidad al 50 %' })])
    expect(screen.getByText('01 / 02')).toBeInTheDocument()
    const botones = screen.getAllByRole('button')
    fireEvent.click(botones[botones.length - 1] as HTMLElement)
    expect(screen.getByText('02 / 02')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Chalinas: 2.ª unidad al 50 %' })).toBeInTheDocument()
  })
})
