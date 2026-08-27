import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { I18nContext, LOCALE_STORAGE_KEY, translate, type I18nContextValue } from './i18n-context'
import { LOCALES, type Locale, type MessageKey } from './messages'

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw && (LOCALES as readonly string[]).includes(raw)) return raw as Locale
    return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'es'
  } catch {
    return 'es'
  }
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? readStoredLocale())

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch {
      /* almacenamiento no disponible */
    }
  }, [locale])

  const setLocale = useCallback((next: Locale) => setLocaleState(next), [])
  const t = useCallback((key: MessageKey) => translate(locale, key), [locale])

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
