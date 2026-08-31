import { describe, expect, it } from 'vitest'
import {
  blockAcceptsItems,
  blockShapeIsComplete,
  isSafeHref,
  isSafeRichText,
  looksLikeMarkup,
  parseRichText,
  contentSettingsSchema,
  type RichTextDocument,
} from '@/domain/content'
import {
  parseExpansions,
  validateBlockForm,
  type BlockFormValues,
} from './types'
import { documentToTiptap, tiptapToDocument } from './tiptapDocument'

/**
 * P11-SaaS · La mitad de CLIENTE de las reglas del CMS.
 *
 * Lo que se prueba aquí no es la seguridad —esa vive en los CHECK de
 * `20260828140000_cms_core.sql` y se comprueba contra Postgres real en
 * `supabase/tests/cms-content.test.ts`— sino que el editor diga que no ANTES de
 * pulsar Guardar, con el foco en el campo. Las dos mitades tienen que dar la
 * misma respuesta: si discrepan, el usuario ve un 400 genérico en vez de un
 * mensaje útil, o —peor— cree que algo está permitido y no lo está.
 */

function form(overrides: Partial<BlockFormValues> = {}): BlockFormValues {
  return {
    block_type: 'hero',
    position: 0,
    title: 'Rebajas',
    subtitle: '',
    body: null,
    media_url: null,
    media_alt: '',
    cta_label: '',
    cta_href: '',
    category_id: null,
    promotion_id: null,
    item_limit: 8,
    is_active: true,
    publish_from: '2026-08-01T00:00',
    publish_to: '',
    channel_id: null,
    segment_id: null,
    columns: 4,
    ...overrides,
  }
}

describe('enlaces admisibles: lista blanca, no lista negra', () => {
  it.each([
    'https://ejemplo.test/promo',
    '/s/tienda/p/envios',
    'mailto:hola@ejemplo.test',
    'tel:+51999111222',
  ])('acepta %s', (href) => {
    expect(isSafeHref(href)).toBe(true)
  })

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['JavaScript con mayúsculas', 'JavaScript:alert(1)'],
    ['data', 'data:text/html,<b>x</b>'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['protocolo-relativo', '//otro-dominio.test/x'],
    ['http sin cifrar', 'http://ejemplo.test'],
    ['con espacios', 'https://ejemplo.test/a b'],
    ['esquema desconocido', 'ftp://ejemplo.test/x'],
  ])('rechaza %s', (_label, href) => {
    expect(isSafeHref(href)).toBe(false)
  })

  it('nulo es válido: un bloque puede no tener enlace', () => {
    expect(isSafeHref(null)).toBe(true)
    expect(isSafeHref(undefined)).toBe(true)
  })
})

describe('el documento enriquecido', () => {
  it('acepta los cuatro tipos de nodo del vocabulario', () => {
    expect(
      isSafeRichText([
        { type: 'heading', level: 2, text: 'Envíos' },
        { type: 'paragraph', text: 'Llegamos a todo el país.' },
        { type: 'list', items: ['Lima en 24 h'] },
        { type: 'quote', text: 'Sin coste desde 200.' },
      ]),
    ).toBe(true)
  })

  it.each([
    ['un tipo inventado', [{ type: 'iframe', text: 'x' }]],
    ['una clave desconocida', [{ type: 'paragraph', text: 'x', onclick: 'y()' }]],
    ['un titular de nivel 1', [{ type: 'heading', level: 1, text: 'x' }]],
    ['un enlace ejecutable', [{ type: 'paragraph', text: 'x', href: 'javascript:alert(1)' }]],
    ['una etiqueta dentro del texto', [{ type: 'paragraph', text: 'hola <b>mundo</b>' }]],
    ['una lista vacía', [{ type: 'list', items: [] }]],
    ['un documento vacío', []],
    ['algo que no es un array', { type: 'paragraph', text: 'x' }],
  ])('rechaza %s', (_label, doc) => {
    expect(isSafeRichText(doc)).toBe(false)
  })

  it('un documento inválido se lee como `null`, no a medias', () => {
    expect(parseRichText([{ type: 'paragraph', text: '<script>x</script>' }])).toBeNull()
    expect(parseRichText(null)).toBeNull()
    expect(parseRichText([{ type: 'paragraph', text: 'bien' }])).toHaveLength(1)
  })

  it('`looksLikeMarkup` no da falsos positivos con una comparación', () => {
    expect(looksLikeMarkup('el precio es < 100')).toBe(false)
    expect(looksLikeMarkup('3 < 4 y 5 > 2')).toBe(false)
    expect(looksLikeMarkup('<span>')).toBe(true)
    expect(looksLikeMarkup('</p>')).toBe(true)
    expect(looksLikeMarkup('<!doctype html>')).toBe(true)
  })
})

