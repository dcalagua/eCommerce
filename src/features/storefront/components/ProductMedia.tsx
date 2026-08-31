import ImageRoundedIcon from '@mui/icons-material/ImageRounded'
import { Box } from '@mui/material'
import { R } from '@/theme/tokens'

/**
 * Imagen de producto con **fallback neutral**.
 *
 * El catálogo casi nunca llega con todas las fotos puestas, y el bucket es
 * privado, así que una firma caducada también deja el `src` vacío. En los dos
 * casos se pinta un marcador de tokens de suite — no un logotipo, no una marca
 * de agua, no una imagen de archivo: nada que le ponga a la tienda una
 * identidad que no eligió.
 */
export function ProductMedia({
  url,
  alt,
  ratio = '1 / 1',
  sizePx = 28,
  eager = false,
  fit = 'cover',
}: {
  url: string | null
  alt: string
  /** `1 / 1` en la rejilla; `4 / 3` en la ficha, donde hay más ancho. */
  ratio?: string
  sizePx?: number
  /** La primera imagen de la ficha se carga sin `lazy`: es lo que se ve. */
  eager?: boolean
  /**
   * Cómo encaja la foto en su caja.
   *
   *  - `cover` en la REJILLA: recorta, y ese recorte es lo que mantiene todas
   *    las tarjetas del mismo tamaño. Una rejilla con fotos de proporciones
   *    distintas se lee como una tabla mal cuadrada.
   *  - `contain` en la FICHA: ahí se ha venido a mirar el producto, y recortarlo
   *    esconde justo lo que se quería ver. Se nota sobre todo con lo que no es
   *    una foto de estudio —un logotipo apaisado, una imagen con márgenes—: con
   *    `cover` sale ampliado y descentrado, y parece un fallo de la tienda.
   */
  fit?: 'cover' | 'contain'
}) {
  return (
    <Box
      sx={{
        aspectRatio: ratio,
        width: '100%',
        bgcolor: 'var(--neutral-soft)',
        borderRadius: `${R.md}px`,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--muted)',
      }}
    >
      {url ? (
        <Box
          component="img"
          src={url}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          sx={{
            width: '100%',
            height: '100%',
            objectFit: fit,
            // Centrada de verdad: con `contain` el hueco sobrante se reparte a
            // los dos lados en vez de quedarse todo abajo.
            objectPosition: 'center',
            display: 'block',
          }}
        />
      ) : (
        <ImageRoundedIcon sx={{ fontSize: sizePx }} aria-hidden />
      )}
    </Box>
  )
}
