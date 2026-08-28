import { describe, expect, it } from 'vitest'
import { AppError, classifyErrorCode, errorKind, isAppError, isRetryable } from './errors'
import { BOUNDARIES, DOMAIN_IDS, boundary, boundaryForPath } from './boundaries'
import {
  OPERATION_FORMAT,
  PROVIDER_KINDS,
  PROVIDER_OPERATIONS,
  isProviderOperation,
  supportsOperation,
  type ProviderRef,
} from './ports/operations'
import { ERP_OPERATIONS } from './ports/erp'
import { PAYMENT_OPERATIONS } from './ports/payment'
import { FULFILLMENT_OPERATIONS } from './ports/fulfillment'
import { NOTIFICATION_OPERATIONS, CHANNEL_OPERATION } from './ports/notification'
import { INVOICING_OPERATIONS } from './ports/invoicing'

describe('clasificación de errores', () => {
  it('cada código conocido cae en su clase', () => {
    expect(classifyErrorCode('SIN_PERMISO')).toBe('forbidden')
    expect(classifyErrorCode('42501')).toBe('forbidden')
    expect(classifyErrorCode('NO_AUTENTICADO')).toBe('unauthorized')
    expect(classifyErrorCode('PGRST116')).toBe('not_found')
    expect(classifyErrorCode('DUPLICADO')).toBe('conflict')
    expect(classifyErrorCode('23505')).toBe('conflict')
    expect(classifyErrorCode('CAMPO_INVALIDO')).toBe('invalid')
    expect(classifyErrorCode('CONFIG_INCOMPLETA')).toBe('config')
  })

  /**
   * «No autenticado» y «sin permiso» se resuelven de forma distinta: uno se
   * arregla volviendo a entrar y el otro no. Colapsarlos manda al usuario a un
   * login que no le va a servir de nada.
   */
  it('no confunde falta de sesión con falta de permiso', () => {
    expect(classifyErrorCode('NO_AUTENTICADO')).not.toBe(classifyErrorCode('SIN_PERMISO'))
  })

  /**
   * Lo desconocido NO es reintentable. Dar por transitorio un error que no se
   * entiende es cómo se construye el bucle que machaca al servidor justo
   * cuando peor está.
   */
  it('lo desconocido no se reintenta', () => {
    expect(classifyErrorCode('ALGO_QUE_NADIE_HA_VISTO')).toBe('unknown')
    expect(isRetryable('unknown')).toBe(false)
    expect(isRetryable('forbidden')).toBe(false)
    expect(isRetryable('rate_limited')).toBe(true)
    expect(isRetryable('unavailable')).toBe(true)
  })

  it('el error lleva su frontera, su código y su clase', () => {
    const error = new AppError({ boundary: 'catalog', code: 'DUPLICADO' })
    expect(error.boundary).toBe('catalog')
    expect(error.code).toBe('DUPLICADO')
    expect(error.kind).toBe('conflict')
    expect(error.retryable).toBe(false)
    expect(isAppError(error)).toBe(true)
    expect(errorKind(error)).toBe('conflict')
  })

  it('un fallo cualquiera capturado no miente sobre su clase', () => {
    expect(errorKind(new Error('boom'))).toBe('unknown')
    expect(errorKind('boom')).toBe('unknown')
    expect(isAppError(new Error('boom'))).toBe(false)
  })

  it('la clase se puede forzar cuando el código no la dice', () => {
    const error = new AppError({ boundary: 'payments', code: 'X_RARO', kind: 'unavailable' })
    expect(error.kind).toBe('unavailable')
    expect(error.retryable).toBe(true)
  })
})

describe('mapa de fronteras', () => {
  it('los identificadores no se repiten', () => {
    const ids = BOUNDARIES.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('están los doce dominios de negocio', () => {
    expect(DOMAIN_IDS).toHaveLength(12)
    for (const id of DOMAIN_IDS) expect(boundary(id).kind).toBe('domain')
  })

  it('gana el prefijo más largo', () => {
    // `features/admin` es el armazón, pero su subcarpeta de ajustes no lo es.
    expect(boundaryForPath('features/admin/AdminLayout.tsx')?.id).toBe('shell')
    expect(boundaryForPath('features/admin/settings/api.ts')?.id).toBe('configuration')
    // La vitrina es contenido; su carrito y su checkout, no.
    expect(boundaryForPath('features/storefront/StoreHomePage.tsx')?.id).toBe('content')
    expect(boundaryForPath('features/storefront/cart/cart.ts')?.id).toBe('checkout')
    expect(boundaryForPath('features/storefront/StoreOrderPage.tsx')?.id).toBe('orders')
  })

  it('una ruta que no pertenece a nadie se reconoce como tal', () => {
    expect(boundaryForPath('features/inventado/x.ts')).toBeNull()
  })

  it('pedir una frontera inexistente falla en vez de devolver algo vacío', () => {
    // @ts-expect-error se comprueba el camino de error en tiempo de ejecución
    expect(() => boundary('no-existe')).toThrow()
  })
})

describe('vocabulario canónico de proveedores', () => {
  it('no hay operaciones repetidas', () => {
    expect(new Set(PROVIDER_OPERATIONS).size).toBe(PROVIDER_OPERATIONS.length)
  })

  /** Mismo CHECK que `integration_outbox_operation_fmt` en la base. */
  it('toda operación tiene el formato que la base exige', () => {
    for (const operation of PROVIDER_OPERATIONS) {
      expect(operation).toMatch(OPERATION_FORMAT)
    }
  })

  it('las operaciones de cada puerto son operaciones canónicas', () => {
    const perPort = [
      ERP_OPERATIONS,
      PAYMENT_OPERATIONS,
      FULFILLMENT_OPERATIONS,
      NOTIFICATION_OPERATIONS,
      INVOICING_OPERATIONS,
    ]
    for (const operations of perPort) {
      for (const operation of operations) expect(isProviderOperation(operation)).toBe(true)
    }
  })

  it('cada canal de aviso apunta a su operación', () => {
    expect(CHANNEL_OPERATION.email).toBe('message.email')
    expect(CHANNEL_OPERATION.sms).toBe('message.sms')
    expect(CHANNEL_OPERATION.whatsapp).toBe('message.whatsapp')
  })

  it('un proveedor solo soporta lo que declara', () => {
    const ref: ProviderRef = {
      code: 'demo',
      kind: 'payment',
      operations: ['payment.authorize', 'payment.capture'],
    }
    expect(supportsOperation(ref, 'payment.authorize')).toBe(true)
    expect(supportsOperation(ref, 'payment.refund')).toBe(false)
  })

  // P14-SaaS anade `webhook`: avisar a un SISTEMA no es lo mismo que avisar a
  // una PERSONA (`messaging`), y meterlos en la misma familia obligaria a
  // filtrar por el codigo del proveedor.
  it('las familias de proveedor son las del enum de la base', () => {
    expect([...PROVIDER_KINDS].sort()).toEqual(
      ['erp', 'identity', 'invoicing', 'logistics', 'messaging', 'payment', 'webhook'].sort(),
    )
  })
})
