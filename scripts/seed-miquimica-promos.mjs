#!/usr/bin/env node
/**
 * Ofertas y promociones de demostracion sobre el catalogo REAL de MiQuimica.
 *
 * ## Que ensena, y por que estas cuatro
 *
 * No son cuatro promociones al azar: son las cuatro formas que su ERP ya usa y
 * que aparecen en su propio modelo de producto (`itemsScales`, `itemsBonuses`).
 * Si en la demo alguien pregunta «¿y nuestras escalas?», la respuesta esta en
 * pantalla:
 *
 *   1. `dermo-20`   — 20 % sobre una CATEGORIA. La oferta de toda la vida.
 *   2. `escala-adium` — ESCALA por volumen sobre una marca: 6→5 %, 12→10 %,
 *      24→15 %. Es su «escala de descuentos», con el motor de verdad.
 *   3. `nutri-3x2`  — LLEVA 3, PAGA 2 sobre otra marca. Su «bonificacion».
 *   4. `bienvenida` — CUPON del 10 %, que exige codigo y no se anuncia solo.
 *
 * ## Dos capas distintas, y no hay que confundirlas
 *
 * - **La rebaja de catalogo** (`compare_at_price`) es una etiqueta: pinta el
 *   «−20 %» y el precio tachado en la rejilla. Es lo que se VE.
 * - **La promocion** la aplica el motor al calcular el carrito. Es lo que se
 *   COBRA.
 *
 * Aqui se siembran las dos porque una demo necesita que se vea y que cuadre,
 * pero son cosas distintas: la primera vive en el producto y la segunda en su
 * propio motor con sus alcances, sus topes y su vigencia.
 *
 * Idempotente: las promociones se identifican por `code` y los bloques por su
 * titulo; correrlo dos veces no duplica nada.
 *
 *   node scripts/seed-miquimica-promos.mjs --check
 *   node scripts/seed-miquimica-promos.mjs
 *   node scripts/seed-miquimica-promos.mjs --clear   (quita lo que sembro)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'
/** Cuantos productos del catalogo salen con precio tachado. */
const REBAJADOS = 60

function env() {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8')
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const i = line.indexOf('=')
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
      }),
  )
}

