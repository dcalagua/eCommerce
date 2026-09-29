import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { PriceTiers } from './PriceTiers'

/**
 * Lámina 31 · Precio por volumen en la ficha.
 *
 * Lo que tiene que cumplir: no pintar nada sin escalas de verdad, marcar la
 * que aplica a la cantidad elegida y, al pulsar una, llevar la cantidad a su
 * mínimo.
 */

const ESCALAS = [
  { minQuantity: 1, unitPrice: 70 },
  { minQuantity: 10, unitPrice: 63 },
  { minQuantity: 50, unitPrice: 59.5 },
]

function pintar(quantity: number, onChoose = vi.fn(), tiers = ESCALAS) {
  renderWithProviders(<PriceTiers tiers={tiers} currency="PEN" quantity={quantity} onChoose={onChoose} />)
  return onChoose
}

describe('PriceTiers', () => {
  it('con una sola escala no pinta nada: repetiría el precio de arriba', () => {
    pintar(1, vi.fn(), [{ minQuantity: 1, unitPrice: 70 }])
    expect(document.querySelector('[data-price-tiers]')).toBeNull()
  })

  it('pinta los rangos y marca la escala de la cantidad elegida', () => {
    pintar(12)
    expect(screen.getByText('1 – 9 u.')).toBeInTheDocument()
    expect(screen.getByText('10 – 49 u.')).toBeInTheDocument()
    expect(screen.getByText('50 + u.')).toBeInTheDocument()
    const botones = screen.getAllByRole('button')
    expect(botones.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
  })

  it('pulsar una escala lleva la cantidad a su mínimo', () => {
    const onChoose = pintar(1)
    fireEvent.click(screen.getByRole('button', { name: /Llevar 50 unidades/ }))
    expect(onChoose).toHaveBeenCalledWith(50)
  })
})
