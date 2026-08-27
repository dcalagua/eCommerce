import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { renderWithProviders } from '@/test/render'
import { createFakeSupabase, FunctionsHttpErrorLike, type FakeSupabase } from '@/test/supabaseMock'

/**
 * Flujo completo del comprador: ficha → carrito → checkout → confirmación.
 *
 * Lo que estos tests defienden es el encargo de P06:
 *  - el carrito suma, resta y quita, y su subtotal cuadra;
 *  - vive en `localStorage` por tienda y no mezcla catálogos;
 *  - al confirmar, el cuerpo que sale hacia `create-order` lleva el SLUG de la
 *    tienda, los productos y las cantidades — y ni un precio;
 *  - los importes de la confirmación son los que devolvió el servidor;
 *  - un doble clic no crea dos pedidos y un fallo se explica sin perder el
 *    carrito.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => holder.client,
  getSupabaseClient: () => holder.client,
  tryGetStorefrontClient: () => holder.client,
  getStorefrontClient: () => holder.client,
}))

const { StorefrontLayout } = await import('./StorefrontLayout')
const { StoreHomePage } = await import('./StoreHomePage')
const { StoreProductPage } = await import('./StoreProductPage')
const { StoreCartPage } = await import('./StoreCartPage')
const { StoreCheckoutPage } = await import('./StoreCheckoutPage')
const { StoreOrderPage } = await import('./StoreOrderPage')
const { CREATE_ORDER_FUNCTION } = await import('./checkout')

const STORE = 'aaaa1111-1111-4111-8111-111111111111'
const OTRA_STORE = 'aaaa2222-1111-4111-8111-111111111111'
const P_SILLA = 'cccc1111-1111-4111-8111-111111111111'
const P_MESA = 'cccc3333-1111-4111-8111-111111111111'

function store(overrides: Record<string, unknown> = {}) {
  return {
    store_id: STORE,
    slug: 'casa-nordica',
    name: 'Casa Nórdica',
    currency: 'PEN',
    accent_color: '#056769',
    logo_url: null,
    white_label: false,
    default_locale: 'es',
    support_email: 'hola@casanordica.demo',
    banner_url: null,
    hero_title: null,
    hero_subtitle: null,
    contact_phone: null,
    contact_address: null,
    ...overrides,
  }
}

function producto(overrides: Record<string, unknown> = {}) {
  return {
    product_id: P_SILLA,
    store_id: STORE,
    category_id: null,
    slug: 'silla-roble',
    name: 'Silla de roble',
    description: 'Roble macizo.',
    price: '100.00',
    compare_at_price: null,
    currency: 'PEN',
    published_at: '2026-08-20T00:00:00.000Z',
    in_stock: true,
    category_slug: null,
    category_name: null,
    primary_image_path: null,
    primary_image_alt: null,
    ...overrides,
  }
}

/** Respuesta de `create-order`: el dinero llega como texto, ya recalculado. */
function respuestaPedido(body: Record<string, unknown>) {
  return {
    order_id: 'eeee1111-1111-4111-8111-111111111111',
    order_number: 'EC-20260827-00001',
    status: 'pending',
    currency: 'PEN',
    subtotal: '200.00',
    tax_total: '36.00',
    grand_total: '236.00',
    items: (body.items as Array<{ product_id: string; quantity: number }>).map((item) => ({
      product_id: item.product_id,
      sku: 'SKU-1',
      name: 'Silla de roble',
      unit_price: '100.00',
      quantity: item.quantity,
    })),
  }
}

function backend(options: { onCreateOrder?: (body: Record<string, unknown>) => unknown } = {}) {
  return createFakeSupabase({
    tables: {
      public_stores: [store()],
      public_categories: [],
      public_products: [
        producto(),
        producto({ product_id: P_MESA, slug: 'mesa', name: 'Mesa', price: '50.00' }),
      ],
      public_product_images: [],
    },
    functions: {
      [CREATE_ORDER_FUNCTION]: options.onCreateOrder ?? respuestaPedido,
    },
  })
}

function renderStorefront(fake: FakeSupabase, route: string) {
  holder.client = fake
  return renderWithProviders(
    <Routes>
      <Route path="/s/:storeSlug" element={<StorefrontLayout />}>
        <Route index element={<StoreHomePage />} />
        <Route path="product/:productSlug" element={<StoreProductPage />} />
        <Route path="cart" element={<StoreCartPage />} />
        <Route path="checkout" element={<StoreCheckoutPage />} />
        <Route path="order/:orderNumber" element={<StoreOrderPage />} />
      </Route>
    </Routes>,
    { route },
  )
}

