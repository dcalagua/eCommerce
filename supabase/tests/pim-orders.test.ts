// @vitest-environment node
/**
 * P03-SaaS · Comprar variantes, unidades y kits, contra Postgres REAL.
 *
 * El PIM sin esto seria un catalogo que no se puede vender. Lo que se prueba
 * aqui es la parte del modelo que mueve dinero y almacen:
 *
 *  · una variante se cobra a SU precio y descuenta SU existencia — nunca la del
 *    maestro, que no lleva ninguna;
 *  · una unidad de venta se valida contra `product_uoms`, no contra el payload,
 *    y su factor decide cuanto se descuenta de verdad;
 *  · un kit descuenta sus componentes y jamas su propia existencia;
 *  · y cuando algo falla a media compra, no queda ni pedido ni stock movido.
 *
 * El producto simple entra en cada bloque como control: si alguna de estas
 * ramas nuevas hubiera cambiado su comportamiento, se veria aqui.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'

let storeA: string
let storeB: string
let jabon: string
let camiseta: string
let camisetaRoja: string
let camisetaAzul: string
let camisetaRetirada: string
let kit: string
let kitVacio: string
let productoB: string

let uomUnit: string
let uomBox: string
let uomPack: string
let uomHalf: string
let uomNoSellable: string

interface OrderItemInput {
  product_id: string
  quantity: number
  variant_id?: string
  uom_code?: string
}

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

async function id(query: string, params: unknown[] = []): Promise<string> {
  const rows = await svc(query, params)
  return String(rows[0]?.id)
}

async function checkout(
  slug: string,
  items: OrderItemInput[],
  options: { email?: string } = {},
): Promise<Row> {
  const rows = await svc(
    `select public.create_order_for_slug(
        $1, $2, $3::jsonb, 'Ana Compradora', '+51 999 111 222',
        '{"address": "Av. Primavera 120"}'::jsonb, null) as result`,
    [slug, options.email ?? 'ana@compradora.com', JSON.stringify(items)],
  )
  return rows[0]?.result as Row
}

async function stockOf(productId: string): Promise<number> {
  const [row] = await svc(`select stock from public.products where id = $1`, [productId])
  return Number(row?.stock)
}

async function variantStockOf(variantId: string): Promise<number> {
  const [row] = await svc(`select stock from public.product_variants where id = $1`, [variantId])
  return Number(row?.stock)
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const [tenant, storeSlug] of [
    [TENANT_A, STORE_A_SLUG],
    [TENANT_B, STORE_B_SLUG],
  ] as const) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId, tenant.companyId, tenant.slug, tenant.slug,
      tenant.adminEmail, tenant.ownerId, storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)
  // Impuesto a cero: aqui se comprueban precios y existencias, y el IGV ya
  // tiene sus propios tests en `taxes.test.ts`.
  await svc(`update public.store_settings set tax_rate = 0`)

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  const insertProduct = `
    insert into public.products
      (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status,
       published_at, kind)
    values ($1, $2, $3, $4, $5, $6, $7, 'PEN', $8, 'published', now(), $9::public.product_kind)
    returning id`

  jabon = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-JABON', 'jabon', 'Jabón',
    '10.00', 100, 'simple',
  ])
  camiseta = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-CAMISETA', 'camiseta', 'Camiseta',
    '60.00', 0, 'variant',
  ])
  kit = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-KIT', 'kit', 'Pack bienvenida',
    '80.00', 0, 'bundle',
  ])
  kitVacio = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-KIT-VACIO', 'kit-vacio', 'Pack vacío',
    '20.00', 0, 'bundle',
  ])
  productoB = await id(insertProduct, [
    TENANT_B.organizationId, TENANT_B.companyId, storeB, 'B-LAMPARA', 'lampara', 'Lámpara',
    '55.00', 4, 'simple',
  ])

  const insertVariant = `
    insert into public.product_variants
      (organization_id, company_id, store_id, product_id, sku, name, price, stock, is_active, is_default)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`

  camisetaRoja = await id(insertVariant, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, camiseta, 'A-CAM-ROJA', 'Roja',
    null, 10, true, true,
  ])
  camisetaAzul = await id(insertVariant, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, camiseta, 'A-CAM-AZUL', 'Azul',
    '69.90', 4, true, false,
  ])
  camisetaRetirada = await id(insertVariant, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, camiseta, 'A-CAM-VERDE', 'Verde',
    null, 5, false, false,
  ])

  const insertUom = `
    insert into public.units_of_measure (organization_id, company_id, code, name)
    values ($1, $2, $3, $4) returning id`

  uomUnit = await id(insertUom, [TENANT_A.organizationId, TENANT_A.companyId, 'UND', 'Unidad'])
  uomBox = await id(insertUom, [TENANT_A.organizationId, TENANT_A.companyId, 'CAJA', 'Caja x 12'])
  uomPack = await id(insertUom, [TENANT_A.organizationId, TENANT_A.companyId, 'PACK', 'Pack x 6'])
  uomHalf = await id(insertUom, [TENANT_A.organizationId, TENANT_A.companyId, 'MEDIA', 'Media unidad'])
  uomNoSellable = await id(insertUom, [
    TENANT_A.organizationId, TENANT_A.companyId, 'PALLET', 'Pallet',
  ])

  await svc(
    `insert into public.product_uoms
       (organization_id, company_id, store_id, product_id, uom_id, factor, is_base, is_sellable, price)
     values
       ($1, $2, $3, $4, $5, 1,   true,  true,  null),
       ($1, $2, $3, $4, $6, 12,  false, true,  '100.00'),
       ($1, $2, $3, $4, $7, 6,   false, true,  null),
       ($1, $2, $3, $4, $8, 0.5, false, true,  null),
       ($1, $2, $3, $4, $9, 480, false, false, null)`,
    [
      TENANT_A.organizationId, TENANT_A.companyId, storeA, jabon,
      uomUnit, uomBox, uomPack, uomHalf, uomNoSellable,
    ],
  )

  await svc(
    `insert into public.bundle_items
       (organization_id, company_id, store_id, bundle_product_id,
        component_product_id, component_kind, component_variant_id, quantity)
     values ($1, $2, $3, $4, $5, 'simple', null, 2),
            ($1, $2, $3, $4, $6, 'variant', $7, 1)`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA, kit, jabon, camiseta, camisetaRoja],
  )
}, 180_000)

/**
 * Estado limpio en cada test: el limite de tasa del checkout cuenta por correo
 * y por tienda en una ventana de una hora, y estos tests hacen decenas de
 * pedidos en segundos. Las existencias se reponen para que el orden de los
 * tests no cambie el resultado de ninguno.
 */
