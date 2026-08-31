#!/usr/bin/env node
/**
 * Importa el catalogo de MiQuimica desde el microservicio de Quimica Suiza.
 *
 * ## Que es esto y que NO es
 *
 * `D:\PROYECTOS_NET\Api` no tiene productos dentro: es un proxy .NET que pide
 * el catalogo a un microservicio externo
 * (`POST {endpoint}ProductsByLine/v1`, cabecera `Authorization_App`). Lo unico
 * local es `Scripts/Data.sql`, que trae CLIENTES REALES con su RUC: eso no
 * entra en una demo ni por asomo.
 *
 * Asi que este script habla con ese microservicio, mapea su modelo al nuestro y
 * siembra la tienda de demo. Es de LECTURA contra el sistema ajeno: solo
 * consulta productos. Nada de pedidos, nada de clientes.
 *
 * ## La credencial no vive aqui
 *
 * `QS_APP_TOKEN` sale del `.env` (git-ignored), y lo pone una persona a
 * conciencia. Los tokens que hay en el repositorio de la API son de PRODUCCION
 * y estan versionados por error —conviene rotarlos—; este script no los lee ni
 * los copia.
 *
 * Por defecto apunta a QA. Cambiar a produccion es escribir la URL de
 * produccion en `QS_PRODUCT_API`, es decir, una decision explicita de quien
 * ejecuta.
 *
 *   # .env
 *   QS_PRODUCT_API=https://apiqa.quimicasuiza.com:8283/Product/
 *   QS_APP_TOKEN=<valor de la cabecera Authorization_App>
 *   QS_SOCIETY_CODE=1010
 *   QS_SALE_ORG=1011
 *   QS_IMAGES_BASE=            # opcional: UrlBaseImages de su configuracion
 *
 *   node scripts/import-qs-catalog.mjs --probe          (que devuelve, sin escribir)
 *   node scripts/import-qs-catalog.mjs --lines 01,02 --limit 150
 *   node scripts/import-qs-catalog.mjs --limit 150      (todas las lineas que vengan)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_SLUG = 'miquimica'

/**
 * Configuracion: `.env` primero, y las variables de entorno mandan por encima.
 *
 * El entorno gana a proposito. Una credencial que solo hace falta para una
 * corrida —y menos aun si es de produccion— no tiene por que quedarse escrita
 * en el disco: pasandola en la invocacion vive lo que vive el proceso.
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

/** Consulta al microservicio. Solo lectura. */
async function fetchByLine(cfg, filter) {
  const response = await fetch(`${cfg.productApi}ProductsByLine/v1?`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization_App: cfg.token,
    },
    body: JSON.stringify(filter),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`QS ${response.status}: ${text.slice(0, 300)}`)
  const body = JSON.parse(text)
  // El proxy .NET desenvuelve `Body`; aqui se acepta cualquiera de las dos
  // formas porque el microservicio ha cambiado de envoltorio antes.
  return body?.Body ?? body?.body ?? (Array.isArray(body) ? body : [])
}

async function sql(query, cfg) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${cfg.ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token_sb}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

function lit(value) {
  if (value === null || value === undefined || value === '') return 'null'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}

