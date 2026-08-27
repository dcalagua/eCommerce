import { z } from 'zod'

/**
 * Personalización de la tienda (`/app/settings`).
 *
 * Los nombres de campo son los del contrato §4.3 (`accent_color`, `logo_url`,
 * `white_label`) y los que P02/P05 dejaron en `store_settings`. No se inventa
 * un `description` nuevo: **`hero_subtitle` ES la descripción publicable de la
 * tienda** —es el texto que la vitrina pinta bajo el nombre— y un segundo campo
 * de descripción sería una segunda fuente de verdad que se desincroniza
 * (precedente P05 #44).
 */

export const STORE_SETTINGS_TABLE = 'store_settings'
export const STORES_TABLE = 'stores'

/** Bucket PRIVADO de branding (`20260827090600_storage_buckets.sql`). */
export const STORE_ASSETS_BUCKET = 'store-assets'

/** 2 MB. Un logo o un banner por encima de esto es una imagen sin optimizar. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024

/**
 * Tipos aceptados y su extensión canónica.
 *
 * **Sin SVG a propósito**: un SVG es un documento que puede llevar `<script>`,
 * y aquí lo sube el tenant y lo sirve el dominio de la vitrina. La extensión
 * sale del MIME, no del nombre del archivo (mismo criterio que P04 #33).
 */
export const ALLOWED_ASSET_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export type AssetKind = 'logo' | 'banner'

export const storeSettingsSchema = z.object({
  store_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  accent_color: z.string(),
  logo_url: z.string().nullable().default(null),
  banner_url: z.string().nullable().default(null),
  white_label: z.boolean().nullable().default(false),
  default_locale: z.string().nullable().default(null),
  support_email: z.string().nullable().default(null),
  hero_title: z.string().nullable().default(null),
  hero_subtitle: z.string().nullable().default(null),
  contact_phone: z.string().nullable().default(null),
  contact_address: z.string().nullable().default(null),
})
export type StoreSettings = z.infer<typeof storeSettingsSchema>

const optionalText = (max: number, error: string) =>
  z
    .string()
    .trim()
    .max(max, error)
    .transform((value) => value || '')

/**
 * Formulario. Los límites replican los CHECK de la base uno a uno: un mensaje
 * en el campo es mejor que un 400 genérico después de pulsar Guardar, pero la
 * validación que manda sigue siendo la de Postgres.
 */
export const storeFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'settings.error.name')
    .max(200, 'settings.error.name'),
  hero_subtitle: optionalText(240, 'settings.error.description'),
  accent_color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'settings.error.color'),
  support_email: z
    .string()
    .trim()
    .max(320, 'settings.error.email')
    .refine((value) => value === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), 'settings.error.email'),
  contact_phone: z
    .string()
    .trim()
    .refine((value) => value === '' || (value.length >= 4 && value.length <= 40), 'settings.error.phone'),
  contact_address: z
    .string()
    .trim()
    .refine((value) => value === '' || (value.length >= 3 && value.length <= 240), 'settings.error.address'),
  logo_url: z.string().nullable(),
  banner_url: z.string().nullable(),
})
export type StoreFormValues = z.infer<typeof storeFormSchema>

/** Fila + nombre de la tienda → valores del formulario. */
export function toForm(name: string, settings: StoreSettings | null): StoreFormValues {
  return {
    name,
    hero_subtitle: settings?.hero_subtitle ?? '',
    accent_color: settings?.accent_color ?? '#5AA97F',
    support_email: settings?.support_email ?? '',
    contact_phone: settings?.contact_phone ?? '',
    contact_address: settings?.contact_address ?? '',
    logo_url: settings?.logo_url ?? null,
    banner_url: settings?.banner_url ?? null,
  }
}

/** Un texto vacío se guarda como NULL: los CHECK de longitud no admiten `''`. */
export function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * ¿La referencia de un asset es una URL externa o una ruta del bucket privado?
 *
 * Es la mitad de cliente de `ebim.is_store_asset_ref` (migración 15): la base
 * la vuelve a comprobar con un CHECK contra las columnas de tenant de la propia
 * fila, así que esto solo decide si hay que firmar la ruta para verla.
 */
export function isExternalAsset(value: string): boolean {
  return /^https:\/\//i.test(value)
}

export type AssetValidation = { ok: true } | { ok: false; key: 'settings.error.assetType' | 'settings.error.assetSize' }

export function validateAssetFile(file: { type: string; size: number }): AssetValidation {
  if (!ALLOWED_ASSET_TYPES[file.type]) return { ok: false, key: 'settings.error.assetType' }
  if (file.size <= 0 || file.size > MAX_ASSET_BYTES) return { ok: false, key: 'settings.error.assetSize' }
  return { ok: true }
}

/**
 * Ruta del objeto: `{organization_id}/{store_id}/branding/{kind}-{uuid}.{ext}`.
 *
 * Los dos primeros segmentos son los que lee `ebim.can_write_store_object` para
 * autorizar la subida y los que exige el CHECK `store_settings_logo_ref`: una
 * ruta del tenant de al lado no llega ni a subirse ni a guardarse.
 */
export function buildAssetPath(input: {
  organizationId: string
  storeId: string
  kind: AssetKind
  mimeType: string
}): string {
  const extension = ALLOWED_ASSET_TYPES[input.mimeType]
  if (!extension) throw new Error('MIME_NO_ADMITIDO')
  return `${input.organizationId}/${input.storeId}/branding/${input.kind}-${crypto.randomUUID()}.${extension}`
}
