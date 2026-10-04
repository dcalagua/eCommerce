// @vitest-environment node
/**
 * Lo que envía Ajustes, la base lo deja escribir (2026-10-04).
 *
 * `store_settings` concede el UPDATE columna por columna (20260828140200) y el
 * formulario de Ajustes guarda con UN solo UPDATE: si una sola de las columnas
 * que envía no tiene GRANT, falla el guardado entero con 42501 y el comercio
 * ve «Tu rol no puede cambiar la configuración». Pasó con `tax_inclusive`.
 *
 * Aquí se leen las claves que escribe `saveStoreSettings` (su código, no una
 * copia a mano que se desactualiza) y se exige el GRANT de cada una que sea
 * columna de `store_settings`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDatabase } from './harness.ts'

let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase()
}, 180_000)

afterAll(async () => {
  await db?.close()
})

/** Claves `nombre:` dentro del cuerpo de `saveStoreSettings`. */
function clavesQueEnviaAjustes(): string[] {
  const ruta = fileURLToPath(new URL('../../src/features/admin/settings/api.ts', import.meta.url))
  const fuente = readFileSync(ruta, 'utf8')
  const inicio = fuente.indexOf('export async function saveStoreSettings')
  expect(inicio).toBeGreaterThan(-1)
  const fin = fuente.indexOf('\nexport ', inicio + 1)
  const cuerpo = fuente.slice(inicio, fin === -1 ? undefined : fin)
  const claves = new Set<string>()
  for (const m of cuerpo.matchAll(/^\s+([a-z][a-z0-9_]*):/gm)) claves.add(m[1] as string)
  for (const m of cuerpo.matchAll(/patch\.([a-z][a-z0-9_]*)\s*=/g)) claves.add(m[1] as string)
  return [...claves]
}

describe('Ajustes guarda con un UPDATE que la base acepta', () => {
  it('cada columna de store_settings que envía el formulario tiene GRANT de UPDATE', async () => {
    const columnas = new Set(
      (
        await db.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'store_settings'`,
        )
      ).rows.map((r) => r.column_name),
    )
    // Las de identidad van solo en el INSERT de la primera vez (sin fila aún),
    // nunca en el UPDATE: el tenant no se cambia desde una pantalla.
    const soloAlCrear = new Set(['store_id', 'organization_id', 'company_id'])
    const enviadas = clavesQueEnviaAjustes().filter((clave) => columnas.has(clave) && !soloAlCrear.has(clave))
    // Que la lectura del código encontró de verdad el formulario.
    expect(enviadas).toEqual(expect.arrayContaining(['accent_color', 'tax_inclusive', 'checkout_requires_account']))

    const sinPermiso: string[] = []
    for (const columna of enviadas) {
      const [fila] = (
        await db.query<{ ok: boolean }>(
          `select has_column_privilege('authenticated', 'public.store_settings', $1, 'UPDATE') as ok`,
          [columna],
        )
      ).rows
      if (!fila?.ok) sinPermiso.push(columna)
    }
    expect(sinPermiso).toEqual([])
  })
})
