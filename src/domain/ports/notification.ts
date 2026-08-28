import type { Provider, ProviderOperation } from './operations'

/**
 * `NotificationProvider` — avisar al comprador o al comercio.
 *
 * La frontera está declarada en la base (`message.email`, `message.sms`,
 * `message.whatsapp`) y hoy tiene un hueco concreto y visible: la pantalla del
 * checkout dice que se envía un correo de confirmación y **no se envía**. Lo
 * que falta no es código sino la decisión de qué proveedor transaccional se usa
 * y con qué secretos; el contrato queda escrito para que esa decisión no
 * arrastre además un rediseño.
 *
 * Dos reglas que fija ahora:
 *
 *  1. **Se envía una PLANTILLA con variables, nunca un cuerpo compuesto.** El
 *     dominio no redacta: dice `order.confirmed` y pasa los datos. Así el texto
 *     se traduce, se personaliza por tenant y se cambia sin desplegar, que es
 *     lo que exige «personalización por configuración, no por código».
 *  2. **La dirección del destinatario no se registra en claro.** Lo que queda
 *     en la bitácora es el resultado y la referencia del proveedor.
 */

export type NotificationChannel = 'email' | 'sms' | 'whatsapp'

export interface NotificationRecipient {
  readonly channel: NotificationChannel
  /** Correo o teléfono, según el canal. */
  readonly address: string
  /** Idioma del destinatario, ISO 639-1. Cae al de la tienda si falta. */
  readonly locale?: string
}

export interface NotificationRequest {
  readonly recipient: NotificationRecipient
  /** Identificador de plantilla, p. ej. `order.confirmed`. */
  readonly template: string
  /** Variables de la plantilla. Sin HTML: lo compone el proveedor. */
  readonly variables: Readonly<Record<string, string>>
  /** El mismo aviso dos veces molesta al comprador y confunde al comercio. */
  readonly idempotencyKey: string
}

export interface NotificationResult {
  readonly accepted: boolean
  readonly providerReference: string | null
  readonly providerCode: string | null
}

export interface NotificationProvider extends Provider {
  send(request: NotificationRequest): Promise<NotificationResult>
}

export const NOTIFICATION_OPERATIONS: readonly ProviderOperation[] = [
  'message.email',
  'message.sms',
  'message.whatsapp',
]

export const CHANNEL_OPERATION: Readonly<Record<NotificationChannel, ProviderOperation>> = {
  email: 'message.email',
  sms: 'message.sms',
  whatsapp: 'message.whatsapp',
}
