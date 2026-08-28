/**
 * El registro de adaptadores logísticos: `provider_code` → adaptador.
 *
 * Es el único sitio de todo el repositorio donde el código de un operador
 * aparece escrito. El dominio de entregas, el de pedidos y el checkout hablan
 * siempre de `provider_code` como de un dato que viene de la fila; aquí se
 * resuelve a la implementación.
 *
 * **Conectar un operador nuevo es escribir un archivo y una línea en este
 * mapa.** Ni una migración sobre `orders`, ni una sobre `fulfillments`, ni un
 * `if` en el checkout, ni un cambio en ninguna pantalla. Eso es, literalmente,
 * la Definition of Done de P12, y este archivo es donde se comprueba —hay un
 * test que registra un operador inventado y recorre el ciclo entero con él—.
 *
 * Un `provider_code` que la base conoce y este mapa no es un error del
 * DESPLIEGUE —fila dada de alta sin desplegar el adaptador—, y por eso sale con
 * su propio código y no como «no soportado».
 */
import type { ShippingProvider } from './provider.ts'
import {
  SANDBOX_CARRIER_CODE,
  createSandboxCarrier,
  type SandboxCarrierOptions,
} from './sandbox.ts'

export interface CarrierResolveOptions extends SandboxCarrierOptions {
  /** Configuración PÚBLICA del método (`delivery_methods.public_config`). Sin secretos. */
  readonly publicConfig?: Record<string, unknown>
}

export type ShippingProviderFactory = (options: CarrierResolveOptions) => ShippingProvider

const FACTORIES = new Map<string, ShippingProviderFactory>([
  [SANDBOX_CARRIER_CODE, (options) => createSandboxCarrier(options)],
])

export class UnknownShippingProviderError extends Error {
  readonly code = 'CONECTOR_NO_DESPLEGADO'
  readonly providerCode: string

  constructor(providerCode: string) {
    super(`No hay adaptador desplegado para el operador "${providerCode}"`)
    this.name = 'UnknownShippingProviderError'
    this.providerCode = providerCode
  }
}

/** Registra un adaptador. Lo usan los tests y, el día que exista, uno real. */
export function registerShippingProvider(code: string, factory: ShippingProviderFactory): void {
  FACTORIES.set(code, factory)
}

export function hasShippingProvider(code: string): boolean {
  return FACTORIES.has(code)
}

export function resolveShippingProvider(
  code: string,
  options: CarrierResolveOptions = {},
): ShippingProvider {
  const factory = FACTORIES.get(code)
  if (!factory) throw new UnknownShippingProviderError(code)
  return factory(options)
}

/** Los códigos con adaptador desplegado. Para diagnóstico, no para decidir. */
export function deployedShippingProviders(): readonly string[] {
  return [...FACTORIES.keys()].sort()
}