describe('el editor de texto: ida y vuelta sin perder nada', () => {
  it('traduce los cinco nodos del dominio y sus marcas', () => {
    const doc = [
      { type: 'heading', level: 2, text: 'Envíos' },
      { type: 'paragraph', text: 'Llegamos a todo el país.' },
      { type: 'list', items: ['Lima en 24 h', 'Provincia en 72 h'] },
      { type: 'list', items: ['Primero', 'Después'], ordered: true },
      { type: 'quote', text: 'Gratis desde 200' },
      { type: 'divider' },
      {
        type: 'paragraph',
        align: 'center',
        text: [
          { text: 'Envíos ' },
          { text: 'gratis', bold: true },
          { text: ' aquí', href: 'https://ejemplo.test' },
        ],
      },
    ] satisfies RichTextDocument

    // La vuelta completa: dominio → TipTap → dominio. Si alguna clave se
    // perdiera por el camino, el contenido publicado cambiaría al editarlo.
    expect(tiptapToDocument(documentToTiptap(doc))).toEqual(doc)
  })

  it('el texto sin ninguna marca se guarda como CADENA, no como un tramo', () => {
    // Envolver todo en tramos llenaría la base de `[{text: '…'}]` y haría
    // ilegible cualquier diff de contenido.
    const doc = tiptapToDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hola' }] }],
    })
    expect(doc).toEqual([{ type: 'paragraph', text: 'Hola' }])
  })

  it('un enlace de párrafo del formato antiguo se abre como tramo con enlace', () => {
    const doc = tiptapToDocument(
      documentToTiptap([
        { type: 'paragraph', text: 'Ver zonas', href: '/s/tienda/p/envios', linkLabel: 'aquí' },
      ]),
    )
    expect(doc).toEqual([
      {
        type: 'paragraph',
        text: [{ text: 'Ver zonas ' }, { text: 'aquí', href: '/s/tienda/p/envios' }],
      },
    ])
  })

  it('un documento sin nada que guardar es NULL, no un array vacío', () => {
    expect(tiptapToDocument({ type: 'doc', content: [{ type: 'paragraph' }] })).toBeNull()
  })

  it('una etiqueta escrita a mano NO se sanea: el documento entero se rechaza', () => {
    const doc = tiptapToDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hola <script>' }] }],
    })
    // El texto se conserva —no se borra el trabajo de nadie— pero no valida, y
    // es el mismo juez que el CHECK de la base.
    expect(doc).toEqual([{ type: 'paragraph', text: 'Hola <script>' }])
    expect(isSafeRichText(doc)).toBe(false)
  })
})

describe('forma del bloque: las reglas ENTRE campos', () => {
  it('un hero necesita título o imagen', () => {
    expect(blockShapeIsComplete({ type: 'hero', title: null, mediaUrl: null, body: null })).toBe(false)
    expect(blockShapeIsComplete({ type: 'hero', title: 'Hola', mediaUrl: null, body: null })).toBe(true)
    expect(blockShapeIsComplete({ type: 'hero', title: null, mediaUrl: 'x/y/z.png', body: null })).toBe(
      true,
    )
  })

  it('un bloque de texto necesita un documento válido', () => {
    expect(blockShapeIsComplete({ type: 'rich_text', title: 'T', mediaUrl: null, body: null })).toBe(false)
    expect(
      blockShapeIsComplete({
        type: 'rich_text',
        title: null,
        mediaUrl: null,
        body: [{ type: 'paragraph', text: 'Hola' }],
      }),
    ).toBe(true)
  })

  it('solo tres tipos aceptan una lista de items', () => {
    expect(blockAcceptsItems('product_collection')).toBe(true)
    expect(blockAcceptsItems('category_collection')).toBe(true)
    expect(blockAcceptsItems('carousel')).toBe(true)
    expect(blockAcceptsItems('hero')).toBe(false)
    expect(blockAcceptsItems('rich_text')).toBe(false)
  })

  it('un formulario correcto no tiene incidencias', () => {
    expect(validateBlockForm(form())).toEqual([])
  })

  it('un botón con texto y sin destino se marca en el destino', () => {
    const issues = validateBlockForm(form({ cta_label: 'Ver', cta_href: '' }))
    expect(issues).toContainEqual({ field: 'cta_href', key: 'content.error.ctaPair' })
  })

  it('un destino ejecutable se marca aunque el botón esté completo', () => {
    const issues = validateBlockForm(form({ cta_label: 'Ver', cta_href: 'javascript:alert(1)' }))
    expect(issues).toContainEqual({ field: 'cta_href', key: 'content.error.href' })
  })

  it('una campaña fuera de un bloque de campaña se marca', () => {
    const issues = validateBlockForm(
      form({ block_type: 'banner', promotion_id: '11111111-1111-4111-8111-111111111111' }),
    )
    expect(issues).toContainEqual({
      field: 'promotion_id',
      key: 'content.error.promotionOnlyCampaign',
    })
  })

  it('una vigencia invertida se marca en la fecha de fin', () => {
    const issues = validateBlockForm(
      form({ publish_from: '2026-09-01T00:00', publish_to: '2026-08-01T00:00' }),
    )
    expect(issues).toContainEqual({ field: 'publish_to', key: 'content.error.window' })
  })

  it('un hero sin nada que enseñar se marca en el título', () => {
    const issues = validateBlockForm(form({ title: '', media_url: null }))
    expect(issues).toContainEqual({ field: 'title', key: 'content.error.shape' })
  })
})

describe('`settings` tiene vocabulario cerrado', () => {
  it('acepta las claves declaradas con valores escalares', () => {
    expect(contentSettingsSchema.safeParse({ columns: 3, show_price: false }).success).toBe(true)
  })

  it.each([
    ['una clave desconocida', { script: 'https://malo.test/x.js' }],
    ['un objeto anidado', { layout: { deep: true } }],
    ['un texto demasiado largo', { layout: 'x'.repeat(61) }],
  ])('rechaza %s', (_label, settings) => {
    expect(contentSettingsSchema.safeParse(settings).success).toBe(false)
  })
})

describe('sinónimos', () => {
  it('separa por comas, quita duplicados y recorta a doce', () => {
    expect(parseExpansions('tenis, zapatilla , tenis')).toEqual(['tenis', 'zapatilla'])
    expect(parseExpansions(Array.from({ length: 20 }, (_, i) => `term${i}`).join(','))).toHaveLength(
      12,
    )
  })

  it('descarta lo demasiado corto: un término de una letra no es un sinónimo', () => {
    expect(parseExpansions('a, ok, b')).toEqual(['ok'])
  })
})
