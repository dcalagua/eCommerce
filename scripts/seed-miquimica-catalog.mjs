#!/usr/bin/env node
/**
 * Catalogo de demostracion de MiQuimica: 150 productos por categoria, con la
 * nomenclatura del sector y los campos de su modelo.
 *
 * ## Por que existe y que NO es
 *
 * Lo real vive en el microservicio de Quimica Suiza, y ese servicio pide linea
 * y cliente para responder (su precio es POR cliente) — sin esos dos datos la
 * consulta expira. Esto NO son sus productos: es un catalogo de demo con su
 * forma, para que la vitrina se pueda ensenar completa mientras llegan los
 * datos de verdad. Cuando lleguen, `import-qs-catalog.mjs` los sustituye.
 *
 * ## Como se componen los nombres
 *
 * Cada familia tiene su gramatica, porque en farmacia el nombre ES la ficha
 * tecnica: «Amoxicilina 500 mg caja x 100 capsulas» dice principio, dosis,
 * presentacion y unidades. Combinar atributos al azar entre familias produce
 * cosas como «Guantes de nitrilo de 70°», que en una demo de botica se nota a
 * la primera. Aqui cada producto sale de UNA plantilla con SUS atributos.
 *
 * ## Los campos de su modelo
 *
 * `custom_fields` lleva lo que su `Product` trae y nuestro esquema no tiene
 * columna: principio activo, tipo, linea, spart, pack maestro, IGV, escalas y
 * bonificaciones. Las escalas van estructuradas (`[{desde, descuento}]`) en vez
 * de como el texto plano que usa su ERP: aqui no conocemos su formato, y una
 * estructura se puede pintar; una cadena opaca, no.
 *
 * ## Las existencias van a los ALMACENES
 *
 * `products.stock` no manda en esta tienda: tiene almacenes que la sirven, y
 * `ebim.atp` suma `inventory_levels` ignorando la columna del catalogo. Un
 * producto sin fila de inventario sale agotado por mucho stock que diga.
 *
 * Idempotente: SKU con prefijo `MQ-`; se completa hasta el objetivo y no se
 * duplica nada.
 *
 *   node scripts/seed-miquimica-catalog.mjs --check
 *   node scripts/seed-miquimica-catalog.mjs --target 150
 *   node scripts/seed-miquimica-catalog.mjs --purge     (borra SOLO lo suyo)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'
const PREFIX = 'MQ-'

/** IGV peruano. Va en los datos porque su modelo trae `Tax` por producto. */
const IGV = 18

/**
 * Familias del catalogo, una por categoria de la tienda.
 *
 * `principios` son principios activos o ingredientes reales del sector; con
 * ellos y las presentaciones se compone el nombre. Nada de listas de adjetivos
 * intercambiables entre familias.
 */
