import { useQuery } from '@tanstack/react-query'
import type { PriceQuote, PriceRequest } from '@/domain'
import { serverPricing } from './serverPricing'

/**
 * Cotización del carrito contra el SERVIDOR.
 *
 * El carrito del navegador guarda un precio de escaparate para poder pintar la
 * línea mientras el comprador decide. Con listas de precio por canal, ese
 * número puede quedarse corto —o largo— antes de llegar a la caja: una escala
 * por volumen no se nota hasta que se suman las unidades, y un acuerdo de canal
 * puede haber cambiado desde que la tarjeta se pintó.
 *
 * Por eso el resumen del carrito pregunta. Lo que devuelve esta consulta es lo
 * MISMO que va a cobrar `create_order`, porque detrás hay una sola función; y
 * cuando la consulta falla, la pantalla se queda con el subtotal local y lo
 * dice, en vez de bloquear la compra por no poder adelantar un total.
 *
 * Va por el `PricingPort` y no por el módulo de datos directamente: es la
 * frontera que permite que mañana el precio lo dé el ERP del tenant sin que el
 * carrito se entere.
 *
 * `retry: false`: si la tienda no existe o una línea ya no está publicada,
 * reintentar cuatro veces solo retrasa el aviso.
 */
export const cartQuoteKey = (storeSlug: string, lines: readonly PriceRequest[]) =>
  ['pricing', 'cart-quote', storeSlug, lines] as const

export function useCartQuote(
  storeSlug: string | undefined,
  currency: string,
  lines: readonly PriceRequest[],
) {
  return useQuery<PriceQuote>({
    queryKey: cartQuoteKey(storeSlug ?? '', lines),
    queryFn: () => serverPricing.quote({ storeSlug: storeSlug as string, currency }, lines),
    enabled: Boolean(storeSlug) && lines.length > 0,
    retry: false,
    staleTime: 30_000,
  })
}
