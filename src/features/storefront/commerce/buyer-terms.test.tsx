import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { createFakeSupabase, makeSession } from '@/test/supabaseMock'

/**
 * Crédito y aprobación dichos ANTES de pagar.
 *
 * Lo que se prueba es que el aviso dice lo que el servidor sabe —el crédito de
 * la cuenta de ESTA tienda, la decisión de `purchase_approval`— y que se calla
 * cuando no aplica. Que el servidor bloquee de verdad se prueba contra Postgres.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => holder.client,
  getSupabaseClient: () => holder.client,
  tryGetStorefrontClient: () => holder.client,
  tryGetStorefrontRpcClient: () => holder.client,
  getStorefrontClient: () => holder.client,
}))

const { BuyerTermsNotice } = await import('./BuyerTermsNotice')

const CUENTA = 'aaaa2222-2222-4222-8222-222222222222'

function contexto(overrides: Record<string, unknown> = {}) {
  return {
    account_name: 'Policlínico Andino SAC',
    account_code: 'POLI-01',
    customer_name: 'Policlínico Andino',
    requires_approval: false,
    purchase_order_required: false,
    has_spending_limit: false,
    has_credit_terms: true,
    locations_count: 1,
    has_commercial_pricing: true,
    accounts_in_store: 1,
    ...overrides,
  }
}

function estado(creditoDisponible: string | null) {
  return [
    // Otra cuenta del mismo usuario, de otra tienda: no es la de aquí.
    { account_id: 'x', account_name: 'Otra SAC', account_code: 'OTRA', credit_limit: '999999.00', payment_terms_days: 60, balance_due: '0', credit_available: '999999.00', overdue_amount: '0', documents: [], purchased_12m: '0', paid_12m: '0', currency: 'PEN' },
    { account_id: CUENTA, account_name: 'Policlínico Andino SAC', account_code: 'POLI-01', credit_limit: '20000.00', payment_terms_days: 30, balance_due: '7600.00', credit_available: creditoDisponible, overdue_amount: '0', documents: [], purchased_12m: '0', paid_12m: '0', currency: 'PEN' },
  ]
}

function render(rpc: Record<string, (args: Record<string, unknown>) => unknown>, total = '2594.98') {
  const client = createFakeSupabase({ session: makeSession(), rpc })
  holder.client = client
  renderWithProviders(<BuyerTermsNotice storeSlug="casa-nordica" total={total} currency="PEN" />, {
    session: makeSession(),
  })
  return client
}

beforeEach(() => {
  holder.client = null
})

describe('crédito de la cuenta', () => {
  it('dice cuánto queda de la línea DESPUÉS de este pedido, con la cuenta de esta tienda', async () => {
    render({ my_commerce_context: () => contexto(), my_account_statement: () => estado('12400.00') })

    expect(await screen.findByText('Crédito empresa · 30 días')).toBeInTheDocument()
    expect(screen.getByText(/Disponible S\/ 12,400\.00 · quedará S\/ 9,805\.02 con este pedido/)).toBeInTheDocument()
  })

  it('si no alcanza, lo dice antes de pagar en vez de fallar al confirmar', async () => {
    render({ my_commerce_context: () => contexto(), my_account_statement: () => estado('1000.00') })
    expect(await screen.findByText(/no alcanza para este pedido/)).toBeInTheDocument()
    expect(document.querySelector('[data-buyer-credit="short"]')).not.toBeNull()
  })

  it('una cuenta sin límite no enseña barra: compra sin tope', async () => {
    const client = render({ my_commerce_context: () => contexto(), my_account_statement: () => estado(null) })
    await waitFor(() => expect(client.state.rpcCalls.some((c) => c.name === 'my_account_statement')).toBe(true))
    expect(screen.queryByText(/Crédito empresa/)).not.toBeInTheDocument()
  })
})

describe('aprobación', () => {
  it('avisa que el pedido pasará por aprobación, preguntando con la cuenta efectiva', async () => {
    const client = render({
      my_commerce_context: () => contexto({ has_credit_terms: false, requires_approval: true }),
      my_store_business_accounts: () => [
        { account_id: CUENTA, code: 'POLI-01', name: 'Policlínico Andino SAC', customer_name: null, is_effective: true },
      ],
      purchase_approval: () => ({ required: true, reason: 'account_threshold', rule_min_amount: null, user_limit: null, approver_role: 'approver' }),
    })

    expect(await screen.findByText('Este pedido pasará por aprobación')).toBeInTheDocument()
    const llamada = client.state.rpcCalls.find((c) => c.name === 'purchase_approval')
    // Redondeado a la unidad: sumar céntimos no dispara otra consulta.
    expect(llamada?.args).toMatchObject({ p_business_account_id: CUENTA, p_amount: '2595' })
  })

  it('sin control de aprobación ni crédito, el aviso no existe', async () => {
    const client = render({
      my_commerce_context: () => contexto({ has_credit_terms: false }),
    })
    await waitFor(() => expect(client.state.rpcCalls.some((c) => c.name === 'my_commerce_context')).toBe(true))
    expect(document.querySelector('[data-buyer-terms]')).toBeNull()
    expect(client.state.rpcCalls.some((c) => c.name === 'purchase_approval')).toBe(false)
    expect(client.state.rpcCalls.some((c) => c.name === 'my_account_statement')).toBe(false)
  })
})
