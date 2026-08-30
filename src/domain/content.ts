import { z } from 'zod'
import { isSafeHref as isSafeHrefValue } from './href'

/**
 * Contenido administrable: el vocabulario y, sobre todo, QUÉ ES CONTENIDO
 * SEGURO (P11-SaaS).
 *
 * ## La decisión que gobierna este archivo: el contenido enriquecido no es HTML
 *
 * El encargo pide «rich content sanitizado» y «no permitas JavaScript arbitrario
 * del tenant». Hay dos formas de cumplirlo y solo una envejece bien:
 *
 *  - **Guardar HTML y sanearlo.** La seguridad pasa a ser una lista de etiquetas
 *    y atributos que hay que mantener al día contra cada mXSS nuevo, y basta una
 *    ruta de renderizado que se salte el saneador —un correo, un export, un
 *    `dangerouslySetInnerHTML` puesto con prisa— para que el agujero vuelva.
 *  - **No guardar HTML.** El documento es un array plano de cuatro tipos de nodo
 *    y el renderizador mapea nodo → componente de React. No hay cadena que
 *    escapar mal porque no hay cadena que interpretar.
 *
 * Este proyecto elige la segunda. La consecuencia es que un editor de texto rico
 * completo (tablas, imágenes en línea, colores) no cabe; la contrapartida es que
 * «¿puede el tenant ejecutar código?» tiene una respuesta demostrable en vez de
 * una lista de mitigaciones. Un test de arquitectura comprueba que
 * `dangerouslySetInnerHTML` no aparece en ningún archivo de `src/`.
 *
 * ## Esto es la MITAD de cliente de una regla que manda en Postgres
 *
 * Las mismas reglas están escritas como CHECK en `20260828140000_cms_core.sql`
 * (`ebim.rich_text_is_safe`, `ebim.is_safe_href`). Lo de aquí existe para que el
 * editor diga «este enlace no vale» antes de pulsar Guardar, no para decidir: si
 * las dos discrepan, la que manda es la base. Un test compara las dos mitades
 * contra Postgres real.
 */

// ---------------------------------------------------------------------------
// Enlaces
// ---------------------------------------------------------------------------

/**
 * Esquemas admitidos: lista BLANCA, no lista negra.
 *
 * `javascript:` es el que todo el mundo recuerda, pero `data:text/html`,
 * `vbscript:` y el protocolo-relativo `//otro-dominio` hacen daño igual. Con
 * lista blanca, el esquema que nadie ha pensado todavía cae en el lado de «no».
 *
 * **P16-SaaS: la regla vive en un solo sitio.** Hasta esta fase había tres
 * copias de la misma condición —esta, la del borde del storefront y el CHECK de
 * Postgres— y las tres compartían el mismo fallo: aceptaban `/\evil.com` como
 * ruta interna cuando el navegador la resuelve a OTRO DOMINIO. Se corrigió en
 * las tres, y las tres de cliente pasan ahora por `@/domain/href` para
 * que no vuelvan a separarse. La semántica de `null` se conserva aquí: un
 * enlace ausente es válido, igual que en el CHECK.
 */
export function isSafeHref(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true
  return isSafeHrefValue(value)
}

/**
 * Nada que se parezca a una etiqueta, ni siquiera como texto plano.
 *
 * El renderizador no interpreta HTML, así que un `<script>` guardado como texto
 * no ejecuta nada aquí. Se rechaza igual porque ese texto acaba en sitios que sí
 * interpretan: un correo, un CSV exportado, el `<title>` de una página.
 */
export function looksLikeMarkup(value: string): boolean {
  return /<[a-zA-Z/!]/.test(value)
}

// ---------------------------------------------------------------------------
// El documento
// ---------------------------------------------------------------------------

const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !looksLikeMarkup(value), { message: 'content.error.markup' })

const hrefSchema = z
  .string()
  .refine((value) => isSafeHref(value), { message: 'content.error.href' })

/**
 * Los cuatro nodos, y por qué son cuatro.
 *
 * Los cuatro son `.strict()`: una clave que el vocabulario no declara —un
 * `onclick`, un `style`— NO se ignora al leer, invalida el nodo entero. Zod
 * descarta las claves de más por defecto, y ese defecto convertiría «esto no
 * está permitido» en «esto se pierde en silencio», que es justo la diferencia
 * entre rechazar y aceptar a medias. Es la misma regla que el CHECK de la base.
 *
 * `paragraph`, `heading`, `list` y `quote` cubren lo que una página de comercio
 * necesita escribir. No hay anidamiento: un árbol admite profundidad arbitraria
 * y la profundidad arbitraria es, en la práctica, un lenguaje — con su coste de
 * validación, de renderizado y de auditoría.
 *
 * El titular solo tiene dos niveles (`2` y `3`): el `h1` es el título de la
 * página, y dejar que un bloque escriba otro rompe el árbol de encabezados, que
 * es lo que un lector de pantalla usa para navegar (WCAG AA).
 */
