import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
 * Fuerza de ventas en pantalla.
 *
 * Lo que se comprueba montando el árbol es lo que no se ve en la base:
 *
 *  · que la página está **gateada por `sales.force`**, y sin la capacidad se lee
 *    qué falta en vez de una tabla vacía que parece un fallo;
 *  · que el desplegable de jefe **no ofrece lo que la base va a rechazar** —ni
 *    el propio vendedor ni su descendencia—, porque un desplegable que ofrece
 *    una opción que falla al guardar es un desplegable que miente;
 *  · que la baja **desactiva** y no borra: de un vendedor cuelgan sus
 *    liquidaciones, y `commission_statements` lo referencia con `restrict`.
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
const { SalesPage } = await import('./SalesPage')

const JEFE = '88888888-8888-4888-8888-888888888801'
const MEDIO = '88888888-8888-4888-8888-888888888802'
const ABAJO = '88888888-8888-4888-8888-888888888803'
const SUELTO = '88888888-8888-4888-8888-888888888804'

const FUERZA = ['ecommerce.sales.force']

function rep(id: string, code: string, name: string, manager: string | null, extras = {}) {
  return {
    id,
    organization_id: ORG,
    company_id: COMPANY_A,
    user_id: null,
    employee_code: code,
    full_name: name,
    email: null,
    phone: null,
    manager_id: manager,
    status: 'active',
    hired_at: null,
    notes: null,
    ...extras,
  }
}

function backend(options: { entitlements?: string[] } = {}): FakeSupabase {
  const { entitlements = FUERZA } = options
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
      sales_reps: [
        rep(JEFE, 'V-001', 'Marta Jefa', null),
        rep(MEDIO, 'V-002', 'Luis Medio', JEFE),
        rep(ABAJO, 'V-003', 'Pia Abajo', MEDIO),
        rep(SUELTO, 'V-004', 'Sin Jefe', null, { user_id: USER }),
      ],
      sales_rep_customers: [],
      customers: [],
    },
    rpc: {
      effective_capabilities: () => makePlatformContext({ entitlements, source: 'hub' }),
    },
  })
}

function pintar(fake: FakeSupabase) {
  holder.client = fake
  return renderWithProviders(
    <TenantProvider>
      <CapabilitiesProvider>
        <CapabilityGate capability="sales.force">
          <SalesPage />
        </CapabilityGate>
      </CapabilitiesProvider>
    </TenantProvider>,
    // La sesion va al render, no solo al falso: sin ella el `TenantProvider`
    // se queda resolviendo y la pagina nunca pasa del esqueleto.
    { session: fake.state.session },
  )
}

describe('la página de fuerza de ventas', () => {
  it('lista los vendedores con su jefe', async () => {
    pintar(backend())

    // Aparece DOS veces: como su propia fila y como jefa de Luis. El jefe se
    // resuelve a nombre y no a un uuid — la tabla se lee, no se descifra.
    expect(await screen.findAllByText('Marta Jefa')).toHaveLength(2)
    expect(screen.getAllByText('Luis Medio')).toHaveLength(2)
  })

  it('distingue quién ENTRA a la aplicación de quién solo existe en el maestro', async () => {
    pintar(backend())
    await screen.findAllByText('Marta Jefa')

    // Muchos preventistas nunca entran: dar de alta a uno no es crear un usuario.
    expect(screen.getAllByText('Solo maestro').length).toBe(3)
    expect(screen.getAllByText('Entra').length).toBe(1)
  })

  it('sin el módulo contratado dice qué falta, no enseña una tabla vacía', async () => {
    pintar(backend({ entitlements: [] }))

    // El gate pinta su propio aviso; lo que importa es que la tabla NO esté.
    // Una tabla vacía se lee como un fallo del sistema; esto se lee como lo que
    // es: algo que no está en el plan.
    await screen.findByRole('heading', { level: 2 })
    expect(screen.queryByText('Marta Jefa')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('el desplegable de jefe', () => {
  it('no ofrece al propio vendedor ni a quien le reporta', async () => {
    const user = userEvent.setup()
    pintar(backend())
    await screen.findAllByText('Marta Jefa')

    await user.click(screen.getByRole('button', { name: /Editar: Marta Jefa/ }))
    await screen.findByRole('heading', { name: 'Marta Jefa' })

    await user.click(screen.getByRole('combobox', { name: 'Jefe' }))

    // Marta es la raíz: Luis y Pía cuelgan de ella, así que ofrecer cualquiera
    // de los tres cerraría un círculo y la base respondería VENDEDOR_CICLO.
    const opciones = screen.getAllByRole('option').map((o) => o.textContent)
    expect(opciones).toEqual(['Sin jefe', 'V-004 · Sin Jefe'])
  })

  it('a un vendedor sin descendencia sí le ofrece a los demás', async () => {
    const user = userEvent.setup()
    pintar(backend())
    await screen.findByText('Sin Jefe')

    await user.click(screen.getByRole('button', { name: /Editar: Pia Abajo/ }))
    await screen.findByRole('heading', { name: 'Pia Abajo' })
    await user.click(screen.getByRole('combobox', { name: 'Jefe' }))

    const opciones = screen.getAllByRole('option').map((o) => o.textContent)
    expect(opciones).toContain('V-001 · Marta Jefa')
    expect(opciones).toContain('V-002 · Luis Medio')
    // Pero nunca a sí misma.
    expect(opciones).not.toContain('V-003 · Pia Abajo')
  })
})

describe('la baja', () => {
  it('DESACTIVA, no borra: de un vendedor cuelgan sus liquidaciones', async () => {
    const user = userEvent.setup()
    const fake = backend()
    pintar(fake)
    await screen.findAllByText('Marta Jefa')

    await user.click(screen.getByRole('button', { name: /Dar de baja: Sin Jefe/ }))

    const filas = (fake.state.tables.sales_reps ?? []) as Array<{ id: string; status: string }>
    // La fila sigue ahí. `commission_statements` la referencia con `restrict`
    // justo para que un borrado no se lleve por delante un pago ya hecho.
    expect(filas).toHaveLength(4)
    expect(filas.find((f) => f.id === SUELTO)?.status).toBe('disabled')
  })
})
