#!/usr/bin/env node
/**
 * Catalogo de DEMOSTRACION a escala: ~100 productos con fotos, en la tienda
 * `casa-nordica` del proyecto de DEV/QAS.
 *
 * Por que existe: con doce productos no se ve nada de lo que hay que ensenar en
 * una demo —paginacion, filtros que descartan de verdad, orden por precio,
 * agotados, rebajados, borradores— porque todo cabe en una pantalla. Cien
 * productos convierten esas funciones en algo que se puede mirar funcionando.
 *
 * ## Las fotos se COPIAN, no se vuelven a descargar
 *
 * Las de `seed-product-images.mjs` ya estan en el bucket y ya tienen su
 * procedencia anotada en `supabase/demo-images.json`. Bajar trescientas mas de
 * Commons seria media hora de limitador ajeno para ensenar lo mismo: aqui se
 * usa la copia servidor-a-servidor de Storage, que no mueve bytes por la red
 * del que ejecuta y tarda milisegundos.
 *
 * Cada copia es un objeto NUEVO con su ruta —`product_images_path_unique` no
 * deja que dos productos compartan una— y en la carpeta de SU producto, para no
 * romper el CHECK de tenant ni dejar rutas que apunten al producto de otro.
 * Las fotos se reparten por familia: a una silla le tocan fotos de sillas.
 *
 * ## Que genera
 *
 * Nombres y descripciones compuestos de piezas reales del sector (material,
 * acabado, medida), no `Producto 47`: en una demo el catalogo se LEE, y una
 * rejilla de nombres numerados delata el relleno. Los precios van por rango de
 * familia y no por rango global, por lo mismo: un cojin al precio de una mesa
 * se nota antes que cualquier nombre. Precios, stock y estado con
 * variedad deliberada —agotados, rebajados, borradores, archivados— porque cada
 * uno enciende una parte distinta de la vitrina y del backoffice.
 *
 * Idempotente: todos los SKU llevan prefijo `DEMO-`, y lo que ya existe se
 * respeta. Correrlo dos veces no duplica nada.
 *
 *   node scripts/seed-demo-catalog.mjs --check
 *   node scripts/seed-demo-catalog.mjs --count 100
 *   node scripts/seed-demo-catalog.mjs --purge     (borra SOLO lo que creo)
 *   node scripts/seed-demo-catalog.mjs --stock     (solo rehacer existencias)
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'supabase', 'demo-images.json')

/** Tienda de demo. Las otras dos (borrador y tenant B) se dejan como estan. */
const STORE_SLUG = 'casa-nordica'
const PREFIX = 'DEMO-'

/**
 * Familias del catalogo. Cada una dice de que categoria cuelga, de que SKU
 * salen sus fotos y con que piezas se componen sus nombres.
 *
 * `photoFrom` es el prefijo de SKU sembrado por `seed-product-images.mjs`: las
 * fotos de sillas para las sillas. Una lampara con foto de mesa se nota a la
 * primera y estropea justo lo que la demo quiere ensenar.
 */
