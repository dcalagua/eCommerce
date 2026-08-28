import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import {
  COMPANY_A,
  ORG,
  STORE_A,
  USER,
  createFakeSupabase,
  makeSession,
  type FakeSupabase,
} from '@/test/supabaseMock'
import { TENANT_FIELDS } from '../../../supabase/functions/_shared/auth'

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => holder.client,
  getSupabaseClient: () => holder.client,
  tryGetStorefrontClient: () => holder.client,
  getStorefrontClient: () => holder.client,
}))

const { TenantProvider } = await import('@/features/tenant/TenantProvider')
const { CapabilitiesProvider } = await import('@/features/capabilities/CapabilitiesProvider')
const { ProductsPage } = await import('./ProductsPage')

const PRODUCT_ID = '88888888-8888-4888-8888-888888888888'
const CATEGORY_ID = '77777777-7777-4777-8777-777777777777'

function backend(role: 'admin' | 'viewer' = 'admin', products = defaultProducts()): FakeSupabase {
  return createFakeSupabase({
    session: makeSession(),
    tables: {
      tenants: [{ organization_id: ORG, slug: 'mi-negocio', name: 'Mi Negocio', status: 'active' }],
      tenant_members: [
        { organization_id: ORG, company_id: COMPANY_A, user_id: USER, role, status: 'active' },
      ],
      stores: [
        {
          id: STORE_A,
          organization_id: ORG,
          company_id: COMPANY_A,
          slug: 'mi-negocio',
          name: 'Mi Negocio',
          status: 'active',
          currency: 'PEN',
        },
      ],
      categories: [
        {
          id: CATEGORY_ID,
          store_id: STORE_A,
          parent_id: null,
          slug: 'sillas',
          name: 'Sillas',
          position: 0,
          is_active: true,
        },
      ],
      products,
      product_images: [],
    },
    rpc: {
      product_deletion_usage: () => ({ name: 'Silla A', order_lines: 2, images: 3 }),
    },
    functions: {
      'catalog-product': (body) => ({ id: String(body.product_id ?? PRODUCT_ID), status: 'draft' }),
    },
  })
}

function defaultProducts() {
  return [
    {
      id: PRODUCT_ID,
      organization_id: ORG,
      company_id: COMPANY_A,
      store_id: STORE_A,
      category_id: CATEGORY_ID,
      sku: 'A-1',
      name: 'Silla A',
      slug: 'silla-a',
      description: null,
      status: 'draft',
      price: '199.90',
      compare_at_price: null,
      currency: 'PEN',
      stock: 4,
      published_at: null,
      updated_at: '2026-08-27T00:00:00.000Z',
    },
  ]
}

/**
 * El `CapabilitiesProvider` va aqui desde P03-SaaS: el cajon de producto
 * pregunta si la sociedad tiene `catalog.advanced` para decidir si ensena las
 * pestanas del PIM. El doble sirve por defecto un tenant con eCommerce activo y
 * SOLO lo baseline, que es exactamente el tenant de antes del PIM: estos tests
 * siguen comprobando el catalogo simple sin el modulo vendible.
 */
function renderPage(fake: FakeSupabase) {
  holder.client = fake
  return renderWithProviders(
    <TenantProvider>
      <CapabilitiesProvider>
        <ProductsPage />
      </CapabilitiesProvider>
    </TenantProvider>,
    { session: fake.state.session },
  )
}

