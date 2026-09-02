import ZoomInRoundedIcon from '@mui/icons-material/ZoomInRounded'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { R, TS } from '@/theme/tokens'
import type { GalleryImage } from '../types'
import { ImageLightbox } from './ImageLightbox'
import { ProductMedia } from './ProductMedia'

/**
 * Galería de la ficha: una imagen grande, las miniaturas debajo y el visor.
 *
 * Sin carrusel automático y sin transiciones: cambiar de foto es una decisión
 * del comprador, y una diapositiva que se mueve sola es justo lo que hay que
 * perseguir con el ratón para poder mirarla.
 *
 * ## Pulsar la foto la abre grande
 *
 * La foto de la ficha vive en una columna estrecha porque al lado va lo que
 * decide la compra. A ese tamaño el producto se reconoce pero no se examina, y
 * el gesto que todo el mundo prueba —pulsar la foto— tiene que llevar a
 * [`ImageLightbox`](./ImageLightbox.tsx). Por eso la imagen es un BOTÓN de
 * verdad: se llega con el tabulador, responde a Enter y se anuncia como lo que
 * hace, en vez de ser un `div` con un `onClick` que solo existe para el ratón.
 * La lupa está para que se vea que se puede pulsar; el `cursor: zoom-in` lo
 * confirma con el ratón encima.
 *
 * **Las miniaturas también abren el visor**, además de cambiar la principal.
 * Una miniatura de 64 px no se mira: se usa para elegir cuál mirar, así que
 * llevar directamente al tamaño grande es lo que se espera de ella.
 *
 * Con cero imágenes se pinta el marcador neutral, que es el caso normal de una
 * tienda recién creada, y entonces no hay nada que ampliar: sin fotos la
 * imagen no es pulsable.
 */
export function ProductGallery({ images, alt }: { images: GalleryImage[]; alt: string }) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [zoomed, setZoomed] = useState<number | null>(null)

  // Al cambiar de producto —el diálogo de vista rápida reutiliza el
  // componente— la galería vuelve a la primera foto. Si no, se abre en la
  // tercera imagen del producto anterior, o en ninguna.
  const firstId = images[0]?.image_id ?? null
  useEffect(() => {
    setIndex(0)
    setZoomed(null)
  }, [firstId])

  const position = Math.min(index, Math.max(images.length - 1, 0))
  const current = images[position] ?? null
  const hasImages = images.length > 0

  function open(next: number) {
    setIndex(next)
    setZoomed(next)
  }

  return (
    <Stack sx={{ gap: 1 }} aria-label={t('store.product.gallery')} component="section">
      <Box sx={{ position: 'relative' }}>
        <ButtonBase
          onClick={() => hasImages && open(position)}
          disabled={!hasImages}
          aria-label={t('store.product.zoom')}
          sx={{
            width: '100%',
            display: 'block',
            borderRadius: `${R.md}px`,
            overflow: 'hidden',
            cursor: hasImages ? 'zoom-in' : 'default',
          }}
        >
          {/* `contain`: aquí se ha venido a mirar el producto, y recortarlo
              esconde justo lo que se quería ver. */}
          <ProductMedia
            url={current?.url ?? null}
            alt={current?.alt ?? alt}
            ratio="4 / 3"
            sizePx={40}
            eager
            fit="contain"
          />
        </ButtonBase>

        {hasImages && (
          // Decorativa: el botón que la contiene ya se anuncia con su
          // `aria-label`, y anunciarla otra vez sería leer dos veces lo mismo.
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              display: 'grid',
              placeItems: 'center',
              width: 32,
              height: 32,
              borderRadius: '999px',
              color: '#FFFFFF',
              bgcolor: 'rgba(0,0,0,0.45)',
              pointerEvents: 'none',
            }}
          >
            <ZoomInRoundedIcon sx={{ fontSize: 20 }} />
          </Box>
        )}
      </Box>

      {images.length > 1 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          {images.map((image, slot) => (
            <ButtonBase
              key={image.image_id}
              onClick={() => open(slot)}
              aria-label={`${t('store.product.image')} ${slot + 1}`}
              aria-current={slot === position}
              sx={{
                width: 64,
                borderRadius: `${R.md}px`,
                overflow: 'hidden',
                border: '2px solid',
                borderColor: slot === position ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {/* `alt=""`: la miniatura es decorativa, el botón ya se anuncia
                  con su `aria-label`. Repetir el texto haría que el lector de
                  pantalla leyera el mismo nombre dos veces por foto. */}
              <ProductMedia url={image.url} alt="" sizePx={16} />
            </ButtonBase>
          ))}
        </Stack>
      )}

      {hasImages && (
        <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
          {t('store.product.zoomHint')}
        </Typography>
      )}

      <ImageLightbox
        images={images}
        index={zoomed}
        alt={alt}
        onIndexChange={(next) => {
          setIndex(next)
          setZoomed(next)
        }}
        onClose={() => setZoomed(null)}
      />
    </Stack>
  )
}
