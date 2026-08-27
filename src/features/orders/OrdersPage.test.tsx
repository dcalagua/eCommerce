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
const { OrdersPage } = await import('./OrdersPage')

const ORDER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ORDER_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const ITEM_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const EVENT_1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const EVENT_2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'

const TODAY = new Date().toISOString()
const OLD = new Date(Date.now() - 200 * 86_400_000).toISOString()

function orderRow(patch: Record<string, unknown> = {}) {
  return {
    id: ORDER_1,
    organization_id: ORG,
    company_id: COMPANY_A,
    store_id: STORE_A,
    order_number: 'MI-000001',
    customer_name: 'Ana Compradora',
    customer_email: 'ana@compradora.com',
    customer_phone: '+51 999 111 222',
    status: 'pending',
    currency: 'PEN',
    subtotal: '200.00',
    tax_total: '36.00',
    shipping_total: '0.00',
    discount_total: '0.00',
    grand_total: '236.00',
    shipping_address: { address: 'Av. Primavera 120', reference: 'Portón verde' },
    notes: null,
    placed_at: TODAY,
    updated_at: TODAY,
    ...patch,
  }
}

function backend(role: 'admin' | 'viewer' = 'admin'): FakeSupabase {
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
      orders: [
        orderRow(),
        orderRow({
          id: ORDER_2,
          order_number: 'MI-000002',
          customer_name: 'Beto Antiguo',
          customer_email: 'beto@antiguo.com',
          status: 'paid',
          grand_total: '99.00',
          placed_at: OLD,
        }),
      ],
      order_items: [
        {
          id: ITEM_1,
          order_id: ORDER_1,
          product_id: null,
          sku: 'SILLA-1',
          name: 'Silla nórdica',
          unit_price: '100.00',
          quantity: 2,
          line_total: '200.00',
          created_at: TODAY,
        },
      ],
      order_status_events: [
        {
          id: EVENT_1,
          order_id: ORDER_1,
          from_status: null,
          to_status: 'pending',
          note: null,
          actor_email: null,
          created_at: TODAY,
        },
        {
          id: EVENT_2,
          order_id: ORDER_1,
          from_status: 'pending',
          to_status: 'paid',
          note: 'Depósito verificado',
          actor_email: 'duenio@negocio.com',
          created_at: TODAY,
        },
      ],
    },
    functions: {
      'update-order-status': (body) => ({ id: String(body.order_id), status: body.status }),
    },
  })
}

function renderPage() {
  return renderWithProviders(
    <TenantProvider>
      <OrdersPage />
    </TenantProvider>,
    { session: makeSession() },
  )
}

beforeEach(() => {
  holder.client = backend()
})

describe('OrdersPage — listado', () => {
  it('muestra numero, cliente, estado, fecha y total del pedido', async () => {
    renderPage()

    const row = (await screen.findByText('MI-000001')).closest('tr') as HTMLElement
    expect(within(row).getByText('Ana Compradora')).toBeInTheDocument()
    expect(within(row).getByText('Pendiente')).toBeInTheDocument()
    expect(within(row).getByText(/236[,.]00/)).toBeInTheDocument()
  })

  it('el buscador general filtra por numero, nombre o correo', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('MI-000001')

    await user.type(screen.getByPlaceholderText(/Buscar por número/i), 'beto')

    await waitFor(() => expect(screen.queryByText('MI-000001')).not.toBeInTheDocument())
    expect(screen.getByText('MI-000002')).toBeInTheDocument()
  })

  it('los tabs de estado son un filtro, no una decoracion', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('MI-000001')

    await user.click(screen.getByRole('tab', { name: 'Pagado' }))

    await waitFor(() => expect(screen.queryByText('MI-000001')).not.toBeInTheDocument())
    expect(screen.getByText('MI-000002')).toBeInTheDocument()
  })

  it('el filtro de fecha deja fuera lo que cae fuera del rango', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('MI-000002')

    await user.click(screen.getByRole('combobox', { name: /Fecha/i }))
    await user.click(await screen.findByRole('option', { name: 'Últimos 7 días' }))

    await waitFor(() => expect(screen.queryByText('MI-000002')).not.toBeInTheDocument())
    expect(screen.getByText('MI-000001')).toBeInTheDocument()
  })
})

