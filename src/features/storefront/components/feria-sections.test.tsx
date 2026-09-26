import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { CartProvider } from '../cart/CartProvider'
import type { StorePromotion } from '../promotions'
import type { PublicProduct } from '../types'
import { FlashOffersBand } from './FlashOffersBand'
import { PromoBanners } from './PromoBanners'

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => null,
  getSupabaseClient: () => null,
  tryGetStorefrontClient: () => null,
  tryGetStorefrontRpcClient: () => null,
  getStorefrontClient: () => null,
}))

const STORE = 'aaaa1111-1111-4111-8111-111111111111'

function producto(n: number): PublicProduct {
  return {
    product_id: `cccc1111-1111-4111-8111-11111111111${n}`,
    store_id: STORE,
    category_id: null,
    slug: `p-${n}`,
    name: `Producto ${n}`,
    description: null,
    price: '60.00',
    compare_at_price: '100.00',
    currency: 'PEN',
    published_at: null,
    in_stock: true,
    category_slug: null,
    category_name: null,
    primary_image_path: null,
    primary_image_alt: null,
    kind: 'simple',
    brand_name: null,
    variant_count: 0,
    price_from: null,
  } as PublicProduct
}

function promo(parcial: Partial<StorePromotion>): StorePromotion {
  return {
    id: 'aaaa0000-0000-4000-8000-000000000001',
    name: 'Semana de la salud',
    description: null,
    kind: 'percentage',
    percentOff: 20,
    amountOff: null,
    buyQuantity: null,
    freeQuantity: null,
    minSubtotal: null,
    endsAt: null,
    imageUrl: null,
    categorySlug: null,
    brandCode: null,
    ...parcial,
  }
}

function banda(clockEndsAt: string | null) {
  renderWithProviders(
    <CartProvider storeId={STORE} storeSlug="botica" currency="PEN">
      <FlashOffersBand
        offers={[1, 2, 3, 4, 5, 6, 7].map(producto)}
        total={48}
        clockEndsAt={clockEndsAt}
        storeSlug="botica"
        thumbnails={{}}
        favorites={new Set()}
        onToggleFavorite={() => {}}
      />
    </CartProvider>,
  )
}

describe('ofertas relámpago (Retail)', () => {
  it('con una campaña que termina pronto: título, reloj y «Ver las 48»', async () => {
    banda(new Date(Date.now() + 3_600_000).toISOString())
    const seccion = await screen.findByRole('region', { name: 'Ofertas relámpago' })
    expect(within(seccion).getByRole('timer')).toBeInTheDocument()
    expect(within(seccion).getByRole('link', { name: /Ver las 48/ })).toHaveAttribute('href', '/s/botica?ver=todo&oferta=1')
    // Seis tarjetas, cada una con su corazón.
    expect(within(seccion).getAllByRole('button', { name: /favoritos/i }).length).toBe(6)
  })

  it('sin fecha de fin no promete urgencia: otro título y sin reloj', async () => {
    banda(null)
    const seccion = await screen.findByRole('region', { name: 'Ofertas vigentes' })
    expect(within(seccion).queryByRole('timer')).toBeNull()
  })
})

describe('campañas en dos banners (Retail)', () => {
  it('pinta dos campañas, la segunda invertida, y cada una lleva a lo que alcanza', () => {
    renderWithProviders(
      <PromoBanners
        promotions={[
          promo({ categorySlug: 'botiquin' }),
          promo({ id: 'aaaa0000-0000-4000-8000-000000000002', name: 'Pañales 2x1', brandCode: 'suave' }),
          promo({ id: 'aaaa0000-0000-4000-8000-000000000003', name: 'No cabe' }),
        ]}
        storeSlug="botica"
        currency="PEN"
      />,
    )
    const banners = document.querySelectorAll('[data-banner]')
    expect(banners).toHaveLength(2)
    expect(banners[1]).toHaveAttribute('data-banner', 'contrast')
    expect(screen.queryByText('No cabe')).toBeNull()
    const enlaces = screen.getAllByRole('link', { name: /Ver los productos/ })
    expect(enlaces[0]).toHaveAttribute('href', '/s/botica?c=botiquin')
    expect(enlaces[1]).toHaveAttribute('href', '/s/botica?b=suave')
  })
})