export const richTextNodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('paragraph'),
      text: safeText(2000),
      href: hrefSchema.optional(),
      linkLabel: safeText(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      text: safeText(2000),
    })
    .strict(),
  z.object({ type: z.literal('quote'), text: safeText(2000) }).strict(),
  z
    .object({
      type: z.literal('list'),
      items: z.array(safeText(300)).min(1).max(20),
    })
    .strict(),
])

export type RichTextNode = z.infer<typeof richTextNodeSchema>

/** Un documento: array plano, con los mismos topes que el CHECK de la base. */
export const richTextSchema = z
  .array(richTextNodeSchema)
  .min(1)
  .max(60)
  .refine((doc) => JSON.stringify(doc).length <= 24000, { message: 'content.error.tooLong' })

export type RichTextDocument = z.infer<typeof richTextSchema>

/** ¿Este documento lo aceptaría la base? Misma respuesta, antes de guardar. */
export function isSafeRichText(value: unknown): value is RichTextDocument {
  return richTextSchema.safeParse(value).success
}

/**
 * Lee un documento que viene de la base. Devuelve `null` si no valida.
 *
 * `null` y no «lo que se pueda salvar»: un documento que no cumple el contrato
 * no se pinta a medias. Si la base lo guardó, es que pasó el CHECK, así que
 * llegar aquí con algo inválido significa que las dos mitades se han separado —
 * y pintar la mitad buena escondería justo eso.
 */
export function parseRichText(value: unknown): RichTextDocument | null {
  if (value === null || value === undefined) return null
  const parsed = richTextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

/** Los siete tipos de bloque. Réplica del enum `public.content_block_type`. */
export const CONTENT_BLOCK_TYPES = [
  'hero',
  'banner',
  'carousel',
  'product_collection',
  'category_collection',
  'rich_text',
  'campaign',
] as const
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number]

/** Réplica del enum `public.content_page_kind`. */
export const CONTENT_PAGE_KINDS = ['home', 'landing', 'legal'] as const
export type ContentPageKind = (typeof CONTENT_PAGE_KINDS)[number]

/** Réplica del enum `public.content_status`. */
export const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/** Réplica del enum `public.content_item_kind`. */
export const CONTENT_ITEM_KINDS = ['product', 'variant', 'category'] as const
export type ContentItemKind = (typeof CONTENT_ITEM_KINDS)[number]

/**
 * Mandos de presentación admitidos, con vocabulario CERRADO.
 *
 * Réplica de `ebim.content_settings_are_safe`. Existe para que «dos columnas o
 * tres» no sea un tipo de bloque nuevo. En el momento en que admitiera objetos
 * anidados o claves libres, sería el sitio donde alguien mete una URL de script
 * «porque es solo configuración».
 */
export const CONTENT_SETTING_KEYS = [
  'layout',
  'columns',
  'autoplay',
  'interval_ms',
  'align',
  'tone',
  'show_price',
  'show_cta',
  'aspect',
  'background',
  'compact',
  'reverse',
] as const
export type ContentSettingKey = (typeof CONTENT_SETTING_KEYS)[number]

export const contentSettingsSchema = z
  .record(z.union([z.string().max(60), z.number(), z.boolean()]))
  .refine(
    (value) =>
      Object.keys(value).length <= 12 &&
      Object.keys(value).every((key) =>
        (CONTENT_SETTING_KEYS as readonly string[]).includes(key),
      ),
    { message: 'content.error.settings' },
  )

export type ContentSettings = z.infer<typeof contentSettingsSchema>

/**
 * ¿Qué tiene que traer cada tipo de bloque para valer algo?
 *
 * Réplica del CHECK `content_blocks_shape`. Sin esto, la vitrina tendría que
 * decidir en tiempo de pintado si un bloque se enseña o no — y esa es la clase
 * de decisión que acaba dando dos respuestas distintas en dos sitios.
 */
export function blockShapeIsComplete(input: {
  type: ContentBlockType
  title: string | null
  mediaUrl: string | null
  body: unknown
}): boolean {
  switch (input.type) {
    case 'hero':
    case 'banner':
      return Boolean(input.title) || Boolean(input.mediaUrl)
    case 'rich_text':
      return isSafeRichText(input.body)
    case 'campaign':
      return Boolean(input.title)
    default:
      return true
  }
}

/** Los tipos que muestran una lista de items. */
export function blockAcceptsItems(type: ContentBlockType): boolean {
  return type === 'product_collection' || type === 'category_collection' || type === 'carousel'
}
