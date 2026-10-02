import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import { Box } from '@mui/material'
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import { R } from '@/theme/tokens'
import { tintFor } from '../tint'

/**
 * Imagen de producto con un hueco que parece INTENCIONADO.
 *
 * El catálogo casi nunca llega con todas las fotos puestas, y el bucket es
 * privado, así que una firma caducada también deja el `src` vacío. Lo que se
 * pinta entonces no puede ser —y hasta P07 era— un rectángulo gris con un icono
 * de imagen en medio: eso es exactamente lo que dibuja un esqueleto de carga, y
 * media rejilla así se lee como una tienda que no terminó de cargar.
 *
 * ## Qué se pinta ahora
 *
 * Un panel con el tinte que le toca al NOMBRE del producto —los mismos seis
 * tintes de orientación que usan las puertas de categoría y las marcas—, una
 * trama de puntos muy suave y, en el centro, el icono dentro de un disco con
 * «Foto próximamente» debajo cuando hay sitio (2026-10-02: la marca de agua
 * enorme en la esquina se leía como un error de maquetación). Se lee como una
 * pieza diseñada, no como un fallo.
 *
 * ## Tres estados, no dos (2026-10-02)
 *
 * Antes, mientras la foto se firmaba o se descargaba, se pintaba el marcador
 * de «sin foto»: la tienda parecía no tener fotos y de golpe las tenía. Ahora:
 *
 *  - **cargando** — `pending` (la ruta existe pero aún no hay URL firmada) o la
 *    URL ya está y el navegador la sigue bajando: un esqueleto con un brillo
 *    que cruza (quieto con `prefers-reduced-motion`).
 *  - **foto** — aparece con un fundido corto, sin salto.
 *  - **sin foto** — el panel de arriba. También si la descarga FALLA, y si la
 *    firma no llega en unos segundos: un esqueleto eterno es peor que decir
 *    que no hay foto.
 *
 * El tinte sale del nombre y no al azar: el mismo producto cae siempre en el
 * mismo color, así que una rejilla sin fotos se puede recorrer —cada hueco
 * tiene sitio propio— y recargar no lo baraja.
 *
 * ## Lo que sigue sin pintarse
 *
 * Ni un logotipo, ni una imagen de archivo, ni una marca de agua de la suite:
 * nada que le ponga a la tienda una identidad que no eligió. Los tintes son
 * señalización, no marca — el acento del comercio sigue siendo el único color
 * de acción.
 */
