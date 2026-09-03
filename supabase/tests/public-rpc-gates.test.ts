// @vitest-environment node
/**
 * Toda función que el navegador llama por RPC existe en `public`.
 *
 * ## El fallo que da nombre a este archivo
 *
 * «Generar sugerido» devolvía «No se pudo completar la operación» con cualquier
 * cliente y cualquier periodo, y no era la pantalla: `ebim.suggest_order` vivía
 * solo en el esquema `ebim`, y el navegador llama por PostgREST, que únicamente
 * publica `public`. La llamada buscaba `public.suggest_order`, que no existía.
 *
 * Lo que hace este caso distinto de un descuido cualquiera es que **los tests
 * de base lo tapaban**: llamaban a `ebim.suggest_order` directamente con
 * `service_role` —o sea, probaban el CÁLCULO, que estaba bien— y nadie probaba
 * la PUERTA, que faltaba. Al barrer las 81 constantes del navegador contra las
 * migraciones apareció una segunda: `customer_aging`, la antigüedad de saldos
 * del panel de crédito.
 *
 * Por eso el barrido se automatiza aquí en vez de arreglarse dos veces: la
 * lista de RPC la escribe `db-schema.ts`, y añadir una constante nueva sin su
 * función en `public` pone este test rojo antes de que nadie abra el cajón.
 *
 * ## Qué se comprueba, y qué NO
 *
 * Que la función EXISTE en `public` y que `authenticated` puede ejecutarla.
 * Quién puede ver qué es cosa de la RLS y se compra en los tests de aislamiento
 * de cada fase; aquí solo se defiende que la puerta esté abierta.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDatabase } from './harness.ts'

let db: PGlite

const ESQUEMA_TS = fileURLToPath(new URL('../../src/shared/lib/db-schema.ts', import.meta.url))

/**
 * Los nombres que el navegador pasa a `rpc(...)`.
 *
 * Se leen del fichero, no de una copia: una lista escrita a mano aquí sería
 * otra cosa que mantener, y la primera que se quedaría vieja.
 */
function rpcDelNavegador(): { constante: string; nombre: string }[] {
  const fuente = readFileSync(ESQUEMA_TS, 'utf8')
  const encontrados = [...fuente.matchAll(/export const (\w*RPC\w*) = '([a-z0-9_]+)'/g)]
  return encontrados.map((m) => ({ constante: String(m[1]), nombre: String(m[2]) }))
}

beforeAll(async () => {
  db = await createTestDatabase()
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('las puertas publicas del navegador', () => {
  it('hay constantes de RPC que barrer: si no, este test no prueba nada', () => {
    // Un barrido sobre una lista vacía pasa siempre. Esta es la guarda del
    // guarda: si alguien cambia el nombre del patrón en `db-schema.ts`, aquí se
    // ve en vez de quedarse verde sin mirar nada.
    expect(rpcDelNavegador().length).toBeGreaterThan(50)
  })

  it('cada RPC que el navegador nombra existe en `public`', async () => {
    const nombres = rpcDelNavegador().map((r) => r.nombre)

    const { rows } = await db.query<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])`,
      [nombres],
    )
    const enPublic = new Set(rows.map((r) => r.proname))

    const faltan = rpcDelNavegador()
      .filter((r) => !enPublic.has(r.nombre))
      .map((r) => `${r.nombre} (${r.constante})`)

    // El mensaje dice QUÉ falta: un `toEqual([])` sin nombres obliga a repetir
    // la investigación entera cada vez que se pone rojo.
    expect(faltan).toEqual([])
  })

  it('`authenticated` puede ejecutar todas: una puerta cerrada no es una puerta', async () => {
    const nombres = rpcDelNavegador().map((r) => r.nombre)

    const { rows } = await db.query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
          and not has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
      [nombres],
    )

    expect(rows.map((r) => r.proname)).toEqual([])
  })
})
