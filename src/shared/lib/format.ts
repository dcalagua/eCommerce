import type { Locale } from '@/shared/i18n/messages'

const LOCALE_TAG: Record<Locale, string> = { es: 'es-PE', en: 'en-US' }

/** Formatea importes con la moneda de la sociedad, no con una moneda cableada. */
export function formatMoney(amount: number, currency: string, locale: Locale = 'es'): string {
  try {
    return new Intl.NumberFormat(LOCALE_TAG[locale], {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

export function formatDate(value: string | Date, locale: Locale = 'es'): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { dateStyle: 'medium' }).format(date)
}

/** Fecha + hora para la bitácora: un cambio de estado se identifica por minuto. */
export function formatDateTime(value: string | Date, locale: Locale = 'es'): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

/**
 * Solo la hora. En un listado donde muchas filas comparten dia, repetir la
 * fecha completa gasta ancho sin distinguir nada: lo que separa un pedido de
 * otro es la hora.
 */
export function formatTime(value: string | Date, locale: Locale = 'es'): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { timeStyle: 'short' }).format(date)
}
