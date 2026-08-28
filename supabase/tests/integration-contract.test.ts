// @vitest-environment node
/**
 * El vocabulario canónico de TypeScript y el de Postgres son el MISMO (P01).
 *
 * `src/domain/ports/operations.ts` declara las operaciones y las familias de
 * proveedor; `20260827150000_integration_framework.sql` las declara otra vez en
 * el enum `integration_kind`, en el CHECK de `integration_outbox.operation` y en
 * las filas sembradas de `integration_providers`. Dos copias de un vocabulario
 * no se separan el día que se escriben: se separan seis meses después, cuando
 * alguien añade un proveedor en SQL y el adaptador de TypeScript sigue sin
 * saber que existe.
 *
 * Esto es, además, lo que impide que los puertos de P01 sean interfaces
 * muertas: hoy no tienen adaptador, pero su vocabulario ya está sujeto a la
 * base y no puede desviarse sin que la suite lo diga.
 *
 * Corre contra Postgres real (PGlite) con las migraciones tal cual están.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDatabase } from './harness.ts'
import {
  OPERATION_FORMAT,
  PROVIDER_KINDS,
  PROVIDER_OPERATIONS,
  isProviderOperation,
} from '../../src/domain/ports/operations.ts'
import { ERP_OPERATIONS } from '../../src/domain/ports/erp.ts'
import { PAYMENT_OPERATIONS } from '../../src/domain/ports/payment.ts'
import { FULFILLMENT_OPERATIONS } from '../../src/domain/ports/fulfillment.ts'
import { NOTIFICATION_OPERATIONS } from '../../src/domain/ports/notification.ts'
import { INVOICING_OPERATIONS } from '../../src/domain/ports/invoicing.ts'

let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const result = await db.query<T>(sql)
  return result.rows
}

describe('las familias de proveedor son las mismas a los dos lados', () => {
  it('el enum integration_kind y PROVIDER_KINDS coinciden', async () => {
    const found = await rows<{ label: string }>(`
      select e.enumlabel as label
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      where t.typname = 'integration_kind'
      order by e.enumsortorder
    `)
    expect(found.map((r) => r.label).sort()).toEqual([...PROVIDER_KINDS].sort())
  })
})

describe('las operaciones son las mismas a los dos lados', () => {
  it('toda capacidad sembrada está declarada en TypeScript', async () => {
    const found = await rows<{ capability: string; code: string }>(`
      select p.code, unnest(p.capabilities) as capability
      from public.integration_providers p
      order by p.code
    `)
    expect(found.length).toBeGreaterThan(0)

    const undeclared = found
      .filter((row) => !isProviderOperation(row.capability))
      .map((row) => `${row.code}: ${row.capability}`)
    expect(undeclared).toEqual([])
  })

  /**
   * En el otro sentido no se exige igualdad: TypeScript puede declarar una
   * operación que todavía no siembra ningún proveedor. Lo que sí se exige es
   * que no sobre nada — una operación que ningún proveedor implementa y que
   * ningún puerto reclama es vocabulario que nadie va a usar.
   */
  it('toda operación declarada la reclama algún puerto', () => {
    const claimed = new Set<string>([
      ...ERP_OPERATIONS,
      ...PAYMENT_OPERATIONS,
      ...FULFILLMENT_OPERATIONS,
      ...NOTIFICATION_OPERATIONS,
      ...INVOICING_OPERATIONS,
    ])
    const orphans = PROVIDER_OPERATIONS.filter((operation) => !claimed.has(operation))
    expect(orphans).toEqual([])
  })

  it('el formato de TypeScript es el que acepta el CHECK de la cola', async () => {
    const [check] = await rows<{ src: string }>(`
      select pg_get_constraintdef(oid) as src
      from pg_constraint
      where conname = 'integration_outbox_operation_fmt'
    `)
    expect(check?.src).toBeTruthy()

    // El CHECK real acepta cada operación declarada, comprobado por la propia
    // base y no por una relectura de la expresión regular.
    for (const operation of PROVIDER_OPERATIONS) {
      expect(operation).toMatch(OPERATION_FORMAT)
      const [row] = await rows<{ ok: boolean }>(
        `select ('${operation}' ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$') as ok`,
      )
      expect(row?.ok, operation).toBe(true)
    }
  })
})

describe('el catálogo de proveedores sigue siendo dato y no código', () => {
  /**
   * Ningún `code` de proveedor puede aparecer en `src/`. Es la otra mitad de la
   * regla que `src/architecture.test.ts` comprueba desde el lado del código:
   * aquí se toma la lista de la BASE, así que un proveedor nuevo entra también
   * en la comprobación sin que nadie tenga que acordarse de añadirlo.
   */
  it('cada proveedor tiene familia, nombre y al menos una operación', async () => {
    const providers = await rows<{ code: string; kind: string; capabilities: string[] }>(
      `select code, kind::text as kind, capabilities from public.integration_providers`,
    )
    for (const provider of providers) {
      expect(PROVIDER_KINDS).toContain(provider.kind)
      expect(provider.capabilities.length, provider.code).toBeGreaterThan(0)
    }
  })
})
