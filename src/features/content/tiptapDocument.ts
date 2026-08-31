import type { JSONContent } from '@tiptap/react'
import type {
  RichTextAlign,
  RichTextDocument,
  RichTextNode,
  RichTextSpan,
  RichTextValue,
} from '@/domain/content'
import { RICH_TEXT_ALIGNMENTS } from '@/domain/content'

/**
 * El puente entre el editor de TipTap y el contenido de EBIM.
 *
 * ## Por qué hay un puente y no se guarda lo que TipTap devuelve
 *
 * TipTap edita sobre ProseMirror y su documento es un árbol con anidamiento
 * arbitrario y un catálogo abierto de marcas. El contenido de EBIM es otra
 * cosa: un array PLANO de cinco nodos, con marcas de vocabulario cerrado y con
 * los mismos topes escritos como CHECK en Postgres (`ebim.rich_text_is_safe`).
 * Guardar el árbol de TipTap tal cual sería cambiar el vocabulario del dominio
 * por el del paquete que hoy toca usar — y el día que se cambie de editor,
 * migrar datos publicados.
 *
 * Así que el editor es una CARA y lo que viaja es el documento del dominio.
 * Cambiar de editor mañana no toca ni la base ni el formulario: se reescribe
 * este archivo y ya.
 *
 * ## Lo que se traduce y lo que no
 *
 * Se traduce lo que el dominio sabe guardar: párrafo, titular (dos niveles),
 * lista de viñetas o numerada, cita, separador, alineación y las marcas
 * negrita, cursiva, subrayado, tachado y enlace. Lo demás —tablas, imágenes en
 * línea, código, colores— no está apagado *aquí* sino en la configuración del
 * editor: es la diferencia entre «no se puede hacer» y «se puede hacer y se
 * pierde al guardar», y lo segundo es la peor experiencia posible porque el
 * trabajo desaparece sin avisar.
 */

const MARK_BY_NAME = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
} as const

function alignOf(node: JSONContent): RichTextAlign | undefined {
  const value = node.attrs?.textAlign
  return typeof value === 'string' && (RICH_TEXT_ALIGNMENTS as readonly string[]).includes(value)
    ? (value as RichTextAlign)
    : undefined
}

/**
 * Los hijos de un bloque de TipTap → el valor de texto del dominio.
 *
 * Devuelve una CADENA cuando no hay ni una marca, y solo entonces una lista de
 * tramos. No es una optimización: es que el 90 % del contenido es texto liso, y
 * guardarlo como `[{text: '…'}]` llenaría la base de envoltorios y haría
 * ilegible cualquier diff de contenido.
 */
function valueOf(node: JSONContent): RichTextValue {
  const spans: RichTextSpan[] = []

  for (const child of node.content ?? []) {
    if (typeof child.text !== 'string' || child.text === '') continue

    const span: RichTextSpan = { text: child.text }
    for (const mark of child.marks ?? []) {
      const name = mark.type as keyof typeof MARK_BY_NAME | 'link'
      if (name === 'link') {
        const href = mark.attrs?.href
        if (typeof href === 'string' && href !== '') span.href = href
        continue
      }
      if (name in MARK_BY_NAME) span[MARK_BY_NAME[name]] = true
    }
    // Tramos contiguos con las MISMAS marcas se funden en uno.
    //
    // ProseMirror parte el texto en varios nodos por su cuenta —al deshacer, al
    // pegar, al quitar una marca— y sin esto el documento guardado acumularía
    // `[{text:'Env'},{text:'íos'}]` cada vez que alguien edita una frase: mismo
    // resultado en pantalla, diff ilegible y más cerca del tope de tamaño.
    const previous = spans[spans.length - 1]
    if (previous && sameMarks(previous, span)) previous.text += span.text
    else spans.push(span)
  }

  const plain = spans.every((span) => Object.keys(span).length === 1)
  return plain ? spans.map((span) => span.text).join('') : spans
}

/** ¿Dos tramos visten igual? Entonces son uno. */
function sameMarks(a: RichTextSpan, b: RichTextSpan): boolean {
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.strike) === Boolean(b.strike) &&
    (a.href ?? null) === (b.href ?? null)
  )
}

/** ¿Este valor tiene algo que guardar? Un nodo sin texto no es un nodo. */
function isEmpty(value: RichTextValue): boolean {
  return typeof value === 'string' ? value.trim() === '' : value.length === 0
}

/** Los nodos que admiten alineación. El separador y la lista no son de estos. */
type AlignableNode = Extract<RichTextNode, { align?: RichTextAlign }>

function withAlign<T extends AlignableNode>(node: T, align: RichTextAlign | undefined): T {
  // `left` es el defecto: guardarlo sería ruido en el documento y una clave más
  // que el CHECK tiene que ver pasar sin motivo.
  //
  // El `as T` es porque TypeScript no sabe que añadir una clave OPCIONAL del
  // propio tipo lo deja siendo el mismo tipo; la unión ya está acotada arriba.
  return align && align !== 'left' ? ({ ...node, align } as T) : node
}

