// @vitest-environment node
/**
 * FIX-ENT-v1 fijado por checksum (plan CCP §3.2, `entitlements-fixtures-pin`).
 *
 * `supabase/tests/fixtures/entitlements-v1/` es una COPIA del contrato que
 * publica EBIM MasterAdmin (`contracts/entitlements/v1`). Aquí no se edita: si
 * alguien toca un fixture, este test falla. Dos comprobaciones:
 *   1. cada archivo contra `CHECKSUMS.sha256`;
 *   2. el propio `CHECKSUMS.sha256` contra la constante publicada en la
 *      evidencia de la fase 08 de MasterAdmin.
 *
 * Y la canonicalización RFC 8785 del receptor pasa TODOS los vectores.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalize, sha256Hex } from '../functions/_shared/platformEntitlements/jcs.ts'

/** sha256 de CHECKSUMS.sha256 publicado por MasterAdmin (fase 08, FIX-ENT-v1). */
export const FIX_ENT_V1_SHA256 = '7aab413a145b0e9a165c5f02be4bfda17f886a4b46bc2a557eec3eeaed1f65d5'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'entitlements-v1')
const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex')

describe('FIX-ENT-v1 fijado', () => {
  const checksums = readFileSync(join(DIR, 'CHECKSUMS.sha256'))

  it('CHECKSUMS.sha256 es exactamente el publicado por MasterAdmin', () => {
    expect(sha256(checksums)).toBe(FIX_ENT_V1_SHA256)
  })

  const entries = checksums
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/) as [string, string])

  it('lista los 20 archivos del contrato', () => {
    expect(entries).toHaveLength(20)
  })

  it.each(entries)('%s · %s intacto', (hash, file) => {
    expect(sha256(readFileSync(join(DIR, file)))).toBe(hash)
  })
})

describe('JCS (RFC 8785) del receptor', () => {
  const vectors = JSON.parse(readFileSync(join(DIR, 'jcs-vectors.json'), 'utf8')) as {
    vectors: { id: string; input: string; canonical: string; sha256: string }[]
  }

  it('los 11 vectores publicados', () => {
    expect(vectors.vectors).toHaveLength(11)
  })

  // `input` es TEXTO JSON: se parsea como lo haría el receptor con el cuerpo.
  it.each(vectors.vectors.map((v) => [v.id, v] as const))('%s', async (_id, v) => {
    const canonical = canonicalize(JSON.parse(v.input))
    expect(canonical).toBe(v.canonical)
    expect(await sha256Hex(canonical)).toBe(v.sha256)
  })
})
