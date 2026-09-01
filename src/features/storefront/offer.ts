import { formatMoney } from '@/shared/lib/format'
import type { Locale, MessageKey } from '@/shared/i18n/messages'

/**
 * Cómo se cuenta un descuento en la vitrina.
 *
 * Vive aparte porque hay DOS sitios que lo cuentan —el bloque de campaña que
 * escribe el comercio y el carrusel que lee las promociones vigentes— y una
 * oferta no puede decir «-20 %» en un sitio y «20 % de descuento» en el otro.
 * La regla de qué se enseña y qué no (nunca el código del cupón) también es una
 * sola.
 */
export interface OfferShape {
  readonly kind: string | null
  readonly percentOff: number | null
  readonly amountOff: number | null
  readonly buyQuantity: number | null
  readonly freeQuantity: number | null
  readonly minSubtotal: number | null
}

/**
 * El importe de un cartel: «S/ 20», no «S/ 20.00».
 *
 * Los céntimos de un precio son obligatorios; los de un descuento redondo son
 * ruido, y encima alargan el medallón hasta comerse el título.
 */
export function moneyCorto(amount: number, currency: string, locale: Locale): string {
  if (!Number.isInteger(amount)) return formatMoney(amount, currency, locale)
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PE', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return formatMoney(amount, currency, locale)
  }
}

/**
 * Qué descuenta la campaña, en cuatro caracteres.
 *
 * Es el dato por el que alguien se para: «-20 %» se lee de lejos, «Semana
 * dermocosmética» no dice cuánto.
 */
export function offerBadge(
  offer: OfferShape | null,
  t: (key: MessageKey) => string,
  locale: Locale,
  currency?: string,
): string | null {
  if (!offer) return null
  switch (offer.kind) {
    case 'percentage':
      // Sin ceros de relleno: la base guarda 15.0000 y el cartel dice 15.
      return offer.percentOff ? `-${Number(offer.percentOff)} %` : null
    case 'fixed_amount':
      if (!offer.amountOff) return null
      return currency
        ? `-${moneyCorto(offer.amountOff, currency, locale)}`
        : t('store.content.offer.save')
    case 'x_for_y': {
      const buy = Number(offer.buyQuantity ?? 0)
      const free = Number(offer.freeQuantity ?? 0)
      // «3x2» solo significa algo si se paga menos de lo que se lleva.
      return buy > free && free > 0 ? `${buy}x${buy - free}` : null
    }
    case 'volume_tier':
      return t('store.content.offer.tiers')
    case 'bundle':
      return t('store.content.offer.bundle')
    default:
      return null
  }
}

/** Días que le quedan a la campaña, redondeados hacia arriba. */
export function daysLeft(endsAt: string, now: number = Date.now()): number {
  return Math.ceil((new Date(endsAt).getTime() - now) / 86_400_000)
}

/**
 * Una semana es donde «me lo pienso» pasa a «se me acaba».
 *
 * Antes de eso la cuenta atrás es ruido; a partir de ahí es la información que
 * decide la compra.
 */
export const URGENTE_DIAS = 7

/** Hasta cuándo, en UNA línea: la urgencia solo se nombra cuando existe. */
export function vigenciaTexto(
  endsAt: string | null,
  t: (key: MessageKey) => string,
  locale: Locale,
): { texto: string; urgente: boolean } | null {
  if (!endsAt) return null
  const restante = daysLeft(endsAt)
  if (restante < 0) return null

  if (restante <= URGENTE_DIAS) {
    return {
      urgente: true,
      texto:
        restante <= 1
          ? t('store.content.offer.lastDay')
          : t('store.content.offer.daysLeft').replace('{days}', String(restante)),
    }
  }

  const fecha = new Date(endsAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-PE', {
    day: 'numeric',
    month: 'long',
  })
  return { urgente: false, texto: `${t('store.content.campaignEnds')} ${fecha}` }
}
