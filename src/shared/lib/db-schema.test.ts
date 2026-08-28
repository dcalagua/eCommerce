/**
 * Los tipos generados de la base tienen consumidores, y esto lo comprueba (R11).
 *
 * Hasta P01, `database.types.ts` estaba commiteado en **0 bytes** —el `>` del
 * script anterior truncaba el archivo antes de ejecutar el CLI, así que un
 * fallo lo dejaba vacío con un exit code que nadie miraba— y pasó inadvertido
 * porque ningún módulo lo importaba. Arreglar el generador no basta: mientras
 * nadie consuma el archivo, volver a vaciarlo seguiría sin romper nada.
 *
 * Hay dos consumidores, y son de tipos distintos a propósito:
 *
 *  1. `db-schema.ts` usa `satisfies` contra `Database['public']`, así que un
 *     nombre de tabla, vista o función que desaparezca **no compila**.
 *  2. Este archivo compara los enums escritos a mano en `src/` contra
 *     `Constants.public.Enums`, que es lo que la base tiene de verdad. La
 *     convención del repositorio es «tipos generados, no escritos a mano»; los
 *     enums se escriben a mano igualmente porque de ellos cuelgan las máquinas
 *     de estado y las matrices de permisos, así que al menos no pueden
 *     desviarse en silencio.
 */
import { describe, expect, it } from 'vitest'
import { Constants } from './database.types'
import { APP_ROLES } from './roles'
import {
  CATEGORIES_TABLE,
  ORDERS_TABLE,
  ORDER_BY_TOKEN_RPC,
  PRODUCTS_TABLE,
  PUBLIC_PRODUCTS_VIEW,
} from './db-schema'
import { PRODUCT_STATUSES } from '@/features/catalog/types'
import { ORDER_STATUSES } from '@/features/orders/types'
import { PROVIDER_KINDS } from '@/domain/ports/operations'

const enums = Constants.public.Enums

/** Compara sin exigir orden: un enum de Postgres tiene orden, una lista no. */
function sameSet(a: readonly string[], b: readonly string[]): void {
  expect([...a].sort()).toEqual([...b].sort())
}

describe('el archivo generado no está vacío', () => {
  it('trae los enums del esquema público', () => {
    expect(Object.keys(enums).length).toBeGreaterThan(5)
  })

  it('trae los nombres que usa la capa de datos', () => {
    expect(PRODUCTS_TABLE).toBe('products')
    expect(CATEGORIES_TABLE).toBe('categories')
    expect(ORDERS_TABLE).toBe('orders')
    expect(PUBLIC_PRODUCTS_VIEW).toBe('public_products')
    expect(ORDER_BY_TOKEN_RPC).toBe('order_by_token')
  })
})

describe('los enums escritos a mano son los de la base', () => {
  /** De aquí cuelga la matriz de capacidades de rol de `shared/lib/roles.ts`. */
  it('app_role', () => {
    sameSet(APP_ROLES, enums.app_role)
  })

  /** De aquí cuelga el CHECK de `published_at` y el filtro del storefront. */
  it('product_status', () => {
    sameSet(PRODUCT_STATUSES, enums.product_status)
  })

  /** De aquí cuelga la máquina de transiciones, replicada en tres sitios. */
  it('order_status', () => {
    sameSet(ORDER_STATUSES, enums.order_status)
  })

  /** De aquí cuelga el vocabulario canónico de los puertos de proveedor. */
  it('integration_kind', () => {
    sameSet(PROVIDER_KINDS, enums.integration_kind)
  })
})