const FAMILIES = [
  {
    key: 'MED',
    categorySlug: 'medicamentos',
    linea: '01',
    lineaNombre: 'Farma',
    spart: '10',
    price: [4.5, 89],
    tipos: ['Generico', 'Etico', 'OTC'],
    /**
     * `[principio, dosis[], formas permitidas[]]`.
     *
     * La forma va ATADA al principio a proposito. Combinandolas libremente
     * salian «Metformina jarabe», «Amlodipino jarabe» y «Enalapril ampollas»:
     * productos que no existen. En una demo para una distribuidora farmaceutica
     * eso lo caza el primero que lo lea, y a partir de ahi ya no mira la
     * pantalla, mira los datos.
     */
    principios: [
      ['Paracetamol', ['500 mg', '1 g'], ['solida', 'liquida']],
      ['Ibuprofeno', ['400 mg', '600 mg'], ['solida', 'liquida']],
      ['Amoxicilina', ['500 mg', '875 mg'], ['solida', 'liquida']],
      ['Azitromicina', ['500 mg'], ['solida', 'liquida']],
      ['Loratadina', ['10 mg'], ['solida', 'liquida']],
      ['Cetirizina', ['10 mg'], ['solida', 'liquida']],
      ['Omeprazol', ['20 mg', '40 mg'], ['solida']],
      ['Metformina', ['850 mg', '1 g'], ['solida']],
      ['Losartan', ['50 mg', '100 mg'], ['solida']],
      ['Atorvastatina', ['20 mg', '40 mg'], ['solida']],
      ['Naproxeno', ['550 mg'], ['solida']],
      ['Diclofenaco', ['50 mg'], ['solida', 'inyectable']],
      ['Ciprofloxacino', ['500 mg'], ['solida']],
      ['Clonazepam', ['0,5 mg', '2 mg'], ['solida']],
      ['Salbutamol', ['100 mcg'], ['inhalador']],
      ['Dexametasona', ['4 mg'], ['solida', 'inyectable']],
      ['Ranitidina', ['150 mg'], ['solida']],
      ['Enalapril', ['10 mg'], ['solida']],
      ['Levotiroxina', ['50 mcg', '100 mcg'], ['solida']],
      ['Amlodipino', ['5 mg', '10 mg'], ['solida']],
    ],
    /**
     * Formas por grupo. En las LIQUIDAS la dosis no entra en el nombre: la
     * concentracion de un jarabe es «mg por 5 ml», no los miligramos de la
     * tableta, y arrastrar ahi el «500 mg» seria escribir una dosis falsa.
     */
    formasPorGrupo: {
      solida: [
        ['tabletas', ['caja x 10', 'caja x 20', 'caja x 100', 'blister x 10']],
        ['capsulas', ['caja x 30', 'caja x 100']],
      ],
      liquida: [
        ['jarabe', ['frasco 60 ml', 'frasco 120 ml']],
        ['suspension', ['frasco 60 ml', 'frasco 100 ml']],
      ],
      inyectable: [['ampollas', ['caja x 5', 'caja x 25']]],
      inhalador: [['inhalador', ['frasco 200 dosis']]],
    },
    copy: (principio, dosis, forma) =>
      `${principio} ${dosis} en ${forma}. Producto farmaceutico; consulte a su medico antes de usar. Conservar por debajo de 30 °C, en su envase original y fuera del alcance de los ninos.`,
  },
  {
    key: 'CPE',
    categorySlug: 'cuidado-personal',
    linea: '02',
    lineaNombre: 'Consumo',
    spart: '20',
    price: [6.9, 129],
    tipos: ['Consumo', 'Dermocosmetico'],
    principios: [
      ['Alcohol en gel', ['70°']],
      ['Jabon liquido antibacterial', ['']],
      ['Shampoo anticaspa', ['']],
      ['Acondicionador reparador', ['']],
      ['Protector solar facial', ['FPS 30', 'FPS 50', 'FPS 70']],
      ['Crema humectante corporal', ['']],
      ['Desodorante antitranspirante', ['']],
      ['Pasta dental con fluor', ['']],
      ['Enjuague bucal', ['']],
      ['Gel de ducha', ['']],
      ['Crema facial con acido hialuronico', ['']],
      ['Bloqueador labial', ['FPS 30']],
      ['Toallitas humedas', ['']],
      ['Talco para pies', ['']],
      ['Mascarilla facial de arcilla', ['']],
    ],
    formas: [
      ['', ['frasco 120 ml', 'frasco 250 ml', 'frasco 400 ml', 'pomo 60 g', 'tubo 90 g', 'pack x 3']],
    ],
    copy: (principio, dosis, forma) =>
      `${principio}${dosis ? ` ${dosis}` : ''} en ${forma}. Uso externo. Dermatologicamente probado; suspender si aparece irritacion.`,
  },
  {
    key: 'VIT',
    categorySlug: 'vitaminas',
    linea: '03',
    lineaNombre: 'Nutricion',
    spart: '30',
    price: [12, 189],
    tipos: ['Suplemento', 'Consumo'],
    principios: [
      ['Vitamina C', ['500 mg', '1 g']],
      ['Vitamina D3', ['1000 UI', '2000 UI']],
      ['Complejo B', ['']],
      ['Omega 3', ['1000 mg']],
      ['Calcio + vitamina D', ['600 mg']],
      ['Magnesio quelado', ['400 mg']],
      ['Zinc', ['50 mg']],
      ['Hierro polimaltosado', ['100 mg']],
      ['Colageno hidrolizado', ['10 g']],
      ['Multivitaminico', ['']],
      ['Acido folico', ['5 mg']],
      ['Probioticos', ['10 000 millones UFC']],
      ['Melatonina', ['3 mg', '5 mg']],
      ['Biotina', ['5 mg']],
      ['Glucosamina + condroitina', ['']],
    ],
    formas: [
      ['tabletas', ['frasco x 30', 'frasco x 60', 'frasco x 100']],
      ['capsulas blandas', ['frasco x 30', 'frasco x 90']],
      ['polvo', ['pote 300 g']],
      ['gomitas', ['frasco x 60']],
    ],
    copy: (principio, dosis, forma) =>
      `${principio}${dosis ? ` ${dosis}` : ''} en ${forma}. Complemento alimenticio; no sustituye una dieta equilibrada. No exceder la dosis diaria recomendada.`,
  },
]

