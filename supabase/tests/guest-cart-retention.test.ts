// @vitest-environment node
/**
 * P16-SaaS · El carrito de invitado no se queda para siempre.
 *
 * El hallazgo que motiva este archivo, medido antes de arreglarlo: `cart_open`
 * esta concedida a `anon` y, sin token, INSERTA. `ebim.expire_due_carts` solo
 * cambia el estado, asi que nada borraba nunca esa fila. Cuarenta llamadas
 * anonimas seguidas dejaban cuarenta filas, y despues de caducarlas seguian
 * siendo cuarenta — ahora con la etiqueta `abandoned`.
 *
 * Lo que se compra aqui, y en este orden:
 *
 *  1. **que el hecho es real** — la llamada sin token crea fila (si algun dia
 *     deja de hacerlo, este test lo dice y no al reves);
 *  2. **que la basura se recoge sola**, sin planificador, con el trafico que la
 *     genero;
 *  3. **que NO se recoge nada que valga algo** — con lineas, con dueño, activo,
 *     con intento de checkout o destino de una fusion. Son las cinco formas de
 *     que esta limpieza se convierta en perdida de datos, y estan compradas una
 *     por una;
 *  4. **que el crecimiento queda acotado** bajo un bucle sostenido, que es la
 *     propiedad por la que existe la fase;
 *  5. **que ni la recogida ni la purga son alcanzables desde el navegador.**
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite
let storeA: string
let storeB: string
let silla: string

const SLUG_A = TENANT_A.storeSlug
const SLUG_B = TENANT_B.storeSlug

/** Comprador con sesion que no es miembro de ningun tenant (caso B2B de P05). */
const BUYER = {
  sub: '0c000000-0000-4000-8000-0000000000f1',
  email: 'compradora@empresa.com',
  org_id: '0c000000-0000-4000-8000-000000000003',
  companies: [] as Array<{ id: string; role: string }>,
  active_company: '0c000000-0000-4000-8000-0000000000c3',
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<Row>(query, params)).rows)
}

async function anon(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'anon', null, async () => (await db.query<Row>(query, params)).rows)
}

async function asBuyer(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'authenticated', BUYER, async () => (await db.query<Row>(query, params)).rows)
}

/** Abre un carrito y devuelve su token, que es lo unico que el invitado tiene. */
async function openGuestCart(slug = SLUG_A, token: string | null = null): Promise<string> {
  const rows = await anon(`select public.cart_open($1, $2) as result`, [slug, token])
  return String((rows[0]?.result as Row).token)
}

async function cartCount(storeId?: string): Promise<number> {
  const rows = storeId
    ? await svc(`select count(*)::int as n from public.carts where store_id = $1`, [storeId])
    : await svc(`select count(*)::int as n from public.carts`)
  return Number(rows[0]?.n)
}

async function cartIdByToken(token: string): Promise<string> {
  const rows = await svc(`select id from public.carts where token = $1`, [token])
  return String(rows[0]?.id)
}

/**
 * Deja el carrito maduro para la recogida: caducado y quieto desde hace mas de
 * la gracia. Se toca el reloj de la fila y no el del sistema porque la
 * condicion que se prueba es la de la funcion, no la del reloj.
 */
async function ageCart(id: string, interval = '4 hours'): Promise<void> {
  await svc(
    `update public.carts
        set expires_at = now() - $2::interval,
            last_activity_at = now() - $2::interval
      where id = $1`,
    [id, interval],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)
  await svc(`update public.store_settings set tax_rate = 0`)

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === SLUG_A)?.id)
  storeB = String(stores.find((s) => s.slug === SLUG_B)?.id)

  const rows = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status,
        published_at)
     values ($1, $2, $3, 'A-SILLA', 'silla', 'Silla', '100.00', 'PEN', 50, 'published', now())
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )
  silla = String(rows[0]?.id)
}, 180_000)

beforeEach(async () => {
  await svc(`delete from public.checkout_intents`)
  await svc(`delete from public.cart_items`)
  // El orden importa: `carts_merged_has_target` prohibe un carrito 'merged' sin
  // destino, asi que primero se deshace la fusion ENTERA y despues se borra.
  await svc(`update public.carts set status = 'abandoned', merged_into = null
              where merged_into is not null`)
  await svc(`delete from public.carts`)
})

// ---------------------------------------------------------------------------
// 1 · El hecho
// ---------------------------------------------------------------------------