describe('OrdersPage — detalle en panel lateral', () => {
  it('abre el pedido con sus lineas, la entrega y el historial', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('MI-000001'))
    const drawer = await screen.findByRole('dialog', { name: 'MI-000001' })

    expect(within(drawer).getByText('Silla nórdica')).toBeInTheDocument()
    expect(within(drawer).getByText('SILLA-1')).toBeInTheDocument()
    expect(within(drawer).getByText('Av. Primavera 120')).toBeInTheDocument()
    expect(within(drawer).getByText('Portón verde')).toBeInTheDocument()

    // Historial: alta del pedido (sin autor) + cambio firmado por su autor.
    expect(within(drawer).getByText('Pedido recibido')).toBeInTheDocument()
    expect(within(drawer).getByText('Desde la vitrina')).toBeInTheDocument()
    expect(within(drawer).getByText('Pendiente → Pagado')).toBeInTheDocument()
    expect(within(drawer).getByText('Depósito verificado')).toBeInTheDocument()
  })

  it('solo ofrece las transiciones que la base permite desde el estado actual', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('MI-000001'))
    const drawer = await screen.findByRole('dialog', { name: 'MI-000001' })
    await user.click(within(drawer).getByRole('combobox', { name: /Nuevo estado/i }))

    const options = (await screen.findAllByRole('option')).map((node) => node.textContent)
    expect(options).toEqual(['Pagado', 'Cancelado'])
  })
})

describe('OrdersPage — cambio de estado', () => {
  it('pasa SIEMPRE por la Edge Function `update-order-status`', async () => {
    const user = userEvent.setup()
    const client = holder.client as FakeSupabase
    renderPage()

    await user.click(await screen.findByText('MI-000001'))
    const drawer = await screen.findByRole('dialog', { name: 'MI-000001' })
    await user.click(within(drawer).getByRole('combobox', { name: /Nuevo estado/i }))
    await user.click(await screen.findByRole('option', { name: 'Pagado' }))
    await user.type(within(drawer).getByLabelText(/Nota del cambio/i), 'Depósito verificado')
    await user.click(within(drawer).getByRole('button', { name: 'Actualizar estado' }))

    await waitFor(() => expect(client.state.invocations).toHaveLength(1))
    const call = client.state.invocations[0]
    expect(call?.name).toBe('update-order-status')
    expect(call?.body).toEqual({
      order_id: ORDER_1,
      status: 'paid',
      notes: 'Depósito verificado',
    })
  })

  it('el cuerpo no lleva tenant ni importes: los pone el servidor', async () => {
    const user = userEvent.setup()
    const client = holder.client as FakeSupabase
    renderPage()

    await user.click(await screen.findByText('MI-000001'))
    const drawer = await screen.findByRole('dialog', { name: 'MI-000001' })
    await user.click(within(drawer).getByRole('combobox', { name: /Nuevo estado/i }))
    await user.click(await screen.findByRole('option', { name: 'Cancelado' }))
    await user.click(within(drawer).getByRole('button', { name: 'Actualizar estado' }))

    await waitFor(() => expect(client.state.invocations).toHaveLength(1))
    const body = client.state.invocations[0]?.body ?? {}
    for (const field of TENANT_FIELDS) expect(body).not.toHaveProperty(field)
    for (const field of ['store_id', 'grand_total', 'subtotal', 'currency']) {
      expect(body).not.toHaveProperty(field)
    }
  })

  it('un rol sin permiso ve el pedido pero no puede moverlo', async () => {
    holder.client = backend('viewer')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('MI-000001'))
    const drawer = await screen.findByRole('dialog', { name: 'MI-000001' })

    expect(within(drawer).getByText(/no cambiar su estado/i)).toBeInTheDocument()
    expect(within(drawer).queryByRole('combobox', { name: /Nuevo estado/i })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Actualizar estado' })).toBeDisabled()
  })
})
