import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded'
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded'
import { Box, IconButton } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { fetchPublicProductsByIds } from '../api'
import { useSignedStoreAssets, useThumbnails } from '../hooks'
import type { HomeVideo } from '../homeVideos'
import { ProductMedia } from './ProductMedia'

/**
 * Carrusel de videos de la portada, formato Reels (2026-10-04).
 *
 * Varios videos VERTICALES a la vista; el activo, al centro y más grande, se
 * reproduce, y debajo sale la tarjeta del producto que enseña (foto, nombre,
 * precio) que lleva a su ficha. Los demás enseñan su primer cuadro con el
 * icono de reproducir; pulsar uno lo trae al centro. Al TERMINAR el activo
 * pasa al siguiente, y después del último vuelve al primero — para siempre.
 * Con un solo video, ese video en bucle.
 *
 * ## Por qué empieza sin sonido
 *
 * Los navegadores solo dejan arrancar sin un gesto un video SILENCIADO: con
 * sonido, el `play()` automático se rechaza y el carrusel se quedaría quieto.
 * Por eso arranca mudo y el altavoz está en la esquina del video activo.
 *
 * ## Lo que no hace
 *
 * - No reproduce fuera de la pantalla ni con la pestaña oculta: bajar de la
 *   portada no deja un video gastando batería y datos por detrás.
 * - Con `prefers-reduced-motion` no arranca solo: el comprador lo inicia
 *   pulsando el video, y desde ahí sí sigue la secuencia.
 */
