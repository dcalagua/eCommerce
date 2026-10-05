import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import type { StorePromotion } from '../promotions'

vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks')>()),
  useSignedStoreAssets: (refs: readonly (string | null)[]) =>
    Object.fromEntries(refs.filter((r): r is string => Boolean(r)).map((r) => [r, `https://firmado.test/${r}`])),
}))

import { PromoRetail } from './PromoRetail'

const VIDEO = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/content/video-33333333-3333-4333-8333-333333333333.mp4'

const promo = (extra: Partial<StorePromotion> = {}): StorePromotion => ({
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Vuelta al cole',
  description: null,
  kind: 'percentage',
  percentOff: 20,
  amountOff: null,
  buyQuantity: null,
  freeQuantity: null,
  minSubtotal: null,
  endsAt: null,
  imageUrl: 'https://cdn.test/cole.jpg',
  categorySlug: null,
  brandCode: null,
  ...extra,
})

const conMovimientoReducido = (reducido: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({ matches: reducido && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  )

afterEach(() => vi.restoreAllMocks())

describe('video de fondo de la banda de promoción', () => {
  it('con video: de fondo, mudo y en bucle, con la imagen debajo y el velo encima', () => {
    conMovimientoReducido(false)
    const { container } = renderWithProviders(
      <PromoRetail promotions={[promo({ videoUrl: VIDEO })]} storeSlug="porta" currency="PEN" />,
    )
    const banda = container.querySelector('[data-promo-retail="band"]')
    expect(banda).toHaveAttribute('data-promo-background', 'video')
    const video = banda?.querySelector('[data-promo-video] video') as HTMLVideoElement
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    expect(video.getAttribute('src')).toBe(`https://firmado.test/${VIDEO}`)
    expect(banda?.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/cole.jpg')
  })

  it('con movimiento reducido: sin video, la imagen y el velo siguen (el texto se lee)', () => {
    conMovimientoReducido(true)
    const { container } = renderWithProviders(
      <PromoRetail promotions={[promo({ videoUrl: VIDEO })]} storeSlug="porta" currency="PEN" />,
    )
    const banda = container.querySelector('[data-promo-retail="band"]')
    expect(banda?.querySelector('[data-promo-video]')).toBeNull()
    expect(banda?.querySelector('img')).not.toBeNull()
  })

  it('sin video: la banda de siempre, en tinta', () => {
    conMovimientoReducido(false)
    const { container } = renderWithProviders(<PromoRetail promotions={[promo()]} storeSlug="porta" currency="PEN" />)
    const banda = container.querySelector('[data-promo-retail="band"]')
    expect(banda).not.toHaveAttribute('data-promo-background')
    expect(banda?.querySelector('img')).toBeNull()
  })
})
