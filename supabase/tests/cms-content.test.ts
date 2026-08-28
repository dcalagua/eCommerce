// @vitest-environment node
/**
 * P11-SaaS · El CMS contra Postgres REAL.
 *
 * Lo que estos tests defienden es exactamente el criterio de aceptación de la
 * fase —«el tenant cambia contenido sin deploy y sin ejecutar código
 * arbitrario»— partido en las cinco propiedades que lo sostienen:
 *
 *  · **resolución** — qué página gana para (tienda, canal, instante), con un
 *    orden TOTAL y reproducible;
 *  · **vigencia** — lo despublicado, lo programado y lo caducado no salen, y no
 *    salen del SERVIDOR: no se filtran en el navegador;
 *  · **sanitización** — el contenido enriquecido no es HTML y la base lo
 *    demuestra rechazando lo que no cabe en su vocabulario, incluso escrito por
 *    `service_role`;
 *  · **aislamiento** — un tenant no ve ni escribe el contenido de otro, y su
 *    vitrina no sirve la página del vecino;
 *  · **degradación** — sin `content.cms` la respuesta es `cms: false` y cero
 *    bloques, nunca un error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>
type Json = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const CMS = 'ecommerce.content.cms'

let storeA: string
let storeB: string
let channelB2c: string
let channelB2b: string
let catHogar: string
let jabon: string
let toalla: string
let segmento: string

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

/** La puerta ANÓNIMA de la vitrina. */
async function publicPage(slug = STORE_A_SLUG, page: string | null = null): Promise<Json> {
  const rows = await asRole(db, 'anon', null, () =>
    sql(`select public.store_page_for_slug($1, $2) as r`, [slug, page]),
  )
  return rows[0]?.r as Json
}

function blocks(result: Json): Json[] {
  return (result.blocks ?? []) as Json[]
}

function blockTitles(result: Json): string[] {
  return blocks(result).map((block) => String(block.title))
}

interface PageInput {
  slug: string
  kind?: 'home' | 'landing' | 'legal'
  status?: 'draft' | 'published' | 'archived'
  channel?: string | null
  priority?: number
  from?: string | null
  to?: string | null
  showInNav?: boolean
  store?: string
  tenant?: typeof TENANT_A
}

async function createPage(input: PageInput): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.content_pages
       (organization_id, company_id, store_id, slug, title, kind, status,
        channel_id, priority, publish_from, publish_to, show_in_nav)
     values ($1, $2, $3, $4, $5, $6::public.content_page_kind, $7::public.content_status,
             $8, $9, coalesce($10::timestamptz, now() - interval '1 day'), $11, $12)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA,
      input.slug, input.slug, input.kind ?? 'landing', input.status ?? 'published',
      input.channel ?? null, input.priority ?? 0, input.from ?? null, input.to ?? null,
      input.showInNav ?? false,
    ],
  )
}

interface BlockInput {
  page: string
  type?: string
  title?: string | null
  body?: string | null
  position?: number
  active?: boolean
  from?: string | null
  to?: string | null
  channel?: string | null
  segment?: string | null
  category?: string | null
  limit?: number
  store?: string
  tenant?: typeof TENANT_A
}

