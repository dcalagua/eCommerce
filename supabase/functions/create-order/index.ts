/**
 * create-order — checkout del storefront (comprador anónimo).
 *
 * El cliente dice QUÉ tienda (por su slug público), QUÉ productos y CUÁNTAS
 * unidades, y con qué datos de contacto. Nada más. El precio, el impuesto y el
 * total salen de la base dentro de `public.create_order`, que además bloquea
 * las filas de producto (`for update`) y descuenta stock en la misma
 * transacción. Un carrito con precios editados en el navegador no cambia ni un
 * céntimo del pedido.
 *
 * El tenant se deriva de la TIENDA y la tienda la resuelve el SERVIDOR:
 * `create_order_for_slug` traduce el slug a una tienda activa. Ni
 * `organization_id`, ni `company_id`, ni `store_id` se aceptan del cuerpo.
 *
 * Usa `service_role` porque el comprador no tiene sesión: es el único modo de
 * insertar un pedido, y toda la autorización vive en la función de la base.
 */
import { assertNoTenantInPayload } from '../_shared/auth.ts'
import { parseAllowedOrigins } from '../_shared/cors.ts'
import { fromDatabaseError } from '../_shared/errors.ts'
import { serveJson } from '../_shared/http.ts'
import { normalizeOrderItems, normalizeShippingAddress } from '../_shared/orders.ts'
import {
  optionalText,
  rejectUnknownFields,
  requireEmail,
  requireSlug,
  requireText,
} from '../_shared/validation.ts'
import { serviceClient } from '../_runtime/clients.ts'

const ALLOWED_FIELDS = [
  'store_slug',
  'customer_email',
  'customer_name',
  'customer_phone',
  'items',
  'shipping_address',
  'notes',
] as const

const handler = serveJson(
  // Storefront público: cualquier origen. No viaja `Authorization`.
  {
    allowedOrigins: parseAllowedOrigins(Deno.env.get('EBIM_STOREFRONT_ORIGINS')),
    service: 'create-order',
  },
  async ({ body, trace }) => {
    assertNoTenantInPayload(body)
    // `store_id` ya no está en la lista: si llega, la petición se cae aquí.
    // La tienda se resuelve en la base a partir del slug de la URL pública.
    rejectUnknownFields(body, ALLOWED_FIELDS)

    const payload = {
      p_store_slug: requireSlug(body, 'store_slug'),
      p_customer_email: requireEmail(body, 'customer_email'),
      p_items: normalizeOrderItems(body.items),
      // Checkout mínimo: nombre, correo, teléfono y dirección son obligatorios.
      // La referencia (dentro de `shipping_address`) es lo único opcional.
      p_customer_name: requireText(body, 'customer_name', { min: 2, max: 200 }),
      p_customer_phone: requireText(body, 'customer_phone', { min: 6, max: 40 }),
      p_shipping_address: normalizeShippingAddress(body.shipping_address),
      p_notes: optionalText(body, 'notes', 1000),
    }

    const { data, error } = await serviceClient(trace).rpc('create_order_for_slug', payload)
    if (error) throw fromDatabaseError(error)

    return { status: 201, body: { data } }
  },
)

Deno.serve(handler)