/**
 * Fotos del fondo comun: se buscan UNA vez por familia y se copian a cada
 * producto. Bajar una por producto serian 450 descargas de Wikimedia para
 * ensenar lo mismo.
 */
const PHOTO_QUERIES = {
  MED: [
    'pills medicine blister',
    'medicine bottle pharmacy',
    'pharmaceutical capsules',
    'tablets pills white background',
    'medical syrup bottle',
    'pharmacy medicine box',
    'ampoule vial medicine',
    'inhaler asthma',
  ],
  CPE: [
    'shampoo bottle',
    'liquid soap dispenser',
    'sunscreen lotion bottle',
    'hand sanitizer gel',
    'toothpaste tube',
    'body lotion cream jar',
    'deodorant stick',
    'cosmetic cream container',
  ],
  VIT: [
    'vitamin supplement bottle',
    'dietary supplement capsules',
    'fish oil omega capsules',
    'vitamin tablets jar',
    'protein powder container',
    'multivitamin pills',
    'collagen powder supplement',
    'probiotic capsules',
  ],
}

/**
 * Cuantas fotos DISTINTAS se buscan por familia.
 *
 * La primera version se quedaba en cuatro por familia y las repartia entre 150
 * productos: la rejilla se veia como un mosaico de la misma foto, que es peor
 * que el marcador neutral —el marcador dice «no hay foto», la foto repetida
 * dice «este catalogo es de mentira»—. Con treinta, cada una sale una de cada
 * cinco tarjetas y la repeticion deja de saltar a la vista.
 */
const POOL_TARGET = 30

const REJECT = [
  'drawing', 'engraving', 'lithograph', 'illustration', 'diagram', 'patent', 'painting',
  'baby', 'child', 'girl', 'boy', 'portrait', 'woman', 'people', 'broken', 'damaged',
]
const HISTORIC = /1[5-9]\d\d/

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

