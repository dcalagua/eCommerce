import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { renderWithProviders } from '@/test/render'
import { createFakeSupabase, makeSession, type FakeSupabase } from '@/test/supabaseMock'

/**
 * Vitrina pública de punta a punta contra un PostgREST falso.
 *
 * Lo que estos tests defienden no es la maquetación, es la regla del encargo:
 * la tienda se resuelve por el slug de la URL, la identidad sale de
 * `store_settings`, y el comprador anónimo ve el catálogo publicado con sus
 * filtros — nada más.
 *
 * El aislamiento de verdad (que un tenant no vea al otro) se comprueba contra
 * Postgres real en `supabase/tests/storefront-public.test.ts`: aquí las vistas
 * son tablas en memoria y fingir RLS daría una falsa sensación de cobertura.
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
const { ProductGridSkeleton } = await import('./components/ProductGrid')

const STORE = 'aaaa1111-1111-4111-8111-111111111111'
const CAT_SILLAS = 'bbbb1111-1111-4111-8111-111111111111'
const CAT_MESAS = 'bbbb2222-1111-4111-8111-111111111111'
const P_SILLA = 'cccc1111-1111-4111-8111-111111111111'
const P_LINO = 'cccc2222-1111-4111-8111-111111111111'
const P_MESA = 'cccc3333-1111-4111-8111-111111111111'
const ORG_ID = 'dddd1111-1111-4111-8111-111111111111'

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
    hero_title: 'Muebles que duran',
    hero_subtitle: 'Fabricación propia',
    contact_phone: '+51 999 111 222',
    contact_address: 'Av. Primavera 120',
    ...overrides,
  }
}

function catalogo() {
  return [
    {
      product_id: P_SILLA,
      store_id: STORE,
      category_id: CAT_SILLAS,
      slug: 'silla-roble',
      name: 'Silla de roble',
      description: 'Roble macizo con acabado al aceite.',
      price: '389.00',
      compare_at_price: '450.00',
      currency: 'PEN',
      published_at: '2026-08-20T00:00:00.000Z',
      in_stock: true,
      category_slug: 'sillas',
      category_name: 'Sillas',
      primary_image_path: `${STORE}/silla.jpg`,
      primary_image_alt: 'Silla de roble',
    },
    {
      product_id: P_LINO,
      store_id: STORE,
      category_id: CAT_SILLAS,
      slug: 'silla-lino',
      name: 'Silla de lino',
      description: null,
      price: '429.00',
      compare_at_price: null,
      currency: 'PEN',
      published_at: '2026-08-18T00:00:00.000Z',
      in_stock: false,
      category_slug: 'sillas',
      category_name: 'Sillas',
      primary_image_path: null,
      primary_image_alt: null,
    },
    {
      product_id: P_MESA,
      store_id: STORE,
      category_id: CAT_MESAS,
      slug: 'mesa-extensible',
      name: 'Mesa extensible',
      description: 'De cuatro a ocho comensales.',
      price: '1890.00',
      compare_at_price: null,
      currency: 'PEN',
      published_at: '2026-08-15T00:00:00.000Z',
      in_stock: true,
      category_slug: 'mesas',
      category_name: 'Mesas',
      primary_image_path: null,
      primary_image_alt: null,
    },
  ]
}

function backend(overrides: Record<string, unknown[]> = {}): FakeSupabase {
  return createFakeSupabase({
    tables: {
      public_stores: [store()],
      public_categories: [
        { category_id: CAT_SILLAS, store_id: STORE, slug: 'sillas', name: 'Sillas', position: 1 },
        { category_id: CAT_MESAS, store_id: STORE, slug: 'mesas', name: 'Mesas', position: 2 },
      ],
      public_products: catalogo(),
      public_product_images: [
        {
          image_id: 'dddd1111-1111-4111-8111-111111111111',
          product_id: P_SILLA,
          storage_path: `${STORE}/silla.jpg`,
          alt: 'Silla de roble de frente',
          position: 0,
          is_primary: true,
        },
        {
          image_id: 'dddd2222-1111-4111-8111-111111111111',
          product_id: P_SILLA,
          storage_path: `${STORE}/silla-lateral.jpg`,
          alt: null,
          position: 1,
          is_primary: false,
        },
      ],
      ...overrides,
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
      </Route>
    </Routes>,
    { route },
  )
}

beforeEach(() => {
  holder.client = null
})

describe('resolución del tenant por slug', () => {
  it('resuelve la tienda del slug y pinta su identidad, no la de casa', async () => {
    renderStorefront(backend(), '/s/casa-nordica')

    expect(await screen.findByRole('banner')).toBeInTheDocument()
    // El nombre sale de la tienda; el hero, de `store_settings`.
    expect(screen.getAllByText('Casa Nórdica').length).toBeGreaterThan(0)
    expect(
      await screen.findByRole('heading', { name: 'Muebles que duran', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('Fabricación propia')).toBeInTheDocument()
  })

  it('un slug que no resuelve da 404 de tienda, no una pantalla en blanco', async () => {
    renderStorefront(backend(), '/s/no-existe')

    expect(await screen.findByText('No encontramos esa tienda')).toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
  })

  it('sin logo cae a iniciales neutras: no planta el isotipo EBIM como marca del tenant', async () => {
    renderStorefront(backend(), '/s/casa-nordica')

    const header = await screen.findByRole('banner')
    expect(within(header).getByText('CN')).toBeInTheDocument()
    expect(within(header).queryByRole('img')).not.toBeInTheDocument()
  })

  /**
   * P07: lo que el tenant sube desde `/app/settings` se guarda como RUTA del
   * bucket privado `store-assets`. La vitrina la firma con el cliente ANÓNIMO
   * antes de pintarla — una URL guardada caducaría en una hora.
   */
  it('el logo que subio el tenant se firma y se pinta', async () => {
    const path = `${ORG_ID}/${STORE}/branding/logo-abc.png`
    const fake = backend({ public_stores: [store({ logo_url: path })] })
    renderStorefront(fake, '/s/casa-nordica')

    const header = await screen.findByRole('banner')
    expect(within(header).getByRole('img', { name: 'Casa Nórdica' })).toHaveAttribute(
      'src',
      `https://firmado.test/${path}`,
    )
  })

  it('una referencia de marca que no es https ni ruta del bucket se descarta', async () => {
    const fake = backend({ public_stores: [store({ logo_url: 'javascript:alert(1)' })] })
    renderStorefront(fake, '/s/casa-nordica')

    const header = await screen.findByRole('banner')
    expect(within(header).getByText('CN')).toBeInTheDocument()
    expect(within(header).queryByRole('img')).not.toBeInTheDocument()
  })

  it('con logo cargado, el logo manda', async () => {
    const fake = backend({ public_stores: [store({ logo_url: 'https://cdn.test/logo.png' })] })
    renderStorefront(fake, '/s/casa-nordica')

    const header = await screen.findByRole('banner')
    expect(within(header).getByRole('img', { name: 'Casa Nórdica' })).toHaveAttribute(
      'src',
      'https://cdn.test/logo.png',
    )
  })

  it('el pie sirve el contacto configurado por el tenant', async () => {
    renderStorefront(backend(), '/s/casa-nordica')

    const footer = await screen.findByRole('contentinfo')
    expect(within(footer).getByText('hola@casanordica.demo')).toHaveAttribute(
      'href',
      'mailto:hola@casanordica.demo',
    )
    expect(within(footer).getByText('+51 999 111 222')).toHaveAttribute('href', 'tel:+51999111222')
    expect(within(footer).getByText('Av. Primavera 120')).toBeInTheDocument()
  })

  it('una tienda sin contacto ni hero se ve igual, con los fallbacks neutrales', async () => {
    const fake = backend({
      public_stores: [
        store({
          hero_title: null,
          hero_subtitle: null,
          support_email: null,
          contact_phone: null,
          contact_address: null,
        }),
      ],
    })
    renderStorefront(fake, '/s/casa-nordica')

    expect(
      await screen.findByRole('heading', { name: 'Casa Nórdica', level: 1 }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Explora el catálogo, revisa precios y disponibilidad al día.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Contacto')).not.toBeInTheDocument()
  })

  it('la vitrina consulta SIEMPRE el modelo público, nunca las tablas del backoffice', async () => {
    const fake = backend()
    const seen: string[] = []
    const original = fake.from.bind(fake)
    fake.from = (table: string) => {
      seen.push(table)
      return original(table)
    }

    renderStorefront(fake, '/s/casa-nordica')
    await screen.findByText('Silla de roble')

    expect(seen.every((table) => table.startsWith('public_'))).toBe(true)
    expect(seen).not.toContain('products')
    expect(seen).not.toContain('stores')
  })
})

