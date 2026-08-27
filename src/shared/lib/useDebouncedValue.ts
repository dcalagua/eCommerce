import { useEffect, useState } from 'react'

/**
 * Retrasa un valor hasta que deja de cambiar.
 *
 * En el buscador de la vitrina no es cosmético: sin esto, "lámpara" son siete
 * consultas a PostgREST y siete renders de la rejilla mientras el comprador
 * todavía está escribiendo.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