/** Aleatorio REPETIBLE: el catalogo de hoy tiene que ser el de manana. */
function rng(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function slugify(text, suffix) {
  const base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${base}-${suffix}`
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function commonsSearch(query) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2' +
    '&generator=search&gsrnamespace=6&gsrlimit=25&gsrsearch=' +
    encodeURIComponent(`filetype:bitmap ${query}`) +
    '&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1000'

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ebim-ecommerce-demo/1.0' } })
    if (response.ok) {
      const body = await response.json()
      await wait(1100)
      return body.query?.pages ?? []
    }
    if (response.status !== 429) return []
    await wait(4000 * (attempt + 1))
  }
  return []
}

function isFree(meta) {
  const short = String(meta?.LicenseShortName?.value ?? '').toLowerCase()
  return short.includes('public domain') || short.includes('cc0')
}

/** Bytes magicos: el limitador de Commons responde 200 con una pagina HTML. */
function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  return null
}

async function upload(path, bytes, mime, cfg) {
  const response = await fetch(`${cfg.url}/storage/v1/object/product-images/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.secret}`,
      apikey: cfg.secret,
      'Content-Type': mime,
      'x-upsert': 'false',
      'cache-control': 'max-age=604800',
    },
    body: bytes,
  })
  if (!response.ok) throw new Error(`storage ${response.status}`)
}

async function copyObject(sourceKey, destinationKey, cfg) {
  const response = await fetch(`${cfg.url}/storage/v1/object/copy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.secret}`,
      apikey: cfg.secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: 'product-images',
      sourceKey,
      destinationBucket: 'product-images',
      destinationKey,
    }),
  })
  if (!response.ok) throw new Error(`copy ${response.status}`)
}

/**
 * Openverse: fotos de PRODUCTO, que es lo que Commons no tiene.
 *
 * Commons es un archivo enciclopedico: sus fotos libres de farmacia son piezas
 * de museo y laminas, y de las pocas utilizables salian cuatro por familia.
 * Openverse agrega bancos de imagen —rawpixel entre ellos— y filtra por
 * licencia de verdad: `cc0,pdm` es dominio publico o equivalente, sin
 * obligacion de atribuir, que es la misma regla que ya seguiamos.
 */
async function openverseSearch(query) {
  const url =
    'https://api.openverse.org/v1/images/?license=cc0,pdm&mature=false&page_size=20&q=' +
    encodeURIComponent(query)
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'ebim-ecommerce-demo/1.0' } })
    if (!response.ok) return []
    const body = await response.json()
    await wait(700)
    return (body.results ?? []).map((item) => ({
      title: String(item.title ?? ''),
      url: item.url,
    }))
  } catch {
    return []
  }
}

/** Sube el fondo comun de fotos de una familia y devuelve sus rutas. */
async function buildPhotoPool(family, store, cfg, wanted = POOL_TARGET) {
  const pool = []
  const seen = new Set()

  async function keep(title, source) {
    if (pool.length >= wanted) return
    const clean = String(title).toLowerCase()
    if (REJECT.some((word) => clean.includes(word)) || HISTORIC.test(clean)) return
    if (!source || seen.has(source)) return
    seen.add(source)

    try {
      const response = await fetch(source, { headers: { 'User-Agent': 'ebim-ecommerce-demo/1.0' } })
      if (!response.ok) return
      const bytes = Buffer.from(await response.arrayBuffer())
      const mime = sniff(bytes)
      // Bytes magicos: un limitador que responde 200 con una pagina de error se
      // subiria como «foto» y en la vitrina saldria rota.
      if (!mime || bytes.byteLength > 5 * 1024 * 1024) return

      // El fondo comun vive en una carpeta propia de la tienda: cumple el CHECK
      // de tenant y no cuelga de ningun producto.
      const extension = mime === 'image/png' ? 'png' : 'jpg'
      const path = `${store.organization_id}/${store.id}/_pool/${family.key.toLowerCase()}-${randomUUID()}.${extension}`
      await upload(path, bytes, mime, cfg)
      pool.push(path)
      await wait(400)
    } catch {
      /* una foto que no baja no puede parar la siembra */
    }
  }

  for (const query of PHOTO_QUERIES[family.key] ?? []) {
    if (pool.length >= wanted) break
    for (const item of await openverseSearch(query)) {
      if (pool.length >= wanted) break
      await keep(item.title, item.url)
    }
  }

  // Commons como respaldo, por si Openverse limita o no cubre una familia.
  for (const query of PHOTO_QUERIES[family.key] ?? []) {
    if (pool.length >= wanted) break
    for (const page of await commonsSearch(query)) {
      if (pool.length >= wanted) break
      const info = page.imageinfo?.[0]
      if (!info || info.mime !== 'image/jpeg' || !isFree(info.extmetadata)) continue
      await keep(page.title, info.thumburl ?? info.url)
    }
  }

  return pool
}

/** Borrado en lote de objetos del bucket. La API acepta rutas de cien en cien. */
async function removeObjects(paths, cfg) {
  for (let start = 0; start < paths.length; start += 100) {
    await fetch(`${cfg.url}/storage/v1/object/product-images`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${cfg.secret}`,
        apikey: cfg.secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: paths.slice(start, start + 100) }),
    }).catch(() => {})
  }
}

