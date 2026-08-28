// @vitest-environment node
/**
 * Capa compartida de las Edge Functions.
 *
 * Lo que se prueba aquí es la frontera: que el tenant no se pueda declarar
 * desde el cliente, que un precio en el carrito se rechace, y que la máquina de
 * estados de TypeScript no se desincronice de la que tiene la base.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  assertNoTenantInPayload,
  assertNotSuiteOperator,
  bearerToken,
  decodeClaims,
  requireProvisioningKey,
  tenantContext,
  timingSafeEqual,
} from '../functions/_shared/auth.ts'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../functions/_shared/cors.ts'
import { AppError, fromDatabaseError, toAppError } from '../functions/_shared/errors.ts'
import {
  ORDER_TRANSITIONS,
  canTransition,
  normalizeOrderItems,
  normalizeShippingAddress,
} from '../functions/_shared/orders.ts'
import { ROLE_PERMISSIONS, can } from '../functions/_shared/roles.ts'
import { rejectUnknownFields, requireUuid } from '../functions/_shared/validation.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ORG = '11111111-1111-4111-8111-111111111111'
const COMPANY = '22222222-2222-4222-8222-222222222222'
const OTHER_COMPANY = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'

function makeToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.firma-no-verificada-aqui`
}

/** `toThrowError` compara el MENSAJE; lo que estabiliza el contrato de la API
 *  es el `code`, asi que se comprueba ese. */
function expectCode(run: () => unknown, code: string, status?: number): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
    if (status !== undefined) expect((error as AppError).status).toBe(status)
    return
  }
  throw new Error(`Se esperaba AppError ${code} y no se lanzo nada`)
}

const validClaims = {
  sub: USER,
  email: 'ana@cliente.com',
  org_id: ORG,
  companies: [{ id: COMPANY, role: 'admin' }],
  active_company: COMPANY,
  apps: ['ecommerce'],
}

describe('el tenant sale del token, no del cuerpo', () => {
  it.each([
    'organization_id',
    'company_id',
    'tenant_id',
    'org_id',
    'active_company',
    'companyId',
  ])('rechaza `%s` en el payload con 400', (field) => {
    expectCode(() => assertNoTenantInPayload({ [field]: ORG }), 'TENANT_NO_ADMITIDO', 400)
  })

  it('rechaza, no ignora en silencio: el mensaje nombra el campo', () => {
    try {
      assertNoTenantInPayload({ organization_id: ORG, company_id: COMPANY })
      throw new Error('deberia haber fallado')
    } catch (error) {
      expect((error as AppError).status).toBe(400)
      expect((error as AppError).message).toContain('organization_id')
      expect((error as AppError).message).toContain('company_id')
    }
  })

  it('un payload limpio pasa', () => {
    expect(() => assertNoTenantInPayload({ store_id: COMPANY, name: 'Silla' })).not.toThrow()
  })

  it('deriva el contexto del claim `active_company`', () => {
    const context = tenantContext(decodeClaims(makeToken(validClaims)))
    expect(context).toEqual({
      userId: USER,
      email: 'ana@cliente.com',
      organizationId: ORG,
      companyId: COMPANY,
      companies: [COMPANY],
    })
  })

  it('una sociedad activa que no esta en companies[] es 403', () => {
    const token = makeToken({ ...validClaims, active_company: OTHER_COMPANY })
    expect(() => tenantContext(decodeClaims(token))).toThrowError(/sociedad activa/i)
  })

  it('un token sin org_id es 403', () => {
    const token = makeToken({ sub: USER, companies: [] })
    expect(() => tenantContext(decodeClaims(token))).toThrowError()
  })

  it('un token expirado es 401', () => {
    const token = makeToken({ ...validClaims, exp: 1000 })
    expect(() => decodeClaims(token)).toThrowError(/expirado/i)
  })

  it('un token que no es un JWT es 401', () => {
    expect(() => decodeClaims('no-es-un-token')).toThrowError(/no es un JWT/i)
  })

  it('exige la cabecera Authorization', () => {
    const request = new Request('https://x.test', { method: 'POST' })
    expect(() => bearerToken(request)).toThrowError(/Authorization/i)
  })
})

describe('gobernanza (contrato §13)', () => {
  it('una cuenta @ebim.pe no opera datos de negocio de un tenant', () => {
    expect(() => assertNotSuiteOperator('dcalagua@ebim.pe')).toThrowError(/@ebim\.pe/)
    expect(() => assertNotSuiteOperator('OPERADOR@EBIM.PE')).toThrowError()
  })

  it('un usuario de cliente si opera', () => {
    expect(() => assertNotSuiteOperator('ana@cliente.com')).not.toThrow()
  })
})

