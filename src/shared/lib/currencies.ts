/**
 * Catálogo de monedas — datos, no código.
 *
 * Antes esto era `const CURRENCIES = ['PEN', 'USD', ...]` dentro de un
 * componente de React, así que dar de alta una tienda boliviana exigía un
 * despliegue. Ahora sale de `public.currencies`, que es un catálogo GLOBAL de
 * solo lectura (ISO 4217): no lleva tenant, y `anon` y `authenticated` solo
 * tienen SELECT sobre él.
 *
 * `minorUnit` no es decorativo: CLP y JPY no tienen decimales. Formatear todo a
 * dos posiciones es un error de dinero, no de presentación.
 */
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { CURRENCIES_TABLE } from './db-schema'
import { tryGetSupabaseClient } from './supabase'

export { CURRENCIES_TABLE }

export const currencySchema = z.object({
  code: z.string().length(3),
  name: z.string(),
  symbol: z.string(),
  minor_unit: z.number().int().min(0).max(4),
})

export type Currency = z.infer<typeof currencySchema>

/**
 * Fallback mínimo para cuando aún no hay backend configurado (P01: la app
 * arranca sin Supabase y las pantallas muestran estado vacío). No es la lista
 * buena: es lo justo para que el formulario no quede sin opciones.
 */
export const FALLBACK_CURRENCIES: Currency[] = [
  { code: 'BOB', name: 'Boliviano', symbol: 'Bs', minor_unit: 2 },
  { code: 'PEN', name: 'Sol', symbol: 'S/', minor_unit: 2 },
  { code: 'USD', name: 'Dolar americano', symbol: '$', minor_unit: 2 },
]

export async function fetchCurrencies(): Promise<Currency[]> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) return FALLBACK_CURRENCIES

  const { data, error } = await supabase
    .from(CURRENCIES_TABLE)
    .select('code, name, symbol, minor_unit')
    .order('code')

  if (error) throw error
  const parsed = currencySchema.array().parse(data ?? [])
  return parsed.length > 0 ? parsed : FALLBACK_CURRENCIES
}

export const currenciesKey = ['currencies'] as const

export function useCurrencies() {
  return useQuery<Currency[]>({
    queryKey: currenciesKey,
    queryFn: fetchCurrencies,
    // ISO 4217 no cambia en una sesión: no tiene sentido revalidarlo.
    staleTime: Infinity,
    placeholderData: FALLBACK_CURRENCIES,
  })
}
