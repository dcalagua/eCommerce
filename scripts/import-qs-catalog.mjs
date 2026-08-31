#!/usr/bin/env node
/**
 * Importa el catalogo REAL de MiQuimica: productos del microservicio de Quimica
 * Suiza y fotos de su CDN publico.
 *
 * ## Las dos mitades, y por que estaban separadas
 *
 * El microservicio (`POST {api}Product/ProductsByLine/v1`, cabecera
 * `Authorization_App`) devuelve el producto SIN foto: no hay campo de imagen en
 * su modelo. La foto la COMPONE su tienda, y asi es como lo hace
 * (`card-product.component.ts`):
 *
 *   {base}/{lineCode}/{productCode}-s.jpg     (sociedad 1010)
 *   {base}/{societyCode}/{lineCode}/{code}-s.jpg   (las demas)
 *
 * con `base = https://extranet.quimicasuiza.com/catalogo/`. El sufijo es el
 * tamano: `-s` para la rejilla, `-l` para la ficha. Es un CDN publico, sin
 * credencial. Aqui se bajan las dos y se suben a NUESTRO bucket en vez de
 * enlazar el suyo: una vitrina que depende del CDN de un tercero se queda sin
 * fotos el dia que ese tercero cambie una ruta.
 *
 * ## Lo que hace falta para que la consulta no expire
 *
 * `lineCode`. Sin linea, el procedimiento escanea todo y muere a los 30 s. Las
 * lineas se descubren del propio CDN, que lista directorios: una carpeta por
 * linea. `--discover` las enumera con su nombre y su numero de productos.
 *
 * ## El stock NO es real
 *
 * Su precio y su existencia son POR CLIENTE: sin `CustomerCode` el servicio
 * responde `stock: 0` e `inStock: "NO"` para todo. Como una vitrina entera en
 * agotado no se puede ensenar, el stock se SIMULA y queda anotado en
 * `custom_fields.stock_simulado`. El precio (`priceTotal`) si viene, y es el de
 * lista. Con un `CustomerCode` de pruebas (`QS_CUSTOMER_CODE`) llegarian los
 * suyos y esto se cae solo.
 *
 *   QS_APP_TOKEN=...  node scripts/import-qs-catalog.mjs --discover
 *   QS_APP_TOKEN=...  node scripts/import-qs-catalog.mjs --lines 041,922,305 --limit 150
 *   QS_APP_TOKEN=...  node scripts/import-qs-catalog.mjs --lines 041 --limit 20 --no-images
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'
const PREFIX = 'QS-'

const DEFAULT_API = 'https://qrq.quimicasuiza.com:8283/Product/'
const DEFAULT_IMAGES = 'https://extranet.quimicasuiza.com/catalogo/'

/**
 * Configuracion: `.env` primero, y las variables de entorno mandan por encima.
 *
 * El entorno gana a proposito. Una credencial que solo hace falta para una
 * corrida no tiene por que quedarse escrita en el disco: pasandola en la
 * invocacion vive lo que vive el proceso.
 */
