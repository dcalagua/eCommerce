#!/usr/bin/env node
/**
 * Aplica `supabase/demo-data.sql` al proyecto Supabase de DEV/QAS.
 *
 * Por que existe: `supabase db push` solo aplica MIGRACIONES, y los datos de
 * demostracion no son una migracion —si lo fueran acabarian en produccion—.
 * Esto los manda por la Management API, que es la unica via que acepta SQL
 * suelto sin tener `psql` instalado.
 *
 * Usa `SUPABASE_ACCESS_TOKEN` del `.env` (git-ignored) y el ref del proyecto,
 * que sale de `VITE_SUPABASE_URL`. Es un token de CUENTA, no de la app: por eso
 * no lleva prefijo `VITE_` y nunca entra en el bundle.
 *
 * El SQL es idempotente, asi que correr esto dos veces no duplica nada.
 *
 *   node scripts/apply-demo-data.mjs
 *   node scripts/apply-demo-data.mjs --check   (solo cuenta filas, no escribe)
 *   node scripts/apply-demo-data.mjs --file supabase/demo-purge.sql
 *
 * `--file` aplica CUALQUIER fichero SQL del repo por la misma via. Existe para
 * el ciclo de cambio de cliente —vaciar, sembrar la base, sembrar la demo— sin
 * tener que escribir tres scripts que hacen lo mismo con otro nombre.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function env() {
  let raw
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8')
  } catch {
    throw new Error('No hay .env en la raiz del repo.')
  }
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

async function run(query, { token, ref }) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    },
  )
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 600)}`)
  return JSON.parse(text)
}

const TABLES = [
  'brands', 'customers', 'inventory_levels', 'price_list_items', 'promotions',
  'coupons', 'gift_cards', 'content_pages', 'return_requests', 'payment_intents',
]

const vars = env()
const token = vars.SUPABASE_ACCESS_TOKEN
const url = vars.VITE_SUPABASE_URL
if (!token) throw new Error('Falta SUPABASE_ACCESS_TOKEN en .env')
if (!url) throw new Error('Falta VITE_SUPABASE_URL en .env')
const ref = new URL(url).hostname.split('.')[0]
const ctx = { token, ref }

const fileFlag = process.argv.indexOf('--file')
// Una ruta relativa a la raiz del repo, no absoluta: lo que se aplica a la base
// de DEV tiene que estar versionado y ser revisable en un diff.
const target = fileFlag === -1 ? join('supabase', 'demo-data.sql') : process.argv[fileFlag + 1]

if (!process.argv.includes('--check')) {
  if (!target) throw new Error('Falta la ruta del fichero tras --file')
  const sql = readFileSync(join(ROOT, target), 'utf8')
  await run(sql, ctx)
  console.log(`${target} aplicado a ${ref}.`)
}

const counts = await run(
  TABLES.map((t) => `select '${t}' as tabla, count(*)::int as filas from public.${t}`).join(
    ' union all ',
  ),
  ctx,
)
console.log(counts.map((r) => `  ${r.tabla}: ${r.filas}`).join('\n'))
