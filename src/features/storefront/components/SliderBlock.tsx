import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import { Box, IconButton, Stack } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { isInternalPath, isSafeHref } from '@/domain/href'
import { useI18n } from '@/shared/i18n/i18n-context'
import { mediaLayoutOf } from '@/domain/content'
import type { ContentBlock } from '../content'

/**
 * Carrusel de imágenes de la portada (P18).
 *
 * Cada diapositiva es un item `media` del bloque: una imagen del bucket de
 * branding —ya firmada por quien llama— con su texto alternativo y, si acaso,
 * un destino.
 *
 * ## Lo que este componente NO hace, y por qué
 *
 * **No escribe texto encima de la imagen.** Un titular sobre una foto que el
 * comercio elige se lee mal en la mitad de las pantallas y no hay contraste que
 * lo salve para todas. Si la diapositiva tiene que decir algo, se dice EN la
 * imagen, que es donde el diseñador puede colocarlo y comprobarlo.
 *
 * **No rota si el visitante pidió menos movimiento.** `prefers-reduced-motion`
 * apaga el avance automático: un carrusel que se mueve solo es justo lo que esa
 * preferencia existe para evitar. Las flechas y los puntos siguen ahí, así que
 * no se pierde ni una diapositiva.
 *
 * **No rota mientras el ratón está encima ni con el foco dentro.** Que la
 * imagen cambie justo cuando alguien iba a pulsarla es la forma más rápida de
 * que un carrusel moleste.
 *
 * **No recorta nunca.** El marco tiene que ser UNO para todas las diapositivas
 * —si cada una trajera su altura, la página daría un salto en cada avance— pero
 * ese marco no se paga recortando: la primera imagen dice su proporción al
 * cargar y el marco se ajusta a ella, y todas se pintan `contain`. Un banner que
 * el comercio ha compuesto con su texto dentro es justo el caso donde recortar
 * borra lo que se quería decir. El comercio puede fijar la proporción a mano con
 * `settings.aspect` si prefiere otra.
 */
const INTERVALO_MS = 6000

export function SliderBlock({
  block,
  assets,
}: {
  block: ContentBlock
  /** Rutas ya firmadas del bucket de branding. */
  assets: Record<string, string>
}) {
  // Dos disposiciones para la MISMA lista de imágenes. El mosaico no es un
  // bloque aparte porque el contenido es idéntico: cambiar de una a otra no
  // puede obligar a volver a subir nada.
  return mediaLayoutOf(block.settings) === 'grid' ? (
    <MediaGrid block={block} assets={assets} />
  ) : (
    <MediaCarousel block={block} assets={assets} />
  )
}

/**
 * El mosaico: todas las imágenes a la vez.
 *
 * Es lo que se quiere cuando las piezas COMPITEN —dos o tres marcas, dos o tres
 * campañas— y hay que poder compararlas de un vistazo. Un carrusel esconde
 * todas menos una y obliga a esperar a que pase la que interesa.
 *
 * Las columnas las fija el comercio (`settings.columns`), pero solo a partir de
 * pantalla mediana: en un móvil, dos banners uno al lado del otro no se leen.
 */
