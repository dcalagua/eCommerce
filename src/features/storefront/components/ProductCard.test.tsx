import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { CartProvider } from '../cart/CartProvider'
import type { PublicProduct } from '../types'
import { ProductCard } from './ProductCard'

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => null,
  getSupabaseClient: () => null,
  tryGetStorefrontClient: () => null,
  tryGetStorefrontRpcClient: () => null,
  getStorefrontClient: () => null,
}))

const STORE = 'aaaa1111-1111-4111-8111-111111111111'

function product(overrides: Partial<PublicProduct> = {}): PublicProduct {
  return {
    product_id: 'cccc1111-1111-4111-8111-111111111111',
    store_id: STORE,
    category_id: null,
    slug: 'silla-roble',
    name: 'Silla de roble',
    description: null,
    price: '389.00',
    compare_at_price: null,
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
    ...overrides,
  } as PublicProduct
}

function render(item: PublicProduct, onQuickView = vi.fn()) {
  renderWithProviders(
    <CartProvider storeId={STORE} storeSlug="casa-nordica" currency="PEN">
      <ProductCard product={item} storeSlug="casa-nordica" onQuickView={onQuickView} />
    </CartProvider>,
  )
  return { onQuickView }
}

beforeEach(() => localStorage.clear())

describe('comprar desde la rejilla', () => {
  it('un producto simple entra al carrito sin salir del catálogo', async () => {
    const user = userEvent.setup()
    render(product())

    await user.click(await screen.findByRole('button', { name: /^Agregar al carrito/ }))

    expect(localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`)).toContain('silla-roble')
  })

  it('con variantes NO añade nada: lleva a elegir', async () => {
    // Meter «la primera» variante en el carrito es mandarle a alguien la talla
    // que no era. El color y la medida cambian precio y stock, así que esa
    // decisión no se toma por el comprador.
    const user = userEvent.setup()
    const { onQuickView } = render(product({ kind: 'variant', variant_count: 3 }))

    await user.click(await screen.findByRole('button', { name: /^Elegir opciones/ }))

    expect(onQuickView).toHaveBeenCalledWith('silla-roble')
    expect(localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`)).toBeNull()
  })

  it('sin stock el botón no se puede pulsar', async () => {
    render(product({ in_stock: false }))

    expect(await screen.findByRole('button', { name: /^Agregar al carrito/ })).toBeDisabled()
  })
})

describe('la tarjeta sigue siendo navegable', () => {
  it('el nombre es un enlace de verdad a la ficha', async () => {
    // Se conserva tras meter el botón: el enlace pasó de envolver la tarjeta a
    // envolver el nombre —un `<button>` dentro de un `<a>` es HTML inválido—,
    // pero ctrl-clic, rueda y «abrir en pestaña nueva» tienen que seguir yendo
    // a la ficha, y un buscador tiene que poder indexarla.
    render(product())

    expect(await screen.findByRole('link', { name: 'Silla de roble' })).toHaveAttribute(
      'href',
      '/s/casa-nordica/product/silla-roble',
    )
  })

  it('un clic normal en el nombre abre la vista rápida, no navega', async () => {
    const user = userEvent.setup()
    const { onQuickView } = render(product())

    await user.click(await screen.findByRole('link', { name: 'Silla de roble' }))

    expect(onQuickView).toHaveBeenCalledWith('silla-roble')
  })
})

describe('comprador empresa', () => {
  it('elige cuántas unidades antes de agregar, y la tarjeta vuelve a uno', async () => {
    // Quien repone 24 cajas no pulsa 24 veces: pone la cifra y agrega.
    const user = userEvent.setup()
    renderWithProviders(
      <CartProvider storeId={STORE} storeSlug="casa-nordica" currency="PEN">
        <ProductCard product={product()} storeSlug="casa-nordica" b2b />
      </CartProvider>,
    )

    const mas = await screen.findByRole('button', { name: 'Sumar una unidad' })
    await user.click(mas)
    await user.click(mas)
    expect(screen.getByLabelText('Cantidad')).toHaveTextContent('3')

    await user.click(screen.getByRole('button', { name: /^Agregar al carrito: Silla de roble/ }))

    const guardado = JSON.parse(localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`) ?? '{}')
    expect(guardado.lines?.[0]?.quantity).toBe(3)
    expect(await screen.findByLabelText('Cantidad')).toHaveTextContent('1')
  })

  it('el consumidor no ve el selector: agrega de a uno como en cualquier tienda', async () => {
    render(product())
    await screen.findByRole('button', { name: /^Agregar al carrito/ })
    expect(screen.queryByRole('button', { name: 'Sumar una unidad' })).not.toBeInTheDocument()
  })
})

describe('SKU y «ya comprado» (Resumen v2)', () => {
  it('el comprador empresa ve el SKU y si su empresa ya lo compró', async () => {
    renderWithProviders(
      <CartProvider storeId={STORE} storeSlug="casa-nordica" currency="PEN">
        <ProductCard product={product({ sku: 'SIL-ROB-01' })} storeSlug="casa-nordica" b2b purchased />
      </CartProvider>,
    )
    // Resumen v2 · el código solo, en monoespaciada, como en el diseño.
    expect(await screen.findByText('SIL-ROB-01')).toBeInTheDocument()
    expect(screen.getByText('Ya comprado')).toBeInTheDocument()
  })

  it('el consumidor no ve ni el SKU ni la marca de compra', async () => {
    renderWithProviders(
      <CartProvider storeId={STORE} storeSlug="casa-nordica" currency="PEN">
        <ProductCard product={product({ sku: 'SIL-ROB-01' })} storeSlug="casa-nordica" purchased />
      </CartProvider>,
    )
    await screen.findByRole('button', { name: /^Agregar al carrito/ })
    expect(screen.queryByText('SIL-ROB-01')).not.toBeInTheDocument()
    expect(screen.queryByText('Ya comprado')).not.toBeInTheDocument()
  })
})

describe('ranking de ventas', () => {
  it('en una fila de más vendidos, la tarjeta lleva su puesto dicho en texto', async () => {
    renderWithProviders(
      <CartProvider storeId={STORE} storeSlug="casa-nordica" currency="PEN">
        <ProductCard product={product()} storeSlug="casa-nordica" rank={1} />
      </CartProvider>,
    )
    expect(await screen.findByText('#1')).toBeInTheDocument()
    // Para un lector de pantalla, el puesto con palabras y no un «#1» suelto.
    expect(screen.getByText('Puesto 1 en ventas')).toBeInTheDocument()
  })

  it('sin ranking no hay insignia', async () => {
    render(product())
    await screen.findByRole('button', { name: /^Agregar al carrito/ })
    expect(screen.queryByText('#1')).not.toBeInTheDocument()
  })
})
