import { describe, expect, it } from 'vitest'
import { COMPANY_A, COMPANY_B, ORG, STORE_A, USER } from '@/test/supabaseMock'
import type { Membership, StoreSummary, TenantContext, TenantSummary, Workspace } from './types'
import { resolveTenantSelection } from './workspace'

const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const STORE_B = '66666666-6666-4666-8666-666666666666'

const claims = (overrides: Partial<TenantContext> = {}): TenantContext => ({
  organization_id: ORG,
  active_company: COMPANY_A,
  companies: [COMPANY_A],
  apps: ['ecommerce'],
  ...overrides,
})

const tenant: TenantSummary = {
  organization_id: ORG,
  slug: 'negocio',
  name: 'Negocio S.A.C.',
  status: 'active',
}

const membership = (overrides: Partial<Membership> = {}): Membership => ({
  organization_id: ORG,
  company_id: COMPANY_A,
  user_id: USER,
  role: 'owner',
  status: 'active',
  ...overrides,
})

const store = (overrides: Partial<StoreSummary> = {}): StoreSummary => ({
  id: STORE_A,
  organization_id: ORG,
  company_id: COMPANY_A,
  slug: 'mi-tienda',
  name: 'Mi tienda',
  status: 'active',
  currency: 'PEN',
  ...overrides,
})

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  tenant,
  memberships: [membership()],
  stores: [store()],
  ...overrides,
})

function resolve(input: Partial<Parameters<typeof resolveTenantSelection>[0]> = {}) {
  return resolveTenantSelection({
    claims: claims(),
    workspace: workspace(),
    isLoading: false,
    isError: false,
    ...input,
  })
}

describe('resolveTenantSelection', () => {
  it('sin claims del hub no hay tenant: es un token que no sirve, no un usuario nuevo', () => {
    const state = resolve({ claims: null })
    expect(state.status).toBe('unauthorized')
    expect(state.activeCompanyId).toBeNull()
    expect(state.tenant).toBeNull()
  })

  it('con claims pero sin tenant, manda a onboarding', () => {
    const state = resolve({ workspace: { tenant: null, memberships: [], stores: [] } })
    expect(state.status).toBe('onboarding')
  })

  it('con tenant pero sin membresía activa, manda a onboarding (no a un panel vacío)', () => {
    const state = resolve({ workspace: workspace({ memberships: [] }) })
    expect(state.status).toBe('onboarding')
  })

  it('selecciona sociedad y tienda solas cuando solo hay una', () => {
    const state = resolve()
    expect(state.status).toBe('ready')
    expect(state.activeCompanyId).toBe(COMPANY_A)
    expect(state.activeStore?.id).toBe(STORE_A)
    expect(state.role).toBe('owner')
  })

  it('usa la sociedad activa del JWT cuando el usuario tiene varias', () => {
    const state = resolve({
      claims: claims({ active_company: COMPANY_B, companies: [COMPANY_A, COMPANY_B] }),
      workspace: workspace({
        memberships: [membership(), membership({ company_id: COMPANY_B, role: 'orders' })],
        stores: [store(), store({ id: STORE_B, company_id: COMPANY_B, name: 'Tienda B' })],
      }),
    })
    expect(state.activeCompanyId).toBe(COMPANY_B)
    expect(state.role).toBe('orders')
    expect(state.activeStore?.id).toBe(STORE_B)
  })

  it('ignora una membresía viva para una sociedad que el token ya no otorga', () => {
    const state = resolve({
      claims: claims({ companies: [COMPANY_A] }),
      workspace: workspace({
        memberships: [membership(), membership({ company_id: COMPANY_B })],
      }),
    })
    expect(state.companies).toEqual([COMPANY_A])
  })

  it('descarta membresías revocadas', () => {
    const state = resolve({
      workspace: workspace({ memberships: [membership({ status: 'revoked' })] }),
    })
    expect(state.status).toBe('onboarding')
  })

  it('no acepta un tenant cuya organización no es la del token', () => {
    const state = resolve({
      workspace: workspace({ tenant: { ...tenant, organization_id: OTHER_ORG } }),
    })
    expect(state.status).toBe('onboarding')
    expect(state.tenant).toBeNull()
  })

  it('no acepta una membresía de otra organización aunque venga en la respuesta', () => {
    const state = resolve({
      workspace: workspace({ memberships: [membership({ organization_id: OTHER_ORG })] }),
    })
    expect(state.status).toBe('onboarding')
  })

  it('solo lista las tiendas de la sociedad activa', () => {
    const state = resolve({
      claims: claims({ companies: [COMPANY_A, COMPANY_B] }),
      workspace: workspace({
        memberships: [membership(), membership({ company_id: COMPANY_B })],
        stores: [store(), store({ id: STORE_B, company_id: COMPANY_B, name: 'Tienda B' })],
      }),
    })
    expect(state.stores.map((s) => s.id)).toEqual([STORE_A])
  })

  it('el selector de tienda solo admite tiendas propias: un id ajeno cae a la primera válida', () => {
    const state = resolve({ storeOverride: STORE_B })
    expect(state.activeStore?.id).toBe(STORE_A)
  })

  it('el selector de sociedad solo admite sociedades con membresía', () => {
    const state = resolve({ companyOverride: COMPANY_B })
    expect(state.activeCompanyId).toBe(COMPANY_A)
  })

  it('mientras carga no decide nada', () => {
    expect(resolve({ isLoading: true, workspace: undefined }).status).toBe('loading')
  })

  it('un fallo de la consulta es error, no ausencia de tenant', () => {
    expect(resolve({ isError: true }).status).toBe('error')
  })

  it('un tenant sin tiendas queda listo pero sin tienda activa', () => {
    const state = resolve({ workspace: workspace({ stores: [] }) })
    expect(state.status).toBe('ready')
    expect(state.activeStore).toBeNull()
  })
})
