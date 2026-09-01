import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import { Box, IconButton } from '@mui/material'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'

/**
 * Fila que se desplaza en horizontal, con flechas y bordes difuminados.
 *
 * ## El problema que resuelve
 *
 * Una fila con `overflow-x: auto` funciona con el dedo y con el trackpad, y no
 * funciona con el raton de sobremesa: no hay rueda horizontal, la barra la
 * esconde el sistema, y lo unico que queda es una pildora cortada por el borde
 * que no parece pulsable ni arrastrable. Las flechas son ese gesto que faltaba.
 *
 * ## Por que las flechas aparecen y desaparecen
 *
 * Solo hay flecha si hay algo a lo que ir: se recalcula al desplazarse y al
 * cambiar el tamano de la ventana. Una flecha muerta en el borde es peor que no
 * tenerla, porque se pulsa y no pasa nada, y a partir de ahi no se vuelve a
 * pulsar la que si funciona.
 *
 * El difuminado del borde es la otra mitad del mensaje: dice «esto sigue» sin
 * ocupar sitio. Se pinta solo del lado por el que queda contenido.
 *
 * ## Accesibilidad
 *
 * Las flechas son un ATAJO, no el unico camino: la fila conserva su
 * desplazamiento nativo y su orden de tabulacion, asi que con teclado se
 * recorre tabulando por las pildoras —el navegador las trae a la vista solo— y
 * con lector de pantalla se lee entera. Por eso las flechas van `aria-hidden`
 * para el lector: repetirian una navegacion que ya existe.
 */
export function ScrollRow({
  children,
  gap = 1,
  ariaLabel,
  component = 'div',
}: {
  children: ReactNode
  gap?: number
  ariaLabel?: string
  component?: 'div' | 'nav'
}) {
  const { t } = useI18n()
  const track = useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const node = track.current
    if (!node) return
    const max = node.scrollWidth - node.clientWidth
    setEdges({ left: node.scrollLeft > 8, right: node.scrollLeft < max - 8 })
  }, [])

  useEffect(() => {
    measure()
    const node = track.current
    if (!node) return
    node.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      node.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [measure, children])

  function slide(direction: -1 | 1) {
    const node = track.current
    if (!node) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Un poco menos de una pantalla: deja a la vista lo ultimo que se estaba
    // mirando, que es lo que evita perder el hilo entre salto y salto.
    node.scrollBy({ left: direction * node.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' })
  }

  return (
    <Box sx={{ position: 'relative' }}>
      <Box
        ref={track}
        component={component}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        sx={{
          display: 'flex',
          gap,
          overflowX: 'auto',
          scrollSnapType: 'x proximity',
          // La barra roba altura en movil y no aporta: el corte en el borde y
          // las flechas ya cuentan que hay mas.
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
          // Sitio para la flecha, y solo cuando hay flecha: sin esto, el
          // ultimo elemento queda debajo del boton y se lee cortado. Con la
          // fila entera a la vista no se indenta nada.
          pl: edges.left ? 5 : 0.25,
          pr: edges.right ? 5 : 0.25,
          py: 0.5,
          transition: 'padding .2s ease',
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        }}
      >
        {children}
      </Box>

      {(['left', 'right'] as const).map((side) =>
        edges[side] ? (
          <Box key={side}>
            {/* Difuminado: dice «esto sigue» sin ocupar sitio ni tapar nada
                pulsable (`pointerEvents: none`). */}
            <Box
              aria-hidden
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                [side]: 0,
                width: 64,
                pointerEvents: 'none',
                background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--bg), transparent)`,
              }}
            />
            <IconButton
              size="small"
              onClick={() => slide(side === 'left' ? -1 : 1)}
              aria-hidden
              tabIndex={-1}
              title={side === 'left' ? t('store.scroll.prev') : t('store.scroll.next')}
              sx={{
                position: 'absolute',
                top: '50%',
                transform: 'translateY(-50%)',
                // Dentro, no a -6 px. Un botón que asoma fuera de su contenedor
                // es ancho de página que nadie pidió: basta con que el elemento
                // de más a la derecha sobresalga para que el documento entero
                // gane barra horizontal.
                [side]: 2,
                width: 34,
                height: 34,
                bgcolor: 'var(--card)',
                color: 'var(--text)',
                border: '1px solid var(--sf-line-strong)',
                boxShadow: 'var(--sf-shadow)',
                '&:hover': { bgcolor: 'var(--accent-soft)', color: 'var(--accent-deep)' },
              }}
            >
              {side === 'left' ? (
                <ChevronLeftRoundedIcon fontSize="small" />
              ) : (
                <ChevronRightRoundedIcon fontSize="small" />
              )}
            </IconButton>
          </Box>
        ) : null,
      )}
    </Box>
  )
}