async function createBlock(input: BlockInput): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.content_blocks
       (organization_id, company_id, store_id, page_id, block_type, position,
        title, body, is_active, publish_from, publish_to, channel_id, segment_id,
        category_id, item_limit)
     values ($1, $2, $3, $4, $5::public.content_block_type, $6, $7, $8::jsonb, $9,
             coalesce($10::timestamptz, now() - interval '1 day'), $11, $12, $13, $14, $15)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.page,
      input.type ?? 'hero', input.position ?? 0, input.title ?? 'Bloque',
      input.body ?? null, input.active ?? true, input.from ?? null, input.to ?? null,
      input.channel ?? null, input.segment ?? null, input.category ?? null,
      input.limit ?? 8,
    ],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const [tenant, storeSlug] of [
    [TENANT_A, STORE_A_SLUG],
    [TENANT_B, STORE_B_SLUG],
  ] as const) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId, tenant.companyId, tenant.slug, tenant.slug,
      tenant.adminEmail, tenant.ownerId, storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)

  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, [CMS]],
    )
  }

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  const defaults = await svc(`select id, store_id from public.channels where is_default`)
  channelB2c = String(defaults.find((c) => c.store_id === storeA)?.id)

  channelB2b = await id(
    `insert into public.channels
       (organization_id, company_id, store_id, code, name, kind, is_default, requires_auth)
     values ($1, $2, $3, 'b2b', 'Mayoristas', 'b2b', false, true) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )

  catHogar = await id(
    `insert into public.categories (organization_id, company_id, store_id, slug, name)
     values ($1, $2, $3, 'hogar', 'Hogar') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )

  const insertProduct = `
    insert into public.products
      (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
       status, published_at, category_id)
    values ($1, $2, $3, $4, $5, $6, $7, 'PEN', $8, 'published', now() - interval '1 hour', $9)
    returning id`

  jabon = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-JABON', 'jabon', 'Jabón',
    '10.00', 100, catHogar,
  ])
  toalla = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-TOALLA', 'toalla', 'Toalla',
    '25.00', 100, catHogar,
  ])

  segmento = await id(
    `insert into public.customer_segments (organization_id, company_id, code, name)
     values ($1, $2, 'mayorista', 'Mayorista') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('resolucion de contenido por tienda, canal y vigencia', () => {
  it('la portada publicada sale por la puerta anonima y con sus bloques en orden', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    await createBlock({ page, title: 'Segundo', position: 2 })
    await createBlock({ page, title: 'Primero', position: 1 })

    const result = await publicPage()
    expect(result.cms).toBe(true)
    expect((result.page as Json).slug).toBe('inicio')
    expect(blockTitles(result)).toEqual(['Primero', 'Segundo'])

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('una pagina en BORRADOR no sale: el filtro esta en el servidor, no en el navegador', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home', status: 'draft' })
    await createBlock({ page, title: 'Secreto' })

    const result = await publicPage()
    expect(result.page).toBeNull()
    expect(blocks(result)).toEqual([])

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('una pagina programada para manana tampoco, y una caducada deja de salir', async () => {
    const futura = await createPage({
      slug: 'inicio', kind: 'home', from: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect((await publicPage()).page).toBeNull()
    await svc(`delete from public.content_pages where id = $1`, [futura])

    const caducada = await createPage({
      slug: 'inicio', kind: 'home',
      from: new Date(Date.now() - 172_800_000).toISOString(),
      to: new Date(Date.now() - 86_400_000).toISOString(),
    })
    expect((await publicPage()).page).toBeNull()
    await svc(`delete from public.content_pages where id = $1`, [caducada])
  })

  /**
   * El orden total de la resolución. Es lo que impide que la portada de una
   * tienda cambie sola: con dos candidatas empatadas, sin este orden el
   * resultado dependería del plan de ejecución de Postgres.
   */
  it('con dos portadas gana la del canal; y entre las de canal nulo, la de mas PRIORIDAD', async () => {
    const general = await createPage({ slug: 'general', kind: 'home', priority: 0 })
    const prioritaria = await createPage({ slug: 'prioritaria', kind: 'home', priority: 10 })
    expect(((await publicPage()).page as Json).slug).toBe('prioritaria')

    const delCanal = await createPage({
      slug: 'del-canal', kind: 'home', channel: channelB2c, priority: -50,
    })
    // Prioridad MENOR y aun así gana: la especificidad del canal manda sobre
    // `priority`, igual que en la precedencia del motor de precios de P04.
    expect(((await publicPage()).page as Json).slug).toBe('del-canal')

    await svc(`delete from public.content_pages where id = any($1)`, [
      [general, prioritaria, delCanal],
    ])
  })

  it('una portada de un canal que EXIGE sesion no la sirve la vitrina publica', async () => {
    const b2b = await createPage({ slug: 'solo-b2b', kind: 'home', channel: channelB2b })
    // El canal por defecto de la tienda es público; la página del canal cerrado
    // no alcanza a `anon` ni pidiéndolo por código.
    expect((await publicPage()).page).toBeNull()

    const rows = await asRole(db, 'anon', null, () =>
      sql(`select public.store_page_for_slug($1, null, 'b2b') as r`, [STORE_A_SLUG]),
    )
    expect(((rows[0]?.r as Json).page ?? null)).toBeNull()

    await svc(`delete from public.content_pages where id = $1`, [b2b])
  })

  it('una pagina de campana se pide por SU slug, y su bloque apagado no viaja', async () => {
    const page = await createPage({ slug: 'rebajas' })
    await createBlock({ page, title: 'Visible', position: 0 })
    await createBlock({ page, title: 'Apagado', position: 1, active: false })
    await createBlock({
      page, title: 'Caducado', position: 2,
      from: new Date(Date.now() - 172_800_000).toISOString(),
      to: new Date(Date.now() - 86_400_000).toISOString(),
    })

    const result = await publicPage(STORE_A_SLUG, 'rebajas')
    expect(blockTitles(result)).toEqual(['Visible'])

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('un bloque SEGMENTADO no lo ve el comprador anonimo, que no tiene segmento', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    await createBlock({ page, title: 'Para todos', position: 0 })
    await createBlock({ page, title: 'Solo mayoristas', position: 1, segment: segmento })

    expect(blockTitles(await publicPage())).toEqual(['Para todos'])

    // Y la vista previa del backoffice SÍ lo ve cuando declara el segmento: es
    // la misma función con otro argumento, no otra resolución.
    const preview = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`select public.content_preview($1, null, null, $2, false) as r`, [page, segmento]),
    )
    expect(
      ((preview[0]?.r as Json).blocks as Json[]).map((b) => String(b.title)),
    ).toEqual(['Para todos', 'Solo mayoristas'])

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('la navegacion solo trae lo publicado y marcado para el menu', async () => {
    const enMenu = await createPage({ slug: 'envios', showInNav: true })
    const fuera = await createPage({ slug: 'privada', showInNav: false })
    const borrador = await createPage({ slug: 'futura', showInNav: true, status: 'draft' })

    const rows = await asRole(db, 'anon', null, () =>
      sql(`select public.store_navigation_for_slug($1) as r`, [STORE_A_SLUG]),
    )
    const nav = (rows[0]?.r ?? []) as Json[]
    expect(nav.map((entry) => String(entry.slug))).toEqual(['envios'])

    await svc(`delete from public.content_pages where id = any($1)`, [[enMenu, fuera, borrador]])
  })
})

describe('colecciones: FK de verdad, no ids dentro de un jsonb', () => {
  it('la coleccion curada a mano manda, y respeta el orden que puso el comercio', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    const block = await createBlock({ page, type: 'product_collection', title: 'Destacados' })

    const addItem = `
      insert into public.content_block_items
        (organization_id, company_id, store_id, block_id, block_type, item_kind, product_id, position)
      values ($1, $2, $3, $4, 'product_collection', 'product', $5, $6)`
    await svc(addItem, [TENANT_A.organizationId, TENANT_A.companyId, storeA, block, toalla, 0])
    await svc(addItem, [TENANT_A.organizationId, TENANT_A.companyId, storeA, block, jabon, 1])

    const items = (blocks(await publicPage())[0]?.items ?? []) as Json[]
    expect(items.map((item) => String(item.slug))).toEqual(['toalla', 'jabon'])
    // El importe sale como TEXTO, nunca como número de JSON.
    expect(items[0]?.price).toBe('25.00')

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('borrar el producto se lleva su fila de la coleccion: no queda un hueco vivo', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    const block = await createBlock({ page, type: 'product_collection', title: 'Destacados' })
    const efimero = await id(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
          status, published_at)
       values ($1, $2, $3, 'A-EFIMERO', 'efimero', 'Efimero', '5.00', 'PEN', 10,
               'published', now() - interval '1 hour')
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    await svc(
      `insert into public.content_block_items
         (organization_id, company_id, store_id, block_id, block_type, item_kind, product_id, position)
       values ($1, $2, $3, $4, 'product_collection', 'product', $5, 0)`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, block, efimero],
    )

    await svc(`delete from public.products where id = $1`, [efimero])
    const left = await svc(`select count(*)::int as n from public.content_block_items where block_id = $1`, [block])
    expect(left[0]?.n).toBe(0)

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('sin items curados y CON categoria, la coleccion se llena sola con lo publicado', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    await createBlock({
      page, type: 'product_collection', title: 'De hogar', category: catHogar, limit: 10,
    })

    const items = (blocks(await publicPage())[0]?.items ?? []) as Json[]
    expect(items.map((item) => String(item.slug)).sort()).toEqual(['jabon', 'toalla'])

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('un item de un tipo de bloque que no lleva lista se rechaza', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    const hero = await createBlock({ page, type: 'hero', title: 'Hola' })

    const message = await expectFailure(() =>
      svc(
        `insert into public.content_block_items
           (organization_id, company_id, store_id, block_id, block_type, item_kind, product_id, position)
         values ($1, $2, $3, $4, 'hero', 'product', $5, 0)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, hero, jabon],
      ),
    )
    expect(message).toMatch(/content_block_items_block_kind|violates check/i)

    await svc(`delete from public.content_pages where id = $1`, [page])
  })
})

