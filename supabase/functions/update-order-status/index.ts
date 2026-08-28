/**
 * update-order-status — cambio de estado de un pedido desde el backoffice.
 *
 * Tampoco usa `service_role`: escribe con el JWT del usuario, así que la RLS
 * (`orders_update_orders_role`) y el trigger `ebim.assert_order_transition`
 * son los que mandan. Esta función solo adelanta el 409 cuando la transición
 * es imposible, para no gastar un viaje a la base.
 *
 * Los importes no se pueden tocar por aquí: el GRANT por columna de `orders`
 * solo permite `status`, `notes` y datos de contacto/envío.
 */
import { assertNoTenantInPayload, assertNotSuiteOperator, requireTenantContext } from '../_shared/auth.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { AppError, fromDatabaseError, notFound } from '../_shared/errors.ts'
import { serveJson } from '../_shared/http.ts'
import { canTransition, ORDER_STATUSES, type OrderStatus } from '../_shared/orders.ts'
import { optionalText, requireEnum, requireUuid, rejectUnknownFields } from '../_shared/validation.ts'
import { userClient } from '../_runtime/clients.ts'

const ALLOWED_FIELDS = ['order_id', 'status', 'notes'] as const

const handler = serveJson(
  {
    allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_ADMIN_ORIGINS')),
    service: 'update-order-status',
  },
  async ({ request, body, trace }) => {
    const { context } = requireTenantContext(request)
    assertNotSuiteOperator(context.email)
    assertNoTenantInPayload(body)
    rejectUnknownFields(body, ALLOWED_FIELDS)

    const orderId = requireUuid(body, 'order_id')
    const nextStatus = requireEnum(body, 'status', ORDER_STATUSES) as OrderStatus
    const notes = optionalText(body, 'notes', 1000)

    const client = userClient(request, trace)

    const { data: current, error: readError } = await client
      .from('orders')
      .select('id, order_number, status')
      .eq('id', orderId)
      .maybeSingle()

    if (readError) throw fromDatabaseError(readError)
    if (!current) throw notFound('PEDIDO_NO_ENCONTRADO', 'El pedido no existe para este tenant')

    const from = current.status as OrderStatus
    if (!canTransition(from, nextStatus)) {
      throw new AppError(
        'ORDER_TRANSICION_INVALIDA',
        `Un pedido en estado "${from}" no puede pasar a "${nextStatus}"`,
        409,
      )
    }

    const patch: Record<string, unknown> = { status: nextStatus }
    if (notes !== null) patch.notes = notes

    const { data, error } = await client
      .from('orders')
      .update(patch)
      .eq('id', orderId)
      .select('id, order_number, status, grand_total, currency, updated_at')
      .single()

    if (error) throw fromDatabaseError(error)

    return { status: 200, body: { data, previous_status: from } }
  },
)

Deno.serve(handler)