/**
 * Rehace SOLO las fotos de lo ya sembrado.
 *
 * Existe porque la primera tanda dejo cuatro fotos por familia repartidas entre
 * ciento cincuenta productos. Rehacer el catalogo entero para cambiar las fotos
 * habria cambiado tambien precios y SKU, y entonces la demo que alguien ya
 * preparo deja de coincidir con lo que ve.
 */
async function rebuildPhotos(store, cfg) {
  const productos = await sql(
    `select p.id, p.sku, left(p.sku, 6) as familia, p.name
       from public.products p
      where p.store_id = ${lit(store.id)} and p.sku like ${lit(`${PREFIX}%`)}
      order by p.sku`,
    cfg,
  )
  if (productos.length === 0) return console.log('No hay productos MQ- que rehacer.')

  const viejas = await sql(
    `select pi.storage_path from public.product_images pi
       join public.products p on p.id = pi.product_id
      where p.store_id = ${lit(store.id)} and p.sku like ${lit(`${PREFIX}%`)}`,
    cfg,
  )
  const pool_viejo = await sql(
    `select name from storage.objects
      where bucket_id = 'product-images' and name like ${lit(`${store.organization_id}/${store.id}/_pool/%`)}`,
    cfg,
  )

  console.log(`Retirando ${viejas.length} foto(s) repetidas y ${pool_viejo.length} del fondo viejo`)
  await sql(
    `delete from public.product_images pi
      using public.products p
      where p.id = pi.product_id and p.store_id = ${lit(store.id)}
        and p.sku like ${lit(`${PREFIX}%`)}`,
    cfg,
  )
  await removeObjects(
    [...viejas.map((row) => row.storage_path), ...pool_viejo.map((row) => row.name)],
    cfg,
  )

  let total = 0
  for (const family of FAMILIES) {
    const mine = productos.filter((row) => row.familia === `${PREFIX}${family.key}`)
    if (mine.length === 0) continue

    const pool = await buildPhotoPool(family, store, cfg)
    console.log(`  fondo ${family.key}: ${pool.length} foto(s) distintas para ${mine.length} productos`)
    if (pool.length === 0) continue

    const values_sql = []
    for (const [index, row] of mine.entries()) {
      const wanted = 2 + (index % 2)
      for (let position = 0; position < wanted; position += 1) {
        // Paso 7 y no 1: con paso 1 las tarjetas contiguas de la rejilla —que
        // es donde se mira— salian con la misma foto.
        const source = pool[(index * 7 + position * 3) % pool.length]
        const extension = source.endsWith('.png') ? 'png' : 'jpg'
        const destination = `${store.organization_id}/${store.id}/${row.id}/${randomUUID()}.${extension}`
        try {
          await copyObject(source, destination, cfg)
        } catch {
          continue
        }
        values_sql.push(
          `(${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)},
            ${lit(row.id)}, ${lit(destination)}, ${lit(row.name)}, ${lit(position)}, false)`,
        )
        total += 1
      }
      if (values_sql.length >= 100) {
        await sql(
          `insert into public.product_images
             (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
           values ${values_sql.join(',\n')}`,
          cfg,
        )
        values_sql.length = 0
        console.log(`  fotos ${total}`)
      }
    }
    if (values_sql.length > 0) {
      await sql(
        `insert into public.product_images
           (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
         values ${values_sql.join(',\n')}`,
        cfg,
      )
      console.log(`  fotos ${total}`)
    }
  }
  console.log(`\nListo: ${total} fotos nuevas repartidas.`)
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const purge = args.includes('--purge')
  const photosOnly = args.includes('--photos')
  const target = args.includes('--target') ? Number(args[args.indexOf('--target') + 1]) : 150

  const values = env()
  const cfg = {
    url: values.VITE_SUPABASE_URL.replace(/\/$/, ''),
    ref: new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0],
    token: values.SUPABASE_ACCESS_TOKEN,
    secret: values.SUPABASE_SECRET_KEY,
  }

  const [store] = await sql(
    `select id, organization_id, company_id, currency from public.stores where slug = ${lit(STORE_SLUG)}`,
    cfg,
  )
  if (!store) throw new Error(`No existe la tienda ${STORE_SLUG}`)

  if (purge) {
    const [{ n }] = await sql(
      `with gone as (
         delete from public.products
          where store_id = ${lit(store.id)} and sku like ${lit(`${PREFIX}%`)}
          returning 1
       ) select count(*)::int as n from gone`,
      cfg,
    )
    console.log(`${n} producto(s) ${PREFIX} borrados.`)
    return
  }

  if (photosOnly) {
    await rebuildPhotos(store, cfg)
    return
  }

  const categories = await sql(
    `select id, slug from public.categories where store_id = ${lit(store.id)}`,
    cfg,
  )
  const brands = await sql(`select id, code from public.brands order by code`, cfg)
  const existing = await sql(
    `select c.slug, count(*)::int as total
       from public.products p
       join public.categories c on c.id = p.category_id
      where p.store_id = ${lit(store.id)}
      group by c.slug`,
    cfg,
  )
  const countOf = Object.fromEntries(existing.map((row) => [row.slug, row.total]))

  const random = rng(20260831)
  const plan = []

  for (const family of FAMILIES) {
    const have = countOf[family.categorySlug] ?? 0
    const missing = Math.max(target - have, 0)
    console.log(`${family.categorySlug}: ${have} → faltan ${missing}`)

    for (let index = 0; index < missing; index += 1) {
      const [principio, dosisList, grupos] =
        family.principios[Math.floor(random() * family.principios.length)]
      const dosis = dosisList[Math.floor(random() * dosisList.length)] ?? ''

      // Familias con formas por grupo (medicamentos) frente a familias con una
      // sola lista (consumo, nutricion).
      const grupo = grupos ? grupos[Math.floor(random() * grupos.length)] : null
      const formas = grupo ? family.formasPorGrupo[grupo] : family.formas
      const [forma, presentaciones] = formas[Math.floor(random() * formas.length)]
      const presentacion = presentaciones[Math.floor(random() * presentaciones.length)]

      // La dosis se cae del nombre en jarabes y suspensiones: ahi la
      // concentracion es por 5 ml y no coincide con la de la tableta.
      const dosisEnNombre = grupo === 'liquida' ? '' : dosis
      const partes = [principio, dosisEnNombre, forma, presentacion].filter(Boolean)
      const name = partes.join(' ')
      const serial = String(index + 1).padStart(3, '0')
      const [floor, ceiling] = family.price
      const price = Math.round((floor + random() * (ceiling - floor)) * 100) / 100
      const rebajado = random() < 0.18
      const stock = random() < 0.1 ? 0 : Math.floor(random() * 240) + 10
      const dado = random()

      plan.push({
        id: randomUUID(),
        family,
        sku: `${PREFIX}${family.key}-${serial}`,
        slug: slugify(name, serial),
        name,
        description: family.copy(principio, dosis, `${forma} ${presentacion}`.trim()),
        price,
        compare: rebajado ? Math.round(price * (1.12 + random() * 0.3) * 100) / 100 : null,
        stock,
        status: dado < 0.94 ? 'published' : dado < 0.98 ? 'draft' : 'archived',
        categoryId: categories.find((row) => row.slug === family.categorySlug)?.id ?? null,
        brandId: brands[Math.floor(random() * brands.length)]?.id ?? null,
        custom: {
          principio_activo: principio,
          tipo_producto: family.tipos[Math.floor(random() * family.tipos.length)],
          linea_codigo: family.linea,
          linea: family.lineaNombre,
          spart: family.spart,
          pack_maestro: [6, 12, 24, 48][Math.floor(random() * 4)],
          igv: IGV,
          // Escala de descuentos por volumen: es LO que su vitrina ensena en el
          // selector «Escala de descuentos», y por eso va estructurada.
          escalas: [
            { desde: 12, descuento: 3 },
            { desde: 48, descuento: 7 },
            { desde: 144, descuento: 12 },
          ],
          bonificaciones: random() < 0.25 ? { lleva: 10, paga: 9 } : null,
        },
      })
    }
  }

  console.log(`\nTotal a crear: ${plan.length}`)
  if (check) {
    for (const row of plan.slice(0, 10)) {
      console.log(`  · ${row.sku}  ${row.name}  S/ ${row.price}  ${row.status}`)
    }
    return
  }
  if (plan.length === 0) return

  for (let start = 0; start < plan.length; start += 25) {
    const batch = plan.slice(start, start + 25)
    const rows = batch
      .map(
        (row) => `(${lit(row.id)}, ${lit(store.organization_id)}, ${lit(store.company_id)},
         ${lit(store.id)}, ${lit(row.categoryId)}, ${lit(row.brandId)}, ${lit(row.sku)},
         ${lit(row.slug)}, ${lit(row.name)}, ${lit(row.description)}, ${lit(row.price)},
         ${lit(row.compare)}, ${lit(store.currency)}, ${lit(row.stock)},
         ${lit(row.status)}::product_status, ${row.status === 'published' ? 'now()' : 'null'},
         ${lit(JSON.stringify(row.custom))}::jsonb)`,
      )
      .join(',\n')

    await sql(
      `insert into public.products
         (id, organization_id, company_id, store_id, category_id, brand_id, sku, slug, name,
          description, price, compare_at_price, currency, stock, status, published_at, custom_fields)
       values ${rows}
       on conflict do nothing`,
      cfg,
    )
    console.log(`  productos ${Math.min(start + 25, plan.length)}/${plan.length}`)
  }

  // ---- Fotos: un fondo por familia, copiado a cada producto ---------------
  let photos = 0
  for (const family of FAMILIES) {
    const mine = plan.filter((row) => row.family.key === family.key)
    if (mine.length === 0) continue

    const pool = await buildPhotoPool(family, store, cfg)
    console.log(`  fondo ${family.key}: ${pool.length} foto(s)`)
    if (pool.length === 0) continue

    const values_sql = []
    for (const [index, row] of mine.entries()) {
      const wanted = 2 + (index % 2)
      for (let position = 0; position < wanted; position += 1) {
        const source = pool[(index + position) % pool.length]
        const destination = `${store.organization_id}/${store.id}/${row.id}/${randomUUID()}.jpg`
        try {
          await copyObject(source, destination, cfg)
        } catch {
          continue
        }
        values_sql.push(
          `(${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)},
            ${lit(row.id)}, ${lit(destination)}, ${lit(row.name)}, ${lit(position)}, false)`,
        )
        photos += 1
      }
      if (values_sql.length >= 100) {
        await sql(
          `insert into public.product_images
             (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
           values ${values_sql.join(',\n')}`,
          cfg,
        )
        values_sql.length = 0
        console.log(`  fotos ${photos}`)
      }
    }
    if (values_sql.length > 0) {
      await sql(
        `insert into public.product_images
           (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
         values ${values_sql.join(',\n')}`,
        cfg,
      )
      console.log(`  fotos ${photos}`)
    }
  }

  // ---- Existencias: en los ALMACENES, no en products.stock ---------------
  const [inventario] = await sql(
    `with nuevas as (
       insert into public.inventory_levels
         (organization_id, company_id, warehouse_id, store_id, product_id,
          on_hand_qty, reserved_qty, safety_stock, reorder_point)
       select p.organization_id, p.company_id, w.id, p.store_id, p.id,
              case when w.code = 'ALM-LIM' then ceil(p.stock * 0.7) else floor(p.stock * 0.3) end,
              0, 0, 12
         from public.products p
         join public.warehouses w
           on w.organization_id = p.organization_id
          and w.company_id = p.company_id
          and w.is_active
          and w.code in ('ALM-LIM', 'TDA-MIR')
        where p.store_id = ${lit(store.id)}
          and p.sku like ${lit(`${PREFIX}%`)}
          and not exists (
            select 1 from public.inventory_levels il
             where il.product_id = p.id and il.warehouse_id = w.id and il.variant_id is null
          )
       returning 1
     ) select count(*)::int as n from nuevas`,
    cfg,
  )
  console.log(`  inventario: ${inventario.n} fila(s)`)

  const [resumen] = await sql(
    `select count(*)::int as productos,
            count(*) filter (where status = 'published')::int as publicados
       from public.products where store_id = ${lit(store.id)}`,
    cfg,
  )
  console.log(`\nListo: ${resumen.productos} productos (${resumen.publicados} publicados), ${photos} fotos nuevas.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
