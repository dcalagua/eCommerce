import type { StorePromotion } from './promotions'
import { discountPercent, type PublicProduct } from './types'

/**
 * Resumen v2 · Las cuentas de la «Feria de ofertas» (tema Retail), como
 * funciones puras: la portada y la banda relámpago las comparten y así se
 * prueban sin pintar nada.
 */

/** Horizonte de urgencia: más allá de esto un reloj no dice nada útil. */
export const HORIZONTE_RELOJ_MS = 7 * 86_400_000

/**
 * La campaña vigente que ANTES termina, dentro del horizonte.
 *
 * Es la que da la cuenta regresiva. Sin ninguna con fecha de fin próxima, no
 * hay reloj: una urgencia sin fecha real es una urgencia inventada.
 */
export function campanaQueTerminaAntes(
  promociones: readonly StorePromotion[],
  ahora: number = Date.now(),
): StorePromotion | null {
  let elegida: StorePromotion | null = null
  let fin = Infinity
  for (const promo of promociones) {
    if (!promo.endsAt) continue
    const t = new Date(promo.endsAt).getTime()
    if (Number.isNaN(t) || t <= ahora || t - ahora > HORIZONTE_RELOJ_MS) continue
    if (t < fin) {
      fin = t
      elegida = promo
    }
  }
  return elegida
}

/** El mayor descuento REAL: de los productos rebajados o de una campaña en porcentaje. */
export function mayorDescuento(
  productos: readonly PublicProduct[],
  promociones: readonly StorePromotion[] = [],
): number {
  let max = 0
  for (const p of productos) max = Math.max(max, discountPercent(p) ?? 0)
  for (const promo of promociones) {
    if (promo.kind === 'percentage') max = Math.max(max, Math.round(promo.percentOff ?? 0))
  }
  return max
}

/** Lo que queda hasta `endsAt`, partido para el reloj. `null` si ya pasó. */
export function partesRestantes(
  endsAt: string,
  ahora: number = Date.now(),
): { dias: number; horas: number; minutos: number; segundos: number } | null {
  const fin = new Date(endsAt).getTime()
  if (Number.isNaN(fin)) return null
  const resto = Math.floor((fin - ahora) / 1000)
  if (resto <= 0) return null
  return {
    dias: Math.floor(resto / 86_400),
    horas: Math.floor((resto % 86_400) / 3_600),
    minutos: Math.floor((resto % 3_600) / 60),
    segundos: resto % 60,
  }
}
