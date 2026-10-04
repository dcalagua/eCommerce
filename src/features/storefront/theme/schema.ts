import { z } from 'zod'
import {
  CATEGORY_VARIANTS,
  CONTENT_WIDTHS,
  HEADER_VARIANTS,
  HERO_VARIANTS,
  HOME_SECTION_IDS,
  IMAGE_RATIOS,
  PRODUCT_CARD_VARIANTS,
  PRODUCT_MEDIA_FITS,
  SECTION_SPACINGS,
  THEME_PRESET_IDS,
  type HomeLayout,
  type StorefrontStyle,
} from './types'
import { MAX_ITEMS_LIMITS } from './normalize'
import { SECTION_PRESENTATION_RULES, SECTION_SURFACES, SECTION_WIDTHS } from './presentation'

/**
 * El contrato del tema, escrito otra vez en Zod para el FORMULARIO.
 *
 * ## Por qué existe si ya está el normalizador
 *
 * Porque responden preguntas distintas. El normalizador dice «qué pinto con
 * esto», y su respuesta nunca es un error: lo raro cae a lo seguro para que una
 * fila mal escrita no cierre la tienda. Esto dice «¿lo que va a escribir esta
 * pantalla es válido?», y ahí sí conviene un no — un formulario que corrige en
 * silencio lo que el usuario acaba de elegir es peor que uno que lo rechaza.
 *
 * Y replica los CHECK de la migración `20260910220000` uno a uno, con la misma
 * convención que el resto del formulario: un mensaje en el campo es mejor que
 * un 400 después de pulsar Guardar, pero **la validación que manda sigue siendo
 * la de Postgres**.
 */

export const themePresetSchema = z.enum(THEME_PRESET_IDS)

/**
 * Lo que la tienda le pisa al tema: parcial y `strict`.
 *
 * `strict` es la mitad del contrato. Sin él, una clave que no está en la lista
 * —`css`, `backgroundUrl`, lo que sea— pasaría la validación del formulario y
 * moriría en el CHECK de la base con un error genérico.
 */
export const storefrontStyleOverridesSchema = z
  .object({
    headerVariant: z.enum(HEADER_VARIANTS).optional(),
    heroVariant: z.enum(HERO_VARIANTS).optional(),
    productCardVariant: z.enum(PRODUCT_CARD_VARIANTS).optional(),
    categoryVariant: z.enum(CATEGORY_VARIANTS).optional(),
    contentWidth: z.enum(CONTENT_WIDTHS).optional(),
    imageRatio: z.enum(IMAGE_RATIOS).optional(),
    sectionSpacing: z.enum(SECTION_SPACINGS).optional(),
    // Storefront V3 · P02.
    productMediaFit: z.enum(PRODUCT_MEDIA_FITS).optional(),
  })
  .strict()

/**
 * Cómo se enseña una sección (Storefront V3 · P06). Hasta el 2026-10-04 el
 * formulario no la conocía: el editor escribía `version: 2` con `presentation`
 * y el formulario lo rechazaba, así que personalizar una sección dejaba Ajustes
 * sin poder guardarse. Mismas reglas que `ebim.section_presentation_is_valid`:
 * variante y fondo de la lista de SU sección, ancho de dos.
 */
const sectionPresentationSchema = z
  .object({
    variant: z.string().min(1).max(40).optional(),
    surface: z.enum(SECTION_SURFACES).optional(),
    width: z.enum(SECTION_WIDTHS).optional(),
  })
  .strict()

export const homeSectionSchema = z
  .object({
    id: z.enum(HOME_SECTION_IDS),
    enabled: z.boolean(),
    maxItems: z.number().int().min(MAX_ITEMS_LIMITS.min).max(MAX_ITEMS_LIMITS.max).optional(),
    presentation: sectionPresentationSchema.optional(),
  })
  .strict()
  .refine((seccion) => {
    const reglas = SECTION_PRESENTATION_RULES[seccion.id]
    const { variant, surface } = seccion.presentation ?? {}
    if (variant !== undefined && variant !== 'auto' && !reglas.variants.includes(variant)) return false
    if (surface !== undefined && !reglas.surfaces.includes(surface)) return false
    return true
  })

export const homeLayoutSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  sections: z.array(homeSectionSchema),
})

/**
 * Los dos campos tal y como los declara el formulario.
 *
 * `z.custom` en vez del esquema directo por una razón de tipos y no de
 * validación: el contrato de P01 es de solo lectura (`readonly`) y lo que
 * infiere Zod no lo es. Así el formulario habla el mismo tipo que el resto del
 * Theme Engine, y la comprobación sigue siendo la de arriba.
 */
export const storefrontStyleField = z.custom<Partial<StorefrontStyle>>(
  (valor) => storefrontStyleOverridesSchema.safeParse(valor).success,
  { message: 'settings.error.invalid' },
)

export const homeLayoutField = z.custom<HomeLayout>(
  (valor) => homeLayoutSchema.safeParse(valor).success,
  { message: 'settings.error.invalid' },
)