export function ProductMedia({
  url,
  alt,
  ratio = '1 / 1',
  sizePx = 28,
  eager = false,
  fit = 'cover',
  pending = false,
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
  /**
   * Cómo encaja la foto. Además de los dos literales acepta una VARIABLE de CSS
   * (Storefront V3 · P02): así la decisión la toma el tema en la frontera
   * —`--sf-media-fit`— y este componente no tiene que preguntar qué tema hay
   * puesto. Sigue habiendo reserva, por si la variable no existe.
   */
  fit?: 'cover' | 'contain' | (string & {})
  /** Hay foto pero su URL aún no llegó: esqueleto en vez de «sin foto». */
  pending?: boolean
}) {
  const { t } = useI18n()
  const tinte = tintFor(alt)
  const [carga, setCarga] = useState<{ url: string | null; estado: 'loading' | 'ready' | 'error' }>({
    url,
    estado: 'loading',
  })
  // El estado es de ESTA url: al cambiar de foto vuelve a «cargando» solo.
  const estado = carga.url === url ? carga.estado : 'loading'

  // Una firma que no llega no puede dejar el esqueleto brillando para siempre.
  const [vencido, setVencido] = useState(false)
  useEffect(() => {
    if (!pending || url) return
    setVencido(false)
    const reloj = window.setTimeout(() => setVencido(true), ESPERA_MAXIMA_MS)
    return () => window.clearTimeout(reloj)
  }, [pending, url])

  // La que ya estaba en caché puede terminar antes de que React enganche el
  // `onLoad`: se mira `complete` al montar el nodo.
  const alMontar = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth > 0) setCarga({ url, estado: 'ready' })
    },
    [url],
  )

  const conFoto = Boolean(url) && estado !== 'error'
  const cargando = (conFoto && estado === 'loading') || (!url && pending && !vencido)
  const conTexto = sizePx >= 28

  return (
    <Box
      data-media={conFoto ? 'photo' : cargando ? 'loading' : 'placeholder'}
      aria-busy={cargando || undefined}
      sx={{
        position: 'relative',
        aspectRatio: ratio,
        width: '100%',
        // Con foto, el color de la TARJETA. Era gris, y con `contain` una foto
        // que no es cuadrada dejaba dos franjas grises arriba y abajo: parecía
        // una imagen rota. Las fotos de catálogo vienen sobre blanco, así que el
        // sobrante se funde con la tarjeta. Sin foto, el tinte del producto.
        // Rediseño v3: el fondo lo pone el ESTILO (`--sf-photo-bg`); retail y
        // premium apoyan la foto sobre un gris cálido y la funden con
        // `multiply`, así el blanco de estudio se vuelve el papel del estilo.
        ...(conFoto || cargando
          ? { bgcolor: 'var(--sf-photo-bg, var(--card))', color: 'var(--muted)' }
          : {
              background: `radial-gradient(circle at 50% 42%, color-mix(in srgb, #fff 55%, transparent) 0%, transparent 62%), linear-gradient(160deg, ${tinte.bg} 0%, color-mix(in srgb, ${tinte.fg} 12%, ${tinte.bg}) 100%)`,
              color: tinte.fg,
            }),
        borderRadius: `var(--sf-radius-sm, ${R.md}px)`,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {conFoto && url ? (
        <Box
          component="img"
          ref={alMontar}
          src={url}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setCarga({ url, estado: 'ready' })}
          onError={() => setCarga({ url, estado: 'error' })}
          className="sf-media-img"
          data-ready={estado === 'ready' || undefined}
          sx={{
            width: '100%',
            height: '100%',
            objectFit: fit,
            // Centrada de verdad: con `contain` el hueco sobrante se reparte a
            // los dos lados en vez de quedarse todo abajo.
            objectPosition: 'center',
            display: 'block',
            mixBlendMode: 'var(--sf-media-blend, normal)',
          }}
        />
      ) : null}

      {cargando ? <Box aria-hidden className="sf-media-shimmer" /> : null}

      {!conFoto && !cargando ? (
        <>
          {/* Trama de puntos: textura de papel, no un patrón que se lea. */}
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              opacity: 0.18,
              backgroundImage: 'radial-gradient(currentColor 1px, transparent 1.2px)',
              backgroundSize: '14px 14px',
              maskImage: 'radial-gradient(circle at 50% 45%, transparent 18%, #000 75%)',
              pointerEvents: 'none',
            }}
          />
          <Box
            sx={{
              position: 'relative',
              display: 'grid',
              justifyItems: 'center',
              gap: 1,
              px: 1,
              textAlign: 'center',
            }}
          >
            <Box
              aria-hidden
              sx={{
                width: sizePx * 2.1,
                height: sizePx * 2.1,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                bgcolor: 'color-mix(in srgb, #fff 72%, transparent)',
                boxShadow: `0 0 0 1px color-mix(in srgb, ${tinte.fg} 14%, transparent), 0 6px 18px -8px color-mix(in srgb, ${tinte.fg} 45%, transparent)`,
              }}
            >
              <ImageOutlinedIcon sx={{ fontSize: sizePx, opacity: 0.85 }} />
            </Box>
            {conTexto ? (
              <Box
                component="span"
                sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', opacity: 0.8, lineHeight: 1.3 }}
              >
                {t('store.media.noPhoto')}
              </Box>
            ) : null}
          </Box>
        </>
      ) : null}
    </Box>
  )
}

/** Cuánto se espera una URL firmada antes de dar la foto por perdida. */
const ESPERA_MAXIMA_MS = 8000