/** Abre el menú de acciones de la fila y devuelve el menú. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Acciones: Silla A/ }))
  return screen.findByRole('menu')
}

beforeEach(() => {
  holder.client = null
})

describe('ProductsPage — listado', () => {
  it('muestra los productos de la tienda activa con precio, stock y estado', async () => {
    renderPage(backend())

    expect(await screen.findByText('Silla A')).toBeInTheDocument()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('A-1')).toBeInTheDocument()
    expect(table.getByText('Sillas')).toBeInTheDocument()
    expect(table.getByText('Borrador')).toBeInTheDocument()
    expect(table.getByText('4')).toBeInTheDocument()
    expect(table.getByText('S/ 199.90')).toBeInTheDocument()
  })

  it('mientras se resuelve el espacio muestra esqueleto, no "no tienes tiendas"', () => {
    renderPage(backend())
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
    expect(screen.queryByText('Todavía no tienes tiendas')).not.toBeInTheDocument()
  })

  it('sin productos muestra el estado vacio, no una tabla vacia', async () => {
    renderPage(backend('admin', []))
    expect(await screen.findByText('Aún no publicaste productos')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('un rol sin permiso de catalogo no ve el boton de alta', async () => {
    renderPage(backend('viewer'))
    await screen.findByText('Silla A')
    expect(screen.queryByRole('button', { name: 'Nuevo producto' })).not.toBeInTheDocument()
  })

  it('el rol de catalogo si lo ve', async () => {
    renderPage(backend())
    expect(await screen.findByRole('button', { name: 'Nuevo producto' })).toBeInTheDocument()
  })

  it('ofrece un unico buscador general, sin panel de filtros multi-campo', async () => {
    renderPage(backend())
    await screen.findByText('Silla A')
    expect(screen.getAllByRole('searchbox')).toHaveLength(1)
  })

  it('las pestanas de estado son las tres del enum mas "Todos"', async () => {
    renderPage(backend())
    await screen.findByText('Silla A')
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual(['Todos', 'Borrador', 'Publicado', 'Archivado'])
  })
})

describe('ProductsPage — alta y edicion', () => {
  it('el alta manda `create` con la tienda y SIN tenant en el cuerpo', async () => {
    const user = userEvent.setup()
    const fake = backend()
    renderPage(fake)

    await user.click(await screen.findByRole('button', { name: 'Nuevo producto' }))
    const drawer = await screen.findByRole('dialog')

    await user.type(within(drawer).getByLabelText('Nombre'), 'Mesa nueva')
    await user.type(within(drawer).getByLabelText('SKU'), 'MES-001')
    await user.type(within(drawer).getByLabelText('Precio'), '349.50')
    await user.clear(within(drawer).getByLabelText('Stock'))
    await user.type(within(drawer).getByLabelText('Stock'), '7')
    await user.click(within(drawer).getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(fake.state.invocations).toHaveLength(1))
    const invocation = fake.state.invocations[0]
    expect(invocation?.name).toBe('catalog-product')
    expect(invocation?.body).toMatchObject({
      action: 'create',
      store_id: STORE_A,
      sku: 'MES-001',
      name: 'Mesa nueva',
      price: '349.50',
      stock: 7,
      status: 'draft',
    })
    // La regla bloqueante del contrato §3: el tenant NO viaja en el cuerpo.
    for (const field of TENANT_FIELDS) {
      expect(invocation?.body).not.toHaveProperty(field)
    }
  })

  it('el slug se sugiere desde el nombre y viaja en minusculas con guiones', async () => {
    const user = userEvent.setup()
    const fake = backend()
    renderPage(fake)

    await user.click(await screen.findByRole('button', { name: 'Nuevo producto' }))
    const drawer = await screen.findByRole('dialog')
    await user.type(within(drawer).getByLabelText('Nombre'), 'Mesa de Comedor')

    expect(within(drawer).getByLabelText('Dirección del producto')).toHaveValue('mesa-de-comedor')
  })

  it('un precio invalido se detiene en el cliente: no se llama a la funcion', async () => {
    const user = userEvent.setup()
    const fake = backend()
    renderPage(fake)

    await user.click(await screen.findByRole('button', { name: 'Nuevo producto' }))
    const drawer = await screen.findByRole('dialog')

    await user.type(within(drawer).getByLabelText('Nombre'), 'Mesa nueva')
    await user.type(within(drawer).getByLabelText('SKU'), 'MES-001')
    await user.type(within(drawer).getByLabelText('Precio'), '19,90')
    await user.click(within(drawer).getByRole('button', { name: 'Guardar' }))

    expect(
      await within(drawer).findByText(/importe con hasta 2 decimales/i),
    ).toBeInTheDocument()
    expect(fake.state.invocations).toHaveLength(0)
  })

  it('al editar se abre el panel con los datos del producto', async () => {
    const user = userEvent.setup()
    renderPage(backend())

    const menu = await openRowMenu(userEvent.setup())
    await user.click(within(menu).getByRole('menuitem', { name: 'Editar' }))

    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByLabelText('Nombre')).toHaveValue('Silla A')
    expect(within(drawer).getByLabelText('SKU')).toHaveValue('A-1')
    expect(within(drawer).getByLabelText('Precio')).toHaveValue('199.90')
  })

  it('el producto sin guardar todavia no ofrece subir imagenes', async () => {
    const user = userEvent.setup()
    renderPage(backend())

    await user.click(await screen.findByRole('button', { name: 'Nuevo producto' }))
    const drawer = await screen.findByRole('dialog')
    // Desde P03-SaaS el cajon va por pestanas: las imagenes viven en la suya.
    await user.click(within(drawer).getByRole('tab', { name: 'Imágenes' }))
    expect(
      await within(drawer).findByText(/Guarda el producto y podrás subir sus imágenes/),
    ).toBeInTheDocument()
  })

  it('el cajon se organiza en pestanas y no en un formulario monolitico', async () => {
    const user = userEvent.setup()
    renderPage(backend())

    await user.click(await screen.findByRole('button', { name: 'Nuevo producto' }))
    const drawer = await screen.findByRole('dialog')

    // Sin `catalog.advanced` contratado solo hay dos: General e Imagenes. Las
    // del PIM aparecen con el modulo, y eso lo comprueba `pim.test.tsx`.
    expect(within(drawer).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'General',
      'Imágenes',
    ])
  })
})

describe('ProductsPage — publicar y despublicar', () => {
  it('publicar manda solo el estado, sin fecha inventada ni tenant', async () => {
    const user = userEvent.setup()
    const fake = backend()
    renderPage(fake)

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Publicar' }))

    await waitFor(() => expect(fake.state.invocations).toHaveLength(1))
    expect(fake.state.invocations[0]?.body).toEqual({
      action: 'update',
      product_id: PRODUCT_ID,
      status: 'published',
    })
  })

  it('un producto publicado ofrece despublicar en vez de publicar', async () => {
    const user = userEvent.setup()
    const published = defaultProducts()
    published[0]!.status = 'published'
    const fake = backend('admin', published)
    renderPage(fake)

    const menu = await openRowMenu(user)
    expect(within(menu).getByRole('menuitem', { name: 'Despublicar' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Publicar' })).not.toBeInTheDocument()
  })

  it('confirma con un aviso al usuario', async () => {
    const user = userEvent.setup()
    renderPage(backend())

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Publicar' }))

    expect(await screen.findByText('Producto publicado')).toBeInTheDocument()
  })
})

describe('ProductsPage — eliminacion segura (contrato §4.2)', () => {
  it('antes de borrar enseña el conteo REAL de uso y ofrece archivar', async () => {
    const user = userEvent.setup()
    renderPage(backend())

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Eliminar' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Uso real de este registro')).toBeInTheDocument()
    await within(dialog).findByText('2') // líneas de pedido
    expect(within(dialog).getByText('3')).toBeInTheDocument() // imágenes
    expect(within(dialog).getByRole('button', { name: 'Archivar' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Eliminar de todas formas' })).toBeInTheDocument()
  })

  it('archivar en vez de borrar conserva la fila y solo cambia el estado', async () => {
    const user = userEvent.setup()
    const fake = backend()
    renderPage(fake)

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Eliminar' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Archivar' }))

    await waitFor(() => expect(fake.state.invocations).toHaveLength(1))
    expect(fake.state.invocations[0]?.body).toMatchObject({ status: 'archived' })
    expect(fake.state.tables.products).toHaveLength(1)
  })

  it('eliminar borra la fila de verdad', async () => {
    const user = userEvent.setup()
    const fake = backend()
    renderPage(fake)

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Eliminar' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar de todas formas' }))

    await waitFor(() => expect(fake.state.tables.products).toHaveLength(0))
    expect(await screen.findByText('Producto eliminado')).toBeInTheDocument()
  })
})