function env() {
  let file = {}
  try {
    const raw = readFileSync(join(ROOT, '.env'), 'utf8')
    file = Object.fromEntries(
      raw
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
        }),
    )
  } catch {
    // Sin `.env` se puede trabajar entero desde el entorno.
  }
  const fromEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => Boolean(value)),
  )
  return { ...file, ...fromEnv }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function sql(query, cfg) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${cfg.ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.supabaseToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

function lit(value) {
  if (value === null || value === undefined || value === '') return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Consulta al microservicio. Solo lectura, y siempre con linea. */
async function productsByLine(lineCode, cfg, totalFilter = 500) {
  const filter = {
    productCode: '',
    productCodes: [],
    productDescription: '',
    lineCode,
    lineCodes: [lineCode],
    societyCode: cfg.society,
    codCentro: cfg.codCentro,
    treatmentCode: cfg.treatmentCode,
    oficina: cfg.oficina,
    BusinessFeature: '',
    SaleOrg: cfg.saleOrg,
    CustomerCode: cfg.customerCode,
    Categories: [],
    isFilterBonif: false,
    isFilterScale: false,
    totalFilter,
    Cod_Almacen: '',
  }

  const response = await fetch(`${cfg.api}ProductsByLine/v1?`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization_App: cfg.token },
    body: JSON.stringify(filter),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`QS ${response.status}: ${text.slice(0, 200)}`)
  const body = JSON.parse(text)
  if (body.IsValid === false) throw new Error(`QS: ${body.Message}`)
  return body.Body ?? []
}

/** Las lineas salen del CDN: lista directorios, una carpeta por linea. */
async function discoverLines(cfg) {
  const response = await fetch(cfg.images)
  const html = await response.text()
  return [...html.matchAll(/HREF="[^"]*\/catalogo\/([^/"]+)\/"/gi)]
    .map((match) => match[1])
    .filter((code) => /^\d+$/.test(code))
}

function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  return null
}

/** Baja una foto del CDN. `null` si no existe o si lo que llega no es imagen. */
async function fetchPhoto(lineCode, productCode, size, cfg) {
  const suffix = cfg.society === '1010' ? '' : `${cfg.society}/`
  const url = `${cfg.images}${suffix}${lineCode}/${productCode}-${size}.jpg`
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    // Bytes magicos: el CDN responde con una pagina de error en 200 para
    // algunas rutas, y esa «foto» acabaria rota en la vitrina.
    const mime = sniff(bytes)
    if (!mime || bytes.byteLength < 500 || bytes.byteLength > 5 * 1024 * 1024) return null
    return { bytes, mime }
  } catch {
    return null
  }
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

/**
 * MAYUSCULAS DE ERP a algo legible en una vitrina.
 *
 * La inicial se busca por POSICION (principio, o detras de espacio, parentesis,
 * barra o guion) y no con `\b`: en JavaScript el limite de palabra es ASCII, y
 * «elastica» tiene frontera antes de la «a» acentuada — de ahi salia
 * «ElÁStica». Es el fallo clasico de mayusculizar espanol con `\b`.
 */
function titleCase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/(^|[\s(/\-.])([a-záéíóúüñ])/g, (_, prefix, letter) => prefix + letter.toUpperCase())
    // Unidades y siglas que NO son nombres propios y quedan ridiculas en
    // capital: «30 Comp Rec» se lee peor que «30 comp rec».
    .replace(/\b(Mg|Ml|Gr|Und|Un|Comp|Rec|Cja|Tab|Cap|Caps|X)\b/g, (word) => word.toLowerCase())
    .replace(/\bDe\b/g, 'de')
    .trim()
}

