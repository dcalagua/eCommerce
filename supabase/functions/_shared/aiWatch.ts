/**
 * «Ejecutar análisis» del centro de vigilancia.
 *
 * El panel YA sabe qué pasa: `public.watch_findings` cuenta pedidos sin cobrar,
 * existencia negativa o entregas vencidas con reglas de SQL. Lo que el modelo
 * aporta es lo único que SQL no sabe: **por dónde empezar** cuando hay ocho
 * avisos a la vez, y por qué.
 *
 * De ahí las tres reglas de este módulo:
 *
 *  1. **No inventa avisos.** El orden que devuelve tiene que ser una
 *     permutación EXACTA de las claves que se le dieron: ni una de más (un
 *     aviso inventado sería una alarma falsa) ni una de menos (uno omitido
 *     sería un problema escondido).
 *  2. **No escribe cifras.** Los números ya están en la tarjeta, calculados por
 *     la base. Un dígito escrito por el modelo es una cifra que nadie calculó,
 *     así que el candado rechaza la respuesta entera.
 *  3. **No decide.** Devuelve orden y una frase de porqué; silenciar, abrir y
 *     resolver los sigue haciendo la persona.
 */
import type { EsquemaIA } from './aiCore.ts'
import { datosJson, delimitarDatos } from './aiCore.ts'

export const MAX_HALLAZGOS = 20
export const MAX_PORQUE = 160

export interface HallazgoParaModelo {
  readonly key: string
  readonly module: string
  readonly severity: string
}

/** Lo que el front necesita para reordenar y explicar. */
export interface AnalisisRevisado {
  readonly order: string[]
  readonly reasons: Array<{ readonly key: string; readonly why: string }>
  readonly headline: string
}

export interface RespuestaModeloAnalisis {
  readonly order?: unknown
  readonly reasons?: unknown
  readonly headline?: unknown
}

export const ESQUEMA_ANALISIS: EsquemaIA = {
  type: 'object',
  properties: {
    headline: { type: 'string', minLength: 1, maxLength: 160 },
    order: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_HALLAZGOS,
      items: { type: 'string', maxLength: 60 },
    },
    reasons: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_HALLAZGOS,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', maxLength: 60 },
          why: { type: 'string', minLength: 1, maxLength: MAX_PORQUE },
        },
        required: ['key', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'order', 'reasons'],
  additionalProperties: false,
}

export const SISTEMA_ANALISIS = [
  'Eres el vigilante operativo de una tienda. Recibes AVISOS que el sistema ya detectó, con su severidad y su modulo.',
  'Tu trabajo es ORDENARLOS por urgencia real para hoy y decir en una frase por que cada uno va donde va.',
  'REGLA DE CLAVES: `order` tiene que contener EXACTAMENTE las claves recibidas, todas, sin repetir y sin inventar ninguna.',
  'REGLA DE CIFRAS: no escribas NINGUN digito. Las cifras ya estan en la pantalla; si necesitas referirte a ellas, hazlo con palabras.',
  'Criterio: primero lo que cuesta dinero o clientes hoy (cobro parado, existencia que no cuadra, entrega incumplida), despues lo que se puede arreglar esta semana.',
  'Cada `why`: una frase corta, concreta y sin promesas. Nada de "urge" ni "critico" a secas: di QUE consecuencia tiene esperar.',
  '`headline`: una linea con la idea general del dia, sin digitos.',
  'No propongas ejecutar nada ni prometas resultados: quien actua es la persona.',
].join('\n')

/** Lo único que ve el modelo: clave, módulo y severidad. Ninguna cifra. */
export function datosParaModelo(hallazgos: readonly HallazgoParaModelo[], locale: string): string {
  return [
    delimitarDatos(
      'avisos',
      datosJson(hallazgos.map((h) => ({ key: h.key, module: h.module, severity: h.severity }))),
    ),
    `IDIOMA: responde en ${locale === 'en' ? 'ingles' : 'espanol'}.`,
  ].join('\n\n')
}

const DIGITO = /[0-9٠-٩۰-۹０-９]/

export type Revision =
  | { readonly ok: true; readonly value: AnalisisRevisado }
  | { readonly ok: false; readonly motivo: 'vacia' | 'bloqueada' | 'esquema' }

/**
 * Candado de dominio: mismas claves, sin cifras y sin porqués huérfanos.
 *
 * Se rechaza la respuesta ENTERA en vez de arreglarla a medias. Un orden con
 * una clave inventada ya no describe lo que el sistema encontró, y quedarse con
 * la parte buena sería enseñar una lista que nadie puede explicar.
 */
export function revisarAnalisis(
  data: RespuestaModeloAnalisis,
  hallazgos: readonly HallazgoParaModelo[],
): Revision {
  const esperadas = hallazgos.map((h) => h.key)
  const order = Array.isArray(data.order) ? data.order.filter((k): k is string => typeof k === 'string') : []
  if (order.length !== esperadas.length) return { ok: false, motivo: 'esquema' }
  if (new Set(order).size !== order.length) return { ok: false, motivo: 'esquema' }
  if (!order.every((key) => esperadas.includes(key))) return { ok: false, motivo: 'bloqueada' }

  const headline = typeof data.headline === 'string' ? data.headline.trim() : ''
  if (!headline) return { ok: false, motivo: 'vacia' }
  if (DIGITO.test(headline)) return { ok: false, motivo: 'bloqueada' }

  const reasons: Array<{ key: string; why: string }> = []
  const vistas = new Set<string>()
  for (const fila of Array.isArray(data.reasons) ? data.reasons : []) {
    if (!fila || typeof fila !== 'object') return { ok: false, motivo: 'esquema' }
    const key = (fila as { key?: unknown }).key
    const why = (fila as { why?: unknown }).why
    if (typeof key !== 'string' || typeof why !== 'string') return { ok: false, motivo: 'esquema' }
    if (!esperadas.includes(key) || vistas.has(key)) return { ok: false, motivo: 'bloqueada' }
    const texto = why.trim()
    if (!texto || texto.length > MAX_PORQUE) return { ok: false, motivo: 'esquema' }
    if (DIGITO.test(texto)) return { ok: false, motivo: 'bloqueada' }
    vistas.add(key)
    reasons.push({ key, why: texto })
  }
  if (reasons.length === 0) return { ok: false, motivo: 'vacia' }

  return { ok: true, value: { order, reasons, headline } }
}
