#!/usr/bin/env node
/**
 * Pone fotos a los productos de DEMOSTRACION del proyecto de DEV/QAS.
 *
 * Por que existe: `demo-data.sql` puede sembrar filas, pero no bytes. Una
 * imagen son dos escrituras que tienen que ir juntas —el objeto en Storage y la
 * fila de `product_images` que lo referencia—, y el SQL suelto solo sabe hacer
 * la segunda. Sin esto la vitrina de demo sale entera con el marcador neutral,
 * que es justo lo que no se quiere ensenar.
 *
 * Siembra VARIAS por producto (`--count`, 4 por defecto) y no una: con una sola
 * foto la galeria de la ficha no se puede ni mirar —no hay miniaturas, no hay
 * paso de una a otra— y justo eso es lo que hay que poder revisar en demo.
 *
 * ## De donde salen las fotos
 *
 * De Wikimedia Commons, y SOLO las de dominio publico o CC0. Las CC BY-SA se
 * descartan a proposito: obligan a atribuir, y una vitrina de catalogo no tiene
 * donde poner el credito sin ensuciar la ficha. Si para un producto no hay
 * imagenes libres que valgan, ese producto se queda como este y se dice — antes
 * eso que colgarle un paisaje aleatorio y llamarlo catalogo.
 *
 * La procedencia de cada foto (pagina, autor, licencia) queda en
 * `supabase/demo-images.json`: son datos de demo, pero siguen siendo obra de
 * alguien y el dia que se pregunte de donde salio una foto la respuesta tiene
 * que estar escrita.
 *
 * ## Lo que el titulo no dice
 *
 * Commons ordena por relevancia de TEXTO. «Drop-leaf Dining Table MET 17656»
 * es, mirandola, la foto de una cuchara; «Carved Oak Chairs» es una lamina
 * escaneada de un libro de 1920. Por eso el filtro no es solo la palabra en el
 * titulo: se descartan laminas, grabados, fotos de personas y titulos con ano,
 * se prefiere JPEG (en Commons el PNG suele ser escaneo) y se comprueban los
 * BYTES MAGICOS de lo descargado —el limitador de Commons devuelve una pagina
 * HTML de error con extension .jpg, y esa «foto» se subiria tan feliz—.
 *
 * Aun asi el acierto no es del 100 %: es material de DEMO y quien lo mire
 * decide. `--sku` permite rehacer uno concreto.
 *
 * ## Como escribe
 *
 * Ruta obligatoria `{organization_id}/{store_id}/{product_id}/{uuid}.{ext}`, la
 * misma que exige el CHECK `product_images_path_tenant` y de la que
 * `ebim.can_write_store_object` deriva el tenant. Sube primero el objeto y
 * despues la fila; si la fila falla, retira el objeto —el mismo orden y la
 * misma limpieza que `uploadProductImage` en el front, para que la demo no
 * tenga una via de escritura distinta de la de produccion—.
 *
 * `is_primary` va en false: lo asciende el trigger `product_images_defaults`.
 *
 * Idempotente: cada producto se completa HASTA `--count`. Correrlo dos veces no
 * duplica nada.
 *
 *   node scripts/seed-product-images.mjs --check      (que haria, sin escribir)
 *   node scripts/seed-product-images.mjs --fix-cache  (cabecera de cache de lo ya subido)
 *   node scripts/seed-product-images.mjs --count 4
 *   node scripts/seed-product-images.mjs --sku MED-PAR-500
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'supabase', 'demo-images.json')

/** Igual que en el front: la extension sale del MIME, nunca del nombre. */
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_BYTES = 5 * 1024 * 1024

/**
 * Que buscar para cada SKU, y como reconocer un acierto.
 *
 * Escrito a mano y en ingles porque el buscador de Commons es de titulos y
 * categorias: «paracetamol 500 mg» no encuentra nada y «paracetamol tablets»
 * encuentra cajas de paracetamol. Un SKU que no este aqui se queda sin foto y se avisa, que
 * es mejor que adivinar con el nombre y colgarle cualquier cosa.
 *
 * `must` es lo que salva la busqueda de si misma: si el titulo del archivo no
 * nombra el objeto, la foto no es del objeto. `nice` solo desempata entre las
 * que ya lo nombran.
 */
