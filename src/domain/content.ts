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
 * El `href` de un TRAMO no admite la cadena vacía.
 *
 * En un nodo, `href` ausente y `href` vacío son lo mismo —no hay enlace— y
 * `isSafeHref` los deja pasar a los dos. En un tramo no: el tramo existe para
 * ser un enlace, y uno con destino vacío es texto subrayado que no lleva a
 * ninguna parte.
 */
const spanHrefSchema = z
  .string()
  .min(1)
  .refine((value) => isSafeHref(value), { message: 'content.error.href' })

/**
 * Un TRAMO de texto: lo que permite negrita, cursiva y enlaces en línea sin
 * guardar una sola etiqueta.
 *
 * Las marcas son BOOLEANOS de un vocabulario cerrado, no marcado: `bold: true`
 * no se puede convertir en `<b onclick=…>` porque nunca es una cadena que
 * alguien interprete — el renderizador elige un componente de React y ya. Es la
 * misma decisión que gobierna el archivo entero, aplicada un nivel más abajo.
 *
 * El `href` de un tramo pasa por el mismo guard que el del nodo (`isSafeHref`),
 * porque el sumidero es idéntico: un `<a>` en el DOM del comprador.
 */
export const richTextSpanSchema = z
  .object({
    text: safeText(2000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    href: spanHrefSchema.optional(),
  })
  .strict()

export type RichTextSpan = z.infer<typeof richTextSpanSchema>

/**
 * El texto de un nodo: una CADENA o una lista de tramos.
 *
 * La cadena no es un atajo, es el formato que ya está guardado: los documentos
 * escritos antes de que existieran las marcas siguen siendo válidos y siguen
 * pintándose igual. Migrar filas para ganar una forma nueva habría sido cambiar
 * datos publicados por comodidad del código.
 */
export const richTextValueSchema = z.union([
  safeText(2000),
  z.array(richTextSpanSchema).min(1).max(50),
])
export type RichTextValue = z.infer<typeof richTextValueSchema>

/** Alineación del bloque. Tres valores: lo que se puede leer, no lo que se puede pedir. */
export const RICH_TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const
export type RichTextAlign = (typeof RICH_TEXT_ALIGNMENTS)[number]
const alignSchema = z.enum(RICH_TEXT_ALIGNMENTS)

/** El texto plano de un valor: lo que se cuenta, se busca o se resume. */
export function richTextPlainText(value: RichTextValue): string {
  return typeof value === 'string' ? value : value.map((span) => span.text).join('')
}

/**
 * Los cinco nodos, y por qué son cinco.
 *
 * Los cinco son `.strict()`: una clave que el vocabulario no declara —un
 * `onclick`, un `style`— NO se ignora al leer, invalida el nodo entero. Zod
 * descarta las claves de más por defecto, y ese defecto convertiría «esto no
 * está permitido» en «esto se pierde en silencio», que es justo la diferencia
 * entre rechazar y aceptar a medias. Es la misma regla que el CHECK de la base.
 *
 * `paragraph`, `heading`, `list`, `quote` y `divider` cubren lo que una página
 * de comercio necesita escribir. **No hay anidamiento**: un árbol admite
 * profundidad arbitraria y la profundidad arbitraria es, en la práctica, un
 * lenguaje — con su coste de validación, de renderizado y de auditoría. Por eso
 * tampoco hay tablas: una tabla es un árbol de filas y celdas, y en un móvil se
 * sale del ancho de la vitrina.
 *
 * El titular solo tiene dos niveles (`2` y `3`): el `h1` es el título de la
 * página, y dejar que un bloque escriba otro rompe el árbol de encabezados, que
 * es lo que un lector de pantalla usa para navegar (WCAG AA).
 */
export const richTextNodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('paragraph'),
      text: richTextValueSchema,
      align: alignSchema.optional(),
      // Enlace de PÁRRAFO: es anterior a los tramos y sigue vivo porque hay
      // contenido publicado que lo usa. Para un enlace dentro de la frase, lo
      // que corresponde hoy es un tramo con `href`.
      href: hrefSchema.optional(),
      linkLabel: safeText(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      text: richTextValueSchema,
      align: alignSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('quote'), text: richTextValueSchema, align: alignSchema.optional() })
    .strict(),
  z
    .object({
      type: z.literal('list'),
      items: z.array(richTextValueSchema).min(1).max(20),
      /** Numerada. Ausente es la de viñetas, que es la de siempre. */
      ordered: z.boolean().optional(),
    })
    .strict(),
  // Separador: no lleva texto ni ninguna otra clave. Es el único nodo que no
  // dice nada, y por eso el único que no puede llevar nada dentro.
  z.object({ type: z.literal('divider') }).strict(),
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
  /**
   * P18 · Carrusel de IMAGENES. Distinto de `carousel`, que desde P11 es un
   * carrusel de productos: un tipo que significa dos cosas segun lo que le
   * falte acaba enseñando lo que no es.
   */
  'slider',
] as const
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number]

/** Réplica del enum `public.content_page_kind`. */
export const CONTENT_PAGE_KINDS = ['home', 'landing', 'legal'] as const
export type ContentPageKind = (typeof CONTENT_PAGE_KINDS)[number]

/** Réplica del enum `public.content_status`. */
export const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/** Réplica del enum `public.content_item_kind`. */
export const CONTENT_ITEM_KINDS = ['product', 'variant', 'category', 'media'] as const
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
  /**
   * P18 · Una colección por categoría incluye las subcategorías.
   *
   * Apagada por defecto, igual que en las campañas: un bloque publicado no
   * puede cambiar de contenido porque alguien añada una subcategoría mañana.
   */
  'descendants',
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

