#!/usr/bin/env node
/**
 * Fotos para las campañas de la demo.
 *
 * Desde que la campaña tiene `image_url`, una oferta puede mirarse en vez de
 * solo leerse. Este script le pone foto a las campañas de la tienda de
 * demostración para que la portada no salga con carteles de texto.
 *
 * ## Lo que hay que saber de estas imágenes
 *
 * Son de **licencia permisiva** (Creative Commons, buscadas en Openverse) y se
 * enlazan por `https://` — que es lo que el CHECK de la columna admite además
 * de una ruta del bucket de la propia tienda. Sirven para una demostración; en
 * producción el comercio sube las suyas desde el cajón de la campaña, que es
 * para lo que existe el campo.
 *
 * Las de licencia `by` y `by-sa` piden atribución: si alguna de estas fotos
 * fuera a salir en la tienda de un cliente real, hay que dar crédito o
 * cambiarla por una propia.
 *
 * Uso:  node scripts/seed-promo-images.mjs [--check]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'

/**
 * Qué foto le toca a cada campaña, por CÓDIGO.
 *
 * Por código y no por nombre: el nombre lo edita el comercio desde el
 * backoffice y este script dejaría de encontrarla; el código es su
 * identificador estable.
 */
const FOTOS = {
  'dermo-20': 'https://live.staticflickr.com/1440/1452617374_caba2def4a_b.jpg',
  'salud-15': 'https://live.staticflickr.com/121/300133762_3983201d01_b.jpg',
  'nutri-3x2': 'https://live.staticflickr.com/174/480699341_b5f0c43cbf.jpg',
  'ahorro-150': 'https://live.staticflickr.com/3184/2734925607_c281799e4a_m.jpg',
  'escala-adium': 'https://live.staticflickr.com/2134/2602771763_1d20b5200b.jpg',
  'vitaminas-15': 'https://live.staticflickr.com/2602/2602770285_aec26e34f1.jpg',
}

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
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Una URL que no responde deja la campaña con un hueco: se comprueba antes. */
async function vive(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

async function main() {
  const soloComprobar = process.argv.includes('--check')
  const values = env()
  const cfg = {
    ref: new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0],
    token: values.SUPABASE_ACCESS_TOKEN,
  }

  const [store] = await sql(
    `select id from public.stores where slug = ${lit(STORE_SLUG)}`,
    cfg,
  )
  if (!store) throw new Error(`No existe la tienda ${STORE_SLUG}`)

  const campanas = await sql(
    `select code, name, image_url from public.promotions
      where store_id = ${lit(store.id)} order by code`,
    cfg,
  )

  let puestas = 0
  for (const campana of campanas) {
    const foto = FOTOS[campana.code]
    if (!foto) {
      console.log(`  · ${campana.code}: sin foto asignada en este script`)
      continue
    }
    if (!(await vive(foto))) {
      console.log(`  ! ${campana.code}: la URL no responde, se deja como estaba`)
      continue
    }
    if (soloComprobar) {
      console.log(`  → ${campana.code}: quedaria con ${foto}`)
      continue
    }

    await sql(
      `update public.promotions set image_url = ${lit(foto)}
        where store_id = ${lit(store.id)} and code = ${lit(campana.code)}`,
      cfg,
    )
    puestas += 1
    console.log(`  ✓ ${campana.code}`)
  }

  console.log(soloComprobar ? '\nNada escrito (--check).' : `\nListo: ${puestas} campanas con foto.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
