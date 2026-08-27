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