export function VideoCarousel({
  videos,
  storeId,
  storeSlug,
}: {
  videos: readonly HomeVideo[]
  storeId: string
  storeSlug: string
}) {
  const { t, locale } = useI18n()
  const urls = useSignedStoreAssets(videos.map((video) => video.path))
  const idsProducto = [...new Set(videos.map((video) => video.product_id).filter((id): id is string => Boolean(id)))]
  const productos = useQuery({
    queryKey: ['storefront', 'video-products', storeId, idsProducto] as const,
    queryFn: () => fetchPublicProductsByIds(storeId, idsProducto),
    enabled: idsProducto.length > 0,
    staleTime: 5 * 60 * 1000,
  })
  const miniaturas = useThumbnails(productos.data ?? [])

  const [activo, setActivo] = useState(0)
  const [muted, setMuted] = useState(true)
  const [reduceMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  // Pausado por la persona (pulsar el video): manda sobre todo lo demás.
  const [pausado, setPausado] = useState(reduceMotion)
  const [visible, setVisible] = useState(true)
  const [pestanaVisible, setPestanaVisible] = useState(true)
  const raiz = useRef<HTMLDivElement | null>(null)
  const refs = useRef<Array<HTMLVideoElement | null>>([])
  // El último que arrancó: el que acaba de pasar al centro empieza desde 0
  // (los que esperan muestran el cuadro del segundo 1, ver `CUADRO_PORTADA`).
  const arrancado = useRef<number | null>(null)
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
        if (Math.abs(video.currentTime - CUADRO_PORTADA) > 0.05) video.currentTime = CUADRO_PORTADA
        return
      }
      video.muted = muted
      if (arrancado.current !== i) {
        arrancado.current = i
        video.currentTime = 0
      }
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

  if (total === 0) return null

  const ir = (indice: number) => setActivo(((indice % total) + total) % total)
  const posicion = (i: number) =>
    t('store.videos.position').replace('{n}', String(i + 1)).replace('{total}', String(total))
  const actual = videos[activo]
  const producto = actual?.product_id ? (productos.data ?? []).find((p) => p.product_id === actual.product_id) : undefined
  const fotoProducto = producto?.primary_image_path ? (miniaturas[producto.primary_image_path] ?? null) : null

  return (
    <Box
      ref={raiz}
      component="section"
      aria-roledescription={t('store.videos.carousel')}
      aria-label={t('store.videos.title')}
      data-video-carousel
      className="sf-video-carousel"
      // Ancho completo SIEMPRE: los videos miden un % de la pista, y en un
      // marco que se ajusta al contenido la pista se encogía hasta casi nada.
      sx={{ position: 'relative', width: '100%' }}
    >
      {/*
        CIRCULAR: cada video se coloca por su distancia al activo contando en
        círculo (de -2 a +2), así que siempre hay vecinos a los dos lados,
        también con el primero activo. El que salta de un extremo al otro lo
        hace invisible (opacidad 0), no cruzando la pantalla.
      */}
      <Box
        sx={{
          position: 'relative',
          overflow: 'hidden',
          // Aire arriba y abajo para el activo, que crece un 12 %: la mitad de
          // lo que crece su alto (que es 16/9 de su ancho) a cada lado, y algo
          // más. En % del ANCHO, que es como mide el `padding`.
          py: { xs: '9%', sm: '5%', md: '3.5%' },
        }}
      >
        {/* Da el alto: un video invisible del mismo tamaño, en el flujo. */}
        <Box aria-hidden sx={{ ...anchoVideo, mx: 'auto', aspectRatio: '9 / 16', visibility: 'hidden' }} />
        {videos.map((video, i) => {
          const url = urls[video.path] ?? null
          const esActivo = i === activo
          const d = distanciaCircular(i, activo, total)
          const lejos = Math.abs(d)
          return (
            <Box
              key={video.path}
              aria-roledescription={t('store.videos.slide')}
              aria-label={video.title ?? posicion(i)}
              aria-current={esActivo ? 'true' : undefined}
              data-video-slide={esActivo ? 'active' : 'idle'}
              data-distance={lejos}
              onClick={() => (esActivo ? setPausado((valor) => !valor) : ir(i))}
              sx={{
                ...anchoVideo,
                position: 'absolute',
                left: '50%',
                top: '50%',
                aspectRatio: '9 / 16',
                // Su sitio: centrado y `d` puestos más allá, con el hueco
                // entre videos.
                transform: `translate(calc(-50% + ${d} * (100% + 16px)), -50%) scale(${esActivo ? 1.12 : 1})`,
                // A la vista: el activo y uno por lado en teléfono y tableta,
                // dos por lado en escritorio. Los demás, transparentes.
                opacity: lejos <= 1 ? 1 : lejos === 2 ? { xs: 0, md: 1 } : 0,
                pointerEvents: lejos <= 1 ? 'auto' : lejos === 2 ? { xs: 'none', md: 'auto' } : 'none',
                borderRadius: 'var(--sf-radius-sm, 10px)',
                overflow: 'hidden',
                bgcolor: '#0b0b0b',
                cursor: 'pointer',
                zIndex: esActivo ? 1 : 0,
                boxShadow: esActivo ? '0 18px 40px -18px rgba(0,0,0,.55)' : 'none',
                transition: reduceMotion ? 'none' : 'transform 420ms ease, opacity 300ms ease, box-shadow 320ms ease',
              }}
            >
              {url ? (
                <Box
                  component="video"
                  ref={(nodo: HTMLVideoElement | null) => {
                    refs.current[i] = nodo
                  }}
                  // `#t=1`: sin reproducir, el navegador pinta ese cuadro en
                  // vez de un rectángulo negro.
                  src={`${url}#t=${CUADRO_PORTADA}`}
                  muted
                  playsInline
                  preload={esActivo ? 'auto' : 'metadata'}
                  loop={total === 1}
                  onEnded={() => total > 1 && ir(activo + 1)}
                  aria-label={video.title ?? posicion(i)}
                  sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <Box className="sf-media-shimmer" aria-hidden />
              )}

              {/* Reproducir: en los que esperan, y en el activo si está en pausa. */}
              {!esActivo || pausado ? (
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'grid',
                    placeItems: 'center',
                    color: '#fff',
                    pointerEvents: 'none',
                  }}
                >
                  <PlayArrowRoundedIcon sx={{ fontSize: { xs: 44, md: 52 }, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.45))' }} />
                </Box>
              ) : null}

              {esActivo ? (
                <IconButton
                  onClick={(event) => {
                    event.stopPropagation()
                    setMuted((valor) => !valor)
                  }}
                  aria-pressed={!muted}
                  aria-label={muted ? t('store.videos.unmute') : t('store.videos.mute')}
                  sx={{
                    position: 'absolute',
                    top: 10,
                    right: 10,
                    // Por encima del botón que pausa, que cubre todo el video.
                    zIndex: 1,
                    width: 34,
                    height: 34,
                    color: '#fff',
                    bgcolor: 'rgba(0,0,0,.55)',
                    '&:hover': { bgcolor: 'rgba(0,0,0,.7)' },
                  }}
                >
                  {muted ? <VolumeOffRoundedIcon sx={{ fontSize: 18 }} /> : <VolumeUpRoundedIcon sx={{ fontSize: 18 }} />}
                </IconButton>
              ) : null}

              {/* Pausar/reanudar con el teclado: el video activo es un botón. */}
              {esActivo ? (
                <Box
                  component="button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPausado((valor) => !valor)
                  }}
                  aria-label={pausado ? t('store.videos.play') : t('store.videos.pause')}
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    background: 'transparent',
                    border: 0,
                    cursor: 'pointer',
                    '&:focus-visible': { outline: '3px solid #fff', outlineOffset: -6 },
                  }}
                />
              ) : null}
            </Box>
          )
        })}
      </Box>

      {/* La tarjeta del producto del video activo, centrada bajo él. */}
      {producto ? (
        <Box
          component={Link}
          to={`/s/${storeSlug}/product/${producto.slug}`}
          data-video-product
          sx={{
            display: 'flex',
            mx: 'auto',
            width: { xs: `${ANCHO.xs * 1.12}%`, sm: `${ANCHO.sm * 1.12}%`, md: `${ANCHO.md * 1.12}%` },
            minWidth: 240,
            mt: { xs: 0, md: -0.5 },
            borderRadius: 'var(--sf-radius-sm, 10px)',
            overflow: 'hidden',
            textDecoration: 'none',
            border: '1px solid var(--sf-line, var(--border))',
            '&:hover .sf-video-product-name': { textDecoration: 'underline' },
            '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
          }}
        >
          <Box sx={{ width: 76, flexShrink: 0, bgcolor: 'var(--card)' }}>
            <ProductMedia url={fotoProducto} pending={Boolean(producto.primary_image_path) && !fotoProducto} alt={producto.name} fit="contain" sizePx={16} />
          </Box>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              px: 1.75,
              py: 1.25,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 0.25,
              bgcolor: 'var(--text)',
              color: 'var(--card)',
            }}
          >
            <Box
              className="sf-video-product-name"
              sx={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {producto.name}
            </Box>
            <Box sx={{ fontSize: 12.5, opacity: 0.85 }}>
              {formatMoney(Number(producto.price_from ?? producto.price), producto.currency, locale)}
            </Box>
          </Box>
        </Box>
      ) : null}

      {total > 1 && (
        <>
          <IconButton
            onClick={() => ir(activo - 1)}
            aria-label={t('store.videos.previous')}
            sx={{ ...flecha, left: { xs: 2, md: 8 }, bgcolor: 'var(--card)', color: 'var(--text)' }}
          >
            <ChevronLeftRoundedIcon />
          </IconButton>
          <IconButton
            onClick={() => ir(activo + 1)}
            aria-label={t('store.videos.next')}
            sx={{ ...flecha, right: { xs: 2, md: 8 }, bgcolor: 'var(--text)', color: 'var(--card)', '&:hover': { bgcolor: 'var(--text)' } }}
          >
            <ChevronRightRoundedIcon />
          </IconButton>
          {/* Puntos: quién va y cuántos son; también eligen. */}
          <Box sx={{ display: 'flex', gap: 0.75, justifyContent: 'center', mt: 1.75 }}>
            {videos.map((video, i) => (
              <Box
                key={video.path}
                component="button"
                type="button"
                onClick={() => ir(i)}
                aria-current={i === activo}
                aria-label={posicion(i)}
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
          </Box>
        </>
      )}
    </Box>
  )
}

/** Ancho de cada video en % de la pista: 1,6 a la vista en el teléfono, 3 en tableta, 5 en escritorio. */
const ANCHO = { xs: 62, sm: 31, md: 18.5 } as const

/**
 * El cuadro que enseña un video que espera. El segundo 1 y no el 0: muchos
 * videos abren con un fundido desde negro (o blanco), y el primer cuadro sería
 * un rectángulo vacío en vez de una imagen del producto.
 */
const CUADRO_PORTADA = 1

/** El ancho de un video en la pista, por tamaño de pantalla. */
const anchoVideo = {
  width: { xs: `${ANCHO.xs}%`, sm: `${ANCHO.sm}%`, md: `${ANCHO.md}%` },
} as const

/**
 * Cuántos puestos separan al video `i` del activo, dando la vuelta: con cinco
 * videos y el activo en 0, el 4 está a -1 (a su izquierda), no a +4.
 */
function distanciaCircular(i: number, activo: number, total: number): number {
  const d = (((i - activo) % total) + total) % total
  return d > total / 2 ? d - total : d
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

const flecha = {
  position: 'absolute',
  top: '42%',
  transform: 'translateY(-50%)',
  zIndex: 2,
  width: 40,
  height: 40,
  boxShadow: 'var(--sf-shadow)',
  '&:hover': { bgcolor: 'var(--card)' },
} as const