function slugify(text, suffix) {
  const base = String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'producto'}-${suffix}`
}

async function main() {
  const args = process.argv.slice(2)
  const discover = args.includes('--discover')
  const noImages = args.includes('--no-images')
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 150
  const lines = args.includes('--lines')
    ? String(args[args.indexOf('--lines') + 1]).split(',').map((code) => code.trim())
    : []

  const values = env()
  if (!values.QS_APP_TOKEN) {
    throw new Error(
      'Falta QS_APP_TOKEN. Este script NO lee credenciales del repositorio de la API: ' +
        'la pone una persona a conciencia (ver cabecera del archivo).',
    )
  }

  const cfg = {
    api: (values.QS_PRODUCT_API ?? DEFAULT_API).replace(/\/?$/, '/'),
    images: (values.QS_IMAGES_BASE ?? DEFAULT_IMAGES).replace(/\/?$/, '/'),
    token: values.QS_APP_TOKEN,
    society: values.QS_SOCIETY_CODE ?? '1010',
    saleOrg: values.QS_SALE_ORG ?? '1011',
    customerCode: values.QS_CUSTOMER_CODE ?? '',
    treatmentCode: values.QS_TREATMENT_CODE ?? '',
    codCentro: values.QS_COD_CENTRO ?? '',
    oficina: values.QS_OFICINA ?? '',
    url: (values.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''),
    ref: values.VITE_SUPABASE_URL ? new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0] : '',
    supabaseToken: values.SUPABASE_ACCESS_TOKEN,
    secret: values.SUPABASE_SECRET_KEY,
  }

  if (discover) {
    const codes = lines.length > 0 ? lines : await discoverLines(cfg)
    console.log(`${codes.length} carpeta(s) de linea en el CDN. Preguntando por cada una...\n`)
    const found = []
    for (const code of codes) {
      try {
        const rows = await productsByLine(code, cfg, 1)
        const first = rows[0]
        if (first?.total > 0) {
          found.push({ code, nombre: first.lineName, productos: first.total })
          console.log(`  ${code.padEnd(5)} ${String(first.total).padStart(5)}  ${first.lineName}`)
        }
      } catch (error) {
        console.log(`  ${code.padEnd(5)}     ?  ${error.message.slice(0, 60)}`)
      }
      await wait(300)
    }
    console.log(`\n${found.length} linea(s) con catalogo.`)
    return
  }

  if (lines.length === 0) throw new Error('Indica al menos una linea: --lines 041,922')
  if (!cfg.ref || !cfg.supabaseToken) throw new Error('Falta VITE_SUPABASE_URL o SUPABASE_ACCESS_TOKEN')

  const [store] = await sql(
    `select id, organization_id, company_id, currency from public.stores where slug = ${lit(STORE_SLUG)}`,
    cfg,
  )
  if (!store) throw new Error(`No existe la tienda ${STORE_SLUG}`)

  const existing = await sql(
    `select lower(sku) as sku from public.products where store_id = ${lit(store.id)}`,
    cfg,
  )
  const already = new Set(existing.map((row) => row.sku))

  let creados = 0
  let fotos = 0

  for (const lineCode of lines) {
    let rows
    try {
      rows = await productsByLine(lineCode, cfg)
    } catch (error) {
      console.log(`! linea ${lineCode}: ${error.message}`)
      continue
    }

    const useful = rows
      .filter((row) => row.productCode && row.productDescription)
      .filter((row) => !already.has(`${PREFIX}${row.productCode}`.toLowerCase()))
      .slice(0, limit)

    console.log(`\nLinea ${lineCode} · ${rows[0]?.lineName ?? '?'} · ${rows.length} recibidos, ${useful.length} nuevos`)
    if (useful.length === 0) continue

    // Categorias y marcas REALES: la categoria viene en el producto y la marca
    // es el laboratorio (la linea). Se crean las que falten.
    const categorias = [...new Set(useful.map((row) => row.category?.trim() || rows[0]?.lineName))]
    for (const nombre of categorias.filter(Boolean)) {
      await sql(
        `insert into public.categories (organization_id, company_id, store_id, slug, name, position, is_active)
         values (${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)},
                 ${lit(slugify(nombre, 'qs'))}, ${lit(nombre)}, 50, true)
         on conflict do nothing`,
        cfg,
      )
    }
    const marca = rows[0]?.lineName
    if (marca) {
      await sql(
        `insert into public.brands (organization_id, company_id, code, name, is_active)
         values (${lit(store.organization_id)}, ${lit(store.company_id)},
                 ${lit(slugify(marca, lineCode))}, ${lit(titleCase(marca))}, true)
         on conflict do nothing`,
        cfg,
      )
    }

    const cats = await sql(
      `select id, name from public.categories where store_id = ${lit(store.id)}`,
      cfg,
    )
    const brands = await sql(`select id, name from public.brands`, cfg)
    const catId = (nombre) =>
      cats.find((row) => row.name?.toLowerCase() === String(nombre ?? '').toLowerCase())?.id ?? null
    const brandId =
      brands.find((row) => row.name?.toLowerCase() === titleCase(marca).toLowerCase())?.id ?? null

    const prepared = useful.map((row, index) => {
      const name = titleCase(row.tradename?.trim() || row.productDescription)
      return {
        id: randomUUID(),
        code: row.productCode,
        sku: `${PREFIX}${row.productCode}`,
        slug: slugify(name, row.productCode),
        name,
        description: row.commercialDescription?.trim() || null,
        price: Number(row.priceTotal ?? 0),
        // Su existencia es por cliente y sin cliente responde 0: se simula y
        // queda anotado que es simulada.
        stock: Number(row.stock) > 0 ? Math.trunc(Number(row.stock)) : 20 + ((index * 7) % 180),
        categoryId: catId(row.category?.trim() || rows[0]?.lineName),
        custom: {
          codigo_qs: row.productCode,
          ean: row.ean || null,
          principio_activo: row.activePrinciple || null,
          nombre_comercial: row.tradename || null,
          tipo_producto: row.productType || null,
          linea_codigo: row.lineCode,
          linea: row.lineName,
          categoria_qs: row.category || null,
          id_categoria_qs: row.idCategory || null,
          pack_maestro: row.masterPack ?? null,
          igv: row.tax ?? null,
          escalas: row.itemsScales ?? [],
          bonificaciones: row.itemsBonuses ?? [],
          stock_simulado: !(Number(row.stock) > 0),
        },
      }
    })

    for (let start = 0; start < prepared.length; start += 25) {
      const batch = prepared.slice(start, start + 25)
      const valuesSql = batch
        .map(
          (row) => `(${lit(row.id)}, ${lit(store.organization_id)}, ${lit(store.company_id)},
           ${lit(store.id)}, ${lit(row.categoryId)}, ${lit(brandId)}, ${lit(row.sku)},
           ${lit(row.slug)}, ${lit(row.name)}, ${lit(row.description)}, ${lit(row.price)},
           ${lit(store.currency)}, ${lit(row.stock)}, 'published'::product_status, now(),
           ${lit(JSON.stringify(row.custom))}::jsonb)`,
        )
        .join(',\n')

      await sql(
        `insert into public.products
           (id, organization_id, company_id, store_id, category_id, brand_id, sku, slug, name,
            description, price, currency, stock, status, published_at, custom_fields)
         values ${valuesSql}
         on conflict do nothing`,
        cfg,
      )
      creados += batch.length
      console.log(`  productos ${Math.min(start + 25, prepared.length)}/${prepared.length}`)
    }

    if (noImages) continue

    /**
     * Los ids REALES, releidos de la base.
     *
     * El insert lleva `on conflict do nothing`, asi que un producto que choque
     * —mismo SKU o mismo slug que uno ya existente— no entra, y su id generado
     * aqui no existe en ninguna parte. Colgarle una foto de ese id reventaba
     * con violacion de clave ajena y se llevaba por delante el lote entero.
     */
    const landed = await sql(
      `select id, sku from public.products
        where store_id = ${lit(store.id)}
          and sku in (${prepared.map((row) => lit(row.sku)).join(', ')})`,
      cfg,
    )
    const idOf = new Map(landed.map((row) => [row.sku, row.id]))
    console.log(`  en base: ${idOf.size}/${prepared.length}`)

    // ---- Fotos del CDN, la grande primero -------------------------------
    const imageRows = []
    for (const row of prepared) {
      const productId = idOf.get(row.sku)
      if (!productId) continue
      let position = 0
      for (const size of ['l', 's']) {
        const photo = await fetchPhoto(lineCode, row.code, size, cfg)
        if (!photo) continue
        const path = `${store.organization_id}/${store.id}/${productId}/${randomUUID()}.jpg`
        try {
          await upload(path, photo.bytes, photo.mime, cfg)
        } catch {
          continue
        }
        imageRows.push(
          `(${lit(store.organization_id)}, ${lit(store.company_id)}, ${lit(store.id)},
            ${lit(productId)}, ${lit(path)}, ${lit(row.name)}, ${lit(position)}, false)`,
        )
        position += 1
        fotos += 1
      }
      if (imageRows.length >= 60) {
        await sql(
          `insert into public.product_images
             (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
           values ${imageRows.join(',\n')}`,
          cfg,
        )
        imageRows.length = 0
        console.log(`  fotos ${fotos}`)
      }
      await wait(60)
    }
    if (imageRows.length > 0) {
      await sql(
        `insert into public.product_images
           (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
         values ${imageRows.join(',\n')}`,
        cfg,
      )
      console.log(`  fotos ${fotos}`)
    }
  }

  // ---- Existencias en los ALMACENES, que es de donde lee la vitrina ------
  const [inv] = await sql(
    `with nuevas as (
       insert into public.inventory_levels
         (organization_id, company_id, warehouse_id, store_id, product_id,
          on_hand_qty, reserved_qty, safety_stock, reorder_point)
       select p.organization_id, p.company_id, w.id, p.store_id, p.id,
              case when w.code = 'ALM-LIM' then ceil(p.stock * 0.7) else floor(p.stock * 0.3) end,
              0, 0, 12
         from public.products p
         join public.warehouses w
           on w.organization_id = p.organization_id and w.company_id = p.company_id
          and w.is_active and w.code in ('ALM-LIM', 'TDA-MIR')
        where p.store_id = ${lit(store.id)} and p.sku like ${lit(`${PREFIX}%`)}
          and not exists (
            select 1 from public.inventory_levels il
             where il.product_id = p.id and il.warehouse_id = w.id and il.variant_id is null
          )
       returning 1
     ) select count(*)::int as n from nuevas`,
    cfg,
  )

  console.log(`\nListo: ${creados} productos, ${fotos} fotos, ${inv.n} filas de inventario.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
