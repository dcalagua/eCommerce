import { Box, Divider, Link as MuiLink, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import type {
  RichTextAlign,
  RichTextDocument,
  RichTextNode,
  RichTextValue,
} from '@/domain/content'
import { isInternalPath, isSafeHref } from '@/domain/href'
import { T } from '@/theme/tokens'

/**
 * Pinta un documento enriquecido del tenant.
 *
 * **Aquí no hay `dangerouslySetInnerHTML`, y esa es toda la seguridad de este
 * componente.** El documento no es HTML (ver `src/domain/content.ts`): es un
 * array de cinco tipos de nodo, y este archivo es la tabla que lleva cada tipo
 * a un componente de MUI. No existe la cadena que se escapa mal porque no hay
 * cadena que interpretar — un `<script>` guardado como texto se pinta como el
 * texto `<script>`, que es exactamente lo que es.
 *
 * Lo mismo vale para las marcas: `bold: true` es un booleano que elige un
 * `<strong>`, no una etiqueta que alguien escribió. Un formato del tenant nunca
 * llega al DOM como texto.
 *
 * Un test de arquitectura comprueba que `dangerouslySetInnerHTML` no aparece en
 * ningún archivo de producción de `src/`. Si alguien lo añade «solo para este
 * caso», la suite se pone roja.
 *
 * El `href` se vuelve a comprobar en `content.ts` antes de llegar aquí, y la
 * base ya lo validó con un CHECK. Tres capas para lo mismo no es exceso: cada
 * enlace se comprueba TAMBIÉN aquí, que es el punto donde un valor del tenant
 * entra al DOM — y en P16-SaaS se demostró que hacía falta: las tres capas
 * compartían el mismo fallo de la barra invertida y la tercera es la única que
 * está en el sumidero real.
 */
export function RichText({ doc }: { doc: RichTextDocument | null }) {
  if (!doc || doc.length === 0) return null

  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      {doc.map((node, index) => (
        <RichTextNodeView key={index} node={node} />
      ))}
    </Box>
  )
}

/** Enlace del tenant, con las dos protecciones que no son negociables. */
function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <MuiLink
      href={href}
      // Un enlace del tenant sale a un sitio que el comercio eligió.
      // `noopener noreferrer` no es cosmética: sin él, la página de destino
      // puede manipular la pestaña que la abrió.
      rel="noopener noreferrer"
      // `isInternalPath` y no `startsWith('/')`: `/\evil.com` empieza por `/` y
      // el navegador la resuelve a otro dominio (P16-SaaS).
      target={isInternalPath(href) ? undefined : '_blank'}
      sx={{ color: 'var(--accent-deep)', fontWeight: 700 }}
    >
      {children}
    </MuiLink>
  )
}

/**
 * El texto de un nodo: una cadena o una lista de tramos con marcas.
 *
 * Cada marca elige un elemento con SIGNIFICADO, no un estilo: `<strong>` y
 * `<em>` los anuncia el lector de pantalla, un `<span>` con `font-weight` no.
 * El subrayado sí es `<u>` a secas —no significa nada más que subrayado— y por
 * eso conviene poco: en una página, subrayado es enlace.
 */
function RichTextValueView({ value }: { value: RichTextValue }) {
  if (typeof value === 'string') return <>{value}</>

  return (
    <>
      {value.map((span, index) => {
        let content: ReactNode = span.text
        if (span.bold) content = <strong>{content}</strong>
        if (span.italic) content = <em>{content}</em>
        if (span.underline) content = <u>{content}</u>
        if (span.strike) content = <s>{content}</s>
        if (isSafeHref(span.href) && span.href) {
          content = <SafeLink href={span.href}>{content}</SafeLink>
        }
        return <span key={index}>{content}</span>
      })}
    </>
  )
}

function textAlign(align: RichTextAlign | undefined) {
  return align ?? 'inherit'
}

function RichTextNodeView({ node }: { node: RichTextNode }) {
  switch (node.type) {
    case 'heading':
      return (
        <Typography
          component={node.level === 2 ? 'h2' : 'h3'}
          sx={{
            fontSize: node.level === 2 ? T.pageTitle : T.cardTitle,
            fontWeight: 800,
            letterSpacing: -0.3,
            color: 'var(--text)',
            textAlign: textAlign(node.align),
          }}
        >
          <RichTextValueView value={node.text} />
        </Typography>
      )

    case 'list':
      return (
        <Box
          component={node.ordered ? 'ol' : 'ul'}
          sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}
        >
          {node.items.map((item, index) => (
            <Typography
              component="li"
              key={index}
              sx={{ fontSize: T.body, color: 'var(--text)', lineHeight: 1.6 }}
            >
              <RichTextValueView value={item} />
            </Typography>
          ))}
        </Box>
      )

    case 'quote':
      return (
        <Box
          component="blockquote"
          sx={{
            m: 0,
            pl: 2,
            borderLeft: '3px solid var(--accent)',
            color: 'var(--muted)',
            textAlign: textAlign(node.align),
          }}
        >
          <Typography sx={{ fontSize: T.bodyStrong, fontStyle: 'italic', lineHeight: 1.6 }}>
            <RichTextValueView value={node.text} />
          </Typography>
        </Box>
      )

    case 'divider':
      // Un descanso entre dos temas. Decorativo de verdad: no separa secciones
      // con nombre —para eso está el titular—, así que no anuncia nada.
      return <Divider aria-hidden sx={{ my: 1 }} />

    default:
      return (
        <Typography
          sx={{
            fontSize: T.body,
            color: 'var(--text)',
            lineHeight: 1.7,
            textAlign: textAlign(node.align),
          }}
        >
          <RichTextValueView value={node.text} />
          {/* Enlace de PÁRRAFO: formato anterior a los tramos, todavía
              publicado en tiendas reales. Va al final de la frase, que es donde
              lo pintaba el día que se guardó. */}
          {isSafeHref(node.href) && node.href ? (
            <>
              {' '}
              <SafeLink href={node.href}>{node.linkLabel ?? node.href}</SafeLink>
            </>
          ) : null}
        </Typography>
      )
  }
}
