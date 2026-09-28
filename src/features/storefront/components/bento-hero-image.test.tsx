import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { StorePromotion } from '../promotions'
import { StoreBentoHero } from './StoreBentoHero'

/**
 * La «feria de ofertas» enseña la foto de su campaña.
 *
 * El bloque tomaba de la campaña el nombre, el texto y el reloj, pero no la
 * foto: el comercio la subía, se guardaba y la portada seguía pintando solo el
 * degradado. Con foto, la foto va de fondo; sin foto, el degradado de siempre.
 */

// Los precios de convenio consultan el servidor; aquí no hay cuenta de empresa.
vi.mock('../commerce/catalogPrices', () => ({ useCatalogCommercialPrices: () => new Map() }))

const CAMPANA = {
  id: 'p-1',
  name: '50% de descuento en mangueras',
  description: 'No te quedes sin esta promoción',
  endsAt: null,
  imageUrl: 'org/store/content/content-1.png',
} as unknown as StorePromotion

function bloque(imageSrc: string | null) {
  renderWithProviders(
    <StoreBentoHero
      products={[]}
      promotion={CAMPANA}
      imageSrc={imageSrc}
      clockEndsAt={null}
      maxDiscount={50}
      storeSlug="tienda"
      thumbnails={{}}
    />,
    { route: '/s/tienda' },
  )
  return document.querySelector('[data-feria-block]') as HTMLElement
}

describe('la feria con foto de campaña', () => {
  it('pinta la foto de la campaña de fondo', () => {
    const el = bloque('https://cdn.test/firmada/foto.png?token=abc')
    expect(el.getAttribute('data-feria-image')).toBe('si')
    expect(getComputedStyle(el).background).toContain('https://cdn.test/firmada/foto.png?token=abc')
  })

  it('sin foto sigue con el degradado de la tienda', () => {
    const el = bloque(null)
    expect(el.hasAttribute('data-feria-image')).toBe(false)
    expect(getComputedStyle(el).background).not.toContain('url(')
  })
})
