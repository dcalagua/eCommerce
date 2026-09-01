import { z } from 'zod'
import {
  CONTENT_BLOCK_TYPES,
  contentSettingsSchema,
  parseRichText,
  type ContentBlockType,
  type ContentSettings,
  type RichTextDocument,
} from '@/domain/content'
import { moneyText } from '@/shared/lib/money'
import { isSafeHref as isSafeHrefValue } from '@/domain/href'
import {
  STORE_NAVIGATION_PUBLIC_RPC,
  STORE_PAGE_PUBLIC_RPC,
} from '@/shared/lib/db-schema'
import { StorefrontError, storefrontClient } from './api'

/**
 * Contenido publicado de la vitrina (P11-SaaS).
 *
 * Todo lo de aquí llega YA RESUELTO por `public.store_page_for_slug`: la base
 * decide qué página gana (canal, vigencia, prioridad), qué bloques están
 * vigentes y qué productos tiene dentro cada colección. La vitrina no filtra
 * nada, y eso es la propiedad: un borrador no se descarta en el navegador
 * porque no llega al navegador.
 *
 * **Sin la capacidad `content.cms` la respuesta trae `cms: false`.** No es un
 * error: es un tenant que no tiene contratado el módulo, y la portada cae a lo
 * que pintaba antes de esta fase (hero de `store_settings` + catálogo). Se
 * degrada, no se rompe — igual que el motor de precios sin `pricing.lists`.
 */

export { STORE_PAGE_PUBLIC_RPC, STORE_NAVIGATION_PUBLIC_RPC }

/**
 * Un enlace que llega del servidor. La base ya lo validó con
 * `ebim.is_safe_href`; esto es la segunda comprobación, en el borde por el que
 * el valor entra al DOM. Dos comprobaciones para lo mismo no es duplicación
 * cuando la segunda es la que impide que un dato viejo —guardado antes de que
 * existiera el CHECK— acabe en un `href`.
 *
 * P16-SaaS: la condición dejó de estar escrita aquí. Estaba copiada palabra por
 * palabra en tres sitios, y las tres copias compartían el fallo de la barra
 * invertida (`/\evil.com` sale del dominio). Ahora las tres llaman a
 * `@/domain/href`, que es donde está el porqué.
 */
const safeHref = z.string().refine(isSafeHrefValue).nullable().catch(null)

const collectionItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('product'),
    product_id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    brand_name: z.string().nullable().default(null),
    price: moneyText.nullable().default(null),
    compare_at_price: moneyText.nullable().default(null),
    price_from: moneyText.nullable().default(null),
    currency: z.string().nullable().default(null),
    in_stock: z.boolean().nullable().default(false),
    image_path: z.string().nullable().default(null),
    image_alt: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('variant'),
    product_id: z.string().uuid(),
    variant_id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    variant_label: z.string().nullable().default(null),
    price: moneyText.nullable().default(null),
    compare_at_price: moneyText.nullable().default(null),
    currency: z.string().nullable().default(null),
    in_stock: z.boolean().nullable().default(false),
    image_path: z.string().nullable().default(null),
    image_alt: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('category'),
    category_id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
])
export type ContentCollectionItem = z.infer<typeof collectionItemSchema>

/**
 * La campana, tal y como la resuelve el servidor.
 *
 * Viaja la FORMA del descuento —cuanto y de que manera— y nunca el codigo del
 * cupon. Todo numerico llega como `number | null` porque una promocion de
 * porcentaje no tiene importe y una de 3x2 no tiene ninguno de los dos.
 */
const campaignSchema = z
  .object({
    id: z.string().uuid().nullable().default(null),
    live: z.boolean().nullable().default(false),
    ends_at: z.string().nullable().default(null),
    kind: z.string().nullable().default(null),
    percent_off: z.coerce.number().nullable().default(null),
    amount_off: z.coerce.number().nullable().default(null),
    buy_quantity: z.coerce.number().nullable().default(null),
    free_quantity: z.coerce.number().nullable().default(null),
    min_subtotal: z.coerce.number().nullable().default(null),
    needs_coupon: z.boolean().nullable().default(false),
  })
  .nullable()
  .default(null)

/**
 * Un bloque tal y como llega. `body` se re-valida contra el esquema del dominio
 * y se queda en `null` si no cumple: un documento que no pasa el contrato no se
 * pinta a medias.
 */
const rawBlockSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(CONTENT_BLOCK_TYPES),
  position: z.number().int(),
  title: z.string().nullable().default(null),
  subtitle: z.string().nullable().default(null),
  body: z.unknown().nullable().default(null),
  media_url: z.string().nullable().default(null),
  media_alt: z.string().nullable().default(null),
  cta_label: z.string().nullable().default(null),
  cta_href: safeHref,
  settings: z.unknown().default({}),
  is_active: z.boolean().default(true),
  category_id: z.string().uuid().nullable().default(null),
  campaign: campaignSchema,
  items: z.array(collectionItemSchema).default([]),
})

/** Que descuenta una campana, en el vocabulario de la vitrina. */
export interface CampaignOffer {
  /** Qué campaña es. La portada la usa para no anunciarla dos veces. */
  readonly id: string | null
  readonly kind: string | null
  readonly percentOff: number | null
  readonly amountOff: number | null
  readonly buyQuantity: number | null
  readonly freeQuantity: number | null
  readonly minSubtotal: number | null
  readonly needsCoupon: boolean
}