function slugify(text, suffix) {
  const base = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'producto'}-${suffix}`.toLowerCase()
}

/** MAYUSCULAS DE ERP a algo legible en una vitrina. */
function titleCase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\b([a-záéíóúñ])/g, (letter) => letter.toUpperCase())
    .replace(/\bDe\b/g, 'de')
    .replace(/\bY\b/g, 'y')
    .trim()
}

/**
 * Su modelo al nuestro.
 *
 * Lo que tiene columna propia va a su columna; lo que es dato del sector va a
 * `custom_fields`, que es exactamente para lo que existe. `Scales` y `Bonuses`
 * se guardan TAL CUAL y no se interpretan: son escalas de descuento y
 * bonificaciones con reglas propias, y traducirlas a nuestras listas de precios
 * a ojo seria inventar precios.
 */
function mapProduct(row, index) {
  const name = titleCase(row.ProductDescription ?? row.productDescription ?? '')
  const code = String(row.ProductCode ?? row.productCode ?? '').trim()
  return {
    sku: code,
    name: name || code,
    slug: slugify(name || code, String(index + 1).padStart(4, '0')),
    description: row.CommercialDescription || row.commercialDescription || null,
    price: Number(row.PriceTotal ?? row.priceTotal ?? 0),
    stock: Math.max(Math.trunc(Number(row.Stock ?? row.stock ?? 0)), 0),
    lineCode: row.LineCode ?? row.lineCode ?? null,
    lineName: titleCase(row.LineName ?? row.lineName ?? '') || null,
    category: titleCase(row.Category ?? row.category ?? '') || null,
    tradename: titleCase(row.Tradename ?? row.tradename ?? '') || null,
    custom: {
      principio_activo: row.ActivePrinciple ?? row.activePrinciple ?? null,
      tipo_producto: row.ProductType ?? row.productType ?? null,
      linea_codigo: row.LineCode ?? row.lineCode ?? null,
      spart: row.Spart ?? row.spart ?? null,
      pack_maestro: row.MasterPack ?? row.masterPack ?? null,
      igv: row.Tax ?? row.tax ?? null,
      escalas: row.Scales ?? row.scales ?? null,
      bonificaciones: row.Bonuses ?? row.bonuses ?? null,
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const probe = args.includes('--probe')
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 150
  const lines = args.includes('--lines')
    ? String(args[args.indexOf('--lines') + 1]).split(',').map((code) => code.trim())
    : []

  const values = env()
  for (const key of ['QS_PRODUCT_API', 'QS_APP_TOKEN']) {
    if (!values[key]) {
      throw new Error(
        `Falta ${key} en .env. Este script NO lee credenciales del repositorio de la API: ` +
          'la pone una persona a conciencia (ver cabecera del archivo).',
      )
    }
  }

  const cfg = {
    productApi: values.QS_PRODUCT_API.endsWith('/')
      ? values.QS_PRODUCT_API
      : `${values.QS_PRODUCT_API}/`,
    token: values.QS_APP_TOKEN,
    society: values.QS_SOCIETY_CODE ?? '1010',
    saleOrg: values.QS_SALE_ORG ?? '1011',
    imagesBase: values.QS_IMAGES_BASE ?? '',
    url: (values.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''),
    ref: values.VITE_SUPABASE_URL ? new URL(values.VITE_SUPABASE_URL).hostname.split('.')[0] : '',
    token_sb: values.SUPABASE_ACCESS_TOKEN,
    secret: values.SUPABASE_SECRET_KEY,
  }

  /**
   * El filtro, con la forma EXACTA que manda su app (`ProductBusiness`).
   *
   * Nada de mandar medio objeto: su servicio inserta lo que recibe en tablas
   * intermedias, y un campo ausente le revienta con «String or binary data
   * would be truncated», que es un error suyo provocado por una peticion mal
   * formada nuestra. Se mandan todos los campos, vacios cuando no aplican.
   *
   * `CustomerCode` y compania NO son opcionales de verdad: el precio de este
   * servicio es POR CLIENTE (B2B). Sin cliente, lo que vuelva —si vuelve— no es
   * el precio de nadie.
   */
  const baseFilter = {
    productCode: '',
    productCodes: [],
    productDescription: '',
    lineCode: lines[0] ?? '',
    lineCodes: lines,
    societyCode: cfg.society,
    codCentro: values.QS_COD_CENTRO ?? '',
    treatmentCode: values.QS_TREATMENT_CODE ?? '',
    oficina: values.QS_OFICINA ?? '',
    BusinessFeature: values.QS_BUSINESS_FEATURE ?? '',
    SaleOrg: cfg.saleOrg,
    CustomerCode: values.QS_CUSTOMER_CODE ?? '',
    Categories: [],
    isFilterBonif: false,
    isFilterScale: false,
    totalFilter: limit,
    Cod_Almacen: '',
  }

  if (probe) {
    const rows = await fetchByLine(cfg, { ...baseFilter, totalFilter: 5 })
    console.log(`Respuesta: ${rows.length} fila(s). Primera, tal cual:`)
    console.log(JSON.stringify(rows[0] ?? null, null, 2))
    const porLinea = {}
    for (const row of rows) {
      const key = `${row.LineCode ?? row.lineCode} · ${row.LineName ?? row.lineName}`
      porLinea[key] = (porLinea[key] ?? 0) + 1
    }
    console.log('Lineas vistas:', porLinea)
    return
  }

  if (!cfg.ref || !cfg.token_sb) throw new Error('Falta VITE_SUPABASE_URL o SUPABASE_ACCESS_TOKEN')

  const [store] = await sql(
    `select id, organization_id, company_id, currency from public.stores where slug = ${lit(STORE_SLUG)}`,
    cfg,
  )
  if (!store) throw new Error(`No existe la tienda ${STORE_SLUG}`)

  const rows = await fetchByLine(cfg, baseFilter)
  console.log(`Recibidos ${rows.length} producto(s) del microservicio`)

  const mapped = rows.map(mapProduct).filter((row) => row.sku)
  const categories = await sql(
    `select id, slug, name from public.categories where store_id = ${lit(store.id)}`,
    cfg,
  )
  const brands = await sql(`select id, code, name from public.brands`, cfg)

  const categoryId = (name) =>
    categories.find((row) => row.name?.toLowerCase() === String(name ?? '').toLowerCase())?.id ??
    null
  const brandId = (name) =>
    brands.find((row) => row.name?.toLowerCase() === String(name ?? '').toLowerCase())?.id ?? null

  let inserted = 0
  for (let start = 0; start < mapped.length; start += 25) {
    const batch = mapped.slice(start, start + 25)
    const values_sql = batch
      .map(
        (row) => `(${lit(randomUUID())}, ${lit(store.organization_id)}, ${lit(store.company_id)},
         ${lit(store.id)}, ${lit(categoryId(row.category ?? row.lineName))}, ${lit(brandId(row.tradename))},
         ${lit(row.sku)}, ${lit(row.slug)}, ${lit(row.name)}, ${lit(row.description)},
         ${lit(row.price)}, ${lit(store.currency)}, ${lit(row.stock)}, 'published'::product_status,
         now(), ${lit(JSON.stringify(row.custom))}::jsonb)`,
      )
      .join(',\n')

    await sql(
      `insert into public.products
         (id, organization_id, company_id, store_id, category_id, brand_id, sku, slug, name,
          description, price, currency, stock, status, published_at, custom_fields)
       values ${values_sql}
       on conflict do nothing`,
      cfg,
    )
    inserted += batch.length
    console.log(`  ${inserted}/${mapped.length}`)
  }

  console.log(
    cfg.imagesBase
      ? '\nFotos: pendiente de `UrlBaseImages`; con el valor real se resuelven por codigo de producto.'
      : '\nSin QS_IMAGES_BASE no se importan fotos: el modelo de producto no trae URL, se compone con la base de su configuracion.',
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
