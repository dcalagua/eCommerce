import { describe, expect, it } from 'vitest'
import {
  APP_ROLES as EDGE_ROLES,
  ROLE_CAPABILITIES as EDGE_CAPABILITIES,
  can as edgeCan,
} from '../../../supabase/functions/_shared/roles'
import { APP_ROLES, ROLE_CAPABILITIES, can } from './roles'

/**
 * El front y el borde llevan copias separadas de la matriz de roles: una la usa
 * el bundle del navegador y la otra corre en Deno, sin `node_modules` común.
 * Copias separadas se separan solas con el tiempo — este test es el que lo
 * impide, comparando las dos contra el mismo enum de la base.
 */
describe('matriz de roles', () => {
  it('los roles del front son los mismos que los del borde', () => {
    expect([...APP_ROLES]).toEqual([...EDGE_ROLES])
  })

  it('cada capacidad concede exactamente los mismos roles en las dos copias', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual(Object.keys(EDGE_CAPABILITIES).sort())
    for (const capability of Object.keys(ROLE_CAPABILITIES) as Array<
      keyof typeof ROLE_CAPABILITIES
    >) {
      expect([...ROLE_CAPABILITIES[capability]]).toEqual([...EDGE_CAPABILITIES[capability]])
    }
  })

  it('`can` responde igual en las dos para toda combinación', () => {
    for (const role of APP_ROLES) {
      for (const capability of Object.keys(ROLE_CAPABILITIES) as Array<
        keyof typeof ROLE_CAPABILITIES
      >) {
        expect(can(role, capability)).toBe(edgeCan(role, capability))
      }
    }
  })

  it('sin rol no hay ninguna capacidad', () => {
    expect(can(null, 'store.manage')).toBe(false)
    expect(can(undefined, 'catalog.write')).toBe(false)
  })

  it('`viewer` no escribe nada y `owner` puede todo', () => {
    for (const capability of Object.keys(ROLE_CAPABILITIES) as Array<
      keyof typeof ROLE_CAPABILITIES
    >) {
      expect(can('viewer', capability)).toBe(false)
      expect(can('owner', capability)).toBe(true)
    }
  })

  it('`catalog` no toca pedidos ni configuración de la tienda', () => {
    expect(can('catalog', 'catalog.write')).toBe(true)
    expect(can('catalog', 'orders.write')).toBe(false)
    expect(can('catalog', 'store.manage')).toBe(false)
    expect(can('catalog', 'tenant.manage')).toBe(false)
  })
})