describe('el contenido enriquecido NO es HTML, y la base lo demuestra', () => {
  async function insertBody(body: string): Promise<string> {
    const page = await createPage({ slug: 'texto' })
    try {
      return await expectFailure(() =>
        svc(
          `insert into public.content_blocks
             (organization_id, company_id, store_id, page_id, block_type, body)
           values ($1, $2, $3, $4, 'rich_text', $5::jsonb)`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA, page, body],
        ),
      )
    } finally {
      await svc(`delete from public.content_pages where id = $1`, [page])
    }
  }

  it('acepta el documento del vocabulario y lo devuelve tal cual', async () => {
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    const doc = JSON.stringify([
      { type: 'heading', level: 2, text: 'Envíos' },
      { type: 'paragraph', text: 'Llegamos a todo el país.', href: '/s/tienda-a/p/envios', linkLabel: 'Ver zonas' },
      { type: 'list', items: ['Lima en 24 h', 'Provincia en 72 h'] },
      { type: 'quote', text: 'Sin coste desde 200.' },
    ])
    await svc(
      `insert into public.content_blocks
         (organization_id, company_id, store_id, page_id, block_type, title, body)
       values ($1, $2, $3, $4, 'rich_text', 'Envios', $5::jsonb)`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, page, doc],
    )

    const body = blocks(await publicPage())[0]?.body as Json[]
    expect(body).toHaveLength(4)
    expect(body[0]).toMatchObject({ type: 'heading', level: 2 })

    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  /**
   * Ocho formas de intentar meter algo que no es contenido. Ninguna entra, y
   * ninguna la para el navegador: las para el CHECK, así que tampoco entran por
   * PostgREST con un token robado ni por un script del propio operador.
   */
  it.each([
    ['una etiqueta de script como texto', '[{"type":"paragraph","text":"<script>alert(1)</script>"}]'],
    ['una etiqueta cualquiera', '[{"type":"paragraph","text":"hola <b>mundo</b>"}]'],
    ['un manejador de evento como clave', '[{"type":"paragraph","text":"hola","onclick":"x()"}]'],
    ['un tipo de nodo inventado', '[{"type":"iframe","text":"hola"}]'],
    ['un enlace javascript:', '[{"type":"paragraph","text":"hola","href":"javascript:alert(1)"}]'],
    ['un enlace data:', '[{"type":"paragraph","text":"hola","href":"data:text/html,<b>x</b>"}]'],
    ['un enlace protocolo-relativo', '[{"type":"paragraph","text":"hola","href":"//otro.test/x"}]'],
    ['un documento que no es un array', '{"type":"paragraph","text":"hola"}'],
    ['un nodo sin texto', '[{"type":"paragraph"}]'],
    ['un titular de nivel 1', '[{"type":"heading","level":1,"text":"hola"}]'],
  ])('rechaza %s', async (_label, body) => {
    expect(await insertBody(body)).toMatch(/content_blocks_body_safe|violates check/i)
  })

  it('rechaza tambien a service_role: no es una validacion de pantalla', async () => {
    const message = await insertBody('[{"type":"paragraph","text":"<img src=x onerror=y>"}]')
    expect(message).toMatch(/violates check/i)
  })

  it('el enlace del boton pasa por la misma lista blanca', async () => {
    const page = await createPage({ slug: 'cta' })
    const message = await expectFailure(() =>
      svc(
        `insert into public.content_blocks
           (organization_id, company_id, store_id, page_id, block_type, title, cta_label, cta_href)
         values ($1, $2, $3, $4, 'banner', 'Oferta', 'Ver', 'javascript:alert(1)')`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, page],
      ),
    )
    expect(message).toMatch(/content_blocks_cta_href_safe|violates check/i)
    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('`settings` tiene vocabulario CERRADO: una clave desconocida no entra', async () => {
    const page = await createPage({ slug: 'ajustes' })
    const message = await expectFailure(() =>
      svc(
        `insert into public.content_blocks
           (organization_id, company_id, store_id, page_id, block_type, title, settings)
         values ($1, $2, $3, $4, 'hero', 'Hola', '{"script":"https://malo.test/x.js"}'::jsonb)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, page],
      ),
    )
    expect(message).toMatch(/content_blocks_settings_safe|violates check/i)
    await svc(`delete from public.content_pages where id = $1`, [page])
  })

  it('un bloque sin la forma de su tipo no se guarda', async () => {
    const page = await createPage({ slug: 'forma' })
    const message = await expectFailure(() =>
      svc(
        `insert into public.content_blocks
           (organization_id, company_id, store_id, page_id, block_type)
         values ($1, $2, $3, $4, 'hero')`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, page],
      ),
    )
    expect(message).toMatch(/content_blocks_shape|violates check/i)
    await svc(`delete from public.content_pages where id = $1`, [page])
  })
})

describe('aislamiento entre tenants', () => {
  it('A no ve ni escribe el contenido de B', async () => {
    const pageB = await createPage({
      slug: 'solo-de-b', kind: 'home', store: storeB, tenant: TENANT_B,
    })
    await createBlock({ page: pageB, title: 'De B', store: storeB, tenant: TENANT_B })

    const visto = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`select count(*)::int as n from public.content_pages`),
    )
    expect(visto[0]?.n).toBe(0)

    // Un UPDATE que la RLS filtra NO lanza: afecta a cero filas. Lo que se
    // comprueba es lo que importa —que el titulo de B sigue siendo el suyo—,
    // porque un test que espere una excepcion pasaria tambien si la policy
    // dejara ver la fila y fallara por otro motivo.
    const cambiadas = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`update public.content_pages set title = 'robado' where id = $1 returning id`, [pageB]),
    )
    expect(cambiadas).toEqual([])

    const sigue = await svc(`select title from public.content_pages where id = $1`, [pageB])
    expect(sigue[0]?.title).toBe('solo-de-b')

    await svc(`delete from public.content_pages where id = $1`, [pageB])
  })

  it('la vitrina de A nunca sirve la pagina de B, ni pidiendola por su slug', async () => {
    const pageB = await createPage({ slug: 'exclusiva', store: storeB, tenant: TENANT_B })
    await createBlock({ page: pageB, title: 'De B', store: storeB, tenant: TENANT_B })

    expect((await publicPage(STORE_A_SLUG, 'exclusiva')).page).toBeNull()
    expect(((await publicPage(STORE_B_SLUG, 'exclusiva')).page as Json).slug).toBe('exclusiva')

    await svc(`delete from public.content_pages where id = $1`, [pageB])
  })

  it('la vista previa de una pagina ajena responde SIN_PERMISO, no el contenido', async () => {
    const pageB = await createPage({
      slug: 'privada-de-b', kind: 'home', store: storeB, tenant: TENANT_B,
    })

    const message = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      expectFailure(() => sql(`select public.content_preview($1) as r`, [pageB])),
    )
    expect(message).toMatch(/SIN_PERMISO/)

    await svc(`delete from public.content_pages where id = $1`, [pageB])
  })

  it('`anon` no tiene ni un GRANT sobre las tres tablas del CMS', async () => {
    const rows = await sql(`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('content_pages', 'content_blocks', 'content_block_items')
        and grantee in ('anon', 'PUBLIC')
    `)
    expect(rows).toEqual([])
  })

  it('`anon` no puede ejecutar la vista previa ni conociendo el uuid', async () => {
    const rows = await sql(`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.rolname = 'anon'
      where n.nspname = 'public'
        and p.proname = 'content_preview'
        and has_function_privilege(r.oid, p.oid, 'EXECUTE')
    `)
    expect(rows).toEqual([])
  })
})

describe('escritura: rol Y capacidad', () => {
  it('un miembro sin rol de administracion no crea paginas', async () => {
    // El rol lo decide la MEMBRESIA de la base (`ebim.has_role`), no el claim
    // del JWT: por eso aqui se da de alta un miembro real con rol `catalog` en
    // vez de retocar los claims. Cambiar solo el token no cambiaria nada, y un
    // test que lo hiciera daria por probado un permiso que no se comprobo.
    const otro = '0a000000-0000-4000-8000-0000000000a9'
    await svc(
      `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
       values ($1, $2, $3, 'catalogo@tenant-a.com', 'catalog')`,
      [TENANT_A.organizationId, TENANT_A.companyId, otro],
    )

    const claims = claimsFor(TENANT_A, {
      sub: otro,
      email: 'catalogo@tenant-a.com',
      companies: [{ id: TENANT_A.companyId, role: 'catalog' }],
    })
    const message = await asRole(db, 'authenticated', claims, () =>
      expectFailure(() =>
        sql(
          `insert into public.content_pages
             (organization_id, company_id, store_id, slug, title)
           values ($1, $2, $3, 'intruso', 'Intruso')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)

    await svc(`delete from public.tenant_members where user_id = $1`, [otro])
  })

  it('sin la capacidad `content.cms` no se escribe, aunque el rol sea owner', async () => {
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [TENANT_A.organizationId, TENANT_A.companyId, []],
    )

    const message = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      expectFailure(() =>
        sql(
          `insert into public.content_pages
             (organization_id, company_id, store_id, slug, title)
           values ($1, $2, $3, 'sin-addon', 'Sin addon')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)

    // Y la vitrina se DEGRADA en vez de fallar: cms:false y cero bloques.
    const page = await createPage({ slug: 'inicio', kind: 'home' })
    await createBlock({ page, title: 'Invisible' })
    const result = await publicPage()
    expect(result.cms).toBe(false)
    expect(blocks(result)).toEqual([])
    expect(result.page).toBeNull()

    // Pero se sigue VIENDO en el backoffice: dar de baja un módulo no puede
    // parecer una pérdida de datos (misma decisión que P04 y P10).
    const visible = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`select count(*)::int as n from public.content_pages`),
    )
    expect(visible[0]?.n).toBeGreaterThan(0)

    await svc(`delete from public.content_pages where id = $1`, [page])
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [TENANT_A.organizationId, TENANT_A.companyId, [CMS]],
    )
  })
})

describe('la vista del backoffice dice el estado EFECTIVO', () => {
  it('publicada con fecha futura es `scheduled`; caducada es `expired`', async () => {
    const viva = await createPage({ slug: 'viva' })
    const programada = await createPage({
      slug: 'programada', from: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const caducada = await createPage({
      slug: 'caducada',
      from: new Date(Date.now() - 172_800_000).toISOString(),
      to: new Date(Date.now() - 86_400_000).toISOString(),
    })
    const borrador = await createPage({ slug: 'borrador', status: 'draft' })

    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`select slug, effective_status from public.content_page_overview order by slug`),
    )
    const byslug = Object.fromEntries(rows.map((r) => [r.slug, r.effective_status]))
    expect(byslug.viva).toBe('live')
    expect(byslug.programada).toBe('scheduled')
    expect(byslug.caducada).toBe('expired')
    expect(byslug.borrador).toBe('draft')

    await svc(`delete from public.content_pages where id = any($1)`, [
      [viva, programada, caducada, borrador],
    ])
  })

  it('cuenta los bloques VIGENTES, no solo los activos', async () => {
    const page = await createPage({ slug: 'contadores' })
    await createBlock({ page, title: 'Vivo', position: 0 })
    await createBlock({ page, title: 'Apagado', position: 1, active: false })
    await createBlock({
      page, title: 'Programado', position: 2,
      from: new Date(Date.now() + 86_400_000).toISOString(),
    })

    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(
        `select block_count, active_block_count, live_block_count
           from public.content_page_overview where id = $1`,
        [page],
      ),
    )
    expect(Number(rows[0]?.block_count)).toBe(3)
    expect(Number(rows[0]?.active_block_count)).toBe(2)
    expect(Number(rows[0]?.live_block_count)).toBe(1)

    await svc(`delete from public.content_pages where id = $1`, [page])
  })
})