const TERMS = {
  'MED-PAR-500': {
    queries: ['paracetamol tablets', 'acetaminophen tablets blister', 'pill blister pack'],
    must: ['tablet', 'pill', 'blister', 'paracetamol', 'acetaminophen'],
    nice: ['paracetamol', 'acetaminophen', 'blister', 'box'],
  },
  'MED-IBU-400': {
    queries: ['ibuprofen tablets', 'ibuprofen blister pack', 'ibuprofen box'],
    must: ['ibuprofen', 'tablet', 'pill', 'blister'],
    nice: ['ibuprofen', 'blister', 'box'],
  },
  'MED-LOR-010': {
    queries: ['loratadine tablets', 'antihistamine tablets', 'tablets blister pack'],
    must: ['tablet', 'pill', 'blister', 'loratadine'],
    nice: ['loratadine', 'antihistamine', 'blister'],
  },
  'MED-AMO-500': {
    queries: ['amoxicillin capsules', 'antibiotic capsules', 'capsules blister pack'],
    must: ['capsule', 'amoxicillin', 'antibiotic'],
    nice: ['amoxicillin', 'capsule', 'blister'],
  },
  'MED-JAR-099': {
    queries: ['cough syrup bottle', 'medicine syrup bottle', 'pharmaceutical bottle liquid'],
    must: ['syrup', 'bottle'],
    nice: ['medicine', 'cough', 'pharmaceutical'],
  },
  'CPE-SOL-050': {
    queries: ['sunscreen bottle', 'sunscreen lotion tube', 'sun cream bottle'],
    must: ['sunscreen', 'sun cream', 'lotion'],
    nice: ['bottle', 'tube', 'spf'],
  },
  'CPE-ALC-070': {
    queries: ['hand sanitizer bottle', 'alcohol gel dispenser bottle', 'hand sanitiser gel'],
    must: ['sanitizer', 'sanitiser', 'alcohol', 'gel'],
    nice: ['hand', 'bottle', 'dispenser'],
  },
  'VIT-VTC-1G0': {
    queries: ['effervescent vitamin tablets', 'vitamin c tablets tube', 'effervescent tablet water'],
    must: ['vitamin', 'effervescent', 'tablet'],
    nice: ['vitamin c', 'effervescent', 'tube'],
  },
  'VIT-OMG-030': {
    queries: ['fish oil capsules', 'omega 3 softgel capsules', 'dietary supplement capsules'],
    must: ['capsule', 'softgel', 'supplement', 'fish oil'],
    nice: ['omega', 'fish oil', 'bottle'],
  },
  'BOT-MAS-095': {
    queries: ['kn95 respirator mask', 'ffp2 mask', 'surgical face mask'],
    must: ['mask', 'respirator'],
    nice: ['kn95', 'ffp2', 'medical', 'surgical'],
  },
  'TB-SECRET-01': {
    queries: ['pharmacy shelf medicine', 'medicine boxes shelf'],
    must: ['pharmacy', 'medicine', 'shelf'],
    nice: ['pharmacy', 'medicine'],
  },
  'P09-RUNTIME-01': {
    queries: ['digital thermometer', 'clinical thermometer'],
    must: ['thermometer'],
    nice: ['digital', 'clinical', 'medical'],
  },
}

/**
 * Palabras que descalifican una foto de catalogo aunque nombre el objeto: una
 * caja de medicinas tirada en la basura sigue siendo una caja de medicinas,
 * pero no es el producto que se vende.
 */
const REJECT = [
  'shattered', 'broken', 'damaged', 'burnt', 'burned', 'ruin', 'destroyed',
  'abandoned', 'garbage', 'dump', 'trash', 'grave', 'cemetery', 'accident',
  // Commons esta lleno de laminas de museo: el dibujo tecnico de una mesa de
  // 1793 nombra la mesa mejor que ninguna foto, pero en una ficha de producto
  // se ve como lo que es, un grabado.
  'drawing', 'design for', 'sketch', 'engraving', 'lithograph', 'etching',
  'patent', 'blueprint', 'diagram', 'illustration', 'woodcut', 'painting',
  'plate', 'catalogue', 'catalog',
  // Y de gente: «Nurse holding a syringe» nombra la jeringa, pero la foto es
  // de la enfermera. En una ficha de producto el protagonista es el producto.
  'baby', 'child', 'girl', 'boy', 'portrait', 'people', 'woman', 'family',
  'wedding', 'selfie',
]

/** Un ano en el titulo delata la lamina de catalogo historico, no la foto. */
const HISTORIC = /1[5-9]\d\d/

/** Licencias que no obligan a atribuir. Lo demas se descarta. */
function isFreeLicense(meta) {
  const short = String(meta?.LicenseShortName?.value ?? '').toLowerCase()
  const code = String(meta?.License?.value ?? '').toLowerCase()
  return (
    short.includes('public domain') ||
    short.includes('cc0') ||
    code === 'cc0' ||
    code.startsWith('pd')
  )
}

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

/** SQL por la Management API, igual que `apply-demo-data.mjs`. */
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