const FAMILIES = [
  {
    key: 'sillas',
    price: [129, 690],
    categorySlug: 'sillas',
    photoFrom: ['SIL-', 'P09-'],
    weight: 34,
    types: ['Silla', 'Silla de comedor', 'Butaca', 'Taburete', 'Banqueta', 'Silla de escritorio'],
    materials: ['de roble', 'de haya', 'de nogal', 'de abedul', 'de fresno', 'tapizada en lino', 'tapizada en bouclé', 'de ratán'],
    finishes: ['natural', 'al aceite', 'ahumado', 'blanco mate', 'nogal oscuro', 'gris piedra', 'arena'],
    copy: [
      'Estructura ensamblada a espiga, sin tornillería a la vista.',
      'Asiento moldeado en contrachapado de nueve capas.',
      'Apilable y pensada para espacios chicos.',
      'Tapizado desmontable y lavable en agua fría.',
      'Patas con regatones de fieltro para no marcar el suelo.',
    ],
  },
  {
    key: 'mesas',
    price: [290, 1890],
    categorySlug: 'mesas',
    photoFrom: ['MES-'],
    weight: 30,
    types: ['Mesa de comedor', 'Mesa auxiliar', 'Mesa de centro', 'Escritorio', 'Consola', 'Mesa alta'],
    materials: ['de roble macizo', 'de pino', 'de nogal', 'con sobre de mármol', 'con tapa de linóleo', 'de acero y madera'],
    finishes: ['extensible', 'redonda', 'rectangular', 'plegable', 'de 140 cm', 'de 180 cm'],
    copy: [
      'Sobre de una sola pieza, canto biselado a mano.',
      'Estructura atornillada por dentro: se monta en diez minutos.',
      'Tratada con aceite duro, apta para uso diario.',
      'Patas desmontables para pasar por puertas estrechas.',
      'Admite hasta 80 kg repartidos sobre el sobre.',
    ],
  },
  {
    key: 'iluminacion',
    price: [89, 780],
    categorySlug: 'iluminacion',
    photoFrom: ['ILU-', 'TB-'],
    weight: 22,
    types: ['Lámpara colgante', 'Lámpara de pie', 'Lámpara de mesa', 'Aplique', 'Flexo', 'Plafón'],
    materials: ['de vidrio opal', 'de latón', 'de acero mate', 'de cerámica', 'con pantalla de lino', 'de aluminio'],
    finishes: ['E27', 'regulable', 'de 40 cm', 'con cable textil', 'orientable', 'de tres luces'],
    copy: [
      'Casquillo E27, bombilla no incluida.',
      'Cable textil de dos metros con interruptor de paso.',
      'Regulador de intensidad en el propio cable.',
      'Difusor de vidrio soplado, cada pieza es distinta.',
      'Instalación a techo con florón incluido.',
    ],
  },
  {
    key: 'textil',
    price: [29, 189],
    categorySlug: 'sillas',
    photoFrom: ['ACC-'],
    weight: 14,
    types: ['Cojín', 'Funda de cojín', 'Manta', 'Plaid', 'Almohadón'],
    materials: ['de lana', 'de algodón peinado', 'de lino lavado', 'de mezcla de lana', 'de terciopelo'],
    finishes: ['gris', 'crudo', 'verde salvia', 'ocre', 'de 45×45', 'de 60×60'],
    copy: [
      'Relleno de fibra hueca siliconada, incluido.',
      'Funda con cremallera oculta, lavable a 30°.',
      'Tejido en telar tradicional, remate a mano.',
      'Encoge menos de un 2 % en el primer lavado.',
    ],
  },
]

/**
 * Existencias de los productos sembrados, EN LOS ALMACENES.
 *
 * `products.stock` no es la existencia de esta tienda. Casa Nordica tiene
 * almacenes que la sirven, y en ese caso `ebim.atp` —de quien cuelga el
 * `in_stock` de la vitrina— suma `inventory_levels` de los almacenes servidores
 * e IGNORA la columna del catalogo, que es el camino corto del tenant que aun
 * no tiene almacenes. Un producto sin fila de inventario no es un producto sin
 * stock: es un producto del que no se sabe nada, y el motor responde 0.
 *
 * Se reparte 70/30 entre el almacen central y la tienda, que es lo que hace que
 * el desglose por almacen del backoffice tenga algo que ensenar. Los agotados
 * se quedan en cero A PROPOSITO: son los que prueban el filtro de
 * disponibilidad y el aviso de sin stock.
 *
 * Idempotente: solo crea la fila que falta para cada par (producto, almacen).
 */
