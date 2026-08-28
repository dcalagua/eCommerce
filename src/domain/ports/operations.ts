/**
 * Vocabulario CANÓNICO de las operaciones que eCommerce pide a un tercero.
 *
 * Es el mismo vocabulario que ya vive en la base desde P12 histórico
 * (`integration_providers.capabilities`, migración `20260827150000`) y en el
 * CHECK de `integration_outbox.operation`. Aquí está en TypeScript para que el
 * dominio pueda tiparse contra él, y `supabase/tests/integration-contract.test.ts`
 * compara las dos copias contra Postgres real: si alguien añade un proveedor en
 * SQL con una operación que no está declarada aquí —o al revés— la suite falla.
 *
 * La regla que sostiene todo el diseño de integraciones (RFP 4.1.3-b): el
 * dominio dice `order.create`. Qué llamada concreta es eso en cada sistema —una
 * función remota en una generación del ERP, un servicio REST en la siguiente,
 * un POST en otra cosa— lo sabe únicamente el adaptador. Ningún nombre de
 * fabricante, banco, transportista ni cliente entra en este archivo ni en
 * ninguno bajo `src/`; `src/architecture.test.ts` lo verifica. El ejemplo
 * concreto, con nombres, está en `docs/adr/001-domain-boundaries.md`, que es
 * documentación y no código.
 *
 * Nota de vocabulario (§5.3 del baseline): la base llama `capabilities` a esto
 * y `shared/lib/roles.ts` llama `Permission` a los permisos de ROL. Son ejes
 * ortogonales y aquí se evita la palabra a propósito: esto son
 * `ProviderOperation`. El tercer eje —lo que el tenant CONTRATÓ— lo resolvió
 * P02: se llama `Capability` (`domain/capabilities.ts`) y por eso el de los
 * roles pasó a llamarse `Permission`. Que un proveedor sepa hacer
 * `stock.read` no significa que la sociedad tenga contratado
 * `inventory.multiwarehouse`, ni que este usuario pueda tocarlo.
 */

/** Familias de proveedor. Espejo del enum `public.integration_kind`. */
export const PROVIDER_KINDS = [
  'erp',
  'payment',
  'invoicing',
  'logistics',
  'messaging',
  'identity',
  // P14-SaaS. Un webhook avisa a un SISTEMA —con firma, reintentos, identidad
  // de evento y reproducción autorizada—; `messaging` avisa a una PERSONA por
  // correo, SMS o mensajería. Meterlos en la misma familia obligaría a filtrar
  // por el código del proveedor, que es como un enum deja de significar nada.
  'webhook',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/**
 * Operaciones canónicas, agrupadas por el sustantivo del dominio. El formato
 * `sustantivo.verbo` no es estético: lo exige el CHECK
 * `integration_outbox_operation_fmt`.
 */
export const PROVIDER_OPERATIONS = [
  'customer.read',
  'product.read',
  'price.read',
  'stock.read',
  'order.create',
  'order.read',
  'invoice.create',
  'invoice.issue',
  'invoice.read',
  'payment.authorize',
  'payment.capture',
  'payment.refund',
  'shipment.create',
  'shipment.track',
  // P12-SaaS. Anular una guia ya emitida no es «no crearla»: el operador puede
  // haberla cobrado y la anulacion es una llamada aparte que no todos ofrecen,
  // por eso es una operacion propia y no una bandera de `shipment.create`.
  'shipment.cancel',
  'message.email',
  'message.sms',
  'message.whatsapp',
  // P14-SaaS. La única operación del conector de webhooks: la plataforma
  // publica un HECHO y el sistema suscrito decide qué hacer con él. No es
  // `event.send` ni `event.notify` a propósito — publicar no presupone que
  // haya alguien escuchando, que es justo la propiedad de un outbox.
  'event.publish',
] as const
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number]

const OPERATION_SET: ReadonlySet<string> = new Set(PROVIDER_OPERATIONS)

export function isProviderOperation(value: string): value is ProviderOperation {
  return OPERATION_SET.has(value)
}

/** Mismo formato que exige `integration_outbox_operation_fmt` en la base. */
export const OPERATION_FORMAT = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/**
 * Referencia a un proveedor habilitado por el tenant.
 *
 * `code` es el `integration_providers.code` (`tenant_integrations.provider_code`)
 * y NO viaja nunca desde el navegador: quién está habilitado lo resuelve el
 * servidor con el tenant del JWT. Este tipo describe el resultado de esa
 * resolución, no una preferencia del cliente.
 */
export interface ProviderRef {
  readonly code: string
  readonly kind: ProviderKind
  readonly operations: readonly ProviderOperation[]
}

/** Contrato mínimo que cumple cualquier adaptador, sea del tipo que sea. */
export interface Provider {
  readonly ref: ProviderRef
  supports(operation: ProviderOperation): boolean
}

export function supportsOperation(ref: ProviderRef, operation: ProviderOperation): boolean {
  return ref.operations.includes(operation)
}