/**
 * Qué campos usa cada tipo de bloque, y cuáles exige.
 *
 * ## Por qué existe
 *
 * El formulario enseñaba los DIECISÉIS campos para los ocho tipos, y la base
 * rechazaba después las combinaciones imposibles: `content_blocks_body_only_text`
 * solo admite contenido en texto, hero y banner, `content_blocks_promotion_only_campaign`
 * solo deja la campaña en el bloque de campaña, `content_blocks_category_only_collection`
 * solo la categoría en las colecciones. Escribir en un campo que el tipo elegido
 * no admite terminaba en un error de CHECK traducido a «faltan datos
 * obligatorios» — que además dice lo contrario de lo que pasaba: sobraban.
 *
 * Esta tabla es la ÚNICA fuente: de ella salen los campos que se pintan, el
 * asterisco de los obligatorios y las reglas que se comprueban antes de guardar.
 * Que el formulario y la base discrepen deja de ser posible por construcción, y
 * hay un test que la contrasta contra los CHECK de Postgres.
 *
 * `unused` no es «opcional pero raro»: es «la base lo rechaza o la vitrina no lo
 * pinta». Un campo así no se enseña, y al cambiar de tipo se vacía — si no,
 * pasar un hero con contenido a carrusel guardaría un cuerpo que nadie ve y que
 * el CHECK ni siquiera admite.
 */
export type BlockFieldUse = 'required' | 'optional' | 'unused'

export interface BlockFieldRules {
  readonly title: BlockFieldUse
  readonly subtitle: BlockFieldUse
  readonly body: BlockFieldUse
  readonly media: BlockFieldUse
  readonly cta: BlockFieldUse
  readonly promotion: BlockFieldUse
  readonly category: BlockFieldUse
  readonly columns: BlockFieldUse
  readonly itemLimit: BlockFieldUse
  /**
   * Hero y banner piden título O imagen, no los dos: un banner que es solo una
   * ilustración es legítimo, y uno que es solo un titular también. Como no es
   * una exigencia de un campo suelto, viaja aparte y el formulario la explica
   * en una línea en vez de poner un asterisco que mentiría en ambos.
   */
  readonly titleOrMedia: boolean
}

const COLECCION: BlockFieldRules = {
  title: 'optional',
  subtitle: 'optional',
  body: 'unused',
  media: 'unused',
  cta: 'optional',
  promotion: 'unused',
  category: 'optional',
  columns: 'optional',
  itemLimit: 'optional',
  titleOrMedia: false,
}

const CARTEL: BlockFieldRules = {
  title: 'optional',
  subtitle: 'optional',
  body: 'optional',
  media: 'optional',
  cta: 'optional',
  promotion: 'unused',
  category: 'unused',
  columns: 'unused',
  itemLimit: 'unused',
  titleOrMedia: true,
}

const RULES: Record<ContentBlockType, BlockFieldRules> = {
  hero: CARTEL,
  banner: CARTEL,
  rich_text: {
    ...CARTEL,
    body: 'required',
    media: 'unused',
    titleOrMedia: false,
  },
  campaign: {
    ...CARTEL,
    title: 'required',
    body: 'unused',
    promotion: 'optional',
    titleOrMedia: false,
  },
  product_collection: COLECCION,
  carousel: COLECCION,
  category_collection: COLECCION,
  /**
   * El carrusel de imágenes no tiene contenido propio: sus diapositivas SON el
   * bloque, y se cargan en su propio panel. El título solo se usa como nombre
   * accesible de la región, así que ni siquiera es obligatorio.
   */
  slider: {
    title: 'optional',
    subtitle: 'unused',
    body: 'unused',
    media: 'unused',
    cta: 'unused',
    promotion: 'unused',
    category: 'unused',
    columns: 'unused',
    itemLimit: 'optional',
    titleOrMedia: false,
  },
}

/**
 * Cómo se enseñan las imágenes de un bloque de imágenes.
 *
 * `carousel` pasa una a una; `grid` las pone todas a la vez en un mosaico. Es la
 * MISMA lista de diapositivas: cambia la disposición, no el contenido, así que
 * pasar de una a otra no obliga a volver a subir nada. Viaja en `settings.layout`,
 * que ya está en el vocabulario cerrado — no hace falta migración ni un tipo de
 * bloque nuevo, que habría duplicado la pantalla de carga de imágenes.
 */
export const MEDIA_LAYOUTS = ['carousel', 'grid'] as const
export type MediaLayout = (typeof MEDIA_LAYOUTS)[number]

export function mediaLayoutOf(settings: Record<string, unknown>): MediaLayout {
  return settings.layout === 'grid' ? 'grid' : 'carousel'
}

export function blockFieldRules(type: ContentBlockType): BlockFieldRules {
  return RULES[type]
}

/** Los tipos que muestran una lista de items. */
export function blockAcceptsItems(type: ContentBlockType): boolean {
  return (
    type === 'product_collection' ||
    type === 'category_collection' ||
    type === 'carousel' ||
    // El carrusel de imagenes NO tiene otra forma de contenido: sus items son
    // el bloque entero.
    type === 'slider'
  )
}

/** Los que llevan IMAGENES como items, en vez de filas del catalogo. */
export function blockUsesMediaItems(type: ContentBlockType): boolean {
  return type === 'slider'
}
