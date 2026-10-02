#!/usr/bin/env node
/**
 * Tienda de demostración «Porta» (tema Retail, B2C), con su propio tenant,
 * sociedad y owner, en el proyecto de QAS (2026-10-02).
 *
 * Mochilas, equipaje, bolsos y accesorios: ~200 variantes por COLOR (y por
 * TAMAÑO en maletas), categorías en dos niveles, dos almacenes, promociones,
 * páginas del pie (Empresa y Legales) y los datos de atención y legales que
 * pinta el pie y el Libro de Reclamaciones. El catálogo vive en
 * `scripts/demo/porta.catalog.mjs`.
 *
 * Mismo camino que `seed-surtidora-andes.mjs`: owner con los claims del
 * contrato, alta por `bootstrap_tenant`, catálogo por el IMPORTADOR del
 * backoffice ejecutado COMO el owner, y SQL directo solo para lo que el
 * importador no cubre, siempre en la sociedad de esta tienda.
 *
 * Idempotente: todo se busca antes de crearlo.
 *
 *   node scripts/seed-porta.mjs --check
 *   node scripts/seed-porta.mjs                 (todo menos fotos)
 *   node scripts/seed-porta.mjs --images <dir>  (sube <dir>/<SKU>.png)
 *
 * Contraseña del owner: PORTA_OWNER_PASSWORD o una aleatoria que se imprime
 * una sola vez al crear.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  ATTRIBUTES,
  BRANDS,
  CATEGORIES,
  PAGES,
  PRODUCTS,
  PROMOTIONS,
  STORE,
  WAREHOUSES,
} from './demo/porta.catalog.mjs'

const UNITS = [{ code: 'UND', name: 'Unidad', symbol: 'und' }]

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Los mismos módulos que las demás demos: catálogo avanzado, CMS, multialmacén, promociones, pagos y entregas. */
const ENTITLEMENTS = [
  'ecommerce.ai.assist', 'ecommerce.ai.catalog.copy', 'ecommerce.ai.content', 'ecommerce.ai.insights',
  'ecommerce.analytics.advanced', 'ecommerce.catalog.advanced', 'ecommerce.content.cms',
  'ecommerce.credit.management', 'ecommerce.customers.b2b', 'ecommerce.fulfillment',
  'ecommerce.inventory.multiwarehouse', 'ecommerce.invoicing', 'ecommerce.orders.advanced',
  'ecommerce.payments', 'ecommerce.planning.demand', 'ecommerce.pricing.lists', 'ecommerce.promotions',
  'ecommerce.sales.force', 'ecommerce.trade.assortments', 'ecommerce.trade.quotes',
]

// ── Configuración ─────────────────────────────────────────────────────────
function env() {
  const values = Object.fromEntries(
    readFileSync(join(ROOT, '.env'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
      }),
  )
  return { ...values, ...process.env }
}
const E = env()
const cfg = {
  url: (E.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''),
  ref: E.VITE_SUPABASE_URL ? new URL(E.VITE_SUPABASE_URL).hostname.split('.')[0] : '',
  token: E.SUPABASE_ACCESS_TOKEN,
  secret: E.SUPABASE_SECRET_KEY,
}
if (!cfg.ref || !cfg.token || !cfg.secret) {
  throw new Error('Faltan VITE_SUPABASE_URL, SUPABASE_ACCESS_TOKEN o SUPABASE_SECRET_KEY en .env')
}
/**
 * Contraseña: de PORTA_OWNER_PASSWORD o, si no viene, una
 * aleatoria que se imprime UNA vez al crear el usuario. Nunca escritas aquí: un
 * secreto en el repo deja de serlo en cuanto se sube.
 */
const randomPassword = () => `${randomUUID().replace(/-/g, '').slice(0, 14)}Aa1!`
const OWNER_PASSWORD = E.PORTA_OWNER_PASSWORD ?? randomPassword()

