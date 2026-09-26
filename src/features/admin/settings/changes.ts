import type { MessageKey } from '@/shared/i18n/messages'
import type { StoreFormValues } from './types'

/**
 * Resumen v2 · «Qué cambió» para la barra de guardar.
 *
 * La barra decía «Cambios sin guardar» y nada más: quien había tocado el tema,
 * el color y el teléfono en tres pestañas distintas no sabía qué iba a publicar
 * al pulsar Guardar. Aquí cada campo del formulario cae en su ZONA, con el
 * nombre que tiene en pantalla, y la barra las enumera sin repetir.
 */
const ZONA: Partial<Record<keyof StoreFormValues, MessageKey>> = {
  theme_preset: 'settings.changes.theme',
  home_layout: 'settings.changes.home',
  storefront_style: 'settings.changes.style',
  value_props: 'settings.changes.trust',
  accent_color: 'settings.changes.color',
  logo_url: 'settings.changes.images',
  favicon_url: 'settings.changes.images',
  banner_url: 'settings.changes.images',
  font_family: 'settings.changes.type',
  ui_radius: 'settings.changes.type',
  ui_density: 'settings.changes.type',
  name: 'settings.changes.texts',
  business_display_name: 'settings.changes.texts',
  hero_title: 'settings.changes.texts',
  hero_subtitle: 'settings.changes.texts',
  hero_kicker: 'settings.changes.texts',
  store_description: 'settings.changes.texts',
  support_email: 'settings.changes.contact',
  contact_phone: 'settings.changes.contact',
  contact_address: 'settings.changes.contact',
  announcement_messages: 'settings.changes.notices',
  brand_lockup: 'settings.changes.notices',
  show_theme_toggle: 'settings.changes.notices',
  checkout_requires_account: 'settings.changes.rules',
  require_payment_before_dispatch: 'settings.changes.rules',
  white_label: 'settings.changes.email',
  email_from_name: 'settings.changes.email',
  email_reply_to: 'settings.changes.email',
}

/** Las zonas tocadas, en el orden de la pantalla y sin repetir. */
export function zonasCambiadas(dirtyFields: Partial<Record<string, unknown>>): MessageKey[] {
  const vistas = new Set<MessageKey>()
  for (const campo of Object.keys(dirtyFields)) {
    if (!dirtyFields[campo]) continue
    vistas.add(ZONA[campo as keyof StoreFormValues] ?? 'settings.changes.other')
  }
  const orden = [...new Set(Object.values(ZONA)), 'settings.changes.other' as MessageKey]
  return orden.filter((zona) => vistas.has(zona))
}
