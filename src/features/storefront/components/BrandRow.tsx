import { Box, Button, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'
import { ScrollRow } from './ScrollRow'

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
    <Stack sx={{ gap: 1 }}>
      <Stack direction="row" sx={{ gap: 1.5, alignItems: 'center' }}>
        <Typography
          component="h2"
          sx={{ fontSize: { xs: 19, md: 22 }, fontWeight: 800, letterSpacing: '-0.02em' }}
        >
          {t('store.brands.title')}
        </Typography>
        {seeAllHref ? (
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
        ) : null}
      </Stack>

      <ScrollRow ariaLabel={t('store.brands.title')} gap={1}>
        {brands.map((brand) => {
          const activa = selected === brand.code
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
                px: 2,
                py: 1.25,
                minWidth: 132,
                borderRadius: 'var(--sf-radius-sm)',
                border: activa
                  ? '1px solid color-mix(in srgb, var(--accent) 55%, transparent)'
                  : '1px solid var(--sf-line)',
                bgcolor: activa ? 'color-mix(in srgb, var(--accent) 12%, var(--card))' : 'var(--card)',
                transition: 'border-color .15s ease, background-color .15s ease',
                '@media (hover: hover)': {
                  '&:hover': { borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' },
                },
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            >
              <Typography
                sx={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: activa ? 'var(--accent-deep)' : 'var(--text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {brand.name}
              </Typography>
              {/* El contador solo cuando se sabe: con un filtro puesto, el resto
                  sale a cero y ese cero significaría «no hay nada» cuando en
                  realidad significa «no te lo he contado». */}
              {brand.count === null ? null : (
                <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
                  {t('store.brands.count').replace('{count}', String(brand.count))}
                </Typography>
              )}
            </Box>
          )
        })}
      </ScrollRow>
    </Stack>
  )
}
