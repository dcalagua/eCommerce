#!/usr/bin/env node
/**
 * Dos ofertas de la demo con TITULAR, FOTO y texto que explica la oferta.
 *
 * ## Qué arregla
 *
 * La portada cerraba con dos imágenes sueltas —un mosaico de banners subidos al
 * CMS— que no decían qué eran. Una foto sola no vende: quien la mira no sabe si
 * es una oferta, una marca o un adorno, y como no puede saberlo, no la pulsa.
 *
 * Lo que sí lo dice es una PROMOCIÓN de verdad: tiene nombre, tiene un
 * porcentaje que sale del motor, tiene hasta cuándo dura y ahora también tiene
 * foto. La vitrina la pinta sola en el carrusel de ofertas, con su medallón, su
 * vigencia y su botón a los productos que alcanza.
 *
 * Estas dos apuntan a categorías REALES del catálogo —fórmulas infantiles y
 * cuidado profesional del cabello, las dos con decenas de productos
 * publicados—, así que el botón «Ver la oferta» lleva a una lista que de verdad
 * está rebajada. Una campaña que lleva a una lista vacía es peor que no ponerla.
 *
 * ## Las fotos
 *
 * Wikimedia Commons, licencia CC0 / dominio público, enlazadas por `https://`
 * —que es lo que admite el CHECK de la columna además de una ruta del bucket de
 * la propia tienda— y en su versión de 500 px: en la tarjeta se pintan a 132 px
 * de ancho, y traerse el original de 2,5 MB para eso es pagar la portada dos
 * veces. En producción el comercio sube las suyas desde el cajón de la campaña.
 *
 * Idempotente: las promociones se identifican por `code`. Correrlo dos veces no
 * duplica nada; `--clear` retira lo que sembró.
 *
 *   node scripts/seed-demo-ofertas-ricas.mjs --check
 *   node scripts/seed-demo-ofertas-ricas.mjs
 *   node scripts/seed-demo-ofertas-ricas.mjs --clear
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'

/**
 * Las dos ofertas.
 *
 * El texto es LARGO a propósito: la tarjeta da sitio para dos líneas y lo que
 * hay que responder ahí es qué entra, si hace falta cupón y qué se lleva quien
 * compra. «20 % de descuento» no responde ninguna de las tres.
 */
const OFERTAS = [
  {
    code: 'mama-bebe-20',
    name: 'Semana Mamá y Bebé: 20 % en fórmulas infantiles',
    description:
      'Fórmulas de inicio y continuación, leches de crecimiento y complementos ' +
      'infantiles con 20 % de descuento durante toda la semana. Sin cupón: el ' +
      'precio ya sale rebajado en la vitrina y se acumula con el envío gratis.',
    categorySlug: 'leches-y-formulas-qs',
    percent: 20,
    priority: 12,
    image:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/' +
      'Woman_shopping_for_infant_formula_in_a_supermarket%2C_Singapore_-_20131102.jpg/' +
      '500px-Woman_shopping_for_infant_formula_in_a_supermarket%2C_Singapore_-_20131102.jpg',
  },
  {
    code: 'salon-en-casa-15',
    name: 'Salón en casa: 15 % en cuidado profesional del cabello',
    description:
      'Champús, mascarillas y tratamientos de línea profesional con 15 % de ' +
      'descuento. Los mismos productos que usa tu peluquería, con receta de uso ' +
      'en cada ficha y entrega en 24 h dentro de Lima metropolitana.',
    categorySlug: 'cuidado-profesional-del-cabello-qs',
    percent: 15,
    priority: 14,
    image:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Shampoo_Aisle.jpg/' +
      '500px-Shampoo_Aisle.jpg',
  },
]

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
  const codigos = OFERTAS.map((oferta) => lit(oferta.code)).join(', ')

  if (clear) {
    await sql(
      `delete from public.promotions where store_id = ${lit(store.id)} and code in (${codigos})`,
      cfg,
    )
    console.log('Ofertas retiradas.')
    return
  }

  for (const oferta of OFERTAS) {
    const [categoria] = await sql(
      `select id, name from public.categories
        where store_id = ${lit(store.id)} and slug = ${lit(oferta.categorySlug)}`,
      cfg,
    )
    if (!categoria) {
      console.log(`  – ${oferta.code}: no existe la categoría ${oferta.categorySlug}, se omite`)
      continue
    }

    const [{ n }] = await sql(
      `select count(*)::int as n from public.products
        where store_id = ${lit(store.id)} and category_id = ${lit(categoria.id)}
          and status = 'published'`,
      cfg,
    )

    if (check) {
      console.log(`  ${oferta.code} → ${categoria.name} (${n} productos publicados)`)
      continue
    }

    // Sin producto detrás no se siembra: el botón de la oferta llevaría a una
    // lista vacía, y eso en una demo se ve peor que no tener la oferta.
    if (n === 0) {
      console.log(`  – ${oferta.code}: la categoría no tiene producto publicado, se omite`)
      continue
    }

    const id = randomUUID()
    await sql(
      `insert into public.promotions
         (id, organization_id, company_id, store_id, code, name, description, kind, status,
          priority, requires_coupon, value_percent, image_url, valid_from, valid_to)
       select ${lit(id)}, ${tenant}, ${lit(oferta.code)}, ${lit(oferta.name)},
              ${lit(oferta.description)}, 'percentage'::promotion_kind, 'active'::promotion_status,
              ${lit(oferta.priority)}, false, ${lit(oferta.percent)}, ${lit(oferta.image)},
              now() - interval '1 day', now() + interval '21 days'
        where not exists (
          select 1 from public.promotions p
           where p.store_id = ${lit(store.id)} and p.code = ${lit(oferta.code)}
        )`,
      cfg,
    )

    const [row] = await sql(
      `select id from public.promotions
        where store_id = ${lit(store.id)} and code = ${lit(oferta.code)}`,
      cfg,
    )
    if (!row) continue

    // Se vuelve a escribir siempre: si el script cambia el titular o la foto,
    // correrlo otra vez tiene que dejar la oferta como dice el script y no como
    // la dejó la primera pasada.
    await sql(
      `update public.promotions
          set name = ${lit(oferta.name)}, description = ${lit(oferta.description)},
              image_url = ${lit(oferta.image)}, value_percent = ${lit(oferta.percent)},
              priority = ${lit(oferta.priority)}, status = 'active'::promotion_status,
              valid_from = now() - interval '1 day', valid_to = now() + interval '21 days'
        where id = ${lit(row.id)}`,
      cfg,
    )

    await sql(
      `insert into public.promotion_scopes
         (organization_id, company_id, store_id, promotion_id, promotion_kind, scope_kind, category_id)
       select ${tenant}, ${lit(row.id)}, 'percentage'::promotion_kind,
              'category'::promotion_scope_kind, ${lit(categoria.id)}
        where not exists (
          select 1 from public.promotion_scopes s where s.promotion_id = ${lit(row.id)}
        )`,
      cfg,
    )

    console.log(`  ✓ ${oferta.code}  ${oferta.name}  → ${categoria.name} (${n} productos)`)
  }

  if (check) console.log('\nNada escrito (--check).')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