async function seedInventory(store, cfg) {
  const [row] = await sql(
    `with nuevas as (
       insert into public.inventory_levels
         (organization_id, company_id, warehouse_id, store_id, product_id,
          on_hand_qty, reserved_qty, safety_stock, reorder_point)
       select p.organization_id, p.company_id, w.id, p.store_id, p.id,
              case when w.code = 'ALM-LIM' then ceil(p.stock * 0.7) else floor(p.stock * 0.3) end,
              0, 0, 3
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
             where il.product_id = p.id
               and il.warehouse_id = w.id
               and il.variant_id is null
          )
       returning 1
     ) select count(*)::int as n from nuevas`,
    cfg,
  )
  console.log(`  inventario: ${row.n} fila(s) nuevas en ALM-LIM y TDA-MIR`)
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
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Copia servidor-a-servidor dentro del bucket. No baja ni sube bytes. */
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
  if (!response.ok) {
    throw new Error(`copy ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
}

/**
 * Aleatorio REPETIBLE.
 *
 * Con `Math.random` cada corrida daria otro catalogo, y entonces el precio que
 * alguien vio ayer en la demo no es el de hoy. Semilla fija: el catalogo es
 * siempre el mismo, y eso es lo que permite preparar una demo.
 */
function rng(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const purge = args.includes('--purge')
  const stockOnly = args.includes('--stock')
  const total = args.includes('--count') ? Number(args[args.indexOf('--count') + 1]) : 100

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
    // Solo lo suyo: el prefijo DEMO- es la frontera. Las imagenes caen por
    // `on delete cascade` de `product_images.product_id`.
    const [{ borrados }] = await sql(
      `with gone as (
         delete from public.products
          where store_id = ${lit(store.id)} and sku like ${lit(`${PREFIX}%`)}
          returning 1
       ) select count(*)::int as borrados from gone`,
      cfg,
    )
    console.log(`${borrados} producto(s) DEMO- borrados. Los objetos del bucket quedan huerfanos a proposito: se reutilizan si se vuelve a sembrar.`)
    return
  }

  if (stockOnly) {
    await seedInventory(store, cfg)
    return
  }

  const categories = await sql(
    `select id, slug from public.categories where store_id = ${lit(store.id)}`,
    cfg,
  )
  const brands = await sql(`select id, code from public.brands order by code`, cfg)
  const existing = await sql(
    `select sku from public.products where store_id = ${lit(store.id)} and sku like ${lit(`${PREFIX}%`)}`,
    cfg,
  )
  const already = new Set(existing.map((row) => row.sku))

  if (!existsSync(MANIFEST)) {
    throw new Error('Falta supabase/demo-images.json: corre antes seed-product-images.mjs')
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

  /** Fotos disponibles por familia, sacadas de lo ya sembrado. */
  const pools = Object.fromEntries(
    FAMILIES.map((family) => [
      family.key,
      Object.entries(manifest)
        .filter(([sku]) => family.photoFrom.some((start) => sku.startsWith(start)))
        .flatMap(([, entries]) => (Array.isArray(entries) ? entries : []))
        .map((entry) => entry.storage_path)
        .filter(Boolean),
    ]),
  )

  const missingPools = FAMILIES.filter((family) => (pools[family.key] ?? []).length === 0)
  if (missingPools.length > 0) {
    console.log(`Aviso: sin fotos para ${missingPools.map((f) => f.key).join(', ')} — esos productos saldran sin imagen.`)
  }

  const random = rng(20260830)
  const rows = []
  const weightTotal = FAMILIES.reduce((sum, family) => sum + family.weight, 0)

  let made = 0
  let index = 0
  while (made < total && index < total * 6) {
    index += 1
    // Reparto por peso: mas sillas que cojines, como en una tienda de verdad.
    let ticket = random() * weightTotal
    const family = FAMILIES.find((item) => (ticket -= item.weight) < 0) ?? FAMILIES[0]

    const type = family.types[Math.floor(random() * family.types.length)]
    const material = family.materials[Math.floor(random() * family.materials.length)]
    const finish = family.finishes[Math.floor(random() * family.finishes.length)]
    const name = `${type} ${material} ${finish}`
    const sku = `${PREFIX}${family.key.slice(0, 3).toUpperCase()}-${String(made + 1).padStart(3, '0')}`
    if (already.has(sku)) {
      made += 1
      continue
    }

    const slugBase = slugify(name)
    // El precio sale del rango de SU familia: un cojin de S/ 1400 delata el
    // relleno mas que cualquier nombre inventado.
    const [floor, ceiling] = family.price
    const price = Math.round((floor + random() * (ceiling - floor)) * 100) / 100
    // Uno de cada cinco, rebajado: la vitrina tiene que ensenar el tachado.
    const compare = random() < 0.2 ? Math.round(price * (1.15 + random() * 0.35) * 100) / 100 : null
    // Uno de cada diez, agotado: es lo que prueba el filtro de disponibilidad.
    // `in_stock` no se escribe: es columna GENERADA a partir de `stock`.
    const stock = random() < 0.1 ? 0 : Math.floor(random() * 40) + 1
    const dice = random()
    const status = dice < 0.9 ? 'published' : dice < 0.97 ? 'draft' : 'archived'

    rows.push({
      id: randomUUID(),
      sku,
      slug: `${slugBase}-${String(made + 1).padStart(3, '0')}`,
      name,
      description: `${family.copy[Math.floor(random() * family.copy.length)]} ${type} ${material}, acabado ${finish}.`,
      price,
      compare,
      stock,
      status,
      categoryId: categories.find((row) => row.slug === family.categorySlug)?.id ?? null,
      brandId: brands[Math.floor(random() * brands.length)]?.id ?? null,
      family: family.key,
    })
    made += 1
  }

  const nuevos = rows.length
  console.log(`Proyecto ${cfg.ref} · tienda ${STORE_SLUG} · ${nuevos} producto(s) nuevos de ${total}`)
  if (check) {
    for (const row of rows.slice(0, 8)) {
      console.log(`  · ${row.sku}  ${row.name}  S/ ${row.price}  ${row.status}  stock ${row.stock}`)
    }
    console.log(`  … y ${Math.max(nuevos - 8, 0)} mas`)
    return
  }
  if (nuevos === 0) return

  // Insercion por lotes: cien `insert` sueltos son cien viajes de red, y la
  // Management API cobra latencia por viaje, no por fila.
  for (let start = 0; start < rows.length; start += 25) {
    const batch = rows.slice(start, start + 25)
    const valuesSql = batch
      .map((row) =>
        `(${lit(row.id)}, ${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)},
          ${lit(row.categoryId)}, ${lit(row.brandId)}, ${lit(row.sku)}, ${lit(row.slug)}, ${lit(row.name)},
          ${lit(row.description)}, ${lit(row.price)}, ${lit(row.compare)}, ${lit(store.currency)},
          ${lit(row.stock)}, ${lit(row.status)}::product_status,
          ${row.status === 'published' ? 'now()' : 'null'})`,
      )
      .join(',\n')

    await sql(
      `insert into public.products
         (id, organization_id, company_id, store_id, category_id, brand_id, sku, slug, name,
          description, price, compare_at_price, currency, stock, status, published_at)
       values ${valuesSql}
       -- Sin objetivo: los indices unicos de products son de EXPRESION
       -- (lower(sku), lower(slug)) y no se pueden nombrar en un ON CONFLICT.
       on conflict do nothing`,
      cfg,
    )
    console.log(`  productos ${start + batch.length}/${rows.length}`)
  }

  // Fotos: dos o tres por producto, copiadas del fondo de su familia.
  let photos = 0
  for (let start = 0; start < rows.length; start += 20) {
    const batch = rows.slice(start, start + 20)
    const imageValues = []

    for (const row of batch) {
      const pool = pools[row.family] ?? []
      if (pool.length === 0) continue
      const wanted = 2 + Math.floor(random() * 2)

      for (let position = 0; position < wanted; position += 1) {
        const source = pool[(photos + position * 3) % pool.length]
        const extension = source.split('.').pop() ?? 'jpg'
        const destination = `${store.organization_id}/${store.id}/${row.id}/${randomUUID()}.${extension}`
        try {
          await copyObject(source, destination, cfg)
        } catch (error) {
          console.log(`  ! ${row.sku} foto ${position}: ${error.message}`)
          continue
        }
        imageValues.push(
          `(${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)}, ${lit(row.id)},
            ${lit(destination)}, ${lit(row.name)}, ${lit(position)}, false)`,
        )
        photos += 1
      }
    }

    if (imageValues.length > 0) {
      await sql(
        `insert into public.product_images
           (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
         values ${imageValues.join(',\n')}`,
        cfg,
      )
    }
    console.log(`  fotos ${photos}`)
  }

  await seedInventory(store, cfg)

  const [resumen] = await sql(
    `select count(*)::int as productos,
            count(*) filter (where status = 'published')::int as publicados,
            (select count(*)::int from public.product_images pi
              join public.products p on p.id = pi.product_id
             where p.store_id = ${lit(store.id)}) as imagenes
       from public.products where store_id = ${lit(store.id)}`,
    cfg,
  )
  console.log(`\nListo: ${resumen.productos} productos en la tienda (${resumen.publicados} publicados), ${resumen.imagenes} imagenes.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
