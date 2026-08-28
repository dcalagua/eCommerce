import { Box, Link as MuiLink, Typography } from '@mui/material'
import type { RichTextDocument, RichTextNode } from '@/domain/content'
import { T } from '@/theme/tokens'

/**
 * Pinta un documento enriquecido del tenant.
 *
 * **Aquí no hay `dangerouslySetInnerHTML`, y esa es toda la seguridad de este
 * componente.** El documento no es HTML (ver `src/domain/content.ts`): es un
 * array de cuatro tipos de nodo, y este archivo es la tabla que lleva cada tipo
 * a un componente de MUI. No existe la cadena que se escapa mal porque no hay
 * cadena que interpretar — un `<script>` guardado como texto se pinta como el
 * texto `<script>`, que es exactamente lo que es.
 *
 * Un test de arquitectura comprueba que `dangerouslySetInnerHTML` no aparece en
 * ningún archivo de producción de `src/`. Si alguien lo añade «solo para este
 * caso», la suite se pone roja.
 *
 * El `href` se vuelve a comprobar en `content.ts` antes de llegar aquí, y la
 * base ya lo validó con un CHECK. Tres capas para lo mismo no es exceso: es que
 * este es el punto donde un valor del tenant entra al DOM.
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
          }}
        >
          {node.text}
        </Typography>
      )

    case 'list':
      return (
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
          {node.items.map((item, index) => (
            <Typography
              component="li"
              key={index}
              sx={{ fontSize: T.body, color: 'var(--text)', lineHeight: 1.6 }}
            >
              {item}
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
          }}
        >
          <Typography sx={{ fontSize: T.bodyStrong, fontStyle: 'italic', lineHeight: 1.6 }}>
            {node.text}
          </Typography>
        </Box>
      )

    default:
      return (
        <Typography sx={{ fontSize: T.body, color: 'var(--text)', lineHeight: 1.7 }}>
          {node.text}
          {node.href ? (
            <>
              {' '}
              <MuiLink
                href={node.href}
                // Un enlace del tenant sale a un sitio que el comercio eligió.
                // `noopener noreferrer` no es cosmética: sin él, la página de
                // destino puede manipular la pestaña que la abrió.
                rel="noopener noreferrer"
                target={node.href.startsWith('/') ? undefined : '_blank'}
                sx={{ color: 'var(--accent-deep)', fontWeight: 700 }}
              >
                {node.linkLabel ?? node.href}
              </MuiLink>
            </>
          ) : null}
        </Typography>
      )
  }
}
