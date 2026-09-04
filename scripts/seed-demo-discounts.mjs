#!/usr/bin/env node
/**
 * Rebajas de demostración, donde la vitrina las lee de verdad.
 *
 * ## El descubrimiento que da nombre a este script
 *
 * `seed-miquimica-promos.mjs` escribía `products.compare_at_price` y la tienda
 * seguía sin enseñar ni una rebaja. El motivo está en `public_products`: cuando
 * una LISTA DE PRECIOS gobierna el producto —que es el caso de esta tienda— la
 * vista toma `unit_price` y `compare_at_price` de la lista, no del producto. El
 * «antes» escrito en el producto queda tapado.
 *
 * Así que la rebaja se pone donde la vitrina la mira: en la fila de la lista.
 *
 * Esto es dato de DEMOSTRACIÓN. En una tienda real el «antes» lo pone el
 * comercio al fijar el precio, y ahí conviene saber que un `compare_at_price`
 * de producto no se ve mientras haya lista activa que lo cubra.
 *
 * Uso:  node scripts/seed-demo-discounts.mjs [--check] [--limpiar]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'
/** Cuántas filas de la lista se rebajan. */
const CUANTAS = 60

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

async function main() {
  const check = process.argv.includes('--check')
  const limpiar = process.argv.includes('--limpiar')
  const values = env()
  const cfg = {
    ref: new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0],
    token: values.SUPABASE_ACCESS_TOKEN,
  }

  const [antes] = await sql(
    `select count(*)::int as rebajados
       from public.public_products p
       join public.stores s on s.id = p.store_id and s.slug = '${STORE_SLUG}'
      where p.compare_at_price is not null and p.compare_at_price > p.price`,
    cfg,
  )
  console.log(`Rebajados ahora mismo: ${antes.rebajados}`)

  if (limpiar) {
    await sql(
      `update public.price_list_items it
          set compare_at_price = null
         from public.price_lists l
         join public.stores s on s.id = l.store_id and s.slug = '${STORE_SLUG}'
        where it.price_list_id = l.id`,
      cfg,
    )
    console.log('Rebajas retiradas de la lista de precios.')
    return
  }

  if (check) {
    console.log('Nada escrito (--check).')
    return
  }

  /**
   * Se rebajan las filas con FOTO: una oferta sin imagen en la portada es un
   * hueco gris, y lo que se está montando es justamente el escaparate.
   *
   * El «antes» sale del propio precio (+25 %), redondeado a céntimo. No se
   * inventa un precio nuevo: se declara de dónde venía.
   */
  const filas = await sql(
    `with candidatas as (
       select it.id
         from public.price_list_items it
         join public.price_lists l on l.id = it.price_list_id
         join public.stores s on s.id = l.store_id and s.slug = '${STORE_SLUG}'
         join public.products p on p.id = it.product_id
        where it.variant_id is null
          and it.compare_at_price is null
          and p.status = 'published'
          and exists (select 1 from public.product_images i where i.product_id = p.id)
        order by it.unit_price desc
        limit ${CUANTAS}
     )
     update public.price_list_items it
        set compare_at_price = round(it.unit_price * 1.25, 2)
       from candidatas c
      where it.id = c.id
      returning it.id`,
    cfg,
  )

  const [despues] = await sql(
    `select count(*)::int as rebajados
       from public.public_products p
       join public.stores s on s.id = p.store_id and s.slug = '${STORE_SLUG}'
      where p.compare_at_price is not null and p.compare_at_price > p.price`,
    cfg,
  )

  console.log(`Filas tocadas: ${filas.length}`)
  console.log(`Rebajados que ve la vitrina: ${despues.rebajados}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