describe('clave de aprovisionamiento (contrato §2.6)', () => {
  const key = 'k'.repeat(48)

  it('acepta la clave correcta en cabecera', () => {
    const request = new Request('https://x.test', {
      method: 'POST',
      headers: { 'x-ebim-provisioning-key': key },
    })
    expect(() => requireProvisioningKey(request, key)).not.toThrow()
  })

  it('rechaza una clave incorrecta', () => {
    const request = new Request('https://x.test', {
      method: 'POST',
      headers: { 'x-ebim-provisioning-key': 'x'.repeat(48) },
    })
    expect(() => requireProvisioningKey(request, key)).toThrowError(/invalida/i)
  })

  it('falla ruidosamente si la funcion no tiene clave configurada', () => {
    const request = new Request('https://x.test', { method: 'POST' })
    expectCode(() => requireProvisioningKey(request, undefined), 'PROVISIONING_NO_CONFIGURADO', 500)
  })

  it('la comparacion no filtra el prefijo correcto', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('carrito: el precio lo decide el servidor', () => {
  it.each(['price', 'unit_price', 'line_total', 'currency', 'store_id'])(
    'rechaza `%s` dentro de una linea',
    (field) => {
      expectCode(
        () => normalizeOrderItems([{ product_id: ORG, quantity: 1, [field]: '0.01' }]),
        'CAMPO_NO_PERMITIDO',
        400,
      )
    },
  )

  it('agrupa lineas repetidas del mismo producto', () => {
    expect(
      normalizeOrderItems([
        { product_id: ORG, quantity: 2 },
        { product_id: ORG, quantity: 3 },
        { product_id: COMPANY, quantity: 1 },
      ]),
    ).toEqual([
      { product_id: ORG, quantity: 5 },
      { product_id: COMPANY, quantity: 1 },
    ])
  })

  it.each([0, -1, 1.5, '2', null])('rechaza la cantidad %p', (quantity) => {
    expect(() => normalizeOrderItems([{ product_id: ORG, quantity }])).toThrowError()
  })

  it('rechaza un carrito vacio y uno desmesurado', () => {
    expectCode(() => normalizeOrderItems([]), 'ITEMS_REQUERIDOS')
    const huge = Array.from({ length: 101 }, () => ({ product_id: ORG, quantity: 1 }))
    expectCode(() => normalizeOrderItems(huge), 'ITEMS_EXCESIVOS')
  })
})

describe('maquina de estados del pedido', () => {
  it('coincide exactamente con el trigger de la base', () => {
    const sql = readFileSync(
      join(HERE, '..', 'migrations', '20260827090400_orders.sql'),
      'utf8',
    )

    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      if (targets.length === 0) continue
      const clause = new RegExp(
        `when '${from}'\\s+then array\\[([^\\]]+)\\]`,
        'i',
      ).exec(sql)
      expect(clause, `falta la rama '${from}' en el trigger`).toBeTruthy()
      const inSql = (clause?.[1] ?? '')
        .split(',')
        .map((item) => item.trim().replace(/'/g, ''))
        .sort()
      expect(inSql).toEqual([...targets].sort())
    }
  })

  it('cancelado y reembolsado son estados finales', () => {
    expect(canTransition('cancelled', 'paid')).toBe(false)
    expect(canTransition('refunded', 'fulfilled')).toBe(false)
  })

  it('un cambio a si mismo es idempotente, no un error', () => {
    expect(canTransition('paid', 'paid')).toBe(true)
  })
})

describe('matriz de roles', () => {
  it('coincide con los roles que exigen las policies del catalogo', () => {
    const sql = readFileSync(
      join(HERE, '..', 'migrations', '20260827090300_catalog.sql'),
      'utf8',
    )
    const rolesEnPolicy = [
      ...new Set(
        [...sql.matchAll(/array\[([^\]]+)\]::public\.app_role\[\]/g)].map((match) =>
          (match[1] ?? '').replace(/['\s]/g, ''),
        ),
      ),
    ]
    expect(rolesEnPolicy).toEqual(['owner,admin,catalog'])
    expect(ROLE_PERMISSIONS['catalog.write']).toEqual(['owner', 'admin', 'catalog'])
  })

  it('viewer no escribe nada', () => {
    for (const permission of Object.keys(ROLE_PERMISSIONS) as Array<
      keyof typeof ROLE_PERMISSIONS
    >) {
      expect(can('viewer', permission)).toBe(false)
    }
  })

  it('owner puede todo', () => {
    for (const permission of Object.keys(ROLE_PERMISSIONS) as Array<
      keyof typeof ROLE_PERMISSIONS
    >) {
      expect(can('owner', permission)).toBe(true)
    }
  })
})

describe('CORS', () => {
  it('el storefront publico permite cualquier origen', () => {
    expect(resolveAllowedOrigin('https://tienda.cliente.com', [])).toBe('*')
  })

  it('el backoffice solo permite origenes de la lista blanca', () => {
    const allowed = ['https://ecommerce.ebim.pe']
    expect(resolveAllowedOrigin('https://ecommerce.ebim.pe', allowed)).toBe(
      'https://ecommerce.ebim.pe',
    )
    expect(resolveAllowedOrigin('https://atacante.com', allowed)).toBeNull()
  })

  it('sin origen permitido no se emite Allow-Origin', () => {
    const headers = corsHeaders('https://atacante.com', {
      allowedOrigins: ['https://ecommerce.ebim.pe'],
    })
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(headers.Vary).toBe('Origin')
  })

  it('parsea la lista blanca del entorno', () => {
    expect(parseAllowedOrigins(' https://a.com , https://b.com ')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
    expect(parseAllowedOrigins(undefined)).toEqual([])
  })
})

describe('errores', () => {
  it('traduce los codigos de negocio de la base a HTTP', () => {
    expect(fromDatabaseError({ message: 'ADMIN_EMAIL_REQUERIDO: falta el correo' }).status).toBe(400)
    expect(fromDatabaseError({ message: 'TENANT_YA_EXISTE: ya existe' }).status).toBe(409)
    expect(fromDatabaseError({ message: 'STOCK_INSUFICIENTE: sin stock' }).status).toBe(409)
    expect(fromDatabaseError({ message: 'TIENDA_NO_DISPONIBLE: nope' }).status).toBe(404)
  })

  it('una violacion de RLS es 403, no un 500 con detalle interno', () => {
    const error = fromDatabaseError({
      code: '42501',
      message: 'new row violates row-level security policy for table "products"',
    })
    expect(error.status).toBe(403)
    expect(error.message).not.toContain('row-level security')
  })

  it('un error desconocido no filtra el interno de Postgres', () => {
    const error = fromDatabaseError({
      code: 'XX000',
      message: 'relation "secreto_interno" does not exist at character 42',
    })
    expect(error.status).toBe(500)
    expect(error.message).toBe('Error interno')
  })

  it('toAppError respeta un AppError ya construido', () => {
    const original = new AppError('MIO', 'mensaje', 409)
    expect(toAppError(original)).toBe(original)
  })
})

describe('validacion de payload', () => {
  it('exige uuid donde toca', () => {
    expect(requireUuid({ store_id: ORG }, 'store_id')).toBe(ORG)
    expect(() => requireUuid({ store_id: 'abc' }, 'store_id')).toThrowError(/uuid/)
  })

  it('rechaza campos desconocidos en vez de descartarlos', () => {
    expectCode(() => rejectUnknownFields({ a: 1, sorpresa: 2 }, ['a']), 'CAMPO_NO_PERMITIDO')
    expect(() => rejectUnknownFields({ a: 1, sorpresa: 2 }, ['a'])).toThrowError(/sorpresa/)
  })
})

describe('direccion de entrega del checkout (P06)', () => {
  it('acepta la direccion sola y la referencia opcional', () => {
    expect(normalizeShippingAddress({ address: '  Av. Primavera 120  ' })).toEqual({
      address: 'Av. Primavera 120',
    })
    expect(
      normalizeShippingAddress({ address: 'Jr. Lima 45', reference: ' Frente al parque ' }),
    ).toEqual({ address: 'Jr. Lima 45', reference: 'Frente al parque' })
  })

  it('una referencia vacia no ensucia el pedido con una clave hueca', () => {
    expect(normalizeShippingAddress({ address: 'Jr. Lima 45', reference: '   ' })).toEqual({
      address: 'Jr. Lima 45',
    })
  })

  it('sin direccion no hay entrega', () => {
    expectCode(() => normalizeShippingAddress({}), 'CAMPO_INVALIDO')
    expectCode(() => normalizeShippingAddress({ address: 'ab' }), 'CAMPO_INVALIDO')
    expectCode(() => normalizeShippingAddress(null), 'CAMPO_INVALIDO')
    expectCode(() => normalizeShippingAddress('Av. Primavera 120'), 'CAMPO_INVALIDO')
  })

  it('no es un vertedero: los campos que no son de direccion se rechazan', () => {
    expectCode(
      () => normalizeShippingAddress({ address: 'Jr. Lima 45', total: '0.01' }),
      'CAMPO_NO_PERMITIDO',
    )
    expectCode(
      () => normalizeShippingAddress({ address: 'Jr. Lima 45', organization_id: ORG }),
      'CAMPO_NO_PERMITIDO',
    )
  })

  it('corta los textos desmesurados en vez de guardarlos', () => {
    expectCode(() => normalizeShippingAddress({ address: 'x'.repeat(301) }), 'CAMPO_INVALIDO')
    expectCode(
      () => normalizeShippingAddress({ address: 'Jr. Lima 45', reference: 'x'.repeat(201) }),
      'CAMPO_INVALIDO',
    )
  })
})
