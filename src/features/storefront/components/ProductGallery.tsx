import FavoriteBorderRoundedIcon from '@mui/icons-material/FavoriteBorderRounded'
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded'
import ZoomInRoundedIcon from '@mui/icons-material/ZoomInRounded'
import { Box, ButtonBase, IconButton, Stack } from '@mui/material'
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
export function ProductGallery({
  images,
  alt,
  badge = null,
  favorite,
  layout = 'viewer',
  loading = false,
}: {
  images: GalleryImage[]
  /** La galería aún no llegó: esqueletos con la forma de la galería. */
  loading?: boolean
  alt: string
  /** «−20 %» sobre la foto, arriba a la izquierda (lámina 31). */
  badge?: string | null
  /** El corazón sobre la foto: se guarda donde se decide. */
  favorite?: { active: boolean; onToggle: () => void; label: string }
  /**
   * Rediseño v3 · `grid`: TODAS las fotos a tamaño grande, en dos columnas
   * (lámina de ficha retail). En el teléfono, una fila que se desliza. Cada
   * foto abre el mismo visor ampliado. `viewer` es la de siempre.
   */
  layout?: 'viewer' | 'grid'
}) {
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

  const corazon = favorite ? (
    <IconButton
      aria-pressed={favorite.active}
      aria-label={favorite.label}
      onClick={favorite.onToggle}
      sx={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 40,
        height: 40,
        bgcolor: 'var(--card)',
        color: favorite.active ? 'var(--sf-heart, var(--accent-deep))' : 'var(--text)',
        boxShadow: 'var(--sf-shadow)',
        '&:hover': { bgcolor: 'var(--card)' },
      }}
    >
      {favorite.active ? <FavoriteRoundedIcon sx={{ fontSize: 20 }} /> : <FavoriteBorderRoundedIcon sx={{ fontSize: 20 }} />}
    </IconButton>
  ) : null

  const insignia = badge ? (
    <Box
      data-gallery-badge
      sx={{
        position: 'absolute',
        top: 14,
        left: 14,
        px: 1.25,
        py: 0.5,
        borderRadius: 'var(--sf-pill)',
        bgcolor: 'var(--accent-deep)',
        color: '#FFFFFF',
        fontSize: 13,
        fontWeight: 800,
        pointerEvents: 'none',
      }}
    >
      {badge}
    </Box>
  ) : null

  // Mientras llega la galería, su FORMA con brillo: el marcador de «sin foto»
  // aquí decía que el producto no tiene fotos justo antes de enseñarlas.
  // En el visor basta con que la foto grande diga «cargando» (ver abajo): así
  // el corazón y el descuento son el MISMO nodo antes y después de llegar.
  if (loading && images.length === 0 && layout === 'grid') {
    const huecos = 4
    return (
      <Box
        component="section"
        aria-label={t('store.product.gallery')}
        aria-busy
        data-gallery-loading
        sx={{
          position: 'relative',
          ...(layout === 'grid'
            ? { display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: { xs: 1, md: 1.25 } }
            : { borderRadius: 'var(--sf-radius, 16px)', overflow: 'hidden' }),
        }}
      >
        {Array.from({ length: huecos }, (_, slot) => (
          <Box key={slot} sx={slot > 0 ? { display: { xs: 'none', md: 'block' } } : undefined}>
            <ProductMedia
              url={null}
              alt=""
              pending
              ratio={layout === 'grid' ? '4 / 5' : 'var(--sf-pdp-ratio, 1 / 1)'}
            />
          </Box>
        ))}
        {/* El descuento y el corazón no esperan a las fotos: son del producto. */}
        {insignia}
        {corazon}
      </Box>
    )
  }

  if (layout === 'grid' && images.length > 0) {
    return (
      <Box component="section" aria-label={t('store.product.gallery')} sx={{ position: 'relative' }}>
        <Box
          data-gallery-layout="grid"
          sx={{
            display: { xs: 'flex', md: 'grid' },
            gridTemplateColumns: images.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr',
            gap: { xs: 1, md: 1.25 },
            overflowX: { xs: 'auto', md: 'visible' },
            scrollSnapType: { xs: 'x mandatory', md: 'none' },
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          {images.map((image, slot) => (
            <ButtonBase
              key={image.image_id}
              onClick={() => open(slot)}
              aria-label={`${t('store.product.zoom')} · ${t('store.product.image')} ${slot + 1}`}
              sx={{
                flex: { xs: images.length > 1 ? '0 0 86%' : '0 0 100%', md: 'initial' },
                scrollSnapAlign: 'start',
                display: 'block',
                overflow: 'hidden',
                borderRadius: 'var(--sf-radius-sm, 0)',
                bgcolor: 'var(--sf-photo-bg, var(--sf-media-bg, #fff))',
                cursor: 'zoom-in',
              }}
            >
              <ProductMedia
                url={image.url}
                alt={slot === 0 ? (image.alt ?? alt) : ''}
                ratio="4 / 5"
                sizePx={40}
                eager={slot < 2}
                fit="contain"
              />
            </ButtonBase>
          ))}
        </Box>

        {badge ? (
          <Box
            data-gallery-badge
            sx={{
              position: 'absolute',
              top: 12,
              left: 12,
              px: 1,
              py: 0.375,
              bgcolor: 'var(--sf-discount-bg, var(--accent-deep))',
              color: '#FFFFFF',
              fontSize: 12,
              fontWeight: 800,
              pointerEvents: 'none',
            }}
          >
            {badge}
          </Box>
        ) : null}
        {corazon}

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
      </Box>
    )
  }

  /**
   * Lámina 31 · Las miniaturas a la IZQUIERDA en escritorio y debajo en el
   * teléfono. En columna no le roban alto a la foto, que es lo que se ha venido
   * a mirar; en el teléfono no hay ancho para una columna.
   */
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      sx={{ gap: { xs: 1, md: 1.5 }, alignItems: 'flex-start' }}
      aria-label={t('store.product.gallery')}
      component="section"
    >
      <Box sx={{ position: 'relative', flex: 1, minWidth: 0, width: '100%', order: { md: 1 } }}>
        <ButtonBase
          onClick={() => hasImages && open(position)}
          disabled={!hasImages}
          aria-label={t('store.product.zoom')}
          sx={{
            width: '100%',
            display: 'block',
            borderRadius: 'var(--sf-radius, 16px)',
            overflow: 'hidden',
            bgcolor: 'var(--sf-media-bg, #fff)',
            cursor: hasImages ? 'zoom-in' : 'default',
          }}
        >
          {/* La proporción y el encaje los pone el TEMA (`--sf-pdp-ratio`,
              `--sf-pdp-fit`): cuadrada y entera por defecto —aquí se ha venido
              a mirar el producto, y recortarlo esconde lo que se quería ver—;
              vertical y a sangre en Premium, donde la foto es el argumento.
              Antes era 4:3 fija, y un producto alto quedaba flotando en un
              lienzo blanco. */}
          <ProductMedia
            url={current?.url ?? null}
            alt={current?.alt ?? alt}
            ratio="var(--sf-pdp-ratio, 1 / 1)"
            sizePx={40}
            eager
            pending={loading && !hasImages}
            fit="var(--sf-pdp-fit, contain)"
          />
        </ButtonBase>

        {insignia}

        {/* Hermano del botón de la foto, no hijo: un botón dentro de otro no
            es HTML válido y el lector de pantalla no sabría cuál pulsa. */}
        {corazon}

        {hasImages && (
          // Cuántas fotos hay y que se amplía, en una pastilla sobre la foto.
          // Antes era una línea suelta debajo que se leía como pie de foto.
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              left: 12,
              bottom: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.25,
              py: 0.5,
              borderRadius: 'var(--sf-pill)',
              bgcolor: 'rgba(255,255,255,.9)',
              color: 'var(--text)',
              fontSize: TS.label,
              fontWeight: 600,
              pointerEvents: 'none',
            }}
          >
            <ZoomInRoundedIcon sx={{ fontSize: 16 }} />
            {images.length > 1 ? `${position + 1} / ${images.length} · ` : ''}
            {t('store.product.zoomHint')}
          </Box>
        )}
      </Box>

      {images.length > 1 && (
        <Stack
          direction={{ xs: 'row', md: 'column' }}
          sx={{ gap: 1, flexWrap: { xs: 'wrap', md: 'nowrap' }, flexShrink: 0, order: { md: 0 } }}
        >
          {images.map((image, slot) => (
            <ButtonBase
              key={image.image_id}
              onClick={() => open(slot)}
              aria-label={`${t('store.product.image')} ${slot + 1}`}
              aria-current={slot === position}
              sx={{
                width: { xs: 64, md: 76 },
                borderRadius: `${R.md}px`,
                overflow: 'hidden',
                border: '2px solid',
                borderColor: slot === position ? 'var(--text)' : 'var(--border)',
                bgcolor: 'var(--sf-media-bg, #fff)',
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