// ── Utilidades ────────────────────────────────────────────────────────────
async function sql(query) {
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
  if (value === null || value === undefined || value === '') return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replace(/'/g, "''")}'`
}
const json = (value) => `${lit(JSON.stringify(value))}::jsonb`
const slug = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
const money = (n) => Math.round(n * 100) / 100

/** Ejecuta como el OWNER de la tienda: rol `authenticated` y sus claims. */
function asOwner(ownerId, query) {
  const claims = {
    sub: ownerId,
    email: STORE.ownerEmail,
    role: 'authenticated',
    org_id: STORE.organizationId,
    companies: [{ id: STORE.companyId, role: 'owner' }],
    active_company: STORE.companyId,
    apps: ['ecommerce'],
  }
  return sql(
    `set local role authenticated;
     select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true);
     ${query}`,
  )
}

async function authAdmin(path, init = {}) {
  const response = await fetch(`${cfg.url}/auth/v1/admin/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.secret}`,
      apikey: cfg.secret,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }
}

/** Crea el usuario si no existe; devuelve su id. */
async function ensureUser(email, password, appMetadata) {
  const [found] = await sql(`select id from auth.users where lower(email) = lower(${lit(email)})`)
  if (found) {
    await authAdmin(`users/${found.id}`, { method: 'PUT', body: JSON.stringify({ app_metadata: appMetadata }) })
    return { id: found.id, created: false }
  }
  const res = await authAdmin('users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: appMetadata }),
  })
  if (!res.ok) throw new Error(`Auth ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`)
  console.log(`  contraseña de ${email} (guárdala, no se vuelve a mostrar): ${password}`)
  return { id: res.body.id, created: true }
}

const T = `${lit(STORE.organizationId)}, ${lit(STORE.companyId)}`

// ── Fases ─────────────────────────────────────────────────────────────────
async function owner() {
  const meta = {
    apps: ['ecommerce'],
    org_id: STORE.organizationId,
    companies: [{ id: STORE.companyId, role: 'owner' }],
    active_company: STORE.companyId,
    ebim_demo: true,
  }
  const user = await ensureUser(STORE.ownerEmail, OWNER_PASSWORD, meta)
  console.log(`owner ${STORE.ownerEmail} ${user.created ? 'creado' : 'ya existía'}`)
  return user.id
}

async function tenant(ownerId) {
  const [exists] = await sql(`select 1 as x from public.tenants where organization_id = ${lit(STORE.organizationId)}`)
  if (!exists) {
    await sql(
      `select public.bootstrap_tenant(${T}, ${lit(STORE.tenantSlug)}, ${lit(STORE.tenantName)},
         ${lit(STORE.ownerEmail)}, ${lit(ownerId)}, ${lit(STORE.slug)}, ${lit(STORE.name)}, ${lit(STORE.currency)})`,
    )
    console.log('tenant y tienda dados de alta')
  }
  await sql(
    `select public.sync_platform_context(${T}, true, ${lit(`{${ENTITLEMENTS.join(',')}}`)}::text[],
       'hub'::public.entitlement_source, null)`,
  )
  const [store] = await sql(`select id from public.stores where slug = ${lit(STORE.slug)}`)
  await sql(`update public.stores set status = 'active' where id = ${lit(store.id)}`)
  await sql(`update public.store_settings set theme_preset = ${lit(STORE.theme)} where store_id = ${lit(store.id)}`)
  console.log(`tienda ${STORE.slug} activa, tema ${STORE.theme}, ${ENTITLEMENTS.length} módulos`)
  return store.id
}

async function vocabulary(ownerId) {
  const sheets = {
    brands: BRANDS.map((b) => ({ code: b.code, name: b.name, is_active: 'sí' })),
    units: UNITS.map((u) => ({ code: u.code, name: u.name, symbol: u.symbol, is_active: 'sí' })),
    attributes: ATTRIBUTES.map((a, i) => ({
      code: a.code, name: a.name, data_type: 'opción', is_variant_axis: 'sí', is_filterable: 'sí', position: i + 1,
    })),
    attribute_values: ATTRIBUTES.flatMap((a) =>
      a.values.map((v, i) => ({ attribute_code: a.code, code: slug(v), label: v, position: i + 1 })),
    ),
  }
  const [r] = await asOwner(ownerId, `select public.import_catalog_vocabulary(${json(sheets)}, false) as r`)
  console.log('vocabulario:', JSON.stringify(r.r).slice(0, 240))
}

async function categories(ownerId, storeId) {
  const rows = CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, parent_slug: c.parent ?? '', position: c.position }))
  const [r] = await asOwner(ownerId, `select public.import_catalog_categories(${lit(storeId)}, ${json(rows)}, false) as r`)
  console.log('categorías:', JSON.stringify(r.r).slice(0, 240))
}

async function products(ownerId, storeId) {
  const rows = []
  for (const p of PRODUCTS) {
    const master = {
      sku: p.sku, name: p.name, description: p.desc, category_slug: p.cat, brand_code: p.brand,
      price: p.price, ...(p.compare ? { compare_at_price: p.compare } : {}), status: 'publicado',
    }
    if (!p.variants) {
      rows.push({ ...master, stock: p.stock })
      continue
    }
    p.variants.forEach((v, i) => {
      rows.push({
        ...(i === 0 ? master : { sku: p.sku }),
        variant_sku: v.sku, variant_name: v.name,
        ...(v.price ? { variant_price: v.price } : {}),
        variant_stock: v.stock, axes: v.axes,
      })
    })
  }
  const [r] = await asOwner(ownerId, `select public.import_catalog_products(${lit(storeId)}, ${json(rows)}, false) as r`)
  console.log('productos:', JSON.stringify(r.r).slice(0, 300))
}

/**
 * Mapa SKU → { product_id, variant_id } de la sociedad.
 *
 * Solo las variantes de productos `variant`: un producto simple también tiene
 * su variante por defecto, con el MISMO SKU, y tomarla haría pasar un simple
 * por variante (lo rechaza `bundle_items_variant_matches_kind`).
 */
async function skuMap() {
  const rows = await sql(
    `select p.sku, p.id as product_id, null::uuid as variant_id from public.products p where p.company_id = ${lit(STORE.companyId)}
     union all
     select v.sku, v.product_id, v.id from public.product_variants v
     where v.company_id = ${lit(STORE.companyId)} and v.product_kind = 'variant'`,
  )
  return new Map(rows.map((row) => [row.sku, row]))
}

async function warehouses(storeId) {
  for (const w of WAREHOUSES) {
    await sql(
      `insert into public.warehouses (organization_id, company_id, code, name, kind, is_active, is_default, city, region, country)
       select ${T}, ${lit(w.code)}, ${lit(w.name)}, 'warehouse', true, ${w.isDefault}, ${lit(w.city)}, ${lit(w.region)}, 'PE'
       where not exists (select 1 from public.warehouses where company_id = ${lit(STORE.companyId)} and code = ${lit(w.code)})`,
    )
    await sql(
      `insert into public.store_warehouses (organization_id, company_id, store_id, warehouse_id, priority, is_active)
       select ${T}, ${lit(storeId)}, w.id, ${w.isDefault ? 1 : 2}, true from public.warehouses w
       where w.company_id = ${lit(STORE.companyId)} and w.code = ${lit(w.code)}
         and not exists (select 1 from public.store_warehouses sw where sw.store_id = ${lit(storeId)} and sw.warehouse_id = w.id)`,
    )
  }
  // Existencias: cada producto o variante repartido entre los dos almacenes.
  const map = await skuMap()
  const items = []
  for (const p of PRODUCTS) {
    if (p.variants) for (const v of p.variants) items.push([map.get(v.sku), v.stock])
    else items.push([map.get(p.sku), p.stock])
  }
  const ids = new Map((await sql(`select code, id from public.warehouses where company_id = ${lit(STORE.companyId)}`)).map((w) => [w.code, w.id]))
  const values = []
  for (const [ref, stock] of items) {
    if (!ref) continue
    for (const w of WAREHOUSES) {
      const qty = w.isDefault ? stock - Math.floor(stock * (1 - w.share)) : Math.floor(stock * w.share)
      values.push(`(${T}, ${lit(ids.get(w.code))}, ${lit(storeId)}, ${lit(ref.product_id)}, ${lit(ref.variant_id)}, ${qty})`)
    }
  }
  await sql(
    `insert into public.inventory_levels (organization_id, company_id, warehouse_id, store_id, product_id, variant_id, on_hand_qty)
     select v.* from (values ${values.join(',\n')}) as v(o, c, w, s, p, var, q)
     where not exists (select 1 from public.inventory_levels il where il.warehouse_id = v.w::uuid and il.product_id = v.p::uuid
                       and il.variant_id is not distinct from v.var::uuid)`.replace(
      'select v.* from',
      'select v.o::uuid, v.c::uuid, v.w::uuid, v.s::uuid, v.p::uuid, v.var::uuid, v.q::numeric from',
    ),
  )
  console.log(`almacenes: ${WAREHOUSES.length}, existencias: ${values.length} filas`)
}

async function promotions(storeId) {
  const map = await skuMap()
  const cats = new Map((await sql(`select slug, id from public.categories where store_id = ${lit(storeId)}`)).map((c) => [c.slug, c.id]))
  for (const [i, p] of PROMOTIONS.entries()) {
    const [existing] = await sql(`select id from public.promotions where store_id = ${lit(storeId)} and code = ${lit(p.code)}`)
    let id = existing?.id
    if (!id) {
      ;[{ id }] = await sql(
        `insert into public.promotions (organization_id, company_id, store_id, code, name, description, kind, status, priority,
           requires_coupon, value_percent, value_amount, buy_quantity, free_quantity, min_subtotal, valid_from, valid_to,
           usage_limit_per_customer)
         values (${T}, ${lit(storeId)}, ${lit(p.code)}, ${lit(p.name)}, ${lit(p.desc)}, ${lit(p.kind)}::public.promotion_kind,
           'active', ${100 - i}, ${p.coupon ? 'true' : 'false'}, ${lit(p.percent ?? null)}, ${lit(p.amount ?? null)},
           ${lit(p.buy ?? null)}, ${lit(p.free ?? null)}, ${lit(p.minSubtotal ?? null)}, now() - interval '1 hour',
           ${p.endsInDays ? `now() + interval '${p.endsInDays} days'` : 'null'}, ${lit(p.perCustomer ?? null)})
         returning id`,
      )
      const s = p.scope
      const kind = s.all ? 'all' : s.product ? 'product' : 'category'
      await sql(
        `insert into public.promotion_scopes (organization_id, company_id, store_id, promotion_id, promotion_kind, scope_kind,
           product_id, category_id, include_descendants)
         values (${T}, ${lit(storeId)}, ${lit(id)}, ${lit(p.kind)}::public.promotion_kind, ${lit(kind)}::public.promotion_scope_kind,
           ${lit(s.product ? map.get(s.product).product_id : null)}, ${lit(s.category ? cats.get(s.category) : null)}, ${s.category ? 'true' : 'false'})`,
      )
      for (const [qty, pct] of p.tiers ?? []) {
        await sql(
          `insert into public.promotion_tiers (organization_id, company_id, store_id, promotion_id, promotion_kind, min_quantity, discount_percent)
           values (${T}, ${lit(storeId)}, ${lit(id)}, ${lit(p.kind)}::public.promotion_kind, ${qty}, ${pct})`,
        )
      }
      if (p.coupon) {
        await sql(
          `insert into public.coupons (organization_id, company_id, store_id, promotion_id, code, is_active, usage_limit_per_customer)
           values (${T}, ${lit(storeId)}, ${lit(id)}, ${lit(p.coupon)}, true, ${lit(p.perCustomer ?? null)})`,
        )
      }
    }
  }
  console.log(`promociones: ${PROMOTIONS.length}`)
}

/** Tema, marca, avisos, contacto, ayuda y datos legales de la tienda. */
async function settings(storeId) {
  await sql(
    `update public.store_settings set
       theme_preset = ${lit(STORE.theme)},
       accent_color = ${lit(STORE.accent)},
       store_description = ${lit(STORE.description)},
       hero_title = ${lit(STORE.heroTitle)},
       hero_kicker = ${lit(STORE.heroKicker)},
       announcement_messages = ${json(STORE.announcements.map((text) => ({ text })))},
       support_email = ${lit(STORE.supportEmail)},
       contact_phone = ${lit(STORE.contactPhone)},
       contact_address = ${lit(STORE.contactAddress)},
       legal_name = ${lit(STORE.legalName)},
       tax_id = ${lit(STORE.taxId)},
       whatsapp_phone = ${lit(STORE.whatsapp)},
       help_note = ${lit(STORE.helpNote)},
       business_hours = ${lit(STORE.hours)},
       social_links = ${json(STORE.social)}
     where store_id = ${lit(storeId)}`,
  )
  console.log('ajustes de tienda: tema, avisos, contacto, ayuda y datos legales')
}

/** Páginas del pie: Empresa (landing) y Legales (legal), con su texto. */
async function pages(storeId) {
  for (const [i, page] of PAGES.entries()) {
    const [existing] = await sql(`select id from public.content_pages where store_id = ${lit(storeId)} and slug = ${lit(page.slug)}`)
    if (existing) continue
    const [{ id }] = await sql(
      `insert into public.content_pages (organization_id, company_id, store_id, slug, title, kind, status, show_in_nav, nav_position)
       values (${T}, ${lit(storeId)}, ${lit(page.slug)}, ${lit(page.title)}, ${lit(page.kind)}::public.content_page_kind,
               'published', true, ${i})
       returning id`,
    )
    await sql(
      `insert into public.content_blocks (organization_id, company_id, store_id, page_id, block_type, position, body)
       values (${T}, ${lit(storeId)}, ${lit(id)}, 'rich_text', 0, ${json(page.body)})`,
    )
  }
  console.log(`páginas: ${PAGES.length}`)
}

/** Sube `<dir>/<SKU>.png` como foto principal de cada producto que no tenga. */
async function images(dir) {
  if (!existsSync(dir)) throw new Error(`No existe ${dir}`)
  const map = await skuMap()
  const [store] = await sql(`select id from public.stores where slug = ${lit(STORE.slug)}`)
  const conFoto = new Set((await sql(`select product_id from public.product_images where company_id = ${lit(STORE.companyId)}`)).map((r) => r.product_id))
  let subidas = 0
  for (const file of readdirSync(dir)) {
    const sku = file.slice(0, -extname(file).length)
    const ref = map.get(sku)
    if (!ref || ref.variant_id || conFoto.has(ref.product_id)) continue
    const ext = extname(file).slice(1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    // La ruta la exige `ebim.assert_product_image_path`: {organización}/{tienda}/...
    const path = `${STORE.organizationId}/${store.id}/${ref.product_id}/${randomUUID()}.${ext}`
    const response = await fetch(`${cfg.url}/storage/v1/object/product-images/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.secret}`, apikey: cfg.secret, 'Content-Type': mime, 'x-upsert': 'false' },
      body: readFileSync(join(dir, file)),
    })
    if (!response.ok) throw new Error(`storage ${response.status} ${sku}`)
    const nombre = PRODUCTS.find((p) => p.sku === sku)?.name ?? sku
    await sql(
      `insert into public.product_images (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
       values (${T}, ${lit(store.id)}, ${lit(ref.product_id)}, ${lit(path)}, ${lit(nombre)}, 0, true)`,
    )
    subidas += 1
  }
  console.log(`fotos subidas: ${subidas}`)
}

async function check() {
  const [s] = await sql(`select id, status from public.stores where slug = ${lit(STORE.slug)}`)
  if (!s) return console.log('La tienda todavía no existe.')
  const [c] = await sql(
    `select (select count(*) from public.store_products where store_id = ${lit(s.id)}) as publicados,
            (select count(*) from public.product_variants where company_id = ${lit(STORE.companyId)}) as variantes,
            (select count(*) from public.inventory_levels where company_id = ${lit(STORE.companyId)}) as existencias,
            (select count(*) from public.content_pages where store_id = ${lit(s.id)}) as paginas,
            (select count(*) from public.promotions where store_id = ${lit(s.id)}) as promociones,
            (select count(*) from public.product_images where company_id = ${lit(STORE.companyId)}) as fotos`,
  )
  console.log(`tienda ${STORE.slug} (${s.status})`, c)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--check')) return check()
  const i = args.indexOf('--images')
  if (i >= 0) return images(args[i + 1])

  const ownerId = await owner()
  const storeId = await tenant(ownerId)
  await vocabulary(ownerId)
  await categories(ownerId, storeId)
  await products(ownerId, storeId)
  await warehouses(storeId)
  await promotions(storeId)
  await settings(storeId)
  await pages(storeId)
  await check()
  console.log(`\nEntrar como owner: ${STORE.ownerEmail}  ·  tienda: /s/${STORE.slug}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
