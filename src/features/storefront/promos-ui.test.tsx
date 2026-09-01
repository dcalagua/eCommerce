import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/I18nProvider'
import { AppearanceProvider } from '@/theme/AppearanceProvider'
import { DEFAULT_APPEARANCE } from '@/theme/appearance'
import { PromoCarousel } from './components/PromoCarousel'
import type { StorePromotion } from './promotions'

/**
 * El carrusel de ofertas vigentes.
 *
 * Un carrusel mueve contenido sin que nadie se lo pida, y eso se paga o se
 * defiende. Aquí se defiende, y lo que estos tests fijan es exactamente el
 * precio pagado:
 *
 *  1. **pasa solo**, porque tres ofertas apiladas ocupan tres pantallas y solo
 *     se ve la primera;
 *  2. **se para al leer** —ratón encima o foco dentro—, porque nada puede
 *     escaparse mientras se está mirando;
 *  3. **no se mueve** si el sistema pide menos movimiento;
 *  4. **cada oferta lleva a SUS productos**, no al catálogo entero: un botón
 *     que lleva a una lista donde no se ve la oferta es peor que no ponerlo.
 */

function promo(over: Partial<StorePromotion> & { id: string; name: string }): StorePromotion {
  return {
    description: null,
    kind: 'percentage',
    percentOff: 20,
    amountOff: null,
    buyQuantity: null,
    freeQuantity: null,
    minSubtotal: null,
    endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    categorySlug: null,
    brandCode: null,
    ...over,
  }
}

const TRES: StorePromotion[] = [
  promo({ id: '1', name: 'Semana dermocosmetica', categorySlug: 'piel' }),
  promo({
    id: '2',
    name: 'Lleva 3, paga 2',
    kind: 'x_for_y',
    percentOff: null,
    buyQuantity: 3,
    freeQuantity: 1,
    brandCode: 'abbott',
  }),
  promo({
    id: '3',
    name: '20 soles sobre 150',
    kind: 'fixed_amount',
    percentOff: null,
    amountOff: 20,
    minSubtotal: 150,
  }),
]

function pintar(promotions: StorePromotion[] = TRES) {
  return render(
    <I18nProvider initial="es">
      <AppearanceProvider initial={DEFAULT_APPEARANCE} tenantAccent={null}>
        <MemoryRouter>
          <PromoCarousel promotions={promotions} storeSlug="miquimica" currency="PEN" />
        </MemoryRouter>
      </AppearanceProvider>
    </I18nProvider>,
  )
}

/** La lámina que se está viendo: las otras están ocultas para el lector. */
function laminaVisible(): HTMLElement {
  const activa = Array.from(document.querySelectorAll('h3')).find(
    (nodo) => !nodo.closest('[aria-hidden="true"]'),
  )
  if (!(activa instanceof HTMLElement)) throw new Error('ninguna lamina visible')
  return activa
}

beforeEach(() => {
  // jsdom no trae `matchMedia`. Sin doble, «menos movimiento» no se puede
  // preguntar y el carrusel se quedaría quieto por accidente en TODOS los
  // tests — incluido el que comprueba que se mueve.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('el carrusel de ofertas vigentes', () => {
  it('pinta la primera oferta con su descuento y a donde lleva', () => {
    pintar()

    expect(laminaVisible()).toHaveTextContent('Semana dermocosmetica')
    expect(screen.getAllByText('-20 %')[0]).toBeInTheDocument()

    // A los productos de SU categoria, no al catalogo entero.
    const lamina = laminaVisible().closest('div[class*="MuiCard"]') as HTMLElement
    expect(within(lamina).getByRole('link', { name: 'Ver los productos' })).toHaveAttribute(
      'href',
      '/s/miquimica?c=piel',
    )
  })

  it('pasa sola al cabo de unos segundos', async () => {
    vi.useFakeTimers()
    pintar()
    expect(laminaVisible()).toHaveTextContent('Semana dermocosmetica')

    await vi.advanceTimersByTimeAsync(6100)
    expect(laminaVisible()).toHaveTextContent('Lleva 3, paga 2')

    await vi.advanceTimersByTimeAsync(6100)
    expect(laminaVisible()).toHaveTextContent('20 soles sobre 150')

    // Y vuelve a empezar: un carrusel que se acaba deja la ultima oferta fija y
    // las anteriores sin volver a verse.
    await vi.advanceTimersByTimeAsync(6100)
    expect(laminaVisible()).toHaveTextContent('Semana dermocosmetica')
  })

  it('se para mientras el raton esta encima', async () => {
    vi.useFakeTimers()
    const { container } = pintar()

    // `fireEvent` y no `userEvent`: el segundo simula el gesto completo con sus
    // esperas, y con relojes falsos se queda esperando un tiempo que solo
    // avanza si alguien lo empuja. Aqui lo que se comprueba es la reaccion al
    // evento, no el gesto.
    fireEvent.mouseEnter(container.querySelector('section') as HTMLElement)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(laminaVisible()).toHaveTextContent('Semana dermocosmetica')

    // Y al retirarlo vuelve a pasar sola: parar no puede ser para siempre.
    fireEvent.mouseLeave(container.querySelector('section') as HTMLElement)
    await vi.advanceTimersByTimeAsync(6100)
    expect(laminaVisible()).toHaveTextContent('Lleva 3, paga 2')
  })

  it('no se mueve si el sistema pide menos movimiento', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    )
    vi.useFakeTimers()
    pintar()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(laminaVisible()).toHaveTextContent('Semana dermocosmetica')
  })

  it('los puntos llevan a una oferta concreta, y dicen a cual', async () => {
    const usuario = userEvent.setup()
    pintar()

    await usuario.click(screen.getByRole('button', { name: 'Ver la oferta: 20 soles sobre 150' }))

    const lamina = laminaVisible()
    expect(lamina).toHaveTextContent('20 soles sobre 150')
    // El importe fijo se anuncia con su minimo: prometer 20 soles sin decir
    // desde cuanto se paga en el carrito.
    expect(screen.getAllByText(/Desde .*150/)[0]).toBeInTheDocument()
  })

  it('con una sola oferta no hay flechas ni puntos: no hay a donde pasar', () => {
    pintar([TRES[0] as StorePromotion])

    expect(screen.queryByRole('button', { name: 'Oferta siguiente' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Semana dermocosmetica')
  })
})
