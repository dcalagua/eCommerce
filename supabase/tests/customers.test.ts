// @vitest-environment node
/**
 * P05-SaaS · Clientes y cuentas B2B, contra Postgres REAL.
 *
 * Lo que se compra aqui son las cinco propiedades de las que depende que este
 * dominio sea reutilizable y no una isla:
 *
 *  · **usuario != cliente** — `customers` no tiene `user_id` y el vinculo con
 *    personas vive en una relacion; un usuario de cuenta B2B no es miembro del
 *    tenant y no ve una sola fila por PostgREST;
 *  · **el vinculo lo pone el SERVIDOR** — `my_business_accounts()` no acepta
 *    parametros, asi que no hay forma de pedir la cuenta de otro;
 *  · **el AISLAMIENTO se sostiene** en las ocho tablas nuevas, y tampoco se
 *    cuela por las claves foraneas: un cliente de otra sociedad no se puede
 *    tarifar, ni colgarle una direccion, ni una cuenta;
 *  · **el modelo hace imposibles** los estados que corrompen una entrega: una
 *    cuenta corporativa sobre una persona, dos direcciones de envio por
 *    defecto, una sucursal apuntando a la direccion de otro cliente;
 *  · **la autorizacion por monto** responde lo mismo desde el portal y desde el
 *    backoffice, porque es una sola funcion.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  TENANT_A,
  TENANT_B,
  asRole,
  claimsFor,
  createTestDatabase,
  expectFailure,
  type JwtClaims,
} from './harness.ts'
import { BUSINESS_ROLES, CUSTOMER_KINDS, ADDRESS_VERIFICATIONS } from '../../src/features/customers/types.ts'

type Row = Record<string, unknown>

let db: PGlite

const B2B = 'ecommerce.customers.b2b'
/**
 * El motor de precios tambien se contrata: sin el, `ebim.active_price_lists` no
 * devuelve ninguna lista y el precio cae al de catalogo. Va en la fixtura
 * porque este archivo prueba que el SEGMENTO sale de la ficha, no si el modulo
 * de precios esta vendido —eso ya lo fija `pricing-engine.test.ts`—.
 */
const PRICING = 'ecommerce.pricing.lists'
const ADDONS = [B2B, PRICING]

/** Comprador de la empresa cliente: tiene sesion y NO es miembro del tenant. */
const BUYER_ID = '0c000000-0000-4000-8000-0000000000e1'
const APPROVER_ID = '0c000000-0000-4000-8000-0000000000e2'
const OUTSIDER_ID = '0c000000-0000-4000-8000-0000000000e3'

let storeA: string
let storeB: string
let channelA: string
let acme: string
let persona: string
let clienteB: string
let segmentoMayorista: string
let cuentaAcme: string
let direccionLima: string
let sucursalLima: string

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

async function id(query: string, params: unknown[] = []): Promise<string> {
  const rows = await svc(query, params)
  return String(rows[0]?.id)
}

async function asMember(tenant: typeof TENANT_A, run: (tx: PGlite) => Promise<Row[]>) {
  return asRole(db, 'authenticated', claimsFor(tenant), run)
}

/**
 * Claims de un comprador B2B: hay `sub` y hay correo, y NO hay membresia. Es
 * exactamente la forma del token que tendra el dia que el portal tenga login, y
 * lo que hace que `can_access` devuelva `false` para el.
 */
function buyerClaims(userId: string, email: string): JwtClaims {
  return {
    sub: userId,
    email,
    org_id: TENANT_A.organizationId,
    companies: [],
    active_company: TENANT_A.companyId,
  }
}

