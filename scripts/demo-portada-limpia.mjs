#!/usr/bin/env node
/**
 * Deja la portada de la demo con UNA sección de cada cosa.
 *
 * Desde que la vitrina compone sola el hero, la banda de ofertas y las marcas,
 * los bloques que el comercio había escrito para eso mismo se ven DOS veces:
 * «Ofertas de la semana» salía tres veces en la misma página —la banda nueva,
 * el mural de campañas y el carrusel del CMS— y eso no es una portada más
 * rica, es una portada que se repite.
 *
 * Este script solo APAGA (`is_active = false`) los bloques que ahora duplican
 * lo que la vitrina hace sola. No borra nada: `--restaurar` los vuelve a
 * encender, y el comercio los ve igual en el backoffice.
 *
 * También apaga los banners MUDOS: un mosaico de imágenes sin titular ni
 * destino no dice si es una oferta, una marca o un adorno, y como no se puede
 * saber, no se pulsa. Lo que ahí hacía falta era una promoción con nombre,
 * foto y vigencia — la siembra `seed-demo-ofertas-ricas.mjs`.
 *
 * Uso:  node scripts/demo-portada-limpia.mjs [--check] [--restaurar]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'

/**
 * Qué se apaga, por TÍTULO, y por qué.
 *
 * Por título porque es lo que el comercio ve en el backoffice: si alguien
 * quiere entender por qué su bloque no sale, lo busca por su nombre.
 */
const DUPLICADOS = [
  ['Probiotico Infantil', 'banner suelto sin texto: no dice de que es ni a donde lleva'],
  ['Anuncios', 'dos imagenes mudas; la oferta con titular y foto lo dice mejor'],
  ['Lo mas vendido', 'la banda de la portada ya enseña destacados'],
  ['Ofertas de la semana', 'la banda de la portada ya enseña lo rebajado'],
  ['Semana dermocosmetica', 'el carrusel de campañas vigentes ya la anuncia'],
  ['Semana de la Salud', 'el carrusel de campañas vigentes ya la anuncia'],
  ['Lleva 3, paga 2', 'el carrusel de campañas vigentes ya la anuncia'],
  ['Escala por volumen Adium', 'el carrusel de campañas vigentes ya la anuncia'],
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
  return `'${String(value).replace(/'/g, "''")}'`
}

async function main() {
  const check = process.argv.includes('--check')
  const restaurar = process.argv.includes('--restaurar')
  const values = env()
  const cfg = {
    ref: new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0],
    token: values.SUPABASE_ACCESS_TOKEN,
  }

  const [store] = await sql(`select id from public.stores where slug = ${lit(STORE_SLUG)}`, cfg)
  if (!store) throw new Error(`No existe la tienda ${STORE_SLUG}`)

  const titulos = DUPLICADOS.map(([titulo]) => lit(titulo)).join(', ')
  const bloques = await sql(
    `select title, block_type, is_active from public.content_blocks
      where store_id = ${lit(store.id)} and title in (${titulos})
      order by title`,
    cfg,
  )

  for (const bloque of bloques) {
    const motivo = DUPLICADOS.find(([titulo]) => titulo === bloque.title)?.[1] ?? ''
    console.log(`  ${bloque.is_active ? '●' : '○'} ${bloque.title} (${bloque.block_type}) — ${motivo}`)
  }

  if (check) {
    console.log('\nNada escrito (--check).')
    return
  }

  await sql(
    `update public.content_blocks set is_active = ${restaurar ? 'true' : 'false'}
      where store_id = ${lit(store.id)} and title in (${titulos})`,
    cfg,
  )

  console.log(
    restaurar
      ? `\nRestaurados ${bloques.length} bloques.`
      : `\nApagados ${bloques.length} bloques duplicados. Se recuperan con --restaurar.`,
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
