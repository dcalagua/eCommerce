/**
 * create-order — checkout del storefront (comprador anónimo).
 *
 * El cliente dice QUÉ producto y CUÁNTAS unidades. Nada más. El precio, el
 * impuesto y el total salen de la base dentro de `public.create_order`, que
 * además bloquea las filas de producto (`for update`) y descuenta stock en la
 * misma transacción. Un carrito con precios editados en el navegador no cambia
 * ni un céntimo del pedido.
 *
 * El tenant se deriva de la TIENDA (que es pública y se resuelve por slug),
 * nunca de un `organization_id` del cuerpo.
 *
 * Usa `service_role` porque el comprador no tiene sesión: es el único modo de
 * insertar un pedido, y toda la autorización vive en la función de la base.
 */
import { assertNoTenantInPayload } from '../_shared/auth.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { badRequest, fromDatabaseError } from '../_shared/errors.ts'
import { serveJson } from '../_shared/http.ts'
import { normalizeOrderItems } from '../_shared/orders.ts'
import { optionalText, requireEmail, requireUuid, rejectUnknownFields } from '../_shared/validation.ts'
import { serviceClient } from '../_runtime/clients.ts'

const ALLOWED_FIELDS = [
  'store_id',
  'customer_email',
  'customer_name',
  'customer_phone',
  'items',
  'shipping_address',
  'notes',
] as const

const handler = serveJson(
  // Storefront público: cualquier origen. No viaja `Authorization`.
  { allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_STOREFRONT_ORIGINS')) },
  async ({ body }) => {
    assertNoTenantInPayload(body)
    rejectUnknownFields(body, ALLOWED_FIELDS)

    const shippingAddress =
      body.shipping_address === undefined || body.shipping_address === null
        ? {}
        : body.shipping_address

    if (typeof shippingAddress !== 'object' || Array.isArray(shippingAddress)) {
      throw badRequest('CAMPO_INVALIDO', '`shipping_address` debe ser un objeto')
    }

    const payload = {
      p_store_id: requireUuid(body, 'store_id'),
      p_customer_email: requireEmail(body, 'customer_email'),
      p_items: normalizeOrderItems(body.items),
      p_customer_name: optionalText(body, 'customer_name', 200),
      p_customer_phone: optionalText(body, 'customer_phone', 40),
      p_shipping_address: shippingAddress,
      p_notes: optionalText(body, 'notes', 1000),
    }

    const { data, error } = await serviceClient().rpc('create_order', payload)
    if (error) throw fromDatabaseError(error)

    return { status: 201, body: { data } }
  },
)

Deno.serve(handler)
