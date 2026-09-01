import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import ChildCareRoundedIcon from '@mui/icons-material/ChildCareRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import HealingRoundedIcon from '@mui/icons-material/HealingRounded'
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import SanitizerRoundedIcon from '@mui/icons-material/SanitizerRounded'
import SpaRoundedIcon from '@mui/icons-material/SpaRounded'
import VaccinesRoundedIcon from '@mui/icons-material/VaccinesRounded'
import { Box, Button, Stack, Typography } from '@mui/material'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'
import { ScrollRow } from './ScrollRow'

export interface CategoryTile {
  readonly code: string
  readonly name: string
  readonly count: number | null
}

/**
 * Qué cara le ponemos a cada familia.
 *
 * Una píldora que dice «Medicamentos» y otra que dice «Abbott Nutricional» se
 * ven iguales y no son lo mismo, y en una fila de doce nadie las distingue. El
 * icono es lo que separa de un vistazo una familia de otra, antes de leer.
 *
 * Se elige por PALABRA del nombre y no por un campo de la base a propósito: el
 * comercio no tiene dónde declarar un icono, y pedirle que lo haga para que su
 * portada no se vea gris es cobrarle nuestro problema. Cuando no reconoce nada,
 * cae al icono genérico — que sigue siendo mejor que ninguno, porque mantiene
 * la fila alineada.
 */
const ICONOS: readonly (readonly [readonly string[], ComponentType<{ sx?: object }>])[] = [
  [['medicamento', 'farmac', 'etico', 'generico', 'drug'], LocalPharmacyRoundedIcon],
  [['vitamina', 'suplemento', 'nutric', 'vitamin'], VaccinesRoundedIcon],
  [['piel', 'dermo', 'cosmet', 'facial', 'skin'], SpaRoundedIcon],
  [['bebe', 'infantil', 'nino', 'baby'], ChildCareRoundedIcon],
  [['higiene', 'limpieza', 'antisep', 'hygiene'], SanitizerRoundedIcon],
  [['afeitad', 'cabello', 'capilar', 'shav', 'hair'], ContentCutRoundedIcon],
  [['cuidado', 'personal', 'care'], HealingRoundedIcon],
  [['cardio', 'presion', 'corazon', 'diabet', 'heart'], MonitorHeartRoundedIcon],
]

function iconoDe(nombre: string): ComponentType<{ sx?: object }> {
  // Sin tildes y en minúsculas: «Antimicóticos» y «antimicoticos» son la misma
  // palabra, y el catálogo real trae las dos formas.
  const limpio = nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  for (const [palabras, Icono] of ICONOS) {
    if (palabras.some((palabra) => limpio.includes(palabra))) return Icono
  }
  return CategoryRoundedIcon
}

/**
 * Las familias de la tienda, con cara y con cuántas cosas tienen dentro.
 *
 * Sustituye a la fila de píldoras en la PORTADA. Las píldoras siguen siendo lo
 * correcto dentro del catálogo —ahí son un filtro y se comparan de un vistazo—,
 * pero en la portada tienen que ser una puerta, y una puerta necesita decir a
 * dónde lleva y cuánto hay detrás.
 */
export function CategoryTiles({
  categories,
  storeSlug,
  seeAllHref,
}: {
  categories: readonly CategoryTile[]
  storeSlug: string
  seeAllHref?: string
}) {
  const { t } = useI18n()
  if (categories.length === 0) return null

  return (
    <Stack component="section" aria-label={t('store.categories.shopBy')} sx={{ gap: 1.25 }}>
      <Stack direction="row" sx={{ gap: 1.5, alignItems: 'center' }}>
        <Typography
          component="h2"
          sx={{ fontSize: { xs: 19, md: 22 }, fontWeight: 800, letterSpacing: '-0.02em' }}
        >
          {t('store.categories.shopBy')}
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

      <ScrollRow ariaLabel={t('store.categories.shopBy')} gap={1.25}>
        {categories.map((category) => {
          const Icono = iconoDe(category.name)
          return (
            <Box
              key={category.code}
              component={Link}
              to={`/s/${storeSlug}?c=${encodeURIComponent(category.code)}`}
              sx={{
                flexShrink: 0,
                width: 150,
                minHeight: 148,
                p: 1.75,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                textDecoration: 'none',
                color: 'var(--text)',
                borderRadius: 'var(--sf-radius)',
                border: '1px solid var(--sf-line)',
                bgcolor: 'var(--card)',
                boxShadow: 'var(--sf-shadow)',
                transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
                '@media (hover: hover)': {
                  '&:hover': {
                    transform: 'translateY(-2px)',
                    boxShadow: 'var(--sf-shadow-hover)',
                    borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)',
                  },
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transition: 'none',
                  '&:hover': { transform: 'none' },
                },
              }}
            >
              <Box
                aria-hidden
                sx={{
                  width: 42,
                  height: 42,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 'var(--sf-radius-sm)',
                  bgcolor: 'color-mix(in srgb, var(--accent) 14%, var(--card))',
                  color: 'var(--accent-deep)',
                }}
              >
                <Icono sx={{ fontSize: 22 }} />
              </Box>

              <Typography
                sx={{
                  fontSize: 14,
                  fontWeight: 700,
                  lineHeight: 1.3,
                  mt: 'auto',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {category.name}
              </Typography>

              {category.count === null ? null : (
                <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
                  {t('store.brands.count').replace('{count}', String(category.count))}
                </Typography>
              )}
            </Box>
          )
        })}
      </ScrollRow>
    </Stack>
  )
}
