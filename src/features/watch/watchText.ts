import type { MessageKey } from '@/shared/i18n/messages'
import type { WatchFinding } from './api'

/**
 * Título y cuerpo del aviso en el idioma de la pantalla, con sus cifras.
 *
 * La base manda un `key` y unas métricas, nunca una frase: así el mismo aviso
 * se lee en español y en inglés, y las tarjetas del cajón y las filas del
 * Resumen dicen exactamente lo mismo.
 */
export function watchText(finding: WatchFinding, t: (key: MessageKey) => string): { title: string; body: string } {
  const title = t(`watch.finding.${finding.key}.title` as MessageKey)
  let body = t(`watch.finding.${finding.key}.body` as MessageKey)
  for (const [name, value] of Object.entries(finding.metrics)) {
    body = body.split(`{${name}}`).join(String(value))
  }
  return { title, body: body.split('{count}').join(String(finding.count)) }
}
