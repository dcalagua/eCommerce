// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * El árbol de categorías, contra Postgres real.
 *
 * `parent_id` existía desde P02 y nadie lo escribía. Antes de dejar construir
 * jerarquías hay que demostrar las dos barandillas, porque las dos rompen
 * CONSULTAS y no datos: un ciclo cuelga cualquier recorrido recursivo —incluido
 * el que la vitrina usa para «esta categoría y todo lo que cuelga»— y un árbol
 * sin tope es un menú que nadie navega.
 *
 * Se prueba también `ebim.category_subtree`, que es la pieza de la que depende
 * la fase siguiente: sin ella, abrir una madre en la vitrina devuelve cero
 * productos, porque los productos cuelgan de las hijas.
 */

let db: PGlite

const STORE = 'd0000000-0000-4000-8000-0000000000a1'

async function sql(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

/** Crea una categoría y devuelve su id. `parent` null = raíz. */
async function crear(name: string, parent: string | null): Promise<string> {
  const rows = await sql(
    `insert into public.categories (organization_id, company_id, store_id, parent_id, slug, name)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, parent, name],
  )
  return rows[0]?.id as string
}

beforeAll(async () => {
  db = await createTestDatabase()
  await sql(
    `insert into public.tenants (organization_id, slug, name, admin_email, status)
     values ($1, 'arbol', 'Arbol', 'admin@arbol.test', 'active')`,
    [TENANT_A.organizationId],
  )
  await sql(
    `insert into public.stores (id, organization_id, company_id, slug, name, status, currency)
     values ($1, $2, $3, 'arbol', 'Arbol', 'active', 'PEN')`,
    [STORE, TENANT_A.organizationId, TENANT_A.companyId],
  )
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('el árbol de categorías', () => {
  it('admite tres niveles: raíz, hija y nieta', async () => {
    const raiz = await crear('salud', null)
    const hija = await crear('nervioso', raiz)
    const nieta = await crear('analgesicos', hija)

    const rows = await sql(`select id, parent_id from public.categories where id = $1`, [nieta])
    expect(rows[0]?.parent_id).toBe(hija)
  })

  it('rechaza el CUARTO nivel: un menú de cuatro saltos no lo navega nadie', async () => {
    const raiz = await crear('cuidado', null)
    const hija = await crear('cabello', raiz)
    const nieta = await crear('champus', hija)

    const message = await expectFailure(() => crear('anticaspa', nieta))
    expect(message).toMatch(/CATEGORIA_PROFUNDIDAD/)
  })

  it('rechaza el ciclo directo: una madre no cuelga de su hija', async () => {
    const raiz = await crear('higiene', null)
    const hija = await crear('jabones', raiz)

    const message = await expectFailure(() =>
      sql(`update public.categories set parent_id = $1 where id = $2`, [hija, raiz]),
    )
    expect(message).toMatch(/CATEGORIA_CICLO/)
  })

  it('rechaza el ciclo LARGO, que es el que nadie ve venir', async () => {
    const a = await crear('a', null)
    const b = await crear('b', a)
    const c = await crear('c', b)

    // A → B → C → A. El guard de `categories_not_self` no lo ve: ninguna fila
    // es su propia madre.
    const message = await expectFailure(() =>
      sql(`update public.categories set parent_id = $1 where id = $2`, [c, a]),
    )
    expect(message).toMatch(/CATEGORIA_CICLO/)
  })

  /**
   * Mover una rama es la operación que revienta el tope sin que el nodo movido
   * cambie de profundidad: lo que no cabe es lo que viaja colgando de él.
   */
  it('al MOVER una rama cuenta lo que cuelga, no solo dónde cae', async () => {
    const raiz = await crear('raiz-m', null)
    const hija = await crear('hija-m', raiz)
    const suelta = await crear('suelta-m', null)
    await crear('nieta-suelta-m', suelta)

    // `suelta` solo baja un nivel, pero se lleva a su hija: serían cuatro.
    const message = await expectFailure(() =>
      sql(`update public.categories set parent_id = $1 where id = $2`, [hija, suelta]),
    )
    expect(message).toMatch(/CATEGORIA_PROFUNDIDAD/)
  })

  it('`category_subtree` devuelve la categoría y toda su descendencia', async () => {
    const raiz = await crear('sub-raiz', null)
    const hija = await crear('sub-hija', raiz)
    const nieta = await crear('sub-nieta', hija)
    await crear('sub-otra', null)

    const rows = await sql(`select category_id from ebim.category_subtree($1)`, [raiz])
    const ids = rows.map((row) => row.category_id)

    expect(ids).toHaveLength(3)
    expect(ids).toEqual(expect.arrayContaining([raiz, hija, nieta]))
  })

  it('una hoja se devuelve a sí misma: quien pregunta no tiene que distinguir', async () => {
    const hoja = await crear('hoja-sola', null)

    const rows = await sql(`select category_id from ebim.category_subtree($1)`, [hoja])
    expect(rows.map((row) => row.category_id)).toEqual([hoja])
  })

  it('borrar la madre sube a las hijas a raíz, no se las lleva por delante', async () => {
    const raiz = await crear('borrable', null)
    const hija = await crear('superviviente', raiz)

    await sql(`delete from public.categories where id = $1`, [raiz])

    const rows = await sql(`select parent_id from public.categories where id = $1`, [hija])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.parent_id).toBeNull()
  })
})

/**
 * La herencia (fase 2): abrir una madre enseña lo que cuelga, y apagar una rama
 * la apaga entera. Son las dos reglas que convierten el árbol en algo que el
 * comprador nota.
 */
describe('la herencia del árbol', () => {
  it('la búsqueda por una madre devuelve los productos de sus hijas', async () => {
    const raiz = await crear('nutricion', null)
    const hija = await crear('leches', raiz)

    // El producto cuelga de la HIJA. Antes de la fase 2, abrir la madre daba 0.
    await sql(
      `insert into public.products (organization_id, company_id, store_id, category_id, sku, slug, name,
                                    price, currency, stock, status, published_at)
       values ($1, $2, $3, $4, 'LECHE-1', 'leche-1', 'Formula infantil',
               '50.00', 'PEN', 10, 'published', now() - interval '1 day')`,
      [TENANT_A.organizationId, TENANT_A.companyId, STORE, hija],
    )

    const madre = await sql(
      `select ebim.search_catalog($1, null, jsonb_build_object('category', 'nutricion'),
                                  'relevance', 24, 0, false) as r`,
      [STORE],
    )
    const rHija = await sql(
      `select ebim.search_catalog($1, null, jsonb_build_object('category', 'leches'),
                                  'relevance', 24, 0, false) as r`,
      [STORE],
    )

    expect((madre[0]?.r as { total: number }).total).toBe(1)
    expect((rHija[0]?.r as { total: number }).total).toBe(1)
  })

  it('un slug que no existe sigue sin devolver nada, no todo', async () => {
    const rows = await sql(
      `select ebim.search_catalog($1, null, jsonb_build_object('category', 'no-existe'),
                                  'relevance', 24, 0, false) as r`,
      [STORE],
    )
    expect((rows[0]?.r as { total: number }).total).toBe(0)
  })

  it('apagar una madre la quita de la vitrina CON sus hijas', async () => {
    const raiz = await crear('visible-raiz', null)
    const hija = await crear('visible-hija', raiz)

    const antes = await sql(
      `select count(*)::int as n from public.public_categories where category_id in ($1, $2)`,
      [raiz, hija],
    )
    expect(antes[0]?.n).toBe(2)

    await sql(`update public.categories set is_active = false where id = $1`, [raiz])

    // La hija sigue activa en su fila, pero ya no es alcanzable: sin esto
    // aparecia en la vitrina y ademas como si fuera raiz.
    const despues = await sql(
      `select count(*)::int as n from public.public_categories where category_id in ($1, $2)`,
      [raiz, hija],
    )
    expect(despues[0]?.n).toBe(0)
  })
})

/**
 * La fase 3: las reglas de negocio heredan SOLO si lo dicen.
 *
 * Cambiar la semántica por debajo ampliaría campañas ya aprobadas a productos
 * que nadie revisó cuando se autorizaron. Por eso `include_descendants` nace
 * apagada y lo guardado sigue significando lo que significaba.
 */
describe('las reglas de negocio y la rama', () => {
  /** Una campaña mínima que pase `promotions_kind_shape`. */
  async function promocion(code: string): Promise<{ id: string; kind: string }> {
    const rows = await sql(
      `insert into public.promotions (organization_id, company_id, store_id, code, name, kind, status,
                                      priority, requires_coupon, value_percent, valid_from)
       values ($1, $2, $3, $4, $4, 'percentage', 'active', 10, false, 10, now())
       returning id, kind`,
      [TENANT_A.organizationId, TENANT_A.companyId, STORE, code],
    )
    return { id: rows[0]?.id as string, kind: rows[0]?.kind as string }
  }

  async function alcance(promo: { id: string; kind: string }, categoria: string, hereda: boolean) {
    const rows = await sql(
      `insert into public.promotion_scopes (organization_id, company_id, store_id, promotion_id,
                                            promotion_kind, scope_kind, category_id, include_descendants)
       values ($1, $2, $3, $4, $5::public.promotion_kind, 'category', $6, $7)
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, STORE, promo.id, promo.kind, categoria, hereda],
    )
    return rows[0]?.id as string
  }

  async function aplica(scopeId: string, categoriaLinea: string): Promise<boolean> {
    const rows = await sql(
      `select ebim.promotion_scope_matches(s, null, null, $2, null) as aplica
         from public.promotion_scopes s where s.id = $1`,
      [scopeId, categoriaLinea],
    )
    return rows[0]?.aplica as boolean
  }

  it('un alcance de categoría NO hereda por defecto', async () => {
    const raiz = await crear('promo-raiz', null)
    const hija = await crear('promo-hija', raiz)
    const scope = await alcance(await promocion('sin-rama'), raiz, false)

    // La línea cuelga de la HIJA: con la casilla apagada, la campaña de la
    // madre no la toca. Es lo que significaba el día que se guardó.
    expect(await aplica(scope, hija)).toBe(false)
    expect(await aplica(scope, raiz)).toBe(true)
  })

  it('y hereda en cuanto el alcance lo pide', async () => {
    const raiz = await crear('promo-raiz2', null)
    const hija = await crear('promo-hija2', raiz)
    const scope = await alcance(await promocion('con-rama'), raiz, true)

    expect(await aplica(scope, hija)).toBe(true)
  })

  /**
   * La casilla solo significa algo en un alcance de categoría. Encendida en uno
   * de marca sería un dato que miente: alguien la vería puesta y creería que
   * hace algo.
   */
  it('la casilla no se puede encender en un alcance que no es de categoría', async () => {
    const promo = await promocion('marca-rama')

    const message = await expectFailure(() =>
      sql(
        `insert into public.promotion_scopes (organization_id, company_id, store_id, promotion_id,
                                              promotion_kind, scope_kind, brand_id, include_descendants)
         values ($1, $2, $3, $4, $5::public.promotion_kind, 'brand', gen_random_uuid(), true)`,
        [TENANT_A.organizationId, TENANT_A.companyId, STORE, promo.id, promo.kind],
      ),
    )
    expect(message).toMatch(/promotion_scopes_descendants_only_category|violates check/i)
  })

  it('`descendants` es una clave admitida en los ajustes de un bloque', async () => {
    const rows = await sql(
      `select ebim.content_settings_are_safe('{"descendants": true}'::jsonb) as ok,
              ebim.content_settings_are_safe('{"inventada": true}'::jsonb)   as no`,
    )
    expect(rows[0]?.ok).toBe(true)
    expect(rows[0]?.no).toBe(false)
  })
})
