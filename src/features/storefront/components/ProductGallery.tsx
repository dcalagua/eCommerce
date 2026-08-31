import { ButtonBase, Stack } from '@mui/material'
import { useState } from 'react'
import { useT } from '@/shared/i18n/i18n-context'
import { R } from '@/theme/tokens'
import type { GalleryImage } from '../types'
import { ProductMedia } from './ProductMedia'

/**
 * Galería de la ficha: una imagen grande y las miniaturas debajo.
 *
 * Sin carrusel automático y sin transiciones: cambiar de foto es una decisión
 * del comprador, y una diapositiva que se mueve sola es justo lo que hay que
 * perseguir con el ratón para poder mirarla.
 *
 * Con cero imágenes se pinta el marcador neutral, que es el caso normal de una
 * tienda recién creada.
 */
export function ProductGallery({ images, alt }: { images: GalleryImage[]; alt: string }) {
  const t = useT()
  const [index, setIndex] = useState(0)
  const current = images[Math.min(index, images.length - 1)] ?? null

  return (
    <Stack sx={{ gap: 1 }} aria-label={t('store.product.gallery')} component="section">
      {/* `contain`: aquí se ha venido a mirar el producto, y recortarlo esconde
          justo lo que se quería ver. */}
      <ProductMedia
        url={current?.url ?? null}
        alt={current?.alt ?? alt}
        ratio="4 / 3"
        sizePx={40}
        eager
        fit="contain"
      />

      {images.length > 1 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          {images.map((image, position) => (
            <ButtonBase
              key={image.image_id}
              onClick={() => setIndex(position)}
              aria-label={`${t('store.product.image')} ${position + 1}`}
              aria-current={position === index}
              sx={{
                width: 64,
                borderRadius: `${R.md}px`,
                overflow: 'hidden',
                border: '2px solid',
                borderColor: position === index ? 'var(--accent)' : 'var(--border)',
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
    </Stack>
  )
}
