#!/usr/bin/env node
/**
 * Tienda de demostración «Surtidora Andes» (tema Universal), con su propio
 * tenant, sociedad y owner, en el proyecto de QAS.
 *
 * Existe para que UNA tienda enseñe todo lo que soporta la plataforma: simple,
 * variantes, venta por caja, kits, escalas por cantidad, listas por segmento y
 * cliente, los cinco tipos de promoción, dos almacenes y cuentas de empresa.
 * El catálogo vive en `scripts/demo/surtidora-andes.catalog.mjs`.
 *
 * ## Por dónde entra cada cosa
 *
 * Por el MISMO camino que usaría el comercio, siempre que existe:
 *
 *   · el owner es un usuario de Auth con los claims del contrato en
 *     `app_metadata` (org_id, companies, active_company, apps), como los demás
 *     owners de demo (`ebim_demo: true`);
 *   · el alta de tenant es `bootstrap_tenant` (tenant, membresía, tienda y
 *     paquete de arranque en una transacción);
 *   · marcas, unidades, atributos, categorías y productos con variantes entran
 *     por el IMPORTADOR del backoffice (`import_catalog_*`) ejecutado COMO el
 *     owner —rol `authenticated` y sus claims—, así que pasan sus mismas
 *     validaciones y su comprobación de módulos contratados.
 *
 * Lo que el importador no cubre (presentaciones por caja, kits, precios,
 * clientes, promociones, almacenes) se escribe con SQL directo, en la sociedad
 * de esta tienda y nada más.
 *
 * Idempotente: todo se busca antes de crearlo (por SKU, código o slug).
 *
 *   node scripts/seed-surtidora-andes.mjs --check
 *   node scripts/seed-surtidora-andes.mjs                 (todo menos fotos)
 *   node scripts/seed-surtidora-andes.mjs --images <dir>  (sube <dir>/<SKU>.png)
 *
 * Contraseñas: SA_OWNER_PASSWORD y SA_BUYER_PASSWORD, o una aleatoria que se
 * imprime una sola vez al crear. Las claves del proyecto se leen del `.env` y
 * no se imprimen.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  ACCOUNTS,
  ATTRIBUTES,
  BRANDS,
  BUNDLES,
  CATEGORIES,
  PRODUCTS,
  PROMOTIONS,
  SEGMENTS,
  STORE,
  UNITS,
  WAREHOUSES,
} from './demo/surtidora-andes.catalog.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Los módulos que tiene FerroMax: la demo tiene que poder enseñar lo mismo. */
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
 * Contraseñas: de SA_OWNER_PASSWORD / SA_BUYER_PASSWORD o, si no vienen, una
 * aleatoria que se imprime UNA vez al crear el usuario. Nunca escritas aquí: un
 * secreto en el repo deja de serlo en cuanto se sube.
 */
const randomPassword = () => `${randomUUID().replace(/-/g, '').slice(0, 14)}Aa1!`
const OWNER_PASSWORD = E.SA_OWNER_PASSWORD ?? randomPassword()
const BUYER_PASSWORD = E.SA_BUYER_PASSWORD ?? randomPassword()

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

async function uoms(storeId) {
  const units = new Map((await sql(`select code, id from public.units_of_measure where company_id = ${lit(STORE.companyId)}`)).map((u) => [u.code, u.id]))
  const map = await skuMap()
  let n = 0
  for (const p of PRODUCTS.filter((x) => x.uoms)) {
    const id = map.get(p.sku)?.product_id
    if (!id) continue
    const lista = [{ code: 'UND', factor: 1, price: p.price, base: true }, ...p.uoms]
    for (const [i, u] of lista.entries()) {
      const uom = units.get(u.code)
      if (!uom) throw new Error(`Falta la unidad ${u.code}`)
      await sql(
        `insert into public.product_uoms (organization_id, company_id, store_id, product_id, uom_id, factor, is_base, is_sellable, price, position)
         select ${T}, ${lit(storeId)}, ${lit(id)}, ${lit(uom)}, ${u.factor}, ${u.base ? 'true' : 'false'}, true, ${u.price}, ${i}
         where not exists (select 1 from public.product_uoms where product_id = ${lit(id)} and uom_id = ${lit(uom)}
                           and store_id is not distinct from ${lit(storeId)})`,
      )
      n += 1
    }
  }
  console.log(`presentaciones: ${n}`)
}