async function asBuyer(userId: string, email: string, run: (tx: PGlite) => Promise<Row[]>) {
  return asRole(db, 'authenticated', buyerClaims(userId, email), run)
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const [tenant, storeSlug] of [
    [TENANT_A, 'tienda-a'],
    [TENANT_B, 'tienda-b'],
  ] as const) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId, tenant.companyId, tenant.slug, tenant.slug,
      tenant.adminEmail, tenant.ownerId, storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)
  await svc(`update public.store_settings set tax_rate = 0`)

  // Solo el tenant A contrata el portal B2B. El B es el control.
  await svc(
    `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
    [TENANT_A.organizationId, TENANT_A.companyId, ADDONS],
  )

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === 'tienda-a')?.id)
  storeB = String(stores.find((s) => s.slug === 'tienda-b')?.id)

  const channels = await svc(`select id from public.channels where store_id = $1 and is_default`, [
    storeA,
  ])
  channelA = String(channels[0]?.id)

  segmentoMayorista = await id(
    `insert into public.customer_segments (organization_id, company_id, code, name)
     values ($1, $2, 'mayorista', 'Mayorista') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )

  const insertCustomer = `
    insert into public.customers
      (organization_id, company_id, kind, code, name, email, segment_id)
    values ($1, $2, $3::public.customer_kind, $4, $5, $6, $7) returning id`

  acme = await id(insertCustomer, [
    TENANT_A.organizationId, TENANT_A.companyId, 'company', 'CLI-ACME', 'Acme',
    'compras@acme.test', segmentoMayorista,
  ])
  persona = await id(insertCustomer, [
    TENANT_A.organizationId, TENANT_A.companyId, 'person', 'CLI-ANA', 'Ana',
    'ana@correo.test', null,
  ])
  clienteB = await id(insertCustomer, [
    TENANT_B.organizationId, TENANT_B.companyId, 'company', 'CLI-B', 'Cliente del vecino',
    'compras@vecino.test', null,
  ])

  cuentaAcme = await id(
    `insert into public.business_accounts
       (organization_id, company_id, customer_id, code, name, requires_approval, approval_threshold)
     values ($1, $2, $3, 'ACME', 'Acme', true, '5000.00') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, acme],
  )

  direccionLima = await id(
    `insert into public.customer_addresses
       (organization_id, company_id, customer_id, label, line1, city, country,
        is_shipping, is_billing, is_default_shipping)
     values ($1, $2, $3, 'Almacen Lima', 'Av. Siempre Viva 742', 'Lima', 'PE', true, true, true)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, acme],
  )

  sucursalLima = await id(
    `insert into public.business_locations
       (organization_id, company_id, business_account_id, customer_id, code, name,
        address_id, is_default)
     values ($1, $2, $3, $4, 'LIM', 'Planta Lima', $5, true) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme, acme, direccionLima],
  )

  await svc(
    `insert into public.business_account_users
       (organization_id, company_id, business_account_id, user_id, email, role,
        spending_limit, status, default_location_id)
     values ($1, $2, $3, $4, 'compras@acme.test', 'buyer', '1000.00', 'active', $5),
            ($1, $2, $3, $6, 'gerencia@acme.test', 'approver', null, 'active', null)`,
    [
      TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme, BUYER_ID, sucursalLima,
      APPROVER_ID,
    ],
  )
}, 180_000)

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------

describe('el vocabulario de la base es el que declara TypeScript', () => {
  it('los enums de cliente, verificacion y rol B2B coinciden', async () => {
    for (const [enumName, declared] of [
      ['customer_kind', CUSTOMER_KINDS],
      ['address_verification', ADDRESS_VERIFICATIONS],
      ['business_role', BUSINESS_ROLES],
    ] as const) {
      const rows = await svc(
        `select e.enumlabel as value
           from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = $1 order by e.enumlabel`,
        [enumName],
      )
      expect(`${enumName}: ${rows.map((r) => r.value).join(',')}`).toBe(
        `${enumName}: ${[...declared].sort().join(',')}`,
      )
    }
  })

  /**
   * La regla 1 de la fase, escrita como esquema: si `customers` tuviera
   * `user_id`, el modelo diria que un cliente ES una persona con sesion — y a
   * partir de ahi el segundo comprador de la misma empresa no cabe.
   */
  it('customers NO tiene user_id: el vinculo con personas es una relacion', async () => {
    const rows = await svc(
      `select a.attname as column_name
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'customers'
          and a.attname in ('user_id', 'auth_user_id', 'sub')`,
    )
    expect(rows).toEqual([])
  })

  it('el vinculo usuario-cuenta no tiene FK a auth.users: la identidad la emite el hub', async () => {
    const rows = await svc(
      `select con.conname as name
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_class f on f.oid = con.confrelid
         join pg_namespace fn on fn.oid = f.relnamespace
        where c.relname = 'business_account_users' and con.contype = 'f'
          and fn.nspname = 'auth'`,
    )
    expect(rows).toEqual([])
  })

  it('anon no tiene ni un GRANT sobre las ocho tablas nuevas', async () => {
    const rows = await svc(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'PUBLIC')
          and table_name in ('customers', 'customer_addresses', 'customer_contacts',
                             'customer_external_ids', 'business_accounts',
                             'business_locations', 'business_account_users', 'approval_rules')`,
    )
    expect(rows).toEqual([])
  })
})