function MediaGrid({ block, assets }: { block: ContentBlock; assets: Record<string, string> }) {
  const { t } = useI18n()
  const slides = block.items.filter((item) => item.kind === 'media')
  if (slides.length === 0) return null

  const columnas = typeof block.settings.columns === 'number' ? block.settings.columns : 2

  return (
    <Box component="section" aria-label={block.title ?? t('store.slider.label')}>
      <Box
        sx={{
          display: 'grid',
          gap: { xs: 1.5, md: 2 },
          gridTemplateColumns: {
            xs: '1fr',
            md: `repeat(${Math.min(Math.max(columnas, 2), 4)}, minmax(0, 1fr))`,
          },
        }}
      >
        {slides.map((slide) => (
          <Box
            key={slide.image_path}
            sx={{
              borderRadius: 'var(--sf-radius)',
              overflow: 'hidden',
              bgcolor: 'var(--sf-media-bg)',
            }}
          >
            <Diapositiva slide={slide} assets={assets} eager />
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function MediaCarousel({
  block,
  assets,
}: {
  block: ContentBlock
  assets: Record<string, string>
}) {
  const { t } = useI18n()
  const slides = block.items.filter((item) => item.kind === 'media')
  const [index, setIndex] = useState(0)
  const [pausado, setPausado] = useState(false)
  // La proporción REAL de la primera diapositiva, medida al cargarla. Es lo que
  // deja el marco a su medida sin tener que preguntarle nada al comercio.
  const [proporcion, setProporcion] = useState<string | null>(null)
  const contenedor = useRef<HTMLDivElement>(null)

  const total = slides.length
  const ir = useCallback(
    (siguiente: number) => setIndex(((siguiente % total) + total) % total),
    [total],
  )

  useEffect(() => {
    if (total <= 1 || pausado) return
    // La preferencia del sistema manda sobre el ajuste del comercio.
    const quieto = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (quieto) return

    const intervalo = typeof block.settings.interval_ms === 'number'
      ? Math.max(block.settings.interval_ms, 2000)
      : INTERVALO_MS
    const handle = setInterval(() => setIndex((actual) => (actual + 1) % total), intervalo)
    return () => clearInterval(handle)
  }, [total, pausado, block.settings.interval_ms])

  if (total === 0) return null

  return (
    <Box
      component="section"
      aria-roledescription="carousel"
      aria-label={block.title ?? t('store.slider.label')}
      ref={contenedor}
      onMouseEnter={() => setPausado(true)}
      onMouseLeave={() => setPausado(false)}
      onFocusCapture={() => setPausado(true)}
      onBlurCapture={() => setPausado(false)}
      sx={{
        position: 'relative',
        borderRadius: 'var(--sf-radius)',
        overflow: 'hidden',
        bgcolor: 'var(--sf-media-bg)',
        // Una sola proporción para todas: con alturas distintas por diapositiva
        // la página daría un salto en cada avance. La manda el comercio si la ha
        // fijado; si no, la de la primera imagen; y hasta que cargue, un marco
        // apaisado para que la página no dé el salto al llegar.
        aspectRatio:
          typeof block.settings.aspect === 'string'
            ? block.settings.aspect
            : (proporcion ?? '16 / 6'),
      }}
    >
      {slides.map((slide, posicion) => (
        <Box
          key={slide.image_path}
          // `inert` no está en todos los navegadores: lo que garantiza que una
          // diapositiva oculta no sea tabulable es que no se pinta.
          hidden={posicion !== index}
          sx={{ position: 'absolute', inset: 0 }}
        >
          <Diapositiva
            slide={slide}
            assets={assets}
            eager={posicion === 0}
            onAspect={posicion === 0 ? setProporcion : undefined}
          />
        </Box>
      ))}

      {total > 1 && (
        <>
          <Flecha lado="izquierda" label={t('store.slider.prev')} onClick={() => ir(index - 1)}>
            <ChevronLeftRoundedIcon />
          </Flecha>
          <Flecha lado="derecha" label={t('store.slider.next')} onClick={() => ir(index + 1)}>
            <ChevronRightRoundedIcon />
          </Flecha>

          {/* Los puntos dicen CUÁNTAS hay y en cuál se está. Un carrusel sin
              esa pista parece que no termina nunca. */}
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              position: 'absolute',
              bottom: 12,
              left: 0,
              right: 0,
              justifyContent: 'center',
            }}
          >
            {slides.map((slide, posicion) => (
              <Box
                key={slide.image_path}
                component="button"
                type="button"
                aria-label={t('store.slider.goTo').replace('{n}', String(posicion + 1))}
                aria-current={posicion === index}
                onClick={() => ir(posicion)}
                sx={{
                  width: posicion === index ? 22 : 8,
                  height: 8,
                  p: 0,
                  border: 0,
                  borderRadius: 'var(--sf-pill)',
                  cursor: 'pointer',
                  bgcolor: posicion === index ? '#fff' : 'rgba(255,255,255,.55)',
                  transition: 'width .2s ease',
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                }}
              />
            ))}
          </Stack>
        </>
      )}
    </Box>
  )
}

/**
 * Una diapositiva: la imagen y, si lo lleva, su enlace.
 *
 * La comparten el carrusel y el mosaico, y por eso las dos disposiciones
 * responden igual a lo que importa: la imagen se ve ENTERA (`contain`) y el
 * destino se vuelve a validar aquí con `isSafeHref` aunque el CHECK de la base
 * ya lo haya hecho — esta función pinta lo que llega por red.
 */
function Diapositiva({
  slide,
  assets,
  eager = false,
  onAspect,
}: {
  slide: Extract<ContentBlock['items'][number], { kind: 'media' }>
  assets: Record<string, string>
  eager?: boolean
  /** Avisa de la proporción real de la imagen, para que el marco se le ajuste. */
  onAspect?: (aspect: string) => void
}) {
  const imagen = (
    <Box
      component="img"
      src={assets[slide.image_path] ?? undefined}
      alt={slide.image_alt}
      loading={eager ? 'eager' : 'lazy'}
      onLoad={
        onAspect
          ? (event) => {
              const img = event.currentTarget
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                onAspect(`${img.naturalWidth} / ${img.naturalHeight}`)
              }
            }
          : undefined
      }
      sx={{
        width: '100%',
        height: '100%',
        // `contain` y no `cover`: la imagen se ve ENTERA. Recortar el banner de
        // una campaña esconde justo lo que anuncia.
        objectFit: 'contain',
        objectPosition: 'center',
        display: 'block',
      }}
    />
  )

  if (!slide.href || !isSafeHref(slide.href)) return imagen

  return isInternalPath(slide.href) ? (
    <Link to={slide.href} style={{ display: 'block', height: '100%' }}>
      {imagen}
    </Link>
  ) : (
    <a
      href={slide.href}
      rel="noopener noreferrer"
      target="_blank"
      style={{ display: 'block', height: '100%' }}
    >
      {imagen}
    </a>
  )
}

function Flecha({
  lado,
  label,
  onClick,
  children,
}: {
  lado: 'izquierda' | 'derecha'
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <IconButton
      aria-label={label}
      onClick={onClick}
      sx={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        [lado === 'izquierda' ? 'left' : 'right']: 8,
        bgcolor: 'rgba(255,255,255,.85)',
        color: 'var(--text)',
        '&:hover': { bgcolor: '#fff' },
      }}
    >
      {children}
    </IconButton>
  )
}
