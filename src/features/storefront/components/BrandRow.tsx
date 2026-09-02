import { Box, Button, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'
import { initials } from '../branding'
import { tintFor } from '../tint'
import { ScrollRow } from './ScrollRow'
import { SectionHeading } from './SectionHeading'

export interface BrandOption {
  readonly code: string
  readonly name: string
  readonly count: number | null
}

/**
 * Las marcas de la tienda, como puerta de entrada.
 *
 * En una botica se compra por marca tanto como por categoría: quien busca
 * «Eucerin» no busca «dermocosmética», busca Eucerin. Estaban solo dentro del
 * panel lateral de filtros, que es donde va quien YA está filtrando — y en
 * móvil queda debajo del catálogo, o sea, después de haber recorrido todo.
 *
 * Sale de las FACETAS de la búsqueda, no de una lista aparte: así solo aparecen
 * las marcas que de verdad tienen producto publicado ahora, con cuántos, y
 * nadie tiene que mantener una segunda lista que se queda vieja.
 */
export function BrandRow({
  brands,
  selected,
  onSelect,
  seeAllHref,
}: {
  brands: readonly BrandOption[]
  selected: string | null
  onSelect: (code: string | null) => void
  /** Puerta al catálogo completo, si esta fila la necesita. */
  seeAllHref?: string
}) {
  const { t } = useI18n()
  if (brands.length === 0) return null

  return (
    <Stack
      component="section"
      // Destino del enlace «Marcas». `scroll-margin` por la cabecera pegajosa.
      id="marcas"
      aria-label={t('store.brands.title')}
      sx={{ gap: 1, scrollMarginTop: 96 }}
    >
      <SectionHeading
        title={t('store.brands.title')}
        action={
          seeAllHref ? (
            <Button
              component={Link}
              to={seeAllHref}
              size="small"
              sx={{
                textTransform: 'none',
                fontWeight: 700,
                borderRadius: 'var(--sf-pill)',
                border: '1px solid var(--sf-line-strong)',
                color: 'var(--text)',
                px: 1.75,
                '&:hover': { borderColor: 'var(--accent)', bgcolor: 'transparent' },
              }}
            >
              {t('store.row.seeAll')}
            </Button>
          ) : undefined
        }
      />

      <ScrollRow ariaLabel={t('store.brands.title')} gap={1}>
        {brands.map((brand) => {
          const activa = selected === brand.code
          const tinte = tintFor(brand.name)
          return (
            <Box
              key={brand.code}
              component="button"
              type="button"
              aria-pressed={activa}
              onClick={() => onSelect(activa ? null : brand.code)}
              sx={{
                cursor: 'pointer',
                flexShrink: 0,
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.5,
                py: 1.25,
                width: 190,
                borderRadius: 'var(--sf-radius)',
                // Elegida: manda el acento del comercio, que es el color de lo
                // que esta ACTIVO. Sin elegir: su propio tinte, para que la
                // fila se lea de lado y cada marca tenga sitio propio.
                border: activa ? '1px solid var(--accent)' : `1px solid ${tinte.line}`,
                bgcolor: activa ? 'color-mix(in srgb, var(--accent) 12%, var(--card))' : tinte.bg,
                boxShadow: 'var(--sf-shadow)',
                transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
                '@media (hover: hover)': {
                  '&:hover': {
                    transform: 'translateY(-2px)',
                    boxShadow: 'var(--sf-shadow-hover)',
                    borderColor: activa ? 'var(--accent)' : tinte.fg,
                  },
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transition: 'none',
                  '&:hover': { transform: 'none' },
                },
              }}
            >
              {/* El monograma hace de logo mientras no haya logo.
                  Un catálogo de marcas sin imagen es una lista de texto gris
                  donde ninguna se distingue de la de al lado; con dos letras
                  sobre el acento del comercio, cada una tiene forma propia y la
                  fila se lee de lado. El día que la marca traiga logo, va en su
                  sitio sin mover nada más. */}
              <Box
                aria-hidden
                sx={{
                  width: 40,
                  height: 40,
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '50%',
                  bgcolor: tinte.fg,
                  color: tinte.bg,
                  fontSize: 14,
                  fontWeight: 800,
                  letterSpacing: '0.02em',
                  boxShadow: `0 6px 16px -8px ${tinte.fg}`,
                }}
              >
                {initials(brand.name)}
              </Box>

              <Box sx={{ minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 800,
                    lineHeight: 1.25,
                    color: activa ? 'var(--accent-deep)' : tinte.fg,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {brand.name}
                </Typography>
                {/* El contador solo cuando se sabe: con un filtro puesto, el
                    resto sale a cero y ese cero significaría «no hay nada»
                    cuando en realidad significa «no te lo he contado». */}
                {brand.count === null ? null : (
                  <Typography
                    sx={{
                      fontSize: TS.label,
                      fontWeight: 600,
                      color: activa ? 'var(--muted)' : tinte.fg,
                      opacity: activa ? 1 : 0.75,
                    }}
                  >
                    {t('store.brands.count').replace('{count}', String(brand.count))}
                  </Typography>
                )}
              </Box>
            </Box>
          )
        })}
      </ScrollRow>
    </Stack>
  )
}