describe('el modelo hace imposibles los estados que rompen una entrega', () => {
  it('una cuenta B2B no puede colgar de una persona', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.business_accounts
           (organization_id, company_id, customer_id, code, name)
         values ($1, $2, $3, 'ANA', 'Ana')`,
        [TENANT_A.organizationId, TENANT_A.companyId, persona],
      ),
    )
    expect(message).toMatch(/business_accounts_customer_fk|foreign key/i)
  })

  it('un cliente con cuenta ya no se puede convertir en persona', async () => {
    const message = await expectFailure(() =>
      svc(`update public.customers set kind = 'person' where id = $1`, [acme]),
    )
    expect(message).toMatch(/business_accounts_customer_fk|foreign key|violates/i)
  })

  it('un cliente no puede tener dos cuentas', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.business_accounts
           (organization_id, company_id, customer_id, code, name)
         values ($1, $2, $3, 'ACME2', 'Acme bis')`,
        [TENANT_A.organizationId, TENANT_A.companyId, acme],
      ),
    )
    expect(message).toMatch(/one_per_customer|duplicate key/i)
  })

  it('una direccion sin uso declarado se rechaza', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_addresses
           (organization_id, company_id, customer_id, label, line1, country,
            is_shipping, is_billing)
         values ($1, $2, $3, 'Ninguno', 'Calle sin uso 1', 'PE', false, false)`,
        [TENANT_A.organizationId, TENANT_A.companyId, acme],
      ),
    )
    expect(message).toMatch(/has_use|check/i)
  })

  it('no se puede marcar por defecto un uso que la direccion no tiene', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_addresses
           (organization_id, company_id, customer_id, label, line1, country,
            is_shipping, is_billing, is_default_billing)
         values ($1, $2, $3, 'Solo envio', 'Calle 2', 'PE', true, false, true)`,
        [TENANT_A.organizationId, TENANT_A.companyId, acme],
      ),
    )
    expect(message).toMatch(/default_billing_use|check/i)
  })

  it('un cliente no puede tener dos direcciones de envio por defecto', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_addresses
           (organization_id, company_id, customer_id, label, line1, country,
            is_shipping, is_default_shipping)
         values ($1, $2, $3, 'Otra', 'Calle 3', 'PE', true, true)`,
        [TENANT_A.organizationId, TENANT_A.companyId, acme],
      ),
    )
    expect(message).toMatch(/one_default_shipping|duplicate key/i)
  })

  it('una sucursal no puede apuntar a la direccion de otro cliente', async () => {
    const ajena = await id(
      `insert into public.customer_addresses
         (organization_id, company_id, customer_id, label, line1, country, is_shipping)
       values ($1, $2, $3, 'Casa de Ana', 'Calle 4', 'PE', true) returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, persona],
    )
    const message = await expectFailure(() =>
      svc(
        `insert into public.business_locations
           (organization_id, company_id, business_account_id, customer_id, code, name, address_id)
         values ($1, $2, $3, $4, 'AJENA', 'Sucursal ajena', $5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme, acme, ajena],
      ),
    )
    expect(message).toMatch(/business_locations_address_fk|foreign key/i)
    await svc(`delete from public.customer_addresses where id = $1`, [ajena])
  })

  it('un contacto sin correo ni telefono se rechaza', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_contacts (organization_id, company_id, customer_id, name)
         values ($1, $2, $3, 'Fantasma')`,
        [TENANT_A.organizationId, TENANT_A.companyId, acme],
      ),
    )
    expect(message).toMatch(/reachable|check/i)
  })

  it('el mismo sistema no puede dar dos codigos al mismo cliente', async () => {
    await svc(
      `insert into public.customer_external_ids
         (organization_id, company_id, customer_id, system_code, external_id)
       values ($1, $2, $3, 'erp', 'C-0001')`,
      [TENANT_A.organizationId, TENANT_A.companyId, acme],
    )
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_external_ids
           (organization_id, company_id, customer_id, system_code, external_id)
         values ($1, $2, $3, 'erp', 'C-0002')`,
        [TENANT_A.organizationId, TENANT_A.companyId, acme],
      ),
    )
    expect(message).toMatch(/one_per_system|duplicate key/i)
  })

  it('el mismo codigo externo no puede apuntar a dos clientes', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_external_ids
           (organization_id, company_id, customer_id, system_code, external_id)
         values ($1, $2, $3, 'erp', 'c-0001')`,
        [TENANT_A.organizationId, TENANT_A.companyId, persona],
      ),
    )
    expect(message).toMatch(/value_key|duplicate key/i)
  })

  it('un umbral de aprobacion sin el control encendido se rechaza', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.business_accounts
           (organization_id, company_id, customer_id, code, name,
            requires_approval, approval_threshold)
         values ($1, $2, $3, 'SINCTRL', 'Sin control', false, '100.00')`,
        [TENANT_B.organizationId, TENANT_B.companyId, clienteB],
      ),
    )
    expect(message).toMatch(/threshold_needs_control|check/i)
  })

  it('un observador no puede ser el aprobador de una regla', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.approval_rules
           (organization_id, company_id, business_account_id, name, min_amount, approver_role)
         values ($1, $2, $3, 'Imposible', 0, 'viewer')`,
        [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme],
      ),
    )
    expect(message).toMatch(/approver_can_act|check/i)
  })

  /** Contrato §13: la suite no es actor de negocio de un tenant. */
  it('una cuenta @ebim.pe no se puede vincular a una cuenta B2B', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.business_account_users
           (organization_id, company_id, business_account_id, user_id, email)
         values ($1, $2, $3, gen_random_uuid(), 'operador@ebim.pe')`,
        [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme],
      ),
    )
    expect(message).toMatch(/not_suite|check/i)
  })

  it('la misma persona no se vincula dos veces a la misma cuenta', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.business_account_users
           (organization_id, company_id, business_account_id, user_id, email, role)
         values ($1, $2, $3, $4, 'compras@acme.test', 'admin')`,
        [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme, BUYER_ID],
      ),
    )
    expect(message).toMatch(/business_account_users_unique|duplicate key/i)
  })
})