/** Deja el carrito de la tienda listo, sin repetir la navegación en cada test. */
function sembrarCarrito(lines: Array<Record<string, unknown>>, storeId = STORE) {
  localStorage.setItem(
    `ebim.ecommerce.cart.v1:${storeId}`,
    JSON.stringify({ store_id: storeId, lines }),
  )
}

const LINEA_SILLA = {
  product_id: P_SILLA,
  slug: 'silla-roble',
  name: 'Silla de roble',
  unit_price: '100.00',
  currency: 'PEN',
  image_path: null,
  quantity: 2,
}

beforeEach(() => {
  holder.client = null
  localStorage.clear()
})

describe('de la ficha al carrito', () => {
  it('agregar abre el panel con lo que se acaba de meter', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica/product/silla-roble')

    await user.click(await screen.findByRole('button', { name: 'Agregar al carrito' }))

    // El panel se abre solo: el comprador ve lo que metió sin dejar la ficha.
    expect(await screen.findByRole('heading', { name: /Carrito/ })).toBeInTheDocument()
    expect(screen.getByText('Subtotal')).toBeInTheDocument()
    expect(screen.getAllByText('Silla de roble').length).toBeGreaterThan(1)
    expect(screen.getByRole('link', { name: 'Ver el carrito' })).toHaveAttribute(
      'href',
      '/s/casa-nordica/cart',
    )
  })

  it('la cantidad elegida en la ficha es la que entra al carrito', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica/product/silla-roble')

    await user.click(await screen.findByRole('button', { name: 'Sumar una unidad' }))
    await user.click(screen.getByRole('button', { name: 'Agregar al carrito' }))

    await waitFor(() => {
      const guardado = localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`)
      expect(guardado).toContain('"quantity":2')
    })
  })

  it('el carrito de otra tienda no se ve en esta', async () => {
    sembrarCarrito([{ ...LINEA_SILLA, quantity: 4 }], OTRA_STORE)
    renderStorefront(backend(), '/s/casa-nordica/cart')

    expect(await screen.findByText('Tu carrito está vacío')).toBeInTheDocument()
  })

  it('el carrito de la tienda sobrevive a la recarga y se puede editar', async () => {
    const user = userEvent.setup()
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(backend(), '/s/casa-nordica/cart')

    expect((await screen.findAllByText(/200\.00/)).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Restar una unidad' }))
    await waitFor(() => expect(screen.queryByText(/200\.00/)).not.toBeInTheDocument())
    expect(screen.getAllByText(/100\.00/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /Quitar del carrito/ }))
    expect(await screen.findByText('Tu carrito está vacío')).toBeInTheDocument()
    expect(localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`)).toBeNull()
  })
})

