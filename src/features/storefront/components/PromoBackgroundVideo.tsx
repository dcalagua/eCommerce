import { Box } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useSignedStoreAssets } from '../hooks'

/**
 * El video de fondo de una promoción (2026-10-04 · migración 20261004110000).
 *
 * Se pone DENTRO del hueco de la imagen (o de la banda entera): ocupa todo,
 * mudo, en bucle y sin controles — es ambiente, no algo que mirar. La imagen
 * sigue debajo, y es lo que se ve:
 *
 *  - mientras el video llega (aparece con un fundido cuando ya pinta),
 *  - si no carga,
 *  - con `prefers-reduced-motion`, donde ni siquiera se pide.
 *
 * Fuera de la pantalla se pausa: una portada con tres campañas en video no
 * tiene por qué tener tres videos corriendo por detrás.
 *
 * `scrim` oscurece encima del video para que el texto blanco que va sobre él
 * se lea siempre (WCAG AA), sea cual sea el video. Quien lo pone es quien tiene
 * texto encima; el hueco de una foto al lado del texto no lo necesita.
 *
 * Quien lo usa: el contenedor tiene `position: relative` y `overflow: hidden`,
 * y su contenido va por encima con `position: relative; z-index: 1`.
 */
export function PromoBackgroundVideo({ path, scrim = false }: { path: string; scrim?: boolean }) {
  const urls = useSignedStoreAssets([path])
  const url = urls[path] ?? null
  const video = useRef<HTMLVideoElement | null>(null)
  const [listo, setListo] = useState(false)
  const [reduceMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )

  // Solo suena (mudo) mientras se ve.
  useEffect(() => {
    const nodo = video.current
    if (!nodo || typeof IntersectionObserver === 'undefined') return
    const observador = new IntersectionObserver(
      ([entrada]) => {
        if (entrada?.isIntersecting) {
          try {
            const intento: Promise<void> | undefined = nodo.play()
            if (intento && typeof intento.catch === 'function') intento.catch(() => undefined)
          } catch {
            // Sin reproducción: queda la imagen, que es el respaldo.
          }
        } else {
          nodo.pause()
        }
      },
      { threshold: 0.2 },
    )
    observador.observe(nodo)
    return () => observador.disconnect()
  }, [url])

  if (reduceMotion || !url) return null

  return (
    <Box aria-hidden data-promo-video sx={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
      <Box
        component="video"
        ref={video}
        src={url}
        muted
        loop
        playsInline
        autoPlay
        preload="auto"
        disablePictureInPicture
        onPlaying={() => setListo(true)}
        onError={() => setListo(false)}
        sx={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          opacity: listo ? 1 : 0,
          transition: 'opacity 500ms ease',
        }}
      />
      {scrim ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            // Más oscuro donde va el texto (izquierda y abajo).
            background: 'linear-gradient(90deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.5) 55%, rgba(0,0,0,.35) 100%)',
          }}
        />
      ) : null}
    </Box>
  )
}
