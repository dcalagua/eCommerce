import { Box, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'
import { BrandLogo } from './BrandLogo'
import type { BrandOption } from './BrandRow'

/** Cuántas marcas caben en la tira antes de la casilla «Ver todas». */
export const MARCAS_EN_TIRA = 5

/**
 * Las marcas en UNA TIRA compacta (tema Catálogo, propuestas 29 y 29b).
 *
 * El muro de logotipos repartía cinco círculos con su inicial a lo ancho de la
 * pantalla: sin logos subidos se leía como un hueco con cinco puntos. Aquí cada
 * marca es una casilla con su logo —o su monograma— y cuántos productos tiene.
 *
 * ## Con muchas marcas
 *
 * La tira no crece: se enseñan las cinco con MÁS productos, que son por donde
 * más se entra, y una sexta casilla «+N · Ver todas» que lleva al catálogo.
 * Una tira de cuarenta marcas no se recorre; se abandona.
 *
 * Pulsar una marca filtra la vitrina, igual que en la fila de tarjetas.
 */
export function BrandStrip({
  brands,
  selected,
  onSelect,
  seeAllHref,
}: {
  brands: readonly BrandOption[]
  selected: string | null
  onSelect: (code: string | null) => void
  seeAllHref: string
}) {
  const { t } = useI18n()
  if (brands.length === 0) return null

  // Las de más productos primero; sin cuenta conocida, al final y por nombre.
  const ordenadas = [...brands].sort(
    (a, b) => (b.count ?? -1) - (a.count ?? -1) || a.name.localeCompare(b.name),
  )
  const visibles = ordenadas.slice(0, MARCAS_EN_TIRA)
  const resto = brands.length - visibles.length

  const casilla = {
    display: 'flex',
    alignItems: 'center',
    gap: 1.25,
    minWidth: 0,
    px: 1.5,
    py: 1,
    borderRadius: 'var(--sf-radius-sm)',
    textAlign: 'left',
    textDecoration: 'none',
    cursor: 'pointer',
    transition: 'border-color .18s ease, background-color .18s ease',
    '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  } as const

  return (
    <Box
      component="section"
      id="marcas"
      aria-label={t('store.brands.title')}
      data-brand-strip={visibles.length}
      sx={{
        scrollMarginTop: 'var(--sf-anchor-offset, 96px)',
        display: 'grid',
        gap: 1.5,
        alignItems: 'center',
        gridTemplateColumns: { xs: '1fr', md: '170px minmax(0, 1fr)' },
        p: { xs: 1.75, md: 2.25 },
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        bgcolor: 'var(--card)',
      }}
    >
      <Stack sx={{ gap: 0.25 }}>
        <Typography component="h2" sx={{ fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>
          {t('store.brands.title')}
        </Typography>
        <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
          {t('store.brands.total').replace('{n}', String(brands.length))}
        </Typography>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: 1,
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            sm: 'repeat(3, minmax(0, 1fr))',
            lg: `repeat(${visibles.length + (resto > 0 ? 1 : 0)}, minmax(0, 1fr))`,
          },
        }}
      >
        {visibles.map((brand) => {
          const activa = selected === brand.code
          return (
            <Box
              key={brand.code}
              component="button"
              type="button"
              aria-pressed={activa}
              onClick={() => onSelect(activa ? null : brand.code)}
              sx={{
                ...casilla,
                font: 'inherit',
                color: 'var(--text)',
                border: '1px solid',
                borderColor: activa ? 'var(--accent)' : 'var(--sf-line)',
                bgcolor: activa ? 'color-mix(in srgb, var(--accent) 10%, var(--card))' : 'var(--card)',
                '@media (hover: hover)': { '&:hover': { borderColor: 'var(--accent)' } },
              }}
            >
              <BrandLogo name={brand.name} url={brand.logoUrl ?? null} size={36} />
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: 14, fontWeight: 700, lineHeight: 1.25 }}>
                  {brand.name}
                </Typography>
                {brand.count === null ? null : (
                  <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
                    {t('store.brands.count').replace('{count}', String(brand.count))}
                  </Typography>
                )}
              </Box>
            </Box>
          )
        })}

        {resto > 0 ? (
          <Box
            component={Link}
            to={seeAllHref}
            data-brand-strip-more={resto}
            sx={{
              ...casilla,
              color: 'var(--text)',
              bgcolor: 'var(--accent-soft)',
              border: '1px solid transparent',
              '@media (hover: hover)': { '&:hover': { borderColor: 'var(--accent)' } },
            }}
          >
            <Box
              aria-hidden
              sx={{
                width: 36,
                height: 36,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 'var(--sf-radius-sm)',
                bgcolor: 'var(--accent-deep)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 800,
              }}
            >
              +{resto}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 800, lineHeight: 1.25, color: 'var(--accent-deep)' }}>
                {t('store.brands.seeAll')}
              </Typography>
              <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
                {t('store.brands.more').replace('{n}', String(resto))}
              </Typography>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
