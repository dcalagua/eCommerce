import { createContext, useContext } from 'react'
import { MESSAGES, type Locale, type MessageKey } from './messages'

export const LOCALE_STORAGE_KEY = 'ecommerce-locale'

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey) => string
}

export function translate(locale: Locale, key: MessageKey): string {
  return MESSAGES[locale][key] ?? MESSAGES.es[key] ?? key
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'es',
  setLocale: () => {},
  t: (key) => translate('es', key),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

/** Atajo para componentes que solo traducen. */
export function useT(): (key: MessageKey) => string {
  return useI18n().t
}
