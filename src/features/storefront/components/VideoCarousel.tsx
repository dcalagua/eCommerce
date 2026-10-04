import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded'
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded'
import { Box, IconButton, Stack } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useSignedStoreAssets } from '../hooks'
import type { HomeVideo } from '../homeVideos'

/**
 * Carrusel de videos de la portada (2026-10-04).
 *
 * Uno a la vez, en el centro, con los vecinos asomando a los lados: se lee
 * como carrusel y se ve qué viene. El activo se reproduce; al TERMINAR pasa al
 * siguiente, y después del último vuelve al primero — para siempre. Con un
 * solo video, ese video en bucle.
 *
 * ## Por qué empieza sin sonido
 *
 * Los navegadores solo dejan arrancar sin un gesto un video SILENCIADO: con sonido,
 * el `play()` automático se rechaza y el carrusel se quedaría quieto. Por eso
 * arranca mudo y el botón del altavoz es lo primero que se ofrece.
 *
 * ## Lo que no hace
 *
 * - No reproduce fuera de la pantalla ni con la pestaña oculta: bajar de la
 *   portada no deja un video gastando batería y datos por detrás.
 * - Con `prefers-reduced-motion` no arranca solo: el comprador lo inicia con
 *   el botón de reproducir, y desde ahí sí sigue la secuencia.
 */