/**
 * Documento de TipTap → documento de EBIM.
 *
 * Corre en cada tecla, así que no valida nada: solo traduce. Quien decide si el
 * resultado vale es `richTextSchema`, que es el mismo juez que la base.
 */
export function tiptapToDocument(doc: JSONContent): RichTextDocument | null {
  const nodes: RichTextNode[] = []

  for (const node of doc.content ?? []) {
    switch (node.type) {
      case 'heading': {
        const text = valueOf(node)
        if (isEmpty(text)) break
        nodes.push(
          withAlign(
            { type: 'heading', level: node.attrs?.level === 3 ? 3 : 2, text },
            alignOf(node),
          ),
        )
        break
      }

      case 'blockquote': {
        // Una cita puede llevar varios párrafos dentro; cada uno es una cita del
        // vocabulario plano, porque anidar no es una opción.
        for (const child of node.content ?? []) {
          const text = valueOf(child)
          if (!isEmpty(text)) nodes.push(withAlign({ type: 'quote', text }, alignOf(child)))
        }
        break
      }

      case 'bulletList':
      case 'orderedList': {
        const items: RichTextValue[] = []
        for (const item of node.content ?? []) {
          for (const child of item.content ?? []) {
            const text = valueOf(child)
            if (!isEmpty(text)) items.push(text)
          }
        }
        if (items.length > 0) {
          nodes.push(
            node.type === 'orderedList'
              ? { type: 'list', items, ordered: true }
              : { type: 'list', items },
          )
        }
        break
      }

      case 'horizontalRule':
        nodes.push({ type: 'divider' })
        break

      default: {
        const text = valueOf(node)
        // Un párrafo vacío es el `Enter` que todavía no tiene texto: se descarta
        // en vez de guardarse, porque el CHECK no admite nodos sin contenido.
        if (!isEmpty(text)) nodes.push(withAlign({ type: 'paragraph', text }, alignOf(node)))
      }
    }
  }

  return nodes.length > 0 ? nodes : null
}

/** Valor del dominio → hijos de un bloque de TipTap. */
function contentOf(value: RichTextValue): JSONContent[] {
  if (typeof value === 'string') {
    return value === '' ? [] : [{ type: 'text', text: value }]
  }

  return value.map((span) => {
    const marks: JSONContent['marks'] = []
    if (span.bold) marks.push({ type: 'bold' })
    if (span.italic) marks.push({ type: 'italic' })
    if (span.underline) marks.push({ type: 'underline' })
    if (span.strike) marks.push({ type: 'strike' })
    if (span.href) marks.push({ type: 'link', attrs: { href: span.href } })
    return marks.length > 0
      ? { type: 'text', text: span.text, marks }
      : { type: 'text', text: span.text }
  })
}

function attrs(align: RichTextAlign | undefined, extra?: Record<string, unknown>) {
  const value = { ...extra, ...(align ? { textAlign: align } : {}) }
  return Object.keys(value).length > 0 ? { attrs: value } : {}
}

/**
 * Documento de EBIM → documento de TipTap.
 *
 * Corre al abrir el editor, no en cada tecla. Un documento vacío se convierte
 * en un párrafo vacío porque el esquema de ProseMirror exige al menos un
 * bloque: sin eso, el editor no llega ni a montarse.
 */
export function documentToTiptap(doc: RichTextDocument | null): JSONContent {
  const content: JSONContent[] = (doc ?? []).map((node) => {
    switch (node.type) {
      case 'heading':
        return {
          type: 'heading',
          ...attrs(node.align, { level: node.level }),
          content: contentOf(node.text),
        }
      case 'quote':
        return {
          type: 'blockquote',
          content: [{ type: 'paragraph', ...attrs(node.align), content: contentOf(node.text) }],
        }
      case 'list':
        return {
          type: node.ordered ? 'orderedList' : 'bulletList',
          content: node.items.map((item) => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: contentOf(item) }],
          })),
        }
      case 'divider':
        return { type: 'horizontalRule' }
      default: {
        // El enlace de PÁRRAFO del formato antiguo se abre como un tramo con su
        // enlace al final de la frase: al editarlo se moderniza solo, y lo que
        // se ve es lo mismo que pinta la vitrina.
        const base = contentOf(node.text)
        const tail: JSONContent[] = node.href
          ? [
              { type: 'text', text: ' ' },
              {
                type: 'text',
                text: node.linkLabel ?? node.href,
                marks: [{ type: 'link', attrs: { href: node.href } }],
              },
            ]
          : []
        return { type: 'paragraph', ...attrs(node.align), content: [...base, ...tail] }
      }
    }
  })

  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
}