/** Literal SQL. Los nombres de producto traen tildes y pueden traer apostrofos. */
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Consulta a Commons, despacio y a la primera educada.
 *
 * La API es de un tercero que no cobra nada: doce productos por tres consultas
 * en rafaga se ganan un 429 merecido a mitad de tanda. Un segundo entre
 * llamadas y reintento con espera creciente convierte «fallo la mitad» en
 * «tarda un rato».
 */
async function search(query) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2' +
    '&generator=search&gsrnamespace=6&gsrlimit=30&gsrsearch=' +
    encodeURIComponent(`filetype:bitmap ${query}`) +
    '&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=1200'

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ebim-ecommerce-demo/1.0' } })
    if (response.ok) {
      const body = await response.json()
      await wait(1200)
      return body.query?.pages ?? []
    }
    if (response.status !== 429) throw new Error(`Commons ${response.status}`)
    await wait(4000 * (attempt + 1))
  }
  throw new Error('Commons 429 tras 6 intentos')
}

/**
 * Candidatas libres de un producto, de mejor a peor.
 *
 * Recorre TODAS las consultas del SKU antes de ordenar: la segunda de una
 * busqueda suele ser mejor foto de producto que la primera de otra.
 */
async function findImages(spec) {
  const seen = new Set()
  const found = []

  for (const query of spec.queries) {
    for (const page of await search(query)) {
      const info = page.imageinfo?.[0]
      if (!info || !ALLOWED[info.mime]) continue
      if (!isFreeLicense(info.extmetadata)) continue
      const source = info.thumburl ?? info.url
      if (!source || seen.has(page.title)) continue

      const title = String(page.title).toLowerCase()
      if (!spec.must.some((word) => title.includes(word))) continue
      if (REJECT.some((word) => title.includes(word))) continue
      if (HISTORIC.test(title)) continue
      seen.add(page.title)

      // Un titulo corto suele ser la foto del objeto («Oak chair.jpg»); uno
      // kilometrico suele ser una escena de tienda o de museo donde el objeto
      // sale de fondo, y esa no es la foto de la ficha.
      const length = title.length < 45 ? 2 : title.length > 90 ? -3 : 0
      // En Commons el PNG suele ser una lamina escaneada y el JPEG una foto.
      const format = info.mime === 'image/jpeg' ? 1 : -1

      found.push({
        score: spec.nice.filter((word) => title.includes(word)).length + length + format,
        title: page.title,
        mime: info.mime,
        source,
        page: info.descriptionurl ?? '',
        license: info.extmetadata?.LicenseShortName?.value ?? 'Public domain',
        author: String(info.extmetadata?.Artist?.value ?? '')
          .replace(/<[^>]*>/g, '')
          .trim(),
      })
    }
  }
  return found.sort((a, b) => b.score - a.score)
}

/** Firmas de archivo. Lo que no empieza por estos bytes NO es una imagen. */
function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png'
  if (bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

/**
 * Descarga y comprueba que lo descargado sea la imagen.
 *
 * El limitador de Commons responde 200 con una PAGINA HTML de error servida
 * bajo una URL `.jpg`. Sin mirar los bytes magicos, eso acaba en el bucket como
 * foto de producto y en la vitrina como una imagen rota.
 */
async function download(url) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ebim-ecommerce-demo/1.0' } })
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer())
      const mime = sniff(bytes)
      if (mime && bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES) {
        await wait(900)
        return { bytes, mime }
      }
      if (bytes.byteLength > MAX_BYTES) throw new Error(`pesa ${bytes.byteLength} B`)
    }
    await wait(3000 * (attempt + 1))
  }
  throw new Error('descarga sin imagen valida (limitador de Commons)')
}

/** Storage REST con la clave de servicio. Nunca sale de este script. */
async function upload(path, bytes, mime, cfg) {
  const response = await fetch(`${cfg.url}/storage/v1/object/product-images/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.secret}`,
      apikey: cfg.secret,
      'Content-Type': mime,
      'x-upsert': 'false',
      // Ruta con uuid = contenido inmutable: el navegador se la queda una
      // semana en vez de volver a pedirla en cada visita de la demo.
      'cache-control': 'max-age=604800',
    },
    body: bytes,
  })
  if (!response.ok) {
    throw new Error(`storage ${response.status} ${(await response.text()).slice(0, 300)}`)
  }
}

async function removeObject(path, cfg) {
  await fetch(`${cfg.url}/storage/v1/object/product-images/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.secret}`, apikey: cfg.secret },
  }).catch(() => {})
}

/**
 * Cabecera de cache de lo YA subido.
 *
 * Storage guarda el `Cache-Control` de cada objeto en su fila de
 * `storage.objects` y lo sirve desde ahi. Lo subido sin la cabecera se quedo en
 * `no-cache`, que le dice al navegador que revalide SIEMPRE: la foto vuelve a
 * viajar en cada visita aunque no haya cambiado. Y no hay endpoint de Storage
 * para cambiar solo la cabecera —habria que volver a subir los bytes de las
 * casi trescientas—, asi que se corrige el metadato, que es de donde sale.
 *
 * Solo para el bucket de fotos de producto y solo en el proyecto de demo.
 */