describe('la verificacion de una direccion la fecha la base', () => {
  it('pasar a verificada estampa la fecha; salir de verificada la borra', async () => {
    const direccion = await id(
      `insert into public.customer_addresses
         (organization_id, company_id, customer_id, label, line1, country, is_shipping)
       values ($1, $2, $3, 'Por verificar', 'Calle 9', 'PE', true) returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, acme],
    )

    const [inicial] = await svc(
      `select verification, verified_at from public.customer_addresses where id = $1`,
      [direccion],
    )
    expect(inicial?.verification).toBe('unverified')
    expect(inicial?.verified_at).toBeNull()

    // La fecha NO se acepta del cliente: se manda una falsa y la base pone la suya.
    await svc(
      `update public.customer_addresses
          set verification = 'verified', verified_at = '1999-01-01'
        where id = $1`,
      [direccion],
    )
    const [verificada] = await svc(
      `select verification, verified_at from public.customer_addresses where id = $1`,
      [direccion],
    )
    expect(verificada?.verification).toBe('verified')
    expect(String(verificada?.verified_at)).not.toMatch(/^1999/)

    await svc(`update public.customer_addresses set verification = 'rejected' where id = $1`, [
      direccion,
    ])
    const [rechazada] = await svc(
      `select verified_at from public.customer_addresses where id = $1`,
      [direccion],
    )
    expect(rechazada?.verified_at).toBeNull()

    await svc(`delete from public.customer_addresses where id = $1`, [direccion])
  })
})

describe('aislamiento entre tenants', () => {
  it('el tenant B no ve ni un cliente del tenant A', async () => {
    const rows = await asMember(TENANT_B, (tx) =>
      tx.query<Row>(`select id from public.customers`).then((r) => r.rows),
    )
    expect(rows.map((r) => r.id)).toEqual([clienteB])
  })

  it('el tenant B no ve direcciones, contactos, cuentas, sucursales ni usuarios de A', async () => {
    for (const table of [
      'customer_addresses',
      'customer_contacts',
      'customer_external_ids',
      'business_accounts',
      'business_locations',
      'business_account_users',
      'approval_rules',
    ]) {
      const rows = await asMember(TENANT_B, (tx) =>
        tx.query<Row>(`select count(*)::int as n from public.${table}`).then((r) => r.rows),
      )
      expect(`${table}: ${rows[0]?.n}`).toBe(`${table}: 0`)
    }
  })

  it('el tenant B no puede escribir un cliente declarando el tenant de A', async () => {
    const message = await expectFailure(() =>
      asMember(TENANT_B, (tx) =>
        tx
          .query<Row>(
            `insert into public.customers (organization_id, company_id, code, name)
             values ($1, $2, 'ROBADO', 'Robado')`,
            [TENANT_A.organizationId, TENANT_A.companyId],
          )
          .then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/row-level security|policy/i)
  })

  /** Ni por la puerta de atras: una direccion de un cliente ajeno no entra. */
  it('no se le puede colgar una direccion a un cliente de otra sociedad', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.customer_addresses
           (organization_id, company_id, customer_id, label, line1, country, is_shipping)
         values ($1, $2, $3, 'Cruzada', 'Calle cruzada 1', 'PE', true)`,
        [TENANT_B.organizationId, TENANT_B.companyId, acme],
      ),
    )
    expect(message).toMatch(/customer_addresses_customer_fk|foreign key/i)
  })

  it('una lista de precio no puede asignarse a un cliente de otra sociedad', async () => {
    const lista = await id(
      `insert into public.price_lists
         (organization_id, company_id, store_id, code, name, currency)
       values ($1, $2, $3, 'cruzada', 'Cruzada', 'PEN') returning id`,
      [TENANT_B.organizationId, TENANT_B.companyId, storeB],
    )
    const message = await expectFailure(() =>
      svc(
        `insert into public.price_list_assignments
           (organization_id, company_id, store_id, price_list_id, scope, customer_id)
         values ($1, $2, $3, $4, 'customer', $5)`,
        [TENANT_B.organizationId, TENANT_B.companyId, storeB, lista, acme],
      ),
    )
    expect(message).toMatch(/price_list_assignments_customer_fk|foreign key/i)
    await svc(`delete from public.price_lists where id = $1`, [lista])
  })

  /** La deuda que P04 dejo escrita: `customer_id` ya no acepta un uuid libre. */
  it('una asignacion a un cliente que no existe se rechaza', async () => {
    const lista = await id(
      `insert into public.price_lists
         (organization_id, company_id, store_id, code, name, currency)
       values ($1, $2, $3, 'fantasma', 'Fantasma', 'PEN') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    const message = await expectFailure(() =>
      svc(
        `insert into public.price_list_assignments
           (organization_id, company_id, store_id, price_list_id, scope, customer_id)
         values ($1, $2, $3, $4, 'customer', gen_random_uuid())`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, lista],
      ),
    )
    expect(message).toMatch(/price_list_assignments_customer_fk|foreign key/i)
    await svc(`delete from public.price_lists where id = $1`, [lista])
  })
})

describe('el usuario de una cuenta B2B no es miembro del tenant', () => {
  it('no lee ni una fila de ninguna tabla del backoffice', async () => {
    for (const table of ['customers', 'customer_addresses', 'business_accounts', 'business_account_users']) {
      const rows = await asBuyer(BUYER_ID, 'compras@acme.test', (tx) =>
        tx.query<Row>(`select count(*)::int as n from public.${table}`).then((r) => r.rows),
      )
      expect(`${table}: ${rows[0]?.n}`).toBe(`${table}: 0`)
    }
  })

  it('su contexto llega entero por `my_business_accounts`, sin pasar un solo id', async () => {
    const rows = await asBuyer(BUYER_ID, 'compras@acme.test', (tx) =>
      tx.query<Row>(`select public.my_business_accounts() as data`).then((r) => r.rows),
    )
    const accounts = rows[0]?.data as Array<Record<string, unknown>>
    expect(accounts).toHaveLength(1)

    const account = accounts[0] as Record<string, unknown>
    expect(account.account_id).toBe(cuentaAcme)
    expect(account.role).toBe('buyer')
    expect(account.customer_name).toBe('Acme')
    expect(account.spending_limit).toBe('1000.00')
    expect(account.requires_approval).toBe(true)
    expect((account.locations as unknown[]).length).toBe(1)
    expect((account.addresses as unknown[]).length).toBeGreaterThan(0)
  })

  it('quien no esta vinculado no recibe ninguna cuenta', async () => {
    const rows = await asBuyer(OUTSIDER_ID, 'nadie@fuera.test', (tx) =>
      tx.query<Row>(`select public.my_business_accounts() as data`).then((r) => r.rows),
    )
    expect(rows[0]?.data).toEqual([])
  })

  it('un vinculo revocado deja de dar contexto', async () => {
    await svc(`update public.business_account_users set status = 'revoked' where user_id = $1`, [
      APPROVER_ID,
    ])
    const rows = await asBuyer(APPROVER_ID, 'gerencia@acme.test', (tx) =>
      tx.query<Row>(`select public.my_business_accounts() as data`).then((r) => r.rows),
    )
    expect(rows[0]?.data).toEqual([])
    await svc(`update public.business_account_users set status = 'active' where user_id = $1`, [
      APPROVER_ID,
    ])
  })

  it('anon no puede ni ejecutar la funcion de contexto', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, (tx) =>
        tx.query<Row>(`select public.my_business_accounts()`).then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/permission denied|no existe|does not exist/i)
  })
})

describe('autorizacion por monto', () => {
  beforeEach(async () => {
    await svc(`delete from public.approval_rules`)
  })

  it('sin reglas, manda el umbral de la cuenta', async () => {
    const bajo = await approvalFor(BUYER_ID, '100.00')
    // 100 pasa del limite personal del comprador? No: su limite es 1000.
    expect(bajo.required).toBe(false)

    const alto = await approvalFor(BUYER_ID, '6000.00')
    expect(alto.required).toBe(true)
  })

  it('el limite personal manda sobre el umbral de la cuenta', async () => {
    const decision = await approvalFor(BUYER_ID, '1500.00')
    expect(decision.required).toBe(true)
    expect(decision.reason).toBe('user_limit')
    expect(decision.user_limit).toBe('1000.00')
  })

  it('gana la regla de MAYOR umbral alcanzado, como una escala de precio', async () => {
    await svc(
      `insert into public.approval_rules
         (organization_id, company_id, business_account_id, name, min_amount, approver_role)
       values ($1, $2, $3, 'Desde 500', 500, 'approver'),
              ($1, $2, $3, 'Desde 200', 200, 'admin')`,
      [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme],
    )

    const decision = await approvalFor(APPROVER_ID, '800.00')
    expect(decision.required).toBe(true)
    expect(decision.reason).toBe('rule')
    expect(decision.rule_name).toBe('Desde 500')
    expect(decision.approver_role).toBe('approver')

    const menor = await approvalFor(APPROVER_ID, '300.00')
    expect(menor.rule_name).toBe('Desde 200')
    expect(menor.approver_role).toBe('admin')
  })

  it('dos reglas con el mismo umbral se rechazan: el ganador seria el orden de las filas', async () => {
    await svc(
      `insert into public.approval_rules
         (organization_id, company_id, business_account_id, name, min_amount)
       values ($1, $2, $3, 'Primera', 1000)`,
      [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme],
    )
    const message = await expectFailure(() =>
      svc(
        `insert into public.approval_rules
           (organization_id, company_id, business_account_id, name, min_amount)
         values ($1, $2, $3, 'Segunda', 1000)`,
        [TENANT_A.organizationId, TENANT_A.companyId, cuentaAcme],
      ),
    )
    expect(message).toMatch(/one_per_amount|duplicate key/i)
  })

  it('el backoffice pregunta por la misma funcion que el portal', async () => {
    const rows = await asMember(TENANT_A, (tx) =>
      tx
        .query<Row>(`select public.purchase_approval($1, $2) as data`, [cuentaAcme, '9000.00'])
        .then((r) => r.rows),
    )
    const decision = rows[0]?.data as Record<string, unknown>
    expect(decision.required).toBe(true)
    expect(decision.reason).toBe('account_threshold')
  })

  it('preguntar por una cuenta ajena es 42501, no una respuesta vacia', async () => {
    const message = await expectFailure(() =>
      asBuyer(OUTSIDER_ID, 'nadie@fuera.test', (tx) =>
        tx.query<Row>(`select public.purchase_approval($1, 1)`, [cuentaAcme]).then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('un importe negativo se rechaza en vez de aprobarse solo', async () => {
    const message = await expectFailure(() =>
      asBuyer(BUYER_ID, 'compras@acme.test', (tx) =>
        tx.query<Row>(`select public.purchase_approval($1, -5)`, [cuentaAcme]).then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/MONTO_INVALIDO/)
  })
})

async function approvalFor(userId: string, amount: string): Promise<Record<string, unknown>> {
  const rows = await asBuyer(userId, 'quien@sea.test', (tx) =>
    tx
      .query<Row>(`select public.purchase_approval($1, $2) as data`, [cuentaAcme, amount])
      .then((r) => r.rows),
  )
  return rows[0]?.data as Record<string, unknown>
}

describe('el cliente entra en el motor de precios', () => {
  beforeEach(async () => {
    await svc(`delete from public.price_list_items`)
    await svc(`delete from public.price_list_assignments`)
    await svc(`delete from public.price_lists`)
  })

  async function jabonId(): Promise<string> {
    const rows = await svc(`select id from public.products where sku = 'A-JABON'`)
    if (rows[0]) return String(rows[0].id)
    return id(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency,
          stock, status, published_at, kind)
       values ($1, $2, $3, 'A-JABON', 'jabon', 'Jabon', '10.00', 'PEN', 100, 'published', now(), 'simple')
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
  }

  it('sin declarar segmento, el precio sale del segmento DE SU FICHA', async () => {
    const jabon = await jabonId()
    const lista = await id(
      `insert into public.price_lists
         (organization_id, company_id, store_id, code, name, currency, valid_from)
       values ($1, $2, $3, 'mayorista', 'Mayorista', 'PEN', now() - interval '1 day') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    await svc(
      `insert into public.price_list_assignments
         (organization_id, company_id, store_id, price_list_id, scope, segment_id)
       values ($1, $2, $3, $4, 'segment', $5)`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, lista, segmentoMayorista],
    )
    await svc(
      `insert into public.price_list_items
         (organization_id, company_id, store_id, price_list_id, product_id, unit_price)
       values ($1, $2, $3, $4, $5, '7.00')`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, lista, jabon],
    )

    // Acme es mayorista; Ana no. El llamante no dice ni una palabra del segmento.
    const conCliente = await quote(acme, jabon)
    expect(conCliente).toBe('7.00')

    const otro = await quote(persona, jabon)
    expect(otro).toBe('10.00')

    const sinCliente = await quote(null, jabon)
    expect(sinCliente).toBe('10.00')
  })

  it('un cliente de otra sociedad se rechaza antes de mirar un precio', async () => {
    const jabon = await jabonId()
    const message = await expectFailure(() =>
      asMember(TENANT_A, (tx) =>
        tx
          .query<Row>(
            `select public.price_quote($1, $2::jsonb, null, null, $3) as data`,
            [storeA, JSON.stringify([{ product_id: jabon, quantity: 1 }]), clienteB],
          )
          .then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/CLIENTE_NO_ENCONTRADO/)
  })

  async function quote(customer: string | null, product: string): Promise<string> {
    const rows = await asMember(TENANT_A, (tx) =>
      tx
        .query<Row>(`select public.price_quote($1, $2::jsonb, null, null, $3) as data`, [
          storeA,
          JSON.stringify([{ product_id: product, quantity: 1 }]),
          customer,
        ])
        .then((r) => r.rows),
    )
    const data = rows[0]?.data as { lines: Array<{ unit_price: string }> }
    return data.lines[0]?.unit_price as string
  }
})

