import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { StoreFilterPanel, type FacetOption } from './StoreFilterPanel'

const BRANDS: FacetOption[] = [
  { code: 'nordica', name: 'Nordica', count: 4 },
  { code: 'lumen', name: 'Lumen', count: 2 },
]

const CATEGORIES: FacetOption[] = [
  { code: 'sillas', name: 'Sillas', count: 3 },
  { code: 'mesas', name: 'Mesas', count: 3 },
]

function render(props: Partial<Parameters<typeof StoreFilterPanel>[0]> = {}) {
  const onBrand = vi.fn()
  const onCategory = vi.fn()
  const onInStock = vi.fn()
  const onClear = vi.fn()
  renderWithProviders(
    <StoreFilterPanel
      brands={BRANDS}
      categories={CATEGORIES}
      selectedBrand={null}
      selectedCategory={null}
      inStockOnly={false}
      onBrand={onBrand}
      onCategory={onCategory}
      onInStock={onInStock}
      onClear={onClear}
      {...props}
    />,
  )
  return { onBrand, onCategory, onInStock, onClear }
}

describe('contadores', () => {
  it('cada opción lleva su número: un filtro que no dice cuánto deja es una apuesta', async () => {
    render()

    expect(await screen.findByText('Nordica')).toBeInTheDocument()
    expect(screen.getAllByText('(4)')).toHaveLength(1)
    expect(screen.getAllByText('(3)')).toHaveLength(2)
  })

  it('sin número no se inventa un cero', async () => {
    // `null` es «no se sabe». Pasa de verdad: el buscador calcula las facetas
    // sobre el resultado YA filtrado, así que con una categoría elegida las
    // demás vuelven a cero. Pintarlo diría «no hay nada» cuando lo que ocurre
    // es «no te lo he contado».
    render({
      selectedCategory: 'sillas',
      categories: [
        { code: 'sillas', name: 'Sillas', count: null },
        { code: 'mesas', name: 'Mesas', count: null },
      ],
    })

    expect(await screen.findByText('Mesas')).toBeInTheDocument()
    expect(screen.queryByText('(0)')).not.toBeInTheDocument()
  })
})

describe('elección', () => {
  it('marcar una marca la propone; volver a marcarla la quita', async () => {
    const user = userEvent.setup()
    const { onBrand } = render({ selectedBrand: 'lumen' })

    await user.click(await screen.findByRole('checkbox', { name: /Nordica/ }))
    expect(onBrand).toHaveBeenCalledWith('nordica')

    await user.click(screen.getByRole('checkbox', { name: /Lumen/ }))
    expect(onBrand).toHaveBeenCalledWith(null)
  })

  it('con una categoría elegida se puede cambiar a otra, no solo quitarla', async () => {
    // Es la razón por la que la lista de categorías NO sale de las facetas: si
    // saliera, al elegir «Sillas» volvería una sola opción y el panel se
    // convertiría en un callejón sin salida.
    const user = userEvent.setup()
    const { onCategory } = render({ selectedCategory: 'sillas' })

    await user.click(await screen.findByRole('checkbox', { name: /Mesas/ }))
    expect(onCategory).toHaveBeenCalledWith('mesas')
  })
})

describe('limpiar', () => {
  it('el botón de quitar filtros no está cuando no hay nada que quitar', async () => {
    render()

    await screen.findByText('Nordica')
    expect(screen.queryByRole('button', { name: 'Quitar filtros' })).not.toBeInTheDocument()
  })

  it('aparece en cuanto hay un filtro puesto', async () => {
    const user = userEvent.setup()
    const { onClear } = render({ inStockOnly: true })

    await user.click(await screen.findByRole('button', { name: 'Quitar filtros' }))
    expect(onClear).toHaveBeenCalled()
  })
})
