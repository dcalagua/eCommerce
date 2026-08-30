import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { I18nContext, LOCALE_STORAGE_KEY, type I18nContextValue } from './i18n-context'
import {
  es,
  loadDictionary,
  loadedDictionary,
  LOCALES,
  type Dictionary,
  type Locale,
  type MessageKey,
} from './messages'

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw && (LOCALES as readonly string[]).includes(raw)) return raw as Locale
    return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'es'
  } catch {
    return 'es'
  }
}

/**
 * Proveedor de idioma.
 *
 * Desde P15-SaaS el diccionario que NO es el de suite se pide con `import()`
 * (ver `messages.ts`). Eso obliga a guardar el diccionario en estado, y no solo
 * el código de idioma: cuando el módulo llega hay que repintar.
 *
 * Mientras llega se traduce en español. Es la degradación correcta —un texto en
 * el idioma equivocado se entiende; una clave cruda o una pantalla vacía, no— y
 * dura lo que tarda un chunk de ~30 kB gzip que además está en la caché del
 * navegador a partir de la segunda visita.
 */
export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? readStoredLocale())
  const [dict, setDict] = useState<Dictionary>(() => loadedDictionary(locale) ?? es)

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch {
      /* almacenamiento no disponible */
    }
  }, [locale])

  useEffect(() => {
    const cached = loadedDictionary(locale)
    if (cached) {
      setDict(cached)
      return
    }
    // Volver al idioma anterior mientras llega el nuevo daría un parpadeo de
    // ida y vuelta: se deja lo que ya está pintado y se sustituye al llegar.
    let alive = true
    void loadDictionary(locale).then((next) => {
      if (alive) setDict(next)
    })
    return () => {
      alive = false
    }
  }, [locale])

  const setLocale = useCallback((next: Locale) => setLocaleState(next), [])
  const t = useCallback((key: MessageKey) => dict[key] ?? es[key] ?? key, [dict])

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