describe('catálogo', () => {
  it('lista los productos publicados con precio, descuento y disponibilidad', async () => {
    renderStorefront(backend(), '/s/casa-nordica')

    expect(await screen.findByText('Silla de roble')).toBeInTheDocument()
    expect(screen.getByText('3 productos')).toBeInTheDocument()
    expect(screen.getByText('-14%')).toBeInTheDocument()
    expect(screen.getAllByText('Disponible')).toHaveLength(2)
    expect(screen.getByText('Sin stock')).toBeInTheDocument()
  })

  it('cada tarjeta enlaza a su ficha', async () => {
    renderStorefront(backend(), '/s/casa-nordica')

    const card = (await screen.findByText('Silla de roble')).closest('a')
    expect(card).toHaveAttribute('href', '/s/casa-nordica/product/silla-roble')
  })

  it('el buscador general filtra por nombre', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica')
    await screen.findByText('Silla de roble')

    await user.type(screen.getByRole('searchbox', { name: 'Buscar productos' }), 'mesa')

    await waitFor(() => expect(screen.queryByText('Silla de roble')).not.toBeInTheDocument())
    expect(screen.getByText('Mesa extensible')).toBeInTheDocument()
  })

  it('una búsqueda sin resultados ofrece quitar los filtros y vuelve al catálogo entero', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica')
    await screen.findByText('Silla de roble')

    await user.type(screen.getByRole('searchbox', { name: 'Buscar productos' }), 'zzz')
    expect(await screen.findByText('Sin resultados')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Quitar filtros' }))
    expect(await screen.findByText('Silla de roble')).toBeInTheDocument()
  })

  it('filtra por categoría desde las píldoras y marca cuál está activa', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica')
    await screen.findByText('Silla de roble')

    await user.click(screen.getByRole('button', { name: 'Mesas' }))

    await waitFor(() => expect(screen.queryByText('Silla de roble')).not.toBeInTheDocument())
    expect(screen.getByText('Mesa extensible')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mesas' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Todo' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('volver a pulsar la categoría activa la quita', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica?c=mesas')
    await screen.findByText('Mesa extensible')

    await user.click(screen.getByRole('button', { name: 'Mesas' }))

    expect(await screen.findByText('Silla de roble')).toBeInTheDocument()
  })

  it('el filtro de disponibilidad esconde lo agotado', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica')
    await screen.findByText('Silla de lino')

    await user.click(screen.getByRole('checkbox', { name: /solo disponibles/i }))

    await waitFor(() => expect(screen.queryByText('Silla de lino')).not.toBeInTheDocument())
    expect(screen.getByText('Silla de roble')).toBeInTheDocument()
  })

  it('una tienda sin catálogo publicado muestra estado vacío, no un error', async () => {
    renderStorefront(backend({ public_products: [] }), '/s/casa-nordica')

    expect(await screen.findByText('Esta tienda todavía no publicó productos')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('el esqueleto del catálogo repite la rejilla real, para que la página no salte', () => {
    renderWithProviders(<ProductGridSkeleton count={4} />)

    const skeleton = screen.getByTestId('catalog-skeleton')
    expect(skeleton).toBeInTheDocument()
    // Oculto al lector de pantalla: no es contenido, es la espera.
    expect(skeleton).toHaveAttribute('aria-hidden')
  })

  it('el esqueleto deja paso al catálogo en cuanto llegan los datos', async () => {
    renderStorefront(backend(), '/s/casa-nordica')

    await screen.findByText('Silla de roble')
    expect(screen.queryByTestId('catalog-skeleton')).not.toBeInTheDocument()
  })

  it('la URL con filtros ya puestos se abre filtrada (deep link)', async () => {
    renderStorefront(backend(), '/s/casa-nordica?c=mesas')

    expect(await screen.findByText('Mesa extensible')).toBeInTheDocument()
    expect(screen.queryByText('Silla de roble')).not.toBeInTheDocument()
  })
})

describe('ficha de producto', () => {
  it('muestra galería, precio, disponibilidad y descripción', async () => {
    renderStorefront(backend(), '/s/casa-nordica/product/silla-roble')

    expect(
      await screen.findByRole('heading', { name: 'Silla de roble', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('Roble macizo con acabado al aceite.')).toBeInTheDocument()
    expect(screen.getByText('Sillas')).toBeInTheDocument()
    expect(screen.getAllByText('Disponible').length).toBeGreaterThan(0)

    // Bucket privado: la imagen llega por URL firmada, no por URL pública.
    const image = await screen.findByRole('img', { name: 'Silla de roble de frente' })
    expect(image.getAttribute('src')).toContain('https://firmado.test/')
  })

  it('la galería deja elegir otra foto sin recargar la ficha', async () => {
    const user = userEvent.setup()
    renderStorefront(backend(), '/s/casa-nordica/product/silla-roble')

    await screen.findByRole('img', { name: 'Silla de roble de frente' })
    await user.click(screen.getByRole('button', { name: 'Imagen 2' }))

    await waitFor(() =>
      expect(screen.getAllByRole('img').some((img) => img.getAttribute('src')?.includes('lateral'))).toBe(
        true,
      ),
    )
  })

  it('sin descripción lo dice, en vez de dejar un hueco', async () => {
    renderStorefront(backend(), '/s/casa-nordica/product/silla-lino')

    expect(
      await screen.findByText('Este producto todavía no tiene descripción.'),
    ).toBeInTheDocument()
  })

  it('propone relacionados de la misma categoría y nunca el producto abierto', async () => {
    renderStorefront(backend(), '/s/casa-nordica/product/silla-roble')

    const heading = await screen.findByRole('heading', { name: 'También te puede interesar' })
    const section = heading.closest('section') as HTMLElement
    expect(within(section).getByText('Silla de lino')).toBeInTheDocument()
    expect(within(section).queryByText('Silla de roble')).not.toBeInTheDocument()
  })

  it('un producto que no está publicado da 404 con salida al catálogo', async () => {
    renderStorefront(backend(), '/s/casa-nordica/product/no-existe')

    expect(await screen.findByText('No encontramos ese producto')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volver al catálogo' })).toHaveAttribute(
      'href',
      '/s/casa-nordica',
    )
  })

  it('la vitrina no depende de tener sesión de backoffice abierta', async () => {
    const fake = backend()
    fake.state.session = makeSession()
    renderStorefront(fake, '/s/casa-nordica/product/silla-roble')

    expect(
      await screen.findByRole('heading', { name: 'Silla de roble', level: 1 }),
    ).toBeInTheDocument()
  })
})