export function VideoCarousel({ videos }: { videos: readonly HomeVideo[] }) {
  const { t } = useI18n()
  const urls = useSignedStoreAssets(videos.map((video) => video.path))
  const [activo, setActivo] = useState(0)
  const [muted, setMuted] = useState(true)
  const [reduceMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  // Pausado por la persona (el botón): manda sobre todo lo demás.
  const [pausado, setPausado] = useState(reduceMotion)
  const [visible, setVisible] = useState(true)
  const raiz = useRef<HTMLDivElement | null>(null)
  const pista = useRef<HTMLDivElement | null>(null)
  const refs = useRef<Array<HTMLVideoElement | null>>([])
  const total = videos.length

  // Fuera de pantalla o con la pestaña oculta, quieto.
  useEffect(() => {
    const nodo = raiz.current
    if (!nodo || typeof IntersectionObserver === 'undefined') return
    const observador = new IntersectionObserver(([entrada]) => setVisible(Boolean(entrada?.isIntersecting)), {
      threshold: 0.35,
    })
    observador.observe(nodo)
    return () => observador.disconnect()
  }, [])
  const [pestanaVisible, setPestanaVisible] = useState(true)
  useEffect(() => {
    const alCambiar = () => setPestanaVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', alCambiar)
    return () => document.removeEventListener('visibilitychange', alCambiar)
  }, [])

  // El activo suena (o no) y avanza; los demás, parados en su primer cuadro.
  const debeSonar = !pausado && visible && pestanaVisible
  useEffect(() => {
    refs.current.forEach((video, i) => {
      if (!video) return
      if (i !== activo) {
        video.pause()
        if (video.currentTime > 0) video.currentTime = 0
        return
      }
      video.muted = muted
      if (debeSonar) {
        reproducir(video, () => {
          // El navegador lo rechazó (p. ej. con sonido sin gesto previo):
          // se vuelve a intentar mudo, que siempre se permite.
          video.muted = true
          setMuted(true)
          reproducir(video, () => setPausado(true))
        })
      } else {
        video.pause()
      }
    })
  }, [activo, debeSonar, muted, urls])

  // El activo, centrado en la pista (sin desplazar la página).
  useEffect(() => {
    const contenedor = pista.current
    const slide = contenedor?.children[activo] as HTMLElement | undefined
    if (!contenedor || !slide) return
    const destino = slide.offsetLeft - (contenedor.clientWidth - slide.clientWidth) / 2
    // `scrollTo` con opciones no existe en navegadores viejos (ni en jsdom).
    if (typeof contenedor.scrollTo === 'function') {
      contenedor.scrollTo({ left: destino, behavior: reduceMotion ? 'auto' : 'smooth' })
    } else {
      contenedor.scrollLeft = destino
    }
  }, [activo, reduceMotion])

  if (total === 0) return null

  const ir = (indice: number) => setActivo(((indice % total) + total) % total)
  const titulo = videos[activo]?.title ?? null

  return (
    <Box
      ref={raiz}
      component="section"
      aria-roledescription={t('store.videos.carousel')}
      aria-label={t('store.videos.title')}
      data-video-carousel
      className="sf-video-carousel"
      sx={{ position: 'relative' }}
    >
      <Box
        ref={pista}
        sx={{
          display: 'flex',
          gap: { xs: 1.25, md: 2 },
          overflow: 'hidden',
          // Aire a los lados para que el primero y el último también queden
          // centrados y se vea que hay más.
          px: { xs: '7%', md: '17%' },
        }}
      >
        {videos.map((video, i) => {
          const url = urls[video.path] ?? null
          const esActivo = i === activo
          return (
            <Box
              key={video.path}
              aria-roledescription={t('store.videos.slide')}
              aria-label={t('store.videos.position')
                .replace('{n}', String(i + 1))
                .replace('{total}', String(total))}
              aria-hidden={!esActivo}
              onClick={() => !esActivo && ir(i)}
              sx={{
                position: 'relative',
                flex: '0 0 100%',
                aspectRatio: '16 / 9',
                borderRadius: 'var(--sf-radius, 16px)',
                overflow: 'hidden',
                bgcolor: '#0b0b0b',
                cursor: esActivo ? 'default' : 'pointer',
                opacity: esActivo ? 1 : 0.45,
                transform: esActivo ? 'none' : 'scale(0.94)',
                transition: reduceMotion ? 'none' : 'opacity 300ms ease, transform 300ms ease',
              }}
            >
              {url ? (
                <Box
                  component="video"
                  ref={(nodo: HTMLVideoElement | null) => {
                    refs.current[i] = nodo
                  }}
                  src={url}
                  muted
                  playsInline
                  preload={esActivo ? 'auto' : 'metadata'}
                  loop={total === 1}
                  onEnded={() => total > 1 && ir(activo + 1)}
                  aria-label={
                    video.title ??
                    t('store.videos.position')
                      .replace('{n}', String(i + 1))
                      .replace('{total}', String(total))
                  }
                  sx={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ) : (
                <Box className="sf-media-shimmer" aria-hidden />
              )}
              {esActivo ? (
                <>
                  {/* Título y controles sobre el video activo. */}
                  <Box
                    sx={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      p: { xs: 1.25, md: 2 },
                      display: 'flex',
                      alignItems: 'flex-end',
                      justifyContent: 'space-between',
                      gap: 1,
                      pointerEvents: 'none',
                      background: 'linear-gradient(to top, rgba(0,0,0,.55), transparent)',
                      color: '#fff',
                    }}
                  >
                    <Box
                      sx={{
                        fontWeight: 800,
                        fontSize: { xs: 15, md: 20 },
                        lineHeight: 1.2,
                        textShadow: '0 1px 6px rgba(0,0,0,.4)',
                      }}
                    >
                      {titulo}
                    </Box>
                    <Stack direction="row" spacing={1} sx={{ pointerEvents: 'auto', flexShrink: 0 }}>
                      <IconButton
                        onClick={() => setPausado((valor) => !valor)}
                        aria-label={pausado ? t('store.videos.play') : t('store.videos.pause')}
                        sx={botonSobreVideo}
                      >
                        {pausado ? <PlayArrowRoundedIcon /> : <PauseRoundedIcon />}
                      </IconButton>
                      <IconButton
                        onClick={() => setMuted((valor) => !valor)}
                        aria-pressed={!muted}
                        aria-label={muted ? t('store.videos.unmute') : t('store.videos.mute')}
                        sx={botonSobreVideo}
                      >
                        {muted ? <VolumeOffRoundedIcon /> : <VolumeUpRoundedIcon />}
                      </IconButton>
                    </Stack>
                  </Box>
                </>
              ) : null}
            </Box>
          )
        })}
      </Box>

      {total > 1 && (
        <>
          <IconButton
            onClick={() => ir(activo - 1)}
            aria-label={t('store.videos.previous')}
            sx={{ ...flecha, left: { xs: 4, md: 'calc(17% - 56px)' } }}
          >
            <ChevronLeftRoundedIcon />
          </IconButton>
          <IconButton
            onClick={() => ir(activo + 1)}
            aria-label={t('store.videos.next')}
            sx={{ ...flecha, right: { xs: 4, md: 'calc(17% - 56px)' } }}
          >
            <ChevronRightRoundedIcon />
          </IconButton>
          <Stack direction="row" spacing={0.75} sx={{ justifyContent: 'center', mt: 1.5 }}>
            {videos.map((video, i) => (
              <Box
                key={video.path}
                component="button"
                type="button"
                onClick={() => ir(i)}
                aria-current={i === activo}
                aria-label={t('store.videos.position')
                  .replace('{n}', String(i + 1))
                  .replace('{total}', String(total))}
                sx={{
                  width: i === activo ? 22 : 8,
                  height: 8,
                  p: 0,
                  border: 0,
                  borderRadius: 'var(--sf-pill, 999px)',
                  bgcolor: i === activo ? 'var(--text)' : 'var(--sf-line-strong, var(--border))',
                  cursor: 'pointer',
                  transition: reduceMotion ? 'none' : 'width 200ms ease',
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
 * `play()` devuelve una promesa en los navegadores actuales y nada en los
 * viejos (y en jsdom): el rechazo solo se escucha si la hay.
 */
function reproducir(video: HTMLVideoElement, siFalla: () => void) {
  try {
    const intento: Promise<void> | undefined = video.play()
    if (intento && typeof intento.catch === 'function') intento.catch(siFalla)
  } catch {
    siFalla()
  }
}

const botonSobreVideo = {
  width: 40,
  height: 40,
  color: '#fff',
  bgcolor: 'rgba(0,0,0,.45)',
  backdropFilter: 'blur(4px)',
  '&:hover': { bgcolor: 'rgba(0,0,0,.6)' },
} as const

const flecha = {
  position: 'absolute',
  top: 'calc(50% - 24px)',
  transform: 'translateY(-50%)',
  zIndex: 1,
  width: 44,
  height: 44,
  bgcolor: 'var(--card)',
  color: 'var(--text)',
  boxShadow: 'var(--sf-shadow)',
  '&:hover': { bgcolor: 'var(--card)' },
} as const