describe('lo que se cuenta antes de borrar, y los pedidos del cliente', () => {
  it('customer_orders enlaza por correo, tambien por el de sus contactos', async () => {
    const jabon = await id(
      `select id from public.products where sku = 'A-JABON'`,
    )
    expect(jabon).not.toBe('undefined')

    await svc(
      `insert into public.orders
         (organization_id, company_id, store_id, channel_id, order_number, customer_email,
          currency, subtotal, tax_total, grand_total)
       values ($1, $2, $3, $4, 'A-0001', 'COMPRAS@acme.test', 'PEN', '100.00', 0, '100.00'),
              ($1, $2, $3, $4, 'A-0002', 'logistica@acme.test', 'PEN', '50.00', 0, '50.00'),
              ($1, $2, $3, $4, 'A-0003', 'otro@nadie.test', 'PEN', '10.00', 0, '10.00')`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, channelA],
    )
    await svc(
      `insert into public.customer_contacts
         (organization_id, company_id, customer_id, name, email)
       values ($1, $2, $3, 'Logistica', 'logistica@acme.test')`,
      [TENANT_A.organizationId, TENANT_A.companyId, acme],
    )

    const rows = await asMember(TENANT_A, (tx) =>
      tx
        .query<Row>(`select order_number, grand_total from public.customer_orders($1)`, [acme])
        .then((r) => r.rows),
    )
    expect(rows.map((r) => r.order_number).sort()).toEqual(['A-0001', 'A-0002'])
    // El dinero sale como TEXTO: un `number` perderia los centimos de cola.
    expect(rows.map((r) => r.grand_total).every((v) => typeof v === 'string')).toBe(true)
  })

  it('el conteo previo al borrado dice todo lo que se lleva por delante', async () => {
    const rows = await asMember(TENANT_A, (tx) =>
      tx.query<Row>(`select public.customer_deletion_usage($1) as data`, [acme]).then((r) => r.rows),
    )
    const usage = rows[0]?.data as Record<string, number>
    // Se compara el objeto ENTERO: una clave nueva que nadie mire seria un
    // borrado en cascada que la pantalla no cuenta.
    expect(Object.keys(usage).sort()).toEqual([
      'account_users',
      'accounts',
      'addresses',
      'contacts',
      'external_ids',
      'orders',
      'price_assignments',
    ])
    expect(usage.accounts).toBe(1)
    expect(usage.account_users).toBe(2)
    expect(usage.orders).toBe(2)
    expect(usage.addresses).toBeGreaterThan(0)
  })

  it('el vecino no cuenta nada de un cliente ajeno', async () => {
    const rows = await asMember(TENANT_B, (tx) =>
      tx.query<Row>(`select public.customer_deletion_usage($1) as data`, [acme]).then((r) => r.rows),
    )
    const usage = rows[0]?.data as Record<string, number>
    expect(Object.values(usage).every((value) => Number(value) === 0)).toBe(true)
  })
})

