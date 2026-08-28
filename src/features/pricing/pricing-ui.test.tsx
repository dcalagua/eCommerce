import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import {
  COMPANY_A,
  ORG,
  STORE_A,
  USER,
  createFakeSupabase,
  makePlatformContext,
  makeSession,
  type FakeSupabase,
} from '@/test/supabaseMock'

/**
 * El motor de precios en pantalla (P04-SaaS).
 *
 * Lo que se comprueba aquí no es el cálculo —eso vive en el servidor y se
 * prueba contra Postgres real— sino las tres cosas que solo se ven montando el
 * árbol: que la pantalla es una sola con pestañas y un buscador por listado
 * (§8), que el módulo está gateado por lo que la sociedad CONTRATÓ, y que el
 * diagnóstico distingue el empate ambiguo —que rompe el precio— de las cuatro
 * formas de que una lista simplemente no se aplique.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => holder.client,
  getSupabaseClient: () => holder.client,
  tryGetStorefrontClient: () => holder.client,
  getStorefrontClient: () => holder.client,
}))

const { TenantProvider } = await import('@/features/tenant/TenantProvider')
const { CapabilitiesProvider } = await import('@/features/capabilities/CapabilitiesProvider')
const { CapabilityGate } = await import('@/features/capabilities/CapabilityGate')
const { PricingPage } = await import('./PricingPage')

const LIST_ID = '77777777-7777-4777-8777-777777777701'
const OTHER_LIST_ID = '77777777-7777-4777-8777-777777777702'
const SEGMENT_ID = '77777777-7777-4777-8777-777777777703'
const EVENT_ID = '77777777-7777-4777-8777-777777777704'

const PRICING = ['ecommerce.pricing.lists']

function backend(options: { entitlements?: string[] } = {}): FakeSupabase {
  const { entitlements = PRICING } = options
  return createFakeSupabase({
    session: makeSession(),
    tables: {
      tenants: [{ organization_id: ORG, slug: 'mi-negocio', name: 'Mi Negocio', status: 'active' }],
      tenant_members: [
        { organization_id: ORG, company_id: COMPANY_A, user_id: USER, role: 'admin', status: 'active' },
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
      price_lists: [
        {
          id: LIST_ID,
          organization_id: ORG,
          company_id: COMPANY_A,
          store_id: STORE_A,
          code: 'mayorista',
          name: 'Mayorista',
          currency: 'PEN',
          priority: 100,
          valid_from: '2026-01-01T00:00:00.000Z',
          valid_to: null,
          is_active: true,
          notes: null,
        },
        {
          id: OTHER_LIST_ID,
          organization_id: ORG,
          company_id: COMPANY_A,
          store_id: STORE_A,
          code: 'temporada',
          name: 'Temporada',
          currency: 'PEN',
          priority: 100,
          valid_from: '2026-01-01T00:00:00.000Z',
          valid_to: '2026-02-01T00:00:00.000Z',
          is_active: true,
          notes: null,
        },
      ],
      price_list_items: [],
      price_list_assignments: [],
      customer_segments: [
        {
          id: SEGMENT_ID,
          organization_id: ORG,
          company_id: COMPANY_A,
          code: 'mayorista',
          name: 'Mayoristas',
          description: null,
          is_active: true,
        },
      ],
      price_change_events: [
        {
          id: EVENT_ID,
          organization_id: ORG,
          company_id: COMPANY_A,
          store_id: STORE_A,
          price_list_id: LIST_ID,
          product_id: null,
          action: 'update',
          old_unit_price: '10.00',
          new_unit_price: '8.00',
          actor_email: 'duenio@negocio.com',
          occurred_at: '2026-06-01T10:00:00.000Z',
        },
      ],
      channels: [],
      products: [],
      product_variants: [],
      product_uoms: [],
      units_of_measure: [],
    },
    rpc: {
      effective_capabilities: () => makePlatformContext({ entitlements, source: 'hub' }),
      price_list_conflicts: () => [
        {
          kind: 'ambiguous_priority',
          price_list_id: LIST_ID,
          price_list_code: 'mayorista',
          other_list_id: OTHER_LIST_ID,
          other_list_code: 'temporada',
          scope: 'store',
          detail: 'Misma prioridad (100) y vigencias solapadas en el mismo alcance',
        },
        {
          kind: 'currency_mismatch',
          price_list_id: OTHER_LIST_ID,
          price_list_code: 'temporada',
          other_list_id: null,
          other_list_code: null,
          scope: null,
          detail: 'La lista esta en USD y la tienda vende en PEN',
        },
      ],
    },
  })
}

function renderPricing(fake: FakeSupabase) {
  holder.client = fake
  return renderWithProviders(
    <TenantProvider>
      <CapabilitiesProvider>
        <CapabilityGate capability="pricing.lists">
          <PricingPage />
        </CapabilityGate>
      </CapabilitiesProvider>
    </TenantProvider>,
    { session: fake.state.session },
  )
}

beforeEach(() => {
  holder.client = null
  // Las pestañas hacen deep-link con `#hash`: sin limpiarlo, el test anterior
  // decide qué pestaña abre el siguiente.
  window.history.replaceState(null, '', '/')
})

describe('Precios — la pantalla', () => {
  it('es una sola pantalla con cuatro pestañas centradas, no cuatro entradas de menú', async () => {
    renderPricing(backend())
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Listas',
      'Segmentos',
      'Simulador',
      'Diagnóstico',
    ])
  })

  it('lista los acuerdos con su vigencia y con un único buscador general', async () => {
    renderPricing(backend())
    expect(await screen.findByText('Mayorista')).toBeInTheDocument()
    expect(screen.getByText('mayorista')).toBeInTheDocument()
    // La prioridad se enseña: es el único dial del operador. Las dos listas la
    // tienen a 100 —de ahí el empate que denuncia el diagnóstico—, así que se
    // esperan dos celdas y no una.
    expect(screen.getAllByText('100')).toHaveLength(2)
    expect(screen.getAllByRole('searchbox')).toHaveLength(1)
  })

  it('marca como caducada la lista cuya ventana terminó', async () => {
    renderPricing(backend())
    expect(await screen.findByText('Temporada')).toBeInTheDocument()
    expect(screen.getByText('Caducada')).toBeInTheDocument()
    expect(screen.getByText('Vigente')).toBeInTheDocument()
  })

  it('el buscador filtra por nombre sin volver a consultar', async () => {
    const user = userEvent.setup()
    renderPricing(backend())
    expect(await screen.findByText('Temporada')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox'), 'mayor')
    expect(screen.queryByText('Temporada')).not.toBeInTheDocument()
    expect(screen.getByText('Mayorista')).toBeInTheDocument()
  })

  it('los segmentos son vocabulario de la sociedad y tienen su pestaña', async () => {
    const user = userEvent.setup()
    renderPricing(backend())
    await screen.findByText('Mayorista')

    await user.click(screen.getByRole('tab', { name: 'Segmentos' }))
    expect(await screen.findByText('Mayoristas')).toBeInTheDocument()
  })

  it('el diagnóstico separa el empate que rompe el precio de lo que solo lo deja sin efecto', async () => {
    const user = userEvent.setup()
    renderPricing(backend())
    await screen.findByText('Mayorista')

    await user.click(screen.getByRole('tab', { name: 'Diagnóstico' }))

    expect(await screen.findByText('Empate ambiguo')).toBeInTheDocument()
    expect(screen.getByText('Moneda distinta')).toBeInTheDocument()
    // El ambiguo levanta un aviso propio arriba: es el único que hace que el
    // precio dependa de un desempate interno.
    expect(
      screen.getByText(/el precio lo decide un desempate interno/i),
    ).toBeInTheDocument()
  })

  it('la bitácora enseña quién cambió el precio y desde qué valor', async () => {
    const user = userEvent.setup()
    renderPricing(backend())
    await screen.findByText('Mayorista')

    await user.click(screen.getByRole('tab', { name: 'Diagnóstico' }))
    expect(await screen.findByText('10.00 → 8.00')).toBeInTheDocument()
    expect(screen.getByText('duenio@negocio.com')).toBeInTheDocument()
  })
})

describe('Precios — gating por lo contratado', () => {
  it('sin el addon, la pantalla no se monta y se explica por qué', async () => {
    renderPricing(backend({ entitlements: [] }))

    expect(await screen.findByText('Este módulo no está en tu plan')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Listas' })).not.toBeInTheDocument()
    // No es un error: nada falló.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('con el addon, las listas se abren sin más', async () => {
    renderPricing(backend())
    expect(await screen.findByRole('tab', { name: 'Listas' })).toBeInTheDocument()
  })
})