export interface ContentBlock {
  readonly id: string
  readonly type: ContentBlockType
  readonly position: number
  readonly title: string | null
  readonly subtitle: string | null
  readonly body: RichTextDocument | null
  readonly mediaUrl: string | null
  readonly mediaAlt: string | null
  readonly ctaLabel: string | null
  readonly ctaHref: string | null
  readonly settings: ContentSettings
  readonly campaignLive: boolean
  readonly campaignEndsAt: string | null
  readonly campaign: CampaignOffer | null
  readonly items: readonly ContentCollectionItem[]
}

const pageSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(['home', 'landing', 'legal']),
    status: z.enum(['draft', 'published', 'archived']),
    seo_title: z.string().nullable().default(null),
    seo_description: z.string().nullable().default(null),
    og_image_url: z.string().nullable().default(null),
  })
  .nullable()
  .default(null)

const contentResponseSchema = z.object({
  cms: z.boolean().default(false),
  store_id: z.string().uuid().nullable().default(null),
  page: pageSchema,
  blocks: z.array(rawBlockSchema).default([]),
  draft: z.boolean().nullable().default(false),
  preview: z.boolean().nullable().default(false),
})

export interface StoreContent {
  /** `false` = la sociedad no tiene `content.cms`. No es un error. */
  readonly cms: boolean
  readonly page: {
    readonly id: string
    readonly slug: string
    readonly title: string
    readonly kind: 'home' | 'landing' | 'legal'
    readonly seoTitle: string | null
    readonly seoDescription: string | null
    readonly ogImageUrl: string | null
  } | null
  readonly blocks: readonly ContentBlock[]
  readonly draft: boolean
  readonly preview: boolean
}

/** Rutas de `store-assets` que hay que firmar para pintarlas. */
export function contentAssetPaths(content: StoreContent): string[] {
  const values = [
    content.page?.ogImageUrl ?? null,
    ...content.blocks.map((block) => block.mediaUrl),
  ]
  return values.filter(
    (value): value is string => Boolean(value) && !/^https:\/\//i.test(value as string),
  )
}

/** Rutas del bucket de imágenes de producto que usan las colecciones. */
export function contentImagePaths(content: StoreContent): string[] {
  return content.blocks.flatMap((block) =>
    block.items
      .map((item) => ('image_path' in item ? item.image_path : null))
      .filter((path): path is string => Boolean(path)),
  )
}

export function toStoreContent(raw: unknown): StoreContent {
  const parsed = contentResponseSchema.parse(raw)
  return {
    cms: parsed.cms,
    page: parsed.page
      ? {
          id: parsed.page.id,
          slug: parsed.page.slug,
          title: parsed.page.title,
          kind: parsed.page.kind,
          seoTitle: parsed.page.seo_title,
          seoDescription: parsed.page.seo_description,
          ogImageUrl: parsed.page.og_image_url,
        }
      : null,
    draft: parsed.draft ?? false,
    preview: parsed.preview ?? false,
    blocks: parsed.blocks
      .filter((block) => block.is_active)
      .map((block) => ({
        id: block.id,
        type: block.type,
        position: block.position,
        title: block.title,
        subtitle: block.subtitle,
        body: parseRichText(block.body),
        mediaUrl: block.media_url,
        mediaAlt: block.media_alt,
        // Un botón sin destino no se pinta: el CHECK de la base ya empareja
        // etiqueta y enlace, pero un `href` que no pase `safeHref` llega aquí
        // como `null` y entonces la etiqueta sobra.
        ctaLabel: block.cta_href ? block.cta_label : null,
        ctaHref: block.cta_href,
        settings: contentSettingsSchema.safeParse(block.settings).data ?? {},
        campaignLive: block.campaign?.live ?? false,
        campaignEndsAt: block.campaign?.ends_at ?? null,
        campaign: block.campaign
          ? {
              id: block.campaign.id,
              kind: block.campaign.kind,
              percentOff: block.campaign.percent_off,
              amountOff: block.campaign.amount_off,
              buyQuantity: block.campaign.buy_quantity,
              freeQuantity: block.campaign.free_quantity,
              minSubtotal: block.campaign.min_subtotal,
              needsCoupon: block.campaign.needs_coupon ?? false,
            }
          : null,
        items: block.items,
      })),
  }
}

/**
 * Contenido de una página de la vitrina. `pageSlug` nulo = la portada.
 *
 * El canal NO se pasa desde el navegador: la función de la base resuelve el
 * canal público por defecto de la tienda. Un canal declarado por el cliente
 * sería una forma de pedir el contenido de un canal que exige sesión.
 */
export async function fetchStoreContent(input: {
  storeSlug: string
  pageSlug?: string | null
}): Promise<StoreContent> {
  const { data, error } = await storefrontClient().rpc(STORE_PAGE_PUBLIC_RPC, {
    p_store_slug: input.storeSlug,
    p_page_slug: input.pageSlug ?? null,
  })

  if (error) throw new StorefrontError(error)
  return toStoreContent(data)
}

const navigationSchema = z
  .array(z.object({ slug: z.string().min(1), title: z.string().min(1) }))
  .default([])

export type StoreNavigationItem = z.infer<typeof navigationSchema>[number]

/**
 * Páginas que el comercio marcó para el menú. Sin `content.cms` devuelve lista
 * vacía y el menú de la vitrina se queda como estaba.
 */
export async function fetchStoreNavigation(storeSlug: string): Promise<StoreNavigationItem[]> {
  const { data, error } = await storefrontClient().rpc(STORE_NAVIGATION_PUBLIC_RPC, {
    p_store_slug: storeSlug,
  })

  // Un menú que falla no puede tumbar la tienda: se queda vacío.
  if (error) return []
  return navigationSchema.parse(data ?? [])
}