describe('roles y capacidad: los dos ejes, no uno', () => {
  it('un miembro con rol viewer no crea clientes', async () => {
    await svc(
      `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
       values ($1, $2, $3, 'miron@tenant-a.com', 'viewer')`,
      [TENANT_A.organizationId, TENANT_A.companyId, OUTSIDER_ID],
    )
    const claims = claimsFor(TENANT_A, { sub: OUTSIDER_ID, email: 'miron@tenant-a.com' })

    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claims, (tx) =>
        tx
          .query<Row>(
            `insert into public.customers (organization_id, company_id, code, name)
             values ($1, $2, 'NOPE', 'No')`,
            [TENANT_A.organizationId, TENANT_A.companyId],
          )
          .then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/row-level security|policy/i)

    // Pero SI los lee: la ficha no es secreta dentro de la sociedad.
    const rows = await asRole(db, 'authenticated', claims, (tx) =>
      tx.query<Row>(`select count(*)::int as n from public.customers`).then((r) => r.rows),
    )
    expect(Number(rows[0]?.n)).toBeGreaterThan(0)

    await svc(`delete from public.tenant_members where user_id = $1`, [OUTSIDER_ID])
  })

  /**
   * La ficha de cliente es BASELINE y la cuenta B2B se vende. El tenant B tiene
   * `app_active` pero no el addon: escribe clientes y no escribe cuentas.
   */
  it('sin el addon se pueden crear clientes y NO cuentas B2B', async () => {
    const creado = await asMember(TENANT_B, (tx) =>
      tx
        .query<Row>(
          `insert into public.customers (organization_id, company_id, kind, code, name)
           values ($1, $2, 'company', 'B-NUEVO', 'Nuevo del vecino') returning id`,
          [TENANT_B.organizationId, TENANT_B.companyId],
        )
        .then((r) => r.rows),
    )
    expect(creado[0]?.id).toBeTruthy()

    const message = await expectFailure(() =>
      asMember(TENANT_B, (tx) =>
        tx
          .query<Row>(
            `insert into public.business_accounts
               (organization_id, company_id, customer_id, code, name)
             values ($1, $2, $3, 'NUEVO', 'Nuevo')`,
            [TENANT_B.organizationId, TENANT_B.companyId, creado[0]?.id],
          )
          .then((r) => r.rows),
      ),
    )
    expect(message).toMatch(/row-level security|policy/i)
  })

  /**
   * Y al reves: perder el addon apaga la GESTION, no la vista. Esconder las
   * cuentas convertiria una baja comercial en una perdida de datos aparente,
   * que es justo lo que P04 decidio para las listas de precio.
   */
  it('con el addon se crea, y quitarlo deja verlas pero no tocarlas', async () => {
    const empresa = await id(
      `insert into public.customers (organization_id, company_id, kind, code, name)
       values ($1, $2, 'company', 'CLI-TMP', 'Temporal') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )

    const creada = await asMember(TENANT_A, (tx) =>
      tx
        .query<Row>(
          `insert into public.business_accounts
             (organization_id, company_id, customer_id, code, name)
           values ($1, $2, $3, 'TMP', 'Temporal') returning id`,
          [TENANT_A.organizationId, TENANT_A.companyId, empresa],
        )
        .then((r) => r.rows),
    )
    expect(creada[0]?.id).toBeTruthy()

    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [TENANT_A.organizationId, TENANT_A.companyId, []],
    )

    const visibles = await asMember(TENANT_A, (tx) =>
      tx.query<Row>(`select count(*)::int as n from public.business_accounts`).then((r) => r.rows),
    )
    expect(Number(visibles[0]?.n)).toBeGreaterThan(0)

    // Un UPDATE cuyo `using` no se cumple no levanta excepcion: no toca NINGUNA
    // fila, que es la forma en que la RLS niega una modificacion. Se comprueba
    // por el efecto —el nombre sigue siendo el de antes— y no por el error,
    // porque esperar un error aqui daria por bueno cualquier resultado.
    await asMember(TENANT_A, (tx) =>
      tx
        .query<Row>(`update public.business_accounts set name = 'Cambiada' where id = $1`, [
          creada[0]?.id,
        ])
        .then((r) => r.rows),
    )
    const [despues] = await svc(`select name from public.business_accounts where id = $1`, [
      creada[0]?.id,
    ])
    expect(despues?.name).toBe('Temporal')

    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [TENANT_A.organizationId, TENANT_A.companyId, ADDONS],
    )
    await svc(`delete from public.customers where id = $1`, [empresa])
  })
})