async function sql(query, cfg) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${cfg.ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 600)}`)
  return JSON.parse(text)
}

function lit(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const clear = args.includes('--clear')

  const values = env()
  const cfg = {
    ref: new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0],
    token: values.SUPABASE_ACCESS_TOKEN,
  }

  const [store] = await sql(
    `select id, organization_id, company_id from public.stores where slug = ${lit(STORE_SLUG)}`,
    cfg,
  )
  if (!store) throw new Error(`No existe la tienda ${STORE_SLUG}`)
  const tenant = `${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)}`

  const codigos = ['dermo-20', 'escala-adium', 'nutri-3x2']

  if (clear) {
    await sql(
      `delete from public.promotions
        where store_id = ${lit(store.id)} and code in (${codigos.map(lit).join(', ')})`,
      cfg,
    )
    await sql(
      `delete from public.content_blocks
        where store_id = ${lit(store.id)}
          and title in ('Ofertas de la semana', 'Semana dermocosmetica',
                        'Lleva 3, paga 2', 'Escala por volumen Adium')`,
      cfg,
    )
    await sql(
      `update public.products set compare_at_price = null
        where store_id = ${lit(store.id)} and sku like 'QS-%'`,
      cfg,
    )
    console.log('Ofertas retiradas.')
    return
  }

  // ---- A quien apunta cada promocion: marcas y categorias REALES ---------
  const [dermo] = await sql(
    `select id, name from public.categories
      where store_id = ${lit(store.id)} and name ilike '%piel%' order by name limit 1`,
    cfg,
  )
  const [adium] = await sql(`select id, name from public.brands where name ilike 'adium' limit 1`, cfg)
  const [abbott] = await sql(
    `select id, name from public.brands where name ilike '%abbott%' limit 1`,
    cfg,
  )

  if (check) {
    console.log('Alcances que se usarian:')
    console.log('  categoria dermo :', dermo?.name ?? '(no encontrada)')
    console.log('  marca escala    :', adium?.name ?? '(no encontrada)')
    console.log('  marca 3x2       :', abbott?.name ?? '(no encontrada)')
    const [{ n }] = await sql(
      `select count(*)::int as n from public.products
        where store_id = ${lit(store.id)} and sku like 'QS-%' and status = 'published'`,
      cfg,
    )
    console.log(`  ${REBAJADOS} de ${n} productos saldrian con precio tachado`)
    return
  }

  // ---- 1. Rebaja de catalogo: lo que se VE en la rejilla ------------------
  //
  // `compare_at_price` se calcula HACIA ARRIBA desde el precio actual, no al
  // reves: el precio que cobra la tienda no se toca. Lo que se anade es el
  // «antes» que justifica el porcentaje.
  const [rebaja] = await sql(
    `with elegidos as (
       select id, row_number() over (order by md5(id::text)) as fila
         from public.products
        where store_id = ${lit(store.id)} and sku like 'QS-%' and status = 'published'
        limit ${REBAJADOS}
     ), actualizados as (
       update public.products p
          set compare_at_price = round(p.price / (1 - (case e.fila % 4
                when 0 then 0.10 when 1 then 0.15 when 2 then 0.20 else 0.25 end)), 2)
         from elegidos e
        where p.id = e.id
        returning 1
     ) select count(*)::int as n from actualizados`,
    cfg,
  )
  console.log(`Rebajas de catalogo: ${rebaja.n} productos con precio tachado`)

  // ---- 2. Las promociones del motor --------------------------------------
  const promos = [
    {
      code: 'dermo-20',
      name: 'Semana dermocosmetica',
      description: '20 % en cuidado de la piel, sin cupon.',
      kind: 'percentage',
      value_percent: 20,
      scope: dermo ? { scope_kind: 'category', category_id: dermo.id } : null,
      tiers: [],
    },
    {
      code: 'escala-adium',
      name: 'Escala por volumen Adium',
      description: 'Mas unidades, mejor precio: 6 → 5 %, 12 → 10 %, 24 → 15 %.',
      kind: 'volume_tier',
      value_percent: null,
      scope: adium ? { scope_kind: 'brand', brand_id: adium.id } : null,
      tiers: [
        { min_quantity: 6, discount_percent: 5 },
        { min_quantity: 12, discount_percent: 10 },
        { min_quantity: 24, discount_percent: 15 },
      ],
    },
    {
      code: 'nutri-3x2',
      name: 'Lleva 3, paga 2',
      description: 'Bonificacion en linea nutricional.',
      kind: 'x_for_y',
      value_percent: null,
      buy_quantity: 3,
      free_quantity: 1,
      scope: abbott ? { scope_kind: 'brand', brand_id: abbott.id } : null,
      tiers: [],
    },
  ]

  for (const promo of promos) {
    if (!promo.scope) {
      console.log(`  – ${promo.code}: sin alcance (marca o categoria no encontrada), se omite`)
      continue
    }
    const id = randomUUID()
    await sql(
      `insert into public.promotions
         (id, organization_id, company_id, store_id, code, name, description, kind, status,
          priority, requires_coupon, value_percent, buy_quantity, free_quantity, valid_from, valid_to)
       values (${lit(id)}, ${tenant}, ${lit(promo.code)}, ${lit(promo.name)},
               ${lit(promo.description)}, ${lit(promo.kind)}::promotion_kind, 'active'::promotion_status,
               10, false, ${lit(promo.value_percent)}, ${lit(promo.buy_quantity ?? null)},
               ${lit(promo.free_quantity ?? null)}, now() - interval '1 day', now() + interval '30 days')
       on conflict do nothing`,
      cfg,
    )

    const [row] = await sql(
      `select id from public.promotions where store_id = ${lit(store.id)} and code = ${lit(promo.code)}`,
      cfg,
    )
    if (!row) continue

    await sql(
      `insert into public.promotion_scopes
         (organization_id, company_id, store_id, promotion_id, promotion_kind, scope_kind,
          category_id, brand_id)
       select ${tenant}, ${lit(row.id)}, ${lit(promo.kind)}::promotion_kind,
              ${lit(promo.scope.scope_kind)}::promotion_scope_kind,
              ${lit(promo.scope.category_id ?? null)}, ${lit(promo.scope.brand_id ?? null)}
        where not exists (
          select 1 from public.promotion_scopes s where s.promotion_id = ${lit(row.id)}
        )`,
      cfg,
    )

    for (const tier of promo.tiers) {
      await sql(
        `insert into public.promotion_tiers
           (organization_id, company_id, store_id, promotion_id, promotion_kind, min_quantity, discount_percent)
         select ${tenant}, ${lit(row.id)}, ${lit(promo.kind)}::promotion_kind,
                ${lit(tier.min_quantity)}, ${lit(tier.discount_percent)}
          where not exists (
            select 1 from public.promotion_tiers t
             where t.promotion_id = ${lit(row.id)} and t.min_quantity = ${lit(tier.min_quantity)}
          )`,
        cfg,
      )
    }
    console.log(`  ✓ ${promo.code}  ${promo.name}`)
  }

  // El cupon de bienvenida ya existe en la semilla: se activa, que es lo que
  // hace falta para poder teclearlo en el checkout durante la demo.
  await sql(
    `update public.promotions set status = 'active'::promotion_status,
            valid_from = now() - interval '1 day', valid_to = now() + interval '30 days'
      where store_id = ${lit(store.id)} and code in ('bienvenida', 'ahorro-150')`,
    cfg,
  )

  // ---- 3. Como se ensena en la portada ------------------------------------
  const [pagina] = await sql(
    `select id from public.content_pages where store_id = ${lit(store.id)} and slug = 'inicio'`,
    cfg,
  )
  const [promoDermo] = await sql(
    `select id from public.promotions where store_id = ${lit(store.id)} and code = 'dermo-20'`,
    cfg,
  )

  if (pagina && promoDermo) {
    // Bloque de campana: lo primero bajo la portada. `promotion_id` es lo que
    // hace que la vitrina pueda decir «esta descontando AHORA» sin que nadie
    // mantenga esa frase a mano.
    await sql(
      `insert into public.content_blocks
         (organization_id, company_id, store_id, page_id, block_type, position, title, subtitle,
          cta_label, cta_href, promotion_id, is_active)
       select ${tenant}, ${lit(pagina.id)}, 'campaign'::content_block_type, 15,
              'Semana dermocosmetica', '20 % en cuidado de la piel. Sin cupon: el descuento se aplica solo.',
              'Ver la seleccion', ${lit(`/s/${STORE_SLUG}`)}, ${lit(promoDermo.id)}, true
        where not exists (
          select 1 from public.content_blocks b
           where b.store_id = ${lit(store.id)} and b.title = 'Semana dermocosmetica'
        )`,
      cfg,
    )

    // Las OTRAS dos campanas automaticas, en las posiciones de al lado.
    //
    // Contiguas a proposito: la vitrina agrupa las campanas CONSECUTIVAS en un
    // mural de tarjetas, asi que 15-16-17 se ven en fila y comparables. Una
    // campana suelta entre medias rompe la fila, que es justo lo que se quiere
    // cuando el editor decide separarlas.
    //
    // No entran aqui `bienvenida` ni `andino-8`: exigen cupon, y anunciar en la
    // portada un descuento que no se aplica solo es como se pierde la venta en
    // el carrito.
    const murales = [
      {
        code: 'nutri-3x2',
        title: 'Lleva 3, paga 2',
        subtitle: 'La tercera unidad sale gratis en nutricion Abbott.',
        position: 16,
      },
      {
        code: 'escala-adium',
        title: 'Escala por volumen Adium',
        subtitle: 'Cuanto mas llevas, menos pagas por unidad. Sin cupon.',
        position: 17,
      },
    ]

    for (const mural of murales) {
      const [promo] = await sql(
        `select id from public.promotions
          where store_id = ${lit(store.id)} and code = ${lit(mural.code)} and status = 'active'`,
        cfg,
      )
      if (!promo) continue

      await sql(
        `insert into public.content_blocks
           (organization_id, company_id, store_id, page_id, block_type, position, title, subtitle,
            cta_label, cta_href, promotion_id, is_active)
         select ${tenant}, ${lit(pagina.id)}, 'campaign'::content_block_type, ${mural.position},
                ${lit(mural.title)}, ${lit(mural.subtitle)},
                'Ver los productos', ${lit(`/s/${STORE_SLUG}`)}, ${lit(promo.id)}, true
          where not exists (
            select 1 from public.content_blocks b
             where b.store_id = ${lit(store.id)} and b.title = ${lit(mural.title)}
          )`,
        cfg,
      )
      console.log(`  ✓ portada: campana «${mural.title}»`)
    }

    // Y una fila con lo rebajado, para que la oferta tenga cara de producto y
    // no solo de cartel.
    const [bloque] = await sql(
      `insert into public.content_blocks
         (organization_id, company_id, store_id, page_id, block_type, position, title, subtitle,
          item_limit, is_active, settings)
       select ${tenant}, ${lit(pagina.id)}, 'carousel'::content_block_type, 25,
              'Ofertas de la semana', 'Precios rebajados en farmacia, dermo y nutricion.',
              12, true, '{"show_price": true}'::jsonb
        where not exists (
          select 1 from public.content_blocks b
           where b.store_id = ${lit(store.id)} and b.title = 'Ofertas de la semana'
        )
       returning id`,
      cfg,
    )

    if (bloque) {
      // `block_type` e `item_kind` van repetidos en la fila a proposito: son
      // parte de la clave ajena compuesta que impide que un item de producto
      // acabe colgando de un bloque de categorias.
      await sql(
        `insert into public.content_block_items
           (organization_id, company_id, store_id, block_id, block_type, item_kind, product_id, position)
         select ${tenant}, ${lit(bloque.id)}, 'carousel'::content_block_type,
                'product'::content_item_kind, p.id,
                row_number() over (order by (p.compare_at_price - p.price) desc) - 1
           from public.products p
          where p.store_id = ${lit(store.id)} and p.compare_at_price is not null
            and p.status = 'published'
            and exists (select 1 from public.product_images i where i.product_id = p.id)
          limit 12`,
        cfg,
      )
      console.log('  ✓ portada: campana + fila de ofertas')
    }
  }

  const [resumen] = await sql(
    `select (select count(*)::int from public.promotions
              where store_id = ${lit(store.id)} and status = 'active') as promociones_activas,
            (select count(*)::int from public.products
              where store_id = ${lit(store.id)} and compare_at_price is not null) as rebajados`,
    cfg,
  )
  console.log(
    `\nListo: ${resumen.promociones_activas} promociones activas, ${resumen.rebajados} productos rebajados.`,
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