describe('la superficie: `cart_open` sin token ESCRIBE', () => {
  /**
   * Esto no es una queja, es el contrato: el invitado no tiene nada que
   * presentar la primera vez y la fila es lo que le da un token. Lo que estaba
   * mal no era crearla, era no recogerla nunca — y llamarla en cada visita.
   */
  it('el invitado sin token deja una fila nueva por llamada', async () => {
    for (let i = 0; i < 5; i += 1) await openGuestCart()
    expect(await cartCount(storeA)).toBe(5)
  })

  it('el invitado CON token no deja una fila nueva: recupera la suya', async () => {
    const token = await openGuestCart()
    for (let i = 0; i < 5; i += 1) await openGuestCart(SLUG_A, token)
    expect(await cartCount(storeA)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2 · La recogida, sin planificador
// ---------------------------------------------------------------------------

describe('la recogida oportunista', () => {
  it('el carrito de invitado vacio y vencido desaparece en la siguiente llamada', async () => {
    const token = await openGuestCart()
    await ageCart(await cartIdByToken(token))

    // La siguiente visita a la tienda hace la recogida: caduca, barre y crea.
    await openGuestCart()

    const restos = await svc(`select token from public.carts where token = $1`, [token])
    expect(restos).toHaveLength(0)
    expect(await cartCount(storeA)).toBe(1) // solo el recien creado
  })

  it('el carrito recien creado NO se recoge a si mismo', async () => {
    const token = await openGuestCart()
    expect(await svc(`select 1 from public.carts where token = $1`, [token])).toHaveLength(1)
  })

  it('sin cumplir la gracia todavia no se recoge', async () => {
    const token = await openGuestCart()
    // Vencido, pero con actividad reciente: aun no.
    await svc(
      `update public.carts set expires_at = now() - interval '1 minute',
                               last_activity_at = now()
        where token = $1`,
      [token],
    )
    await openGuestCart()
    expect(await svc(`select 1 from public.carts where token = $1`, [token])).toHaveLength(1)
  })

  it('la recogida es POR TIENDA: la llamada de B no toca la basura de A', async () => {
    const token = await openGuestCart(SLUG_A)
    await ageCart(await cartIdByToken(token))

    await openGuestCart(SLUG_B)

    expect(await svc(`select 1 from public.carts where token = $1`, [token])).toHaveLength(1)
    expect(await cartCount(storeB)).toBe(1)
  })

  it('el tope por llamada se respeta: no barre mas de lo que se le pide', async () => {
    const tokens: string[] = []
    for (let i = 0; i < 6; i += 1) tokens.push(await openGuestCart())
    for (const token of tokens) await ageCart(await cartIdByToken(token))

    // La recogida solo mira lo ya ABANDONADO. Quien lo marca es
    // `expire_due_carts`, que `cart_open` ejecuta un paso antes; llamando a la
    // recogida directamente hay que hacer ese paso a mano, y que haga falta es
    // precisamente la garantia de que un carrito vivo no esta en su alcance.
    await svc(`select public.expire_carts()`)

    const rows = await svc(
      `select ebim.sweep_empty_guest_carts($1, '1 hour'::interval, 2) as n`,
      [storeA],
    )
    expect(Number(rows[0]?.n)).toBe(2)
    expect(await cartCount(storeA)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 3 · Lo que NUNCA se recoge
//
// Cinco formas de que esta limpieza se convierta en perdida de datos. Una por
// una, y cada una con la razon por la que ese carrito le importa a alguien.
// ---------------------------------------------------------------------------

describe('lo que la recogida no puede tocar', () => {
  it('un carrito abandonado CON lineas se queda: es material de recuperacion', async () => {
    const token = await openGuestCart()
    await anon(`select public.cart_replace_lines($1, $2, $3::jsonb)`, [
      SLUG_A,
      token,
      JSON.stringify([{ product_id: silla, quantity: 2 }]),
    ])
    await ageCart(await cartIdByToken(token))

    await openGuestCart()

    expect(await svc(`select 1 from public.carts where token = $1`, [token])).toHaveLength(1)
  })

  it('un carrito CON dueño se queda aunque este vacio y vencido', async () => {
    const rows = await asBuyer(`select public.cart_open($1, null) as result`, [SLUG_A])
    const token = String((rows[0]?.result as Row).token)
    await ageCart(await cartIdByToken(token))

    await openGuestCart()

    expect(await svc(`select 1 from public.carts where token = $1`, [token])).toHaveLength(1)
  })

  it('un carrito ACTIVO no se toca aunque lleve una eternidad quieto', async () => {
    const token = await openGuestCart()
    await svc(
      `update public.carts set last_activity_at = now() - interval '30 days',
                               expires_at = now() + interval '1 day'
        where token = $1`,
      [token],
    )
    await openGuestCart()
    expect(await svc(`select 1 from public.carts where token = $1`, [token])).toHaveLength(1)
  })

  it('un carrito que llego a la caja se queda: hubo intencion', async () => {
    const token = await openGuestCart()
    const cartId = await cartIdByToken(token)
    await svc(
      `insert into public.checkout_intents
         (organization_id, company_id, store_id, cart_id, idempotency_key, request_hash, status)
       values ($1, $2, $3, $4, $5, repeat('a', 64), 'running')`,
      [
        TENANT_A.organizationId,
        TENANT_A.companyId,
        storeA,
        cartId,
        'idem-key-de-prueba-0000000000',
      ],
    )
    await ageCart(cartId)

    await openGuestCart()

    expect(await svc(`select 1 from public.carts where id = $1`, [cartId])).toHaveLength(1)
  })

  it('el destino de una fusion se queda: el rastro no se parte', async () => {
    const destino = await openGuestCart()
    const origen = await openGuestCart()
    const destinoId = await cartIdByToken(destino)
    const origenId = await cartIdByToken(origen)

    await svc(`update public.carts set status = 'merged', merged_into = $2 where id = $1`, [
      origenId,
      destinoId,
    ])
    await ageCart(destinoId)

    await openGuestCart()

    expect(await svc(`select 1 from public.carts where id = $1`, [destinoId])).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4 · La propiedad que importa: el crecimiento queda acotado
// ---------------------------------------------------------------------------

describe('el bucle anonimo sostenido', () => {
  /**
   * Antes de P16 esto crecia sin techo y para siempre: 30 llamadas = 30 filas
   * permanentes. Ahora la basura que ya cumplio la gracia se recoge con el
   * mismo trafico que la crea, asi que lo que queda es lo reciente y no todo lo
   * que se ha llamado nunca.
   */
  it('las filas viejas no se acumulan: la basura madura se recoge sola', async () => {
    const tokens: string[] = []
    for (let i = 0; i < 30; i += 1) tokens.push(await openGuestCart())
    expect(await cartCount(storeA)).toBe(30)

    // Pasa el tiempo sobre TODO lo creado y el bucle sigue.
    await svc(
      `update public.carts
          set expires_at = now() - interval '4 hours',
              last_activity_at = now() - interval '4 hours'
        where store_id = $1`,
      [storeA],
    )
    for (let i = 0; i < 3; i += 1) await openGuestCart()

    // Las 30 viejas se fueron; quedan las 3 recien creadas.
    expect(await cartCount(storeA)).toBe(3)
    const viejas = await svc(`select 1 from public.carts where token = any($1)`, [tokens])
    expect(viejas).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5 · Quien puede llamarlas
// ---------------------------------------------------------------------------

describe('la superficie de las dos funciones nuevas', () => {
  it('`ebim.sweep_empty_guest_carts` no es alcanzable por anon ni authenticated', async () => {
    const desdeAnon = await expectFailure(() =>
      anon(`select ebim.sweep_empty_guest_carts($1)`, [storeA]),
    )
    expect(desdeAnon).toMatch(/permission denied|no existe|does not exist/i)

    const desdeSesion = await expectFailure(() =>
      asBuyer(`select ebim.sweep_empty_guest_carts($1)`, [storeA]),
    )
    expect(desdeSesion).toMatch(/permission denied|no existe|does not exist/i)
  })

  it('`public.purge_empty_guest_carts` es solo del servidor', async () => {
    const desdeAnon = await expectFailure(() => anon(`select public.purge_empty_guest_carts()`))
    expect(desdeAnon).toMatch(/permission denied|no existe|does not exist/i)

    const rows = await svc(`select public.purge_empty_guest_carts() as n`)
    expect(Number(rows[0]?.n)).toBe(0)
  })

  it('la purga programada borra lo mismo que la recogida, sin tope', async () => {
    const tokens: string[] = []
    for (let i = 0; i < 8; i += 1) tokens.push(await openGuestCart())
    await svc(
      `update public.carts
          set expires_at = now() - interval '2 days',
              last_activity_at = now() - interval '2 days',
              status = 'abandoned'
        where store_id = $1`,
      [storeA],
    )

    const rows = await svc(`select public.purge_empty_guest_carts() as n`)
    expect(Number(rows[0]?.n)).toBe(8)
    expect(await cartCount(storeA)).toBe(0)
  })
})
