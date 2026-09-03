/**
 * Suelta las categorias fijas de la portada y comprueba el resultado.
 *
 * Aplica `supabase/home-categorias-automaticas.sql`, que retira los items
 * curados del bloque de categorias de inicio para que mande el camino
 * automatico que abrio la migracion `20260903120000`. El SQL vive aparte a
 * proposito: lo que se aplica a DEV tiene que poder revisarse en un diff.
 *
 * Sonda antes y despues con la MISMA funcion que usa la vitrina
 * (`ebim.content_block_items_json`), asi que lo que imprime es literalmente lo
 * que se va a pintar. Sin la sonda, un «listo» no distingue entre haber
 * borrado bien y haber borrado nada.
 *
 * Idempotente: la segunda pasada no encuentra items que borrar y deja el mismo
 * resultado.
 *
 * Uso: `node scripts/soltar-categorias.mjs`
 * Deshacer: `supabase/home-compose-miquimica.sql`
 */
import fs from 'node:fs'

const env = Object.fromEntries(
  fs
    .readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => {
      const corte = line.indexOf('=')
      return [
        line.slice(0, corte).trim(),
        line.slice(corte + 1).trim().replace(/^["']|["']$/g, ''),
      ]
    }),
)

if (!env.SUPABASE_ACCESS_TOKEN || !env.VITE_SUPABASE_URL) {
  console.error('Falta SUPABASE_ACCESS_TOKEN o VITE_SUPABASE_URL en .env')
  process.exit(1)
}

const ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]

async function consulta(sql) {
  const respuesta = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  const cuerpo = await respuesta.text()
  if (!respuesta.ok) throw new Error(cuerpo)
  return cuerpo ? JSON.parse(cuerpo) : []
}

/** Lo que la vitrina pintaria ahora mismo, resuelto por la funcion de verdad. */
const SONDA = `
  select
    b.title,
    (select count(*) from public.content_block_items i where i.block_id = b.id) as items_a_mano,
    jsonb_array_length(ebim.content_block_items_json(b.*)) as puertas,
    (select string_agg(x ->> 'name', ' · ')
     from jsonb_array_elements(ebim.content_block_items_json(b.*)) x) as cuales
  from public.content_blocks b
  join public.content_pages p on p.id = b.page_id
  where p.kind = 'home' and b.block_type = 'category_collection';
`

function pinta(momento, filas) {
  for (const fila of filas) {
    console.log(
      `${momento}  «${fila.title}» · a mano: ${fila.items_a_mano} · puertas: ${fila.puertas}`,
    )
    console.log(`         ${fila.cuales ?? '(ninguna)'}`)
  }
  if (filas.length === 0) console.log(`${momento}  sin bloque de categorias en la portada`)
}

pinta('ANTES ', await consulta(SONDA))

await consulta(fs.readFileSync('supabase/home-categorias-automaticas.sql', 'utf8'))

const despues = await consulta(SONDA)
pinta('DESPUES', despues)

if (despues.some((fila) => Number(fila.items_a_mano) > 0)) {
  console.error('\nQuedan items a mano: el borrado no alcanzo al bloque.')
  process.exit(1)
}