async function fixCacheHeaders(cfg) {
  const [row] = await sql(
    `with actualizadas as (
       update storage.objects
          set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{cacheControl}', '"max-age=604800"')
        where bucket_id = 'product-images'
          and coalesce(metadata->>'cacheControl', '') <> 'max-age=604800'
        returning 1
     ) select count(*)::int as n from actualizadas`,
    cfg,
  )
  console.log(`${row.n} objeto(s) pasan a max-age=604800 (una semana de cache de navegador).`)
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const fixCache = args.includes('--fix-cache')
  const onlySku = args.includes('--sku') ? args[args.indexOf('--sku') + 1] : null
  const count = args.includes('--count') ? Number(args[args.indexOf('--count') + 1]) : 4

  const values = env()
  for (const key of ['VITE_SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SECRET_KEY']) {
    if (!values[key]) throw new Error(`Falta ${key} en .env`)
  }

  const cfg = {
    url: values.VITE_SUPABASE_URL.replace(/\/$/, ''),
    ref: new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0],
    token: values.SUPABASE_ACCESS_TOKEN,
    secret: values.SUPABASE_SECRET_KEY,
  }

  if (fixCache) {
    await fixCacheHeaders(cfg)
    return
  }

  const products = await sql(
    `select p.id, p.sku, p.name, p.store_id, s.organization_id, s.company_id, s.name as store,
            coalesce((select count(*) from public.product_images pi where pi.product_id = p.id), 0)::int as tiene,
            coalesce((select max(pi.position) from public.product_images pi where pi.product_id = p.id), -1)::int as ultima
       from public.products p
       join public.stores s on s.id = p.store_id
      order by p.sku`,
    cfg,
  )

  const targets = (onlySku ? products.filter((row) => row.sku === onlySku) : products).filter(
    (row) => row.tiene < count,
  )

  console.log(`Proyecto ${cfg.ref} · objetivo ${count} foto(s) por producto · ${targets.length} a completar`)
  if (targets.length === 0) return

  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
  let done = 0

  for (const product of targets) {
    const spec = TERMS[product.sku]
    if (!spec) {
      console.log(`  – ${product.sku}  sin termino de busqueda, se deja como esta`)
      continue
    }

    let candidates
    try {
      candidates = await findImages(spec)
    } catch (error) {
      console.log(`  ! ${product.sku}  Commons fallo: ${error.message}`)
      continue
    }

    // Lo ya usado por este producto no se repite: correr el script otra vez
    // completa la galeria, no la duplica.
    const previous = Array.isArray(manifest[product.sku]) ? manifest[product.sku] : []
    const used = new Set(previous.map((entry) => entry.titulo))
    const wanted = count - product.tiene
    const picks = candidates.filter((item) => !used.has(item.title)).slice(0, wanted)

    if (check) {
      console.log(`  · ${product.sku}  faltan ${wanted}: ${picks.map((p) => p.title.replace('File:', '')).join(' | ') || '(sin candidatas)'}`)
      continue
    }

    let position = product.ultima
    for (const pick of picks) {
      let file
      try {
        file = await download(pick.source)
      } catch (error) {
        console.log(`  ! ${product.sku}  ${pick.title}: ${error.message}`)
        continue
      }

      position += 1
      const path = `${product.organization_id}/${product.store_id}/${product.id}/${randomUUID()}.${ALLOWED[file.mime]}`

      await upload(path, file.bytes, file.mime, cfg)
      try {
        await sql(
          `insert into public.product_images
             (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
           values (${lit(product.organization_id)}, ${lit(product.company_id)}, ${lit(product.store_id)},
                   ${lit(product.id)}, ${lit(path)}, ${lit(product.name)}, ${position}, false)`,
          cfg,
        )
      } catch (error) {
        // El objeto ya subido seria basura invisible en el bucket.
        await removeObject(path, cfg)
        throw error
      }

      previous.push({
        storage_path: path,
        posicion: position,
        origen: pick.page,
        titulo: pick.title,
        licencia: pick.license,
        autor: pick.author || null,
        bytes: file.bytes.byteLength,
      })
      manifest[product.sku] = previous
      writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      done += 1
      console.log(`  ✓ ${product.sku}  #${position}  ${(file.bytes.byteLength / 1024).toFixed(0)} KB  [${pick.license}]`)
    }
  }

  if (!check) console.log(`\n${done} foto(s) subidas. Procedencia en supabase/demo-images.json`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
