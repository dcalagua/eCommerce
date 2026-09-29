import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { StorePromotion } from '../promotions'
import type { PublicProduct } from '../types'
import { BrandStrip } from './BrandStrip'
import { CatalogCampaignStack } from './CatalogCampaignStack'
import { OffersFeaturedBand } from './OffersFeaturedBand'

/**
 * La portada de Catálogo con poco contenido (propuesta 29).
 *
 * Lo que no puede volver a pasar:
 *  - una sola oferta que se estira al ancho entero y mide 1.500 px de alto;
 *  - marcas repartidas a lo ancho sin decir cuántas hay ni llevar a las demás;
 *  - campañas en un carrusel de una tarjeta con media pantalla vacía.
 */

vi.mock('../commerce/catalogPrices', () => ({ useCatalogCommercialPrices: () => new Map() }))
vi.mock('../cart/useAddToCart', () => ({ useAddToCart: () => ({ add: vi.fn(), adding: false }) }))

const producto = (n: number): PublicProduct =>
  ({
    product_id: `p-${n}`,
    slug: `producto-${n}`,
    name: `Producto ${n}`,
    price: '70.00',
    price_from: '70.00',
    compare_at_price: '98.30',
    currency: 'PEN',
    in_stock: true,
    kind: 'simple',
    variant_count: 0,
    primary_image_path: null,
  }) as unknown as PublicProduct

describe('ofertas: la tarjeta no se estira', () => {
  it('con UNA oferta y el ancho entero, la rejilla sigue teniendo cuatro columnas', () => {
    renderWithProviders(
      <OffersFeaturedBand offers={[producto(1)]} featured={[]} storeSlug="t" offersThumbs={{}} featuredThumbs={{}} />,
      { route: '/s/t' },
    )
    expect(document.querySelector('[data-offer-columns]')?.getAttribute('data-offer-columns')).toBe('4')
  })

  it('con el ancho entero caben cinco; compartiendo banda, tres', () => {
    const siete = Array.from({ length: 7 }, (_, i) => producto(i))
    const { unmount } = renderWithProviders(
      <OffersFeaturedBand offers={siete} featured={[]} storeSlug="t" offersThumbs={{}} featuredThumbs={{}} />,
      { route: '/s/t' },
    )
    expect(document.querySelector('[data-offer-columns]')?.getAttribute('data-offer-columns')).toBe('5')
    unmount()

    renderWithProviders(
      <OffersFeaturedBand
        offers={siete}
        featured={[producto(9)]}
        storeSlug="t"
        offersThumbs={{}}
        featuredThumbs={{}}
      />,
      { route: '/s/t' },
    )
    expect(document.querySelector('[data-offer-columns]')?.getAttribute('data-offer-columns')).toBe('3')
  })
})

describe('marcas en tira', () => {
  const marca = (code: string, count: number) => ({ code, name: code.toUpperCase(), count, logoUrl: null })

  it('con cinco o menos, las enseña todas y sin «Ver todas»', () => {
    renderWithProviders(
      <BrandStrip brands={[marca('a', 3), marca('b', 9)]} selected={null} onSelect={vi.fn()} seeAllHref="/s/t?ver=todo" />,
      { route: '/s/t' },
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(document.querySelector('[data-brand-strip-more]')).toBeNull()
  })

  it('con más de cinco, las cinco con más productos y «+N · Ver todas»', () => {
    const muchas = [2, 50, 7, 31, 12, 44, 1, 9].map((n, i) => marca(`m${i}`, n))
    renderWithProviders(
      <BrandStrip brands={muchas} selected={null} onSelect={vi.fn()} seeAllHref="/s/t?ver=todo" />,
      { route: '/s/t' },
    )
    const nombres = screen.getAllByRole('button').map((b) => within(b).getAllByText(/^M\d$/)[0]?.textContent)
    expect(nombres).toEqual(['M1', 'M5', 'M3', 'M4', 'M7'])
    const mas = document.querySelector('[data-brand-strip-more]') as HTMLAnchorElement
    expect(mas.getAttribute('data-brand-strip-more')).toBe('3')
    expect(mas.getAttribute('href')).toBe('/s/t?ver=todo')
    expect(within(mas).getByText('Ver todas')).toBeInTheDocument()
  })
})

describe('campañas al lado de la oferta', () => {
  const campana = (id: string, name: string) =>
    ({ id, name, description: null, kind: 'percentage', percentOff: 10, amountOff: null, endsAt: null, imageUrl: null, categorySlug: null, brandCode: null }) as unknown as StorePromotion

  it('enseña como mucho dos, cada una con su puerta', () => {
    renderWithProviders(
      <CatalogCampaignStack
        promotions={[campana('1', 'Mangueras'), campana('2', 'B2B'), campana('3', 'Tercera')]}
        storeSlug="t"
        currency="PEN"
      />,
      { route: '/s/t' },
    )
    const seccion = screen.getByRole('region', { name: 'Campañas vigentes' })
    expect(seccion.getAttribute('data-catalog-campaigns')).toBe('2')
    expect(within(seccion).getByRole('heading', { name: 'Mangueras' })).toBeInTheDocument()
    expect(within(seccion).queryByRole('heading', { name: 'Tercera' })).toBeNull()
    expect(within(seccion).getAllByRole('link')).toHaveLength(2)
  })
})