beforeEach(async () => {
  await svc(`delete from public.checkout_attempts`)
  await svc(`update public.products set stock = 100 where id = $1`, [jabon])
  await svc(`update public.product_variants set stock = 10 where id = $1`, [camisetaRoja])
  await svc(`update public.product_variants set stock = 4  where id = $1`, [camisetaAzul])
})

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------

describe('el producto simple no cambia de comportamiento', () => {
  it('se compra igual que antes del PIM: precio del producto y su propia existencia', async () => {
    const result = await checkout(STORE_A_SLUG, [{ product_id: jabon, quantity: 3 }])

    expect(result.subtotal).toBe('30.00')
    expect(await stockOf(jabon)).toBe(97)

    const [line] = await svc(
      `select sku, variant_id, uom_code, uom_factor::text as uom_factor,
              base_quantity::text as base_quantity
         from public.order_items where order_id = $1`,
      [result.order_id],
    )
    expect(line?.sku).toBe('A-JABON')
    expect(line?.variant_id).toBeNull()
    expect(line?.uom_code).toBeNull()
    expect(line?.uom_factor).toBe('1.000000')
    expect(line?.base_quantity).toBe('3.000000')
  })
})

describe('variantes', () => {
  it('una variante sin precio propio se cobra al del maestro y descuenta SU existencia', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: camiseta, variant_id: camisetaRoja, quantity: 2 },
    ])

    expect(result.subtotal).toBe('120.00')
    expect(await variantStockOf(camisetaRoja)).toBe(8)
    // El maestro no lleva existencia y no se toca: si se tocara, quedaria en
    // negativo o bloquearia la venta por un stock que no significa nada.
    expect(await stockOf(camiseta)).toBe(0)
  })

  it('una variante con precio propio se cobra al suyo, no al del maestro', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: camiseta, variant_id: camisetaAzul, quantity: 1 },
    ])
    expect(result.subtotal).toBe('69.90')
    expect(await variantStockOf(camisetaAzul)).toBe(3)
  })

  it('la linea guarda el SKU de la variante y el nombre compuesto', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: camiseta, variant_id: camisetaRoja, quantity: 1 },
    ])
    const [line] = await svc(
      `select product_id, variant_id, sku, name from public.order_items where order_id = $1`,
      [result.order_id],
    )
    expect(line?.product_id).toBe(camiseta)
    expect(line?.variant_id).toBe(camisetaRoja)
    expect(line?.sku).toBe('A-CAM-ROJA')
    expect(line?.name).toBe('Camiseta · Roja')
  })

  it('el maestro de variantes NO se vende sin decir cual', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: camiseta, quantity: 1 }]),
    )
    expect(message).toMatch(/VARIANTE_REQUERIDA/)
    expect(await variantStockOf(camisetaRoja)).toBe(10)
  })

  it('un producto simple no admite variante en el payload', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [
        { product_id: jabon, variant_id: camisetaRoja, quantity: 1 },
      ]),
    )
    expect(message).toMatch(/VARIANTE_NO_APLICA/)
  })

  it('una variante de otro producto no se cuela aunque se conozca su uuid', async () => {
    const otroPadre = await id(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
          status, published_at, kind)
       values ($1, $2, $3, 'A-OTRO', 'otro', 'Otro', '5.00', 'PEN', 0, 'published', now(), 'variant')
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    const otraVariante = await id(
      `insert into public.product_variants
         (organization_id, company_id, store_id, product_id, sku, name, stock)
       values ($1, $2, $3, $4, 'A-OTRO-V', 'Única', 5) returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, otroPadre],
    )

    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [
        { product_id: camiseta, variant_id: otraVariante, quantity: 1 },
      ]),
    )
    expect(message).toMatch(/VARIANTE_NO_DISPONIBLE/)
    expect(await variantStockOf(otraVariante)).toBe(5)

    await svc(`delete from public.products where id = $1`, [otroPadre])
  })

  it('una variante desactivada no se vende', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [
        { product_id: camiseta, variant_id: camisetaRetirada, quantity: 1 },
      ]),
    )
    expect(message).toMatch(/VARIANTE_NO_DISPONIBLE/)
  })

  it('no se venden mas unidades de una variante de las que hay', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [
        { product_id: camiseta, variant_id: camisetaAzul, quantity: 5 },
      ]),
    )
    expect(message).toMatch(/STOCK_INSUFICIENTE/)
    expect(await variantStockOf(camisetaAzul)).toBe(4)
  })

  it('dos variantes distintas del mismo producto son dos lineas', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: camiseta, variant_id: camisetaRoja, quantity: 1 },
      { product_id: camiseta, variant_id: camisetaAzul, quantity: 1 },
    ])
    const lines = await svc(
      `select sku from public.order_items where order_id = $1 order by sku`,
      [result.order_id],
    )
    expect(lines.map((l) => l.sku)).toEqual(['A-CAM-AZUL', 'A-CAM-ROJA'])
    expect(result.subtotal).toBe('129.90')
  })

  it('una linea con variante y otra sin ella conviven en el mismo pedido', async () => {
    // El recorrido de lineas reutiliza la misma variable de variante en cada
    // vuelta: si no se reiniciara, la linea del jabon heredaria la camiseta de
    // la anterior y descontaria de la variante equivocada.
    const result = await checkout(STORE_A_SLUG, [
      { product_id: camiseta, variant_id: camisetaRoja, quantity: 1 },
      { product_id: jabon, quantity: 2 },
    ])

    const lines = await svc(
      `select sku, variant_id from public.order_items where order_id = $1 order by sku`,
      [result.order_id],
    )
    expect(lines.map((l) => [l.sku, l.variant_id])).toEqual([
      ['A-CAM-ROJA', camisetaRoja],
      ['A-JABON', null],
    ])
    expect(await variantStockOf(camisetaRoja)).toBe(9)
    expect(await stockOf(jabon)).toBe(98)
  })

  it('la misma variante repetida se agrupa en una linea', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: camiseta, variant_id: camisetaRoja, quantity: 1 },
      { product_id: camiseta, variant_id: camisetaRoja, quantity: 2 },
    ])
    const lines = await svc(`select quantity from public.order_items where order_id = $1`, [
      result.order_id,
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.quantity).toBe(3)
    expect(await variantStockOf(camisetaRoja)).toBe(7)
  })
})

describe('unidades de venta', () => {
  it('vender por caja descuenta las unidades base, no las cajas', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: jabon, uom_code: 'CAJA', quantity: 2 },
    ])

    // Precio propio de la caja: 100.00, no 12 x 10.00. Ese es el caso que
    // `product_uoms.price` existe para representar.
    expect(result.subtotal).toBe('200.00')
    expect(await stockOf(jabon)).toBe(100 - 24)

    const [line] = await svc(
      `select quantity, unit_price::text as unit_price, uom_code,
              uom_factor::text as uom_factor, base_quantity::text as base_quantity
         from public.order_items where order_id = $1`,
      [result.order_id],
    )
    expect(line?.quantity).toBe(2)
    expect(line?.unit_price).toBe('100.00')
    expect(line?.uom_code).toBe('CAJA')
    expect(line?.uom_factor).toBe('12.000000')
    expect(line?.base_quantity).toBe('24.000000')
  })

  it('sin precio propio, la unidad cuesta el precio base por el factor', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: jabon, uom_code: 'PACK', quantity: 1 },
    ])
    expect(result.subtotal).toBe('60.00')
    expect(await stockOf(jabon)).toBe(94)
  })

  it('el codigo de unidad no distingue mayusculas', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: jabon, uom_code: 'caja', quantity: 1 },
    ])
    expect(result.subtotal).toBe('100.00')
    expect(await stockOf(jabon)).toBe(88)
  })

  it('una unidad que el producto no tiene configurada no se vende', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: jabon, uom_code: 'BARRIL', quantity: 1 }]),
    )
    expect(message).toMatch(/UOM_NO_DISPONIBLE/)
    expect(await stockOf(jabon)).toBe(100)
  })

  it('una unidad marcada como no vendible tampoco se vende', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: jabon, uom_code: 'PALLET', quantity: 1 }]),
    )
    expect(message).toMatch(/UOM_NO_DISPONIBLE/)
  })

  it('una conversion que no da unidades base enteras se rechaza en vez de redondear', async () => {
    // Media unidad x 1 = 0,5 unidades base. `stock` es entero: aproximar seria
    // regalar o cobrar de mas media unidad en cada pedido.
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: jabon, uom_code: 'MEDIA', quantity: 1 }]),
    )
    expect(message).toMatch(/CANTIDAD_INVALIDA/)
    expect(await stockOf(jabon)).toBe(100)
  })

  it('la misma media unidad en cantidad par si es vendible', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: jabon, uom_code: 'MEDIA', quantity: 2 },
    ])
    expect(result.subtotal).toBe('10.00')
    expect(await stockOf(jabon)).toBe(99)
  })

  it('el mismo producto en dos unidades distintas son dos lineas', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: jabon, uom_code: 'CAJA', quantity: 1 },
      { product_id: jabon, quantity: 5 },
    ])
    const lines = await svc(
      `select uom_code, quantity, base_quantity::text as base_quantity
         from public.order_items where order_id = $1 order by uom_code nulls last`,
      [result.order_id],
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]?.uom_code).toBe('CAJA')
    expect(lines[1]?.uom_code).toBeNull()
    expect(await stockOf(jabon)).toBe(100 - 12 - 5)
  })

  it('el factor de conversion no se acepta del payload', async () => {
    const message = await expectFailure(() =>
      svc(
        `select public.create_order_for_slug(
            $1, 'ana@compradora.com', $2::jsonb, 'Ana', '+51 999 111 222',
            '{"address": "Av. Primavera 120"}'::jsonb, null)`,
        [
          STORE_A_SLUG,
          JSON.stringify([{ product_id: jabon, quantity: 1, uom_factor: 1000 }]),
        ],
      ),
    )
    expect(message).toMatch(/CAMPO_NO_PERMITIDO/)
    expect(await stockOf(jabon)).toBe(100)
  })
})

describe('kits', () => {
  it('un kit descuenta sus componentes y nunca su propia existencia', async () => {
    const result = await checkout(STORE_A_SLUG, [{ product_id: kit, quantity: 2 }])

    expect(result.subtotal).toBe('160.00')
    // 2 kits x (2 jabones + 1 camiseta roja)
    expect(await stockOf(jabon)).toBe(96)
    expect(await variantStockOf(camisetaRoja)).toBe(8)
    expect(await stockOf(kit)).toBe(0)

    const [line] = await svc(
      `select product_id, variant_id, sku, quantity from public.order_items where order_id = $1`,
      [result.order_id],
    )
    expect(line?.product_id).toBe(kit)
    expect(line?.variant_id).toBeNull()
    expect(line?.sku).toBe('A-KIT')
    expect(line?.quantity).toBe(2)
  })

  it('si un componente no alcanza, no queda ni pedido ni existencia movida', async () => {
    await svc(`update public.product_variants set stock = 1 where id = $1`, [camisetaRoja])
    const pedidosAntes = await svc(`select count(*)::int as n from public.orders`)

    const message = await expectFailure(() => checkout(STORE_A_SLUG, [{ product_id: kit, quantity: 3 }]))
    expect(message).toMatch(/STOCK_INSUFICIENTE/)

    // El jabon se descuenta ANTES que la camiseta en el recorrido de
    // componentes: si la transaccion no fuera atomica, aqui faltarian 6.
    expect(await stockOf(jabon)).toBe(100)
    expect(await variantStockOf(camisetaRoja)).toBe(1)

    const pedidosDespues = await svc(`select count(*)::int as n from public.orders`)
    expect(pedidosDespues[0]?.n).toBe(pedidosAntes[0]?.n)
  })

  it('un kit sin componentes no se vende', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: kitVacio, quantity: 1 }]),
    )
    expect(message).toMatch(/KIT_SIN_COMPONENTES/)
  })

  it('un kit no admite variante en el payload: la variante la elige la receta', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [
        { product_id: kit, variant_id: camisetaRoja, quantity: 1 },
      ]),
    )
    expect(message).toMatch(/VARIANTE_NO_APLICA/)
  })

  it('un kit y sus componentes sueltos en el mismo pedido descuentan los dos', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: kit, quantity: 1 },
      { product_id: jabon, quantity: 4 },
    ])
    expect(result.subtotal).toBe('120.00')
    expect(await stockOf(jabon)).toBe(100 - 2 - 4)
  })
})

describe('el aislamiento no se rompe por las rutas nuevas', () => {
  it('una variante no se puede comprar desde la tienda de otro tenant', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_B_SLUG, [
        { product_id: camiseta, variant_id: camisetaRoja, quantity: 1 },
      ]),
    )
    expect(message).toMatch(/PRODUCTO_NO_DISPONIBLE/)
    expect(await variantStockOf(camisetaRoja)).toBe(10)
  })

  it('un producto de otro tenant sigue sin colarse aunque venga con unidad', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: productoB, uom_code: 'CAJA', quantity: 1 }]),
    )
    expect(message).toMatch(/PRODUCTO_NO_DISPONIBLE/)
    expect(await stockOf(productoB)).toBe(4)
  })
})
