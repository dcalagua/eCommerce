import type { Session } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { tenantFromSession } from './session'

const ORG = '11111111-1111-4111-8111-111111111111'
const COMPANY_A = '22222222-2222-4222-8222-222222222222'
const COMPANY_B = '33333333-3333-4333-8333-333333333333'

function sessionWith(appMetadata: Record<string, unknown>): Session {
  return {
    access_token: 'token',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'refresh',
    user: { id: 'user', app_metadata: appMetadata, user_metadata: {}, aud: 'authenticated' },
  } as unknown as Session
}

/**
 * Regla bloqueante del contrato: el tenant sale SIEMPRE del JWT.
 * Si los claims no vienen completos, no hay tenant — no se asume uno.
 */
describe('tenantFromSession', () => {
  it('deriva la jerarquía de los claims del token', () => {
    const tenant = tenantFromSession(
      sessionWith({
        org_id: ORG,
        active_company: COMPANY_A,
        companies: [COMPANY_A, COMPANY_B],
        apps: ['ecommerce'],
      }),
    )
    expect(tenant).toEqual({
      organization_id: ORG,
      active_company: COMPANY_A,
      companies: [COMPANY_A, COMPANY_B],
      apps: ['ecommerce'],
    })
  })

  it('sin sesión no hay tenant', () => {
    expect(tenantFromSession(null)).toBeNull()
  })

  it('rechaza claims incompletos en vez de inventar un tenant', () => {
    expect(tenantFromSession(sessionWith({ org_id: ORG }))).toBeNull()
  })

  it('rechaza un org_id que no es uuid del hub', () => {
    const tenant = tenantFromSession(
      sessionWith({ org_id: 'acme', active_company: COMPANY_A, companies: [COMPANY_A] }),
    )
    expect(tenant).toBeNull()
  })

  it('rechaza company_code usado como si fuera la clave de sociedad', () => {
    const tenant = tenantFromSession(
      sessionWith({ org_id: ORG, active_company: '1000', companies: ['1000'] }),
    )
    expect(tenant).toBeNull()
  })
})