async function bundles(storeId) {
  const [cat] = await sql(`select id from public.categories where store_id = ${lit(storeId)} and slug = 'kits'`)
  const brands = new Map((await sql(`select code, id from public.brands where company_id = ${lit(STORE.companyId)}`)).map((b) => [b.code, b.id]))
  for (const k of BUNDLES) {
    let map = await skuMap()
    let id = map.get(k.sku)?.product_id
    if (!id) {
      ;[{ id }] = await sql(
        `insert into public.products (organization_id, company_id, sku, name, description, kind, brand_id, status, category_id, price, currency)
         values (${T}, ${lit(k.sku)}, ${lit(k.name)}, ${lit(k.desc)}, 'bundle', ${lit(brands.get(k.brand))}, 'published',
                 ${lit(cat.id)}, ${k.price}, ${lit(STORE.currency)})
         returning id`,
      )
    }
    await sql(
      `insert into public.store_products (organization_id, company_id, store_id, product_id, category_id, slug, status, published_at, price, compare_at_price, currency)
       select ${T}, ${lit(storeId)}, ${lit(id)}, ${lit(cat.id)}, ${lit(slug(k.name))}, 'published', now(), ${k.price}, ${lit(k.compare ?? null)}, ${lit(STORE.currency)}
       where not exists (select 1 from public.store_products where store_id = ${lit(storeId)} and product_id = ${lit(id)})`,
    )
    map = await skuMap()
    for (const [i, [sku, qty]] of k.components.entries()) {
      const c = map.get(sku)
      if (!c) throw new Error(`Kit ${k.sku}: falta el componente ${sku}`)
      await sql(
        // `component_kind` no se deriva solo: por defecto vale `simple`, y un
        // componente con variante tiene que decir `variant` (CHECK de la tabla).
        `insert into public.bundle_items (organization_id, company_id, bundle_product_id, component_product_id, component_kind,
           component_variant_id, quantity, position)
         select ${T}, ${lit(id)}, ${lit(c.product_id)}, p.kind, ${lit(c.variant_id)}, ${qty}, ${i}
         from public.products p where p.id = ${lit(c.product_id)}
           and not exists (select 1 from public.bundle_items where bundle_product_id = ${lit(id)}
                           and component_product_id = ${lit(c.product_id)}
                           and component_variant_id is not distinct from ${lit(c.variant_id)})`,
      )
    }
  }
  console.log(`kits: ${BUNDLES.length}`)
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

async function priceList(storeId, code, name, scope, target, priority) {
  const [existing] = await sql(`select id from public.price_lists where store_id = ${lit(storeId)} and code = ${lit(code)}`)
  const id =
    existing?.id ??
    (
      await sql(
        `insert into public.price_lists (organization_id, company_id, store_id, code, name, currency, priority, valid_from, is_active)
         values (${T}, ${lit(storeId)}, ${lit(code)}, ${lit(name)}, ${lit(STORE.currency)}, ${priority}, now() - interval '1 day', true)
         returning id`,
      )
    )[0].id
  await sql(
    `insert into public.price_list_assignments (organization_id, company_id, store_id, price_list_id, scope, segment_id, customer_id, is_active)
     select ${T}, ${lit(storeId)}, ${lit(id)}, ${lit(scope)}::public.price_scope,
            ${lit(scope === 'segment' ? target : null)}, ${lit(scope === 'customer' ? target : null)}, true
     where not exists (select 1 from public.price_list_assignments where price_list_id = ${lit(id)})`,
  )
  return id
}

async function item(storeId, listId, ref, minQty, price) {
  await sql(
    `insert into public.price_list_items (organization_id, company_id, store_id, price_list_id, product_id, variant_id, min_quantity, unit_price)
     select ${T}, ${lit(storeId)}, ${lit(listId)}, ${lit(ref.product_id)}, ${lit(ref.variant_id)}, ${minQty}, ${money(price)}
     where not exists (select 1 from public.price_list_items where price_list_id = ${lit(listId)} and product_id = ${lit(ref.product_id)}
                       and variant_id is not distinct from ${lit(ref.variant_id)} and min_quantity = ${minQty} and uom_id is null)`,
  )
}

async function pricing(storeId) {
  const map = await skuMap()
  // 1) Lista PÚBLICA de la tienda: solo las escalas por cantidad.
  const publica = await priceList(storeId, 'precio-publico', 'Precio público (escalas)', 'store', null, 10)
  for (const p of PRODUCTS.filter((x) => x.tiers)) {
    const ref = { product_id: map.get(p.sku).product_id, variant_id: null }
    for (const [qty, price] of p.tiers) await item(storeId, publica, ref, qty, price)
  }
  // 2) Segmentos y 3) clientes: se crean con los clientes.
  console.log('lista pública con escalas lista')
}

async function customers(storeId, ownerId) {
  const map = await skuMap()
  const segIds = new Map()
  for (const s of SEGMENTS) {
    await sql(
      `insert into public.customer_segments (organization_id, company_id, code, name, is_active)
       select ${T}, ${lit(s.code)}, ${lit(s.name)}, true
       where not exists (select 1 from public.customer_segments where company_id = ${lit(STORE.companyId)} and code = ${lit(s.code)})`,
    )
    const [{ id }] = await sql(`select id from public.customer_segments where company_id = ${lit(STORE.companyId)} and code = ${lit(s.code)}`)
    segIds.set(s.code, id)
    // Lista del segmento: el precio público menos su descuento, producto a producto.
    const list = await priceList(storeId, `seg-${s.code}`, `Convenio ${s.name}`, 'segment', id, 50)
    for (const p of PRODUCTS) {
      if (p.variants) {
        for (const v of p.variants) await item(storeId, list, map.get(v.sku), 1, (v.price ?? p.price) * (1 - s.discount))
      } else {
        await item(storeId, list, { product_id: map.get(p.sku).product_id, variant_id: null }, 1, p.price * (1 - s.discount))
      }
    }
  }

  for (const a of ACCOUNTS) {
    await sql(
      `insert into public.customers (organization_id, company_id, kind, code, name, legal_name, tax_id, segment_id, is_active)
       select ${T}, 'company', ${lit(a.code)}, ${lit(a.name)}, ${lit(a.legal)}, ${lit(a.ruc)}, ${lit(segIds.get(a.segment))}, true
       where not exists (select 1 from public.customers where company_id = ${lit(STORE.companyId)} and code = ${lit(a.code)})`,
    )
    const [{ id: customerId }] = await sql(`select id from public.customers where company_id = ${lit(STORE.companyId)} and code = ${lit(a.code)}`)
    await sql(
      `insert into public.business_accounts (organization_id, company_id, customer_id, customer_kind, code, name, is_active,
         purchase_order_required, credit_limit, payment_terms_days)
       select ${T}, ${lit(customerId)}, 'company', ${lit(a.code)}, ${lit(a.name)}, true, ${a.poRequired}, ${a.credit}, ${a.terms}
       where not exists (select 1 from public.business_accounts where company_id = ${lit(STORE.companyId)} and code = ${lit(a.code)})`,
    )
    if (a.agreed.length > 0) {
      const list = await priceList(storeId, `cli-${a.code.toLowerCase()}`, `Precio pactado ${a.name}`, 'customer', customerId, 100)
      for (const [sku, price] of a.agreed) await item(storeId, list, { product_id: map.get(sku).product_id, variant_id: null }, 1, price)
    }
  }

  // Comprador del hotel: usuario de Auth vinculado a la cuenta, activo.
  const buyer = await ensureUser(STORE.buyerEmail, BUYER_PASSWORD, { provider: 'email', providers: ['email'] })
  const [cuenta] = await sql(`select id from public.business_accounts where company_id = ${lit(STORE.companyId)} and code = 'HMP'`)
  await sql(
    `insert into public.business_account_users (organization_id, company_id, business_account_id, user_id, email, role, status, invited_by)
     select ${T}, ${lit(cuenta.id)}, ${lit(buyer.id)}, ${lit(STORE.buyerEmail)}, 'buyer', 'active', ${lit(ownerId)}
     where not exists (select 1 from public.business_account_users where business_account_id = ${lit(cuenta.id)} and user_id = ${lit(buyer.id)})`,
  )
  console.log(`segmentos: ${SEGMENTS.length}, cuentas: ${ACCOUNTS.length}, comprador ${STORE.buyerEmail} ${buyer.created ? 'creado' : 'ya existía'}`)
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
    const nombre = [...PRODUCTS, ...BUNDLES].find((p) => p.sku === sku)?.name ?? sku
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
            (select count(*) from public.product_uoms where company_id = ${lit(STORE.companyId)}) as presentaciones,
            (select count(*) from public.bundle_items where company_id = ${lit(STORE.companyId)}) as piezas_de_kits,
            (select count(*) from public.price_list_items where store_id = ${lit(s.id)}) as precios,
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
  await uoms(storeId)
  await bundles(storeId)
  await warehouses(storeId)
  await pricing(storeId)
  await customers(storeId, ownerId)
  await promotions(storeId)
  await check()
  console.log(`\nEntrar como owner: ${STORE.ownerEmail}  ·  comprador B2B: ${STORE.buyerEmail}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
