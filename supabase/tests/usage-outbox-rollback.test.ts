// @vitest-environment node
/**
 * Rollback de la fase 17 en seco: el SQL del operador
 * (`docs/.../rollback/fase-17-usage-outbox-rollback.sql`) retira el outbox sin
 * tocar la traza de IA, y se deshace al final (nada queda aplicado).
 */
import type { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, TENANT_A } from './harness.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROLLBACK = join(
  ROOT,
  'docs',
  'superpowers',
  'evidence',
  'commercial-control-plane',
  'rollback',
  'fase-17-usage-outbox-rollback.sql',
)

let db: PGlite
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows

const record = async () =>
  (
    await q<{ id: string | null }>(
      `select ebim.ai_record_for($1, $2, 'content', 'ai', 'claude-sonnet-5', 'p', 'r', 3, 2, 0, 10) as id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
  )[0]!.id

beforeAll(async () => {
  db = await createTestDatabase()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('rollback fase 17 (dry-run)', () => {
  it('retira esquema, trigger y RPC; la traza de IA sigue igual; y se deshace', async () => {
    expect(await record()).toMatch(/^[0-9a-f-]{36}$/)
    expect((await q<{ n: number }>('select count(*)::int as n from platform_usage.usage_outbox'))[0]!.n).toBe(1)

    const sql = readFileSync(ROLLBACK, 'utf8').replace(/^commit;\s*$/m, '')
    await db.exec(sql)
    try {
      const [state] = await q<Record<string, boolean>>(`
        select exists(select 1 from pg_namespace where nspname = 'platform_usage') as schema,
               exists(select 1 from pg_trigger where tgname = 'ai_interactions_usage_outbox') as trigger,
               exists(select 1 from pg_proc where proname like 'platform_usage_outbox_%') as rpc`)
      expect(state).toEqual({ schema: false, trigger: false, rpc: false })
      // La traza sigue funcionando sin el outbox.
      expect(await record()).toMatch(/^[0-9a-f-]{36}$/)
      expect((await q<{ n: number }>('select count(*)::int as n from public.ai_interactions'))[0]!.n).toBe(2)
    } finally {
      await db.exec('rollback')
    }

    // Deshecho: todo vuelve a estar.
    expect((await q<{ n: number }>('select count(*)::int as n from platform_usage.usage_outbox'))[0]!.n).toBe(1)
  })
})
