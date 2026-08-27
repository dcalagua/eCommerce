// @vitest-environment node
/**
 * Autorización del alta de tenant.
 *
 * `bootstrap-tenant` es la única función con dos credenciales válidas, así que
 * es también la única donde un despiste deja una puerta abierta: que el camino
 * del usuario acepte un `organization_id` del cuerpo, o que el camino del
 * operador se pueda usar sin clave. Las dos cosas se prueban aquí.
 */
import { describe, expect, it } from 'vitest'
import type { HubClaims } from '../functions/_shared/auth.ts'
import {
  PROVISIONING_HEADER,
  SELF_SERVICE_FIELDS,
  bootstrapMode,
  buildProvisioningPayload,
  buildSelfServicePayload,
} from '../functions/_shared/bootstrap.ts'
import { AppError } from '../functions/_shared/errors.ts'
import { optionalCurrency } from '../functions/_shared/validation.ts'

const ORG = '0a000000-0000-4000-8000-000000000001'
const COMPANY = '0a000000-0000-4000-8000-0000000000c1'
const OTHER_COMPANY = '0a000000-0000-4000-8000-0000000000c9'
const USER = '0a000000-0000-4000-8000-0000000000a1'

const claims = (overrides: Partial<HubClaims> = {}): HubClaims => ({
  sub: USER,
  email: 'duenio@negocio.com',
  org_id: ORG,
  companies: [{ id: COMPANY, role: 'admin' }],
  active_company: COMPANY,
  apps: ['ecommerce'],
  ...overrides,
})

function request(headers: Record<string, string>): Request {
  return new Request('https://edge.local/bootstrap-tenant', { method: 'POST', headers })
}

function catchError(run: () => unknown): AppError {
  try {
    run()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Se esperaba un AppError y la operación tuvo éxito')
}

describe('bootstrapMode', () => {
  it('la clave de aprovisionamiento manda sobre la sesión', () => {
    const mode = bootstrapMode(
      request({ [PROVISIONING_HEADER]: 'x'.repeat(32), authorization: 'Bearer abc' }),
    )
    expect(mode).toBe('provisioning')
  })

  it('con solo Authorization es alta de sí mismo', () => {
    expect(bootstrapMode(request({ authorization: 'Bearer abc' }))).toBe('self-service')
  })

  it('sin ninguna credencial es 401, nunca un alta anónima', () => {
    const error = catchError(() => bootstrapMode(request({})))
    expect(error.status).toBe(401)
  })
})

describe('alta de sí mismo', () => {
  const body = { tenant_name: 'Bodega Central', store_slug: 'bodega-central', currency: 'PEN' }

  it('deriva el tenant del token y NO del cuerpo', () => {
    const payload = buildSelfServicePayload({ ...body }, claims())
    expect(payload.p_organization_id).toBe(ORG)
    expect(payload.p_company_id).toBe(COMPANY)
    expect(payload.p_owner_user_id).toBe(USER)
    expect(payload.p_admin_email).toBe('duenio@negocio.com')
  })

  it('rechaza (no ignora) un organization_id declarado en el cuerpo', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body, organization_id: ORG }, claims()),
    )
    expect(error.code).toBe('TENANT_NO_ADMITIDO')
    expect(error.status).toBe(400)
  })

  it('rechaza también las variantes de nombre del tenant', () => {
    for (const field of ['company_id', 'tenant_id', 'org_id', 'active_company']) {
      const error = catchError(() => buildSelfServicePayload({ ...body, [field]: ORG }, claims()))
      expect(error.code).toBe('TENANT_NO_ADMITIDO')
    }
  })

  it('rechaza el usuario propietario declarado desde fuera', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body, owner_user_id: USER }, claims()),
    )
    expect(error.code).toBe('CAMPO_NO_PERMITIDO')
  })

  it('rechaza el correo del administrador declarado desde fuera (§3.2)', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body, admin_email: 'otro@negocio.com' }, claims()),
    )
    expect(error.code).toBe('CAMPO_NO_PERMITIDO')
  })

  it('una cuenta @ebim.pe no puede crearse un tenant (contrato §13)', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body }, claims({ email: 'dcalagua@ebim.pe' })),
    )
    expect(error.status).toBe(403)
  })

  it('sin correo en el token no hay alta', () => {
    const withoutEmail = claims()
    delete withoutEmail.email
    const error = catchError(() => buildSelfServicePayload({ ...body }, withoutEmail))
    expect(error.code).toBe('ADMIN_EMAIL_REQUERIDO')
  })

  it('sin sociedades asignadas no hay alta', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body }, claims({ companies: [], active_company: undefined })),
    )
    expect(error.status).toBe(403)
  })

  it('una sociedad activa que no está en companies[] no vale', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body }, claims({ active_company: OTHER_COMPANY })),
    )
    expect(error.status).toBe(403)
  })

  it('el espacio y su primera tienda comparten slug', () => {
    const payload = buildSelfServicePayload({ ...body }, claims())
    expect(payload.p_tenant_slug).toBe('bodega-central')
    expect(payload.p_store_slug).toBe('bodega-central')
  })

  it('sin nombre de tienda, la tienda toma el nombre del negocio', () => {
    const payload = buildSelfServicePayload({ ...body }, claims())
    expect(payload.p_store_name).toBe('Bodega Central')
  })

  it('un slug inválido se rechaza aquí, no en la base', () => {
    const error = catchError(() =>
      buildSelfServicePayload({ ...body, store_slug: 'Mi Tienda!' }, claims()),
    )
    expect(error.code).toBe('CAMPO_INVALIDO')
  })

  it('el cuerpo admitido es corto y cerrado', () => {
    expect([...SELF_SERVICE_FIELDS].sort()).toEqual([
      'currency',
      'store_name',
      'store_slug',
      'tenant_name',
    ])
  })
})

describe('alta desde el operador', () => {
  const body = {
    organization_id: ORG,
    company_id: COMPANY,
    tenant_slug: 'bodega',
    tenant_name: 'Bodega Central',
    admin_email: 'duenio@negocio.com',
    owner_user_id: USER,
    store_slug: 'bodega-central',
    store_name: 'Bodega Central',
  }

  it('acepta los uuid del cuerpo: es el alta, todavía no hay token del que derivarlos', () => {
    const payload = buildProvisioningPayload({ ...body })
    expect(payload.p_organization_id).toBe(ORG)
    expect(payload.p_company_id).toBe(COMPANY)
    expect(payload.p_currency).toBe('PEN')
  })

  it('exige el correo del administrador', () => {
    const withoutEmail = { ...body } as Record<string, unknown>
    delete withoutEmail.admin_email
    expect(catchError(() => buildProvisioningPayload(withoutEmail)).code).toBe('CAMPO_INVALIDO')
  })

  it('rechaza campos que no están en su lista', () => {
    expect(catchError(() => buildProvisioningPayload({ ...body, status: 'active' })).code).toBe(
      'CAMPO_NO_PERMITIDO',
    )
  })
})

describe('optionalCurrency', () => {
  it('ausente cae al default de la base', () => {
    expect(optionalCurrency({}, 'currency')).toBe('PEN')
  })

  it('normaliza a mayúsculas', () => {
    expect(optionalCurrency({ currency: 'usd' }, 'currency')).toBe('USD')
  })

  it('una moneda mal escrita falla en vez de degradarse a PEN en silencio', () => {
    expect(catchError(() => optionalCurrency({ currency: 'soles' }, 'currency')).code).toBe(
      'CAMPO_INVALIDO',
    )
  })
})
