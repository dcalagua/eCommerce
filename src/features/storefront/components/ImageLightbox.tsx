import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { Box, Dialog, IconButton, Stack, Typography } from '@mui/material'
import { useEffect } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { R, T } from '@/theme/tokens'
import type { GalleryImage } from '../types'

/**
 * La foto, a pantalla completa y sin nada alrededor.
 *
 * ## Por que existe
 *
 * La galeria de la ficha vive en una columna de 300-400 px porque al lado va lo
 * que decide la compra —precio, stock, boton—. A ese tamano una silla se
 * reconoce, pero no se puede MIRAR: ni el tejido, ni el acabado de la madera,
 * ni si la pata es de acero o de haya. Comprar sin poder acercarse a la foto es
 * comprar a ciegas, y la respuesta de cualquier tienda a eso es la misma:
 * pulsar la imagen y verla grande.
 *
 * ## Decisiones
 *
 * **Fondo oscuro y opaco, no el `--bg` del tenant.** Aqui la pantalla entera es
 * el visor: cualquier color de marca alrededor compite con la foto y falsea los
 * colores del producto, que es justo lo que se ha venido a juzgar.
 *
 * **`contain`, nunca `cover`.** Recortar en el visor de detalle seria esconder
 * lo que se quiere ver. La foto se ajusta entera al hueco disponible.
 *
 * **Teclado de verdad**: `Esc` cierra (lo trae el `Dialog`), y las flechas
 * pasan de foto. Quien abre un visor de imagenes prueba las flechas antes que
 * cualquier boton, y si no responden el visor parece roto.
 *
 * **Las flechas solo salen si hay mas de una foto.** Un control que no lleva a
 * ningun sitio ensena a no pulsarlo.
 *
 * El contador («Imagen 2 de 4») no es decoracion: sin el, en una galeria de
 * cuatro fotos no se sabe si queda algo por ver o se esta dando vueltas.
 */
export function ImageLightbox({
  images,
  index,
  alt,
  onIndexChange,
  onClose,
}: {
  images: GalleryImage[]
  /** `null` = cerrado. Es el indice dentro de `images`. */
  index: number | null
  alt: string
  onIndexChange: (next: number) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const open = index !== null && images.length > 0
  const position = index ?? 0
  const current = images[position] ?? null
  const many = images.length > 1

  // Circular: desde la ultima, «siguiente» vuelve a la primera. En una galeria
  // de cuatro fotos toparse con un boton muerto al final es peor que dar la
  // vuelta, que es lo que hace todo el mundo mirando fotos.
  const go = (delta: number) => onIndexChange((position + delta + images.length) % images.length)

  useEffect(() => {
    if (!open || !many) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'ArrowRight') go(1)
      if (event.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!current) return null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      aria-label={alt}
      slotProps={{
        paper: {
          sx: {
            borderRadius: `${R.lg}px`,
            bgcolor: '#0B0F0E',
            backgroundImage: 'none',
            // El visor ocupa la pantalla menos un margen: pegado a los bordes
            // parece que la foto se sale, y con la mitad del alto no sirve de
            // nada haberla abierto.
            //
            // `overflow: hidden` es lo que impide que el dialogo saque barra de
            // desplazamiento: sin el, la foto empujaba hacia abajo, las
            // miniaturas se le montaban encima y el visor pedia scroll para ver
            // una imagen que cabia entera.
            height: { xs: '100%', md: '90vh' },
            maxHeight: '100%',
            m: { xs: 0, md: 4 },
            overflow: 'hidden',
          },
        },
      }}
    >
      <Stack sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 2, py: 1.25 }}
        >
          <Typography sx={{ fontSize: T.body, fontWeight: 700, color: 'rgba(255,255,255,0.82)' }}>
            {t('store.product.imageOf')
              .replace('{n}', String(position + 1))
              .replace('{total}', String(images.length))}
          </Typography>
          <IconButton
            onClick={onClose}
            aria-label={t('store.product.closeImage')}
            sx={{ color: '#FFFFFF' }}
          >
            <CloseRoundedIcon />
          </IconButton>
        </Stack>

        {/* Centrado con flex y no con grid: en grid la fila se dimensiona por
            la imagen y `maxHeight: 100%` no la sujeta, que era justo por donde
            se desbordaba. */}
        <Box
          sx={{
            flex: '1 1 auto',
            minHeight: 0,
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            px: { xs: 1, md: 7 },
            pb: 1,
          }}
        >
          <Box
            component="img"
            // La `key` fuerza un elemento nuevo por foto: sin ella el navegador
            // reutiliza el anterior y deja ver la imagen vieja estirada un
            // instante mientras carga la nueva.
            key={current.image_id}
            src={current.url ?? ''}
            alt={current.alt ?? alt}
            sx={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: `${R.md}px`,
              display: 'block',
            }}
          />

          {many && (
            <>
              <IconButton
                onClick={() => go(-1)}
                aria-label={t('store.product.prevImage')}
                sx={arrowSx('left')}
              >
                <ChevronLeftRoundedIcon />
              </IconButton>
              <IconButton
                onClick={() => go(1)}
                aria-label={t('store.product.nextImage')}
                sx={arrowSx('right')}
              >
                <ChevronRightRoundedIcon />
              </IconButton>
            </>
          )}
        </Box>

        {many && (
          <Stack
            direction="row"
            sx={{
              gap: 1,
              px: 2,
              py: 1.5,
              // Fuera del hueco de la foto, no encima: la tira es su propia
              // banda y no le come alto a la imagen mas que el suyo.
              flexShrink: 0,
              overflowX: 'auto',
              justifyContent: 'center',
              borderTop: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {images.map((image, slot) => (
              <Box
                key={image.image_id}
                component="button"
                type="button"
                onClick={() => onIndexChange(slot)}
                aria-label={t('store.product.imageOf')
                  .replace('{n}', String(slot + 1))
                  .replace('{total}', String(images.length))}
                aria-current={slot === position}
                sx={{
                  p: 0,
                  width: 56,
                  height: 56,
                  flexShrink: 0,
                  cursor: 'pointer',
                  borderRadius: `${R.sm}px`,
                  overflow: 'hidden',
                  border: '2px solid',
                  borderColor: slot === position ? 'var(--accent)' : 'rgba(255,255,255,0.25)',
                  bgcolor: 'rgba(255,255,255,0.06)',
                  // Lo no elegido se atenua en vez de desaparecer: sigue
                  // pulsable, pero no compite con la foto que se esta mirando.
                  opacity: slot === position ? 1 : 0.6,
                }}
              >
                <Box
                  component="img"
                  src={image.url ?? ''}
                  alt=""
                  loading="lazy"
                  sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </Box>
            ))}
          </Stack>
        )}
      </Stack>
    </Dialog>
  )
}

/** Flechas sobre la foto, con fondo propio: sobre una foto clara desaparecen. */
function arrowSx(side: 'left' | 'right') {
  return {
    position: 'absolute' as const,
    top: '50%',
    transform: 'translateY(-50%)',
    [side]: { xs: 4, md: 12 },
    color: '#FFFFFF',
    bgcolor: 'rgba(0,0,0,0.45)',
    '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' },
  }
}