describe('checkout', () => {
  async function rellenar(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(/Nombre y apellido/), 'Ana Pérez')
    await user.type(screen.getByLabelText(/Correo/), 'ana@compradora.com')
    await user.type(screen.getByLabelText(/Teléfono/), '+51 999 888 777')
    await user.type(screen.getByLabelText(/Dirección de entrega/), 'Av. Primavera 120')
  }

  it('manda tienda, productos y cantidades — y ningún precio', async () => {
    const user = userEvent.setup()
    const fake = backend()
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(fake, '/s/casa-nordica/checkout')

    await rellenar(user)
    await user.type(screen.getByLabelText(/Referencia/), 'Portón verde')
    await user.click(screen.getByRole('button', { name: 'Confirmar pedido' }))

    await waitFor(() => expect(fake.state.invocations).toHaveLength(1))
    const { name, body } = fake.state.invocations[0]!

    expect(name).toBe(CREATE_ORDER_FUNCTION)
    expect(body).toEqual({
      store_slug: 'casa-nordica',
      customer_name: 'Ana Pérez',
      customer_email: 'ana@compradora.com',
      customer_phone: '+51 999 888 777',
      shipping_address: { address: 'Av. Primavera 120', reference: 'Portón verde' },
      items: [{ product_id: P_SILLA, quantity: 2 }],
    })

    // Ni el tenant ni el dinero salen del navegador.
    const plano = JSON.stringify(body)
    for (const prohibido of [
      'price',
      'unit_price',
      'subtotal',
      'total',
      'currency',
      'store_id',
      'organization_id',
      'company_id',
    ]) {
      expect(plano).not.toContain(prohibido)
    }
  })

  it('la referencia es opcional: sin ella, no viaja el campo', async () => {
    const user = userEvent.setup()
    const fake = backend()
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(fake, '/s/casa-nordica/checkout')

    await rellenar(user)
    await user.click(screen.getByRole('button', { name: 'Confirmar pedido' }))

    await waitFor(() => expect(fake.state.invocations).toHaveLength(1))
    expect(fake.state.invocations[0]?.body.shipping_address).toEqual({
      address: 'Av. Primavera 120',
    })
  })

  it('no envía nada con datos incompletos', async () => {
    const user = userEvent.setup()
    const fake = backend()
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(fake, '/s/casa-nordica/checkout')

    await user.type(await screen.findByLabelText(/Nombre y apellido/), 'Ana Pérez')
    await user.type(screen.getByLabelText(/Correo/), 'no-es-un-correo')
    await user.click(screen.getByRole('button', { name: 'Confirmar pedido' }))

    expect(await screen.findByText('Escribe un correo válido')).toBeInTheDocument()
    expect(fake.state.invocations).toHaveLength(0)
  })

  it('un carrito vacío no llega ni a la pantalla de pago', async () => {
    renderStorefront(backend(), '/s/casa-nordica/checkout')

    expect(await screen.findByText('Tu carrito está vacío')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirmar pedido' })).not.toBeInTheDocument()
  })

  it('doble clic no crea dos pedidos', async () => {
    const user = userEvent.setup()
    const pendiente: { responder: (() => void) | null } = { responder: null }
    const fake = backend({
      onCreateOrder: (body) => {
        // La primera llamada se queda en vuelo: es el hueco por el que se
        // colaría el segundo clic si el botón no se bloqueara.
        return new Promise((resolve) => {
          pendiente.responder = () => resolve(respuestaPedido(body))
        })
      },
    })
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(fake, '/s/casa-nordica/checkout')

    await rellenar(user)
    const form = document.querySelector('form') as HTMLFormElement
    await user.click(screen.getByRole('button', { name: 'Confirmar pedido' }))

    // El botón se bloquea mientras el pedido está en vuelo...
    expect(await screen.findByRole('button', { name: 'Registrando el pedido…' })).toBeDisabled()
    // ...y un submit que se cuele igual (Enter repetido) no dispara nada.
    fireEvent.submit(form)
    fireEvent.submit(form)

    await waitFor(() => expect(fake.state.invocations).toHaveLength(1))
    pendiente.responder?.()
    expect(await screen.findByText('EC-20260827-00001')).toBeInTheDocument()
    expect(fake.state.invocations).toHaveLength(1)
  })

  it('un error del servidor se explica y no vacía el carrito', async () => {
    const user = userEvent.setup()
    const fake = backend({
      onCreateOrder: () => {
        throw new FunctionsHttpErrorLike(409, 'STOCK_INSUFICIENTE')
      },
    })
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(fake, '/s/casa-nordica/checkout')

    await rellenar(user)
    await user.click(screen.getByRole('button', { name: 'Confirmar pedido' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/unidades disponibles/i)
    expect(localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Confirmar pedido' })).toBeEnabled()
  })
})

describe('confirmación', () => {
  it('muestra los importes del SERVIDOR, no los del carrito, y vacía el carrito', async () => {
    const user = userEvent.setup()
    const fake = backend()
    // El carrito dice 200.00 de subtotal; el servidor manda 236.00 de total.
    sembrarCarrito([LINEA_SILLA])
    renderStorefront(fake, '/s/casa-nordica/checkout')

    await user.type(await screen.findByLabelText(/Nombre y apellido/), 'Ana Pérez')
    await user.type(screen.getByLabelText(/Correo/), 'ana@compradora.com')
    await user.type(screen.getByLabelText(/Teléfono/), '+51 999 888 777')
    await user.type(screen.getByLabelText(/Dirección de entrega/), 'Av. Primavera 120')
    await user.click(screen.getByRole('button', { name: 'Confirmar pedido' }))

    expect(await screen.findByRole('heading', { name: 'Pedido registrado' })).toBeInTheDocument()
    expect(screen.getByText('EC-20260827-00001')).toBeInTheDocument()
    expect(screen.getByText('Pendiente de pago')).toBeInTheDocument()
    // Impuesto y total del servidor, no el subtotal que calculó el carrito.
    expect(screen.getByText(/^S\/ 36\.00$/)).toBeInTheDocument()
    expect(screen.getByText(/^S\/ 236\.00$/)).toBeInTheDocument()

    await waitFor(() =>
      expect(localStorage.getItem(`ebim.ecommerce.cart.v1:${STORE}`)).toBeNull(),
    )
  })

  it('sin estado de navegación sigue mostrando el número de la URL', async () => {
    renderStorefront(backend(), '/s/casa-nordica/order/EC-20260827-00042')

    expect(await screen.findByText('EC-20260827-00042')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Pedido registrado' })).toBeInTheDocument()
  })
})
