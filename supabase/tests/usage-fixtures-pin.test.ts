// @vitest-environment node
/**
 * FIX-USG-v1 fijado por checksum (plan CCP §12, `usage-fixtures-pin`).
 *
 * `supabase/tests/fixtures/usage-v1/` es una COPIA del contrato `ebim.usage/v1`
 * que publica EBIM MasterAdmin (`contracts/usage/v1`, sin sus `*.test.ts`).
 * Aquí no se edita: si alguien toca un archivo, este test falla.
 *   1. el propio `CHECKSUMS.sha256` contra la constante publicada;
 *   2. cada archivo contra `CHECKSUMS.sha256`;
 *   3. el medidor de eCommerce que emite este repo es el de `meters.json`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ECOMMERCE_USAGE_METERS } from '../functions/_shared/usageOutbox/contract.ts'

/** sha256 de CHECKSUMS.sha256 publicado por MasterAdmin (FIX-USG-v1). */
export const FIX_USG_V1_SHA256 = '9f77d3cd692a52287d1af20b766d3a6024d3f4485de664460de035245ba7d6e1'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-v1')
const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex')

describe('FIX-USG-v1 fijado', () => {
  const checksums = readFileSync(join(DIR, 'CHECKSUMS.sha256'))

  it('CHECKSUMS.sha256 es exactamente el publicado por MasterAdmin', () => {
    expect(sha256(checksums)).toBe(FIX_USG_V1_SHA256)
  })

  const entries = checksums
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/) as [string, string])

  it('lista los 10 archivos del contrato', () => {
    expect(entries).toHaveLength(10)
  })

  it.each(entries)('%s · %s intacto', (hash, file) => {
    expect(sha256(readFileSync(join(DIR, file)))).toBe(hash)
  })
})

describe('medidores de eCommerce', () => {
  const meters = JSON.parse(readFileSync(join(DIR, 'meters.json'), 'utf8')) as {
    eventMeters: { productCode: string; code: string; unit: string }[]
    dailySnapshotMeters: unknown[]
  }

  it('emite exactamente los medidores del contrato para ecommerce', () => {
    const published = meters.eventMeters
      .filter((m) => m.productCode === 'ecommerce')
      .map((m) => ({ code: m.code, unit: m.unit }))
    expect(ECOMMERCE_USAGE_METERS).toEqual(published)
  })

  it('ninguna foto diaria aprobada', () => {
    expect(meters.dailySnapshotMeters).toEqual([])
  })
})
