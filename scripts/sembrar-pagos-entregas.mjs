/**
 * Siembra los medios de pago y metodos de entrega por defecto en una tienda que
 * YA existe.
 *
 * Las tiendas nuevas los reciben solas (trigger `stores_default_payment_delivery`,
 * migracion 20260928100000). Este script es para las anteriores a esa migracion.
 *
 * ## Una sola lista de valores por defecto
 *
 * No repite la lista: lee el cuerpo de `ebim.seed_store_payment_delivery` de la
 * propia migracion y lo ejecuta como bloque anonimo para esta tienda. Asi el
 * script funciona aunque la migracion no este aplicada todavia en el proyecto, y
 * los dos caminos no pueden separarse.
 *
 * ## Y ademas, el punto de recojo
 *
 * Una tienda que ya existe suele tener direccion de contacto. Con ella se crea
 * el punto de recojo «Tienda principal» y se activa el metodo `recojo` — solo si
 * ninguno de los dos existia antes: lo que el comercio ya configuro no se toca.
 *
 * Idempotente: correrlo dos veces deja lo mismo que correrlo una.
 *
 * Uso:  node scripts/sembrar-pagos-entregas.mjs <slug>
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRACION = join(ROOT, 'supabase', 'migrations', '20260928100000_store_default_payment_delivery.sql')
const SLUG = process.argv[2]

if (!SLUG) {
  console.error('Uso: node scripts/sembrar-pagos-entregas.mjs <slug>')
  process.exit(1)
}

const archivoEnv = join(ROOT, '.env')
const env = {
  ...(existsSync(archivoEnv)
    ? Object.fromEntries(
        readFileSync(archivoEnv, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith('#') && line.includes('='))
          .map((line) => {
            const i = line.indexOf('=')
            return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
          }),
      )
    : {}),
  ...process.env,
}

if (!env.VITE_SUPABASE_URL || !env.SUPABASE_ACCESS_TOKEN) {
  console.error('Faltan VITE_SUPABASE_URL o SUPABASE_ACCESS_TOKEN (entorno o .env).')
  process.exit(1)
}

const REF = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]

async function sql(query) {
  const respuesta = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const cuerpo = await respuesta.text()
  if (!respuesta.ok) throw new Error(cuerpo.slice(0, 500))
  return cuerpo ? JSON.parse(cuerpo) : []
}

const lit = (valor) => `'${String(valor).replace(/'/g, "''")}'`

/** El cuerpo de la funcion de siembra, tal cual esta en la migracion. */
function cuerpoDeSiembra(storeId) {
  const texto = readFileSync(MIGRACION, 'utf8')
  const inicio = texto.indexOf('create or replace function ebim.seed_store_payment_delivery(')
  const desde = texto.indexOf('$fn$', inicio) + '$fn$'.length
  const hasta = texto.indexOf('$fn$', desde)
  if (inicio < 0 || hasta < 0) throw new Error('No encuentro ebim.seed_store_payment_delivery en la migracion')
  const cuerpo = texto.slice(desde, hasta).trim()
  if (!cuerpo.startsWith('declare')) throw new Error('El cuerpo de la siembra ya no empieza por declare')
  // El parametro de la funcion pasa a ser una variable del bloque anonimo.
  return cuerpo.replace(/^declare/, `declare\n  p_store_id uuid := ${lit(storeId)};`)
}

const resumen = (storeId) =>
  sql(`select
    (select count(*)::int from public.payment_methods  where store_id = ${lit(storeId)}) as pagos,
    (select count(*)::int from public.payment_methods  where store_id = ${lit(storeId)} and is_active) as pagos_activos,
    (select count(*)::int from public.delivery_methods where store_id = ${lit(storeId)}) as entregas,
    (select count(*)::int from public.delivery_methods where store_id = ${lit(storeId)} and is_active) as entregas_activas,
    (select count(*)::int from public.delivery_zones   where store_id = ${lit(storeId)}) as zonas,
    (select count(*)::int from public.delivery_rates   where store_id = ${lit(storeId)}) as tarifas,
    (select count(*)::int from public.pickup_points    where store_id = ${lit(storeId)} and is_active) as puntos_recojo`)

const [tienda] = await sql(
  `select id, name, currency, status from public.stores where slug = ${lit(SLUG)}`,
)
if (!tienda) {
  console.error(`No hay ninguna tienda con slug «${SLUG}» en ${REF}.`)
  process.exit(1)
}

console.log(`Tienda «${tienda.name}» (${SLUG}) · ${tienda.currency} · ${tienda.status} · proyecto ${REF}`)
console.log('Antes:  ', (await resumen(tienda.id))[0])

// Todo en una transaccion: o queda la siembra completa o no queda nada.
await sql(`
begin;

do $siembra$
${cuerpoDeSiembra(tienda.id)}
$siembra$;

-- Punto de recojo con la direccion de contacto, solo si la tienda no tiene
-- ninguno y tiene direccion.
with ajustes as (
  select s.id, s.organization_id, s.company_id, s.name,
         nullif(btrim(ss.contact_address), '') as direccion,
         case when char_length(btrim(coalesce(ss.contact_phone, ''))) between 6 and 40
              then btrim(ss.contact_phone) end as telefono
    from public.stores s
    left join public.store_settings ss on ss.store_id = s.id
   where s.id = ${lit(tienda.id)}
), nuevo as (
  insert into public.pickup_points
    (organization_id, company_id, store_id, code, name, address, contact_phone, is_active, position)
  select a.organization_id, a.company_id, a.id, 'tienda-principal', 'Tienda principal',
         jsonb_build_object('line1', a.direccion), a.telefono, true, 10
    from ajustes a
   where a.direccion is not null
     and not exists (select 1 from public.pickup_points p where p.store_id = a.id)
  returning store_id
)
update public.delivery_methods m
   set is_active = true
  from nuevo
 where m.store_id = nuevo.store_id
   and m.code = 'recojo';

commit;
`)

console.log('Después:', (await resumen(tienda.id))[0])
console.log('\nListo. Edítalos en el backoffice: Pagos (instrucciones con tu cuenta y tu número) y Entregas (zonas y tarifas).')
