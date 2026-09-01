import ChildCareRoundedIcon from '@mui/icons-material/ChildCareRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import HealingRoundedIcon from '@mui/icons-material/HealingRounded'
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import SanitizerRoundedIcon from '@mui/icons-material/SanitizerRounded'
import PsychologyRoundedIcon from '@mui/icons-material/PsychologyRounded'
import SpaRoundedIcon from '@mui/icons-material/SpaRounded'
import VaccinesRoundedIcon from '@mui/icons-material/VaccinesRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WaterDropRoundedIcon from '@mui/icons-material/WaterDropRounded'
import { Box, Button, Stack, Typography } from '@mui/material'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { T } from '@/theme/tokens'
import { initials } from '../branding'
import { tintFor } from '../tint'
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
  [['nervioso', 'neuro', 'psiq', 'sueno', 'nerve'], PsychologyRoundedIcon],
  [['desodorante', 'antitranspirante', 'deo'], WaterDropRoundedIcon],
  [['ocular', 'oftalm', 'ojo', 'vision', 'eye'], VisibilityRoundedIcon],
]

/**
 * Devuelve `null` cuando no reconoce la familia.
 *
 * Antes caia a un icono generico, y con el catalogo real —donde media lista son
 * nombres de marca colados como categoria— la fila acababa siendo siete cajas
 * con el MISMO pictograma: peor que no tener icono, porque promete una
 * distincion que no existe. Sin icono se pintan sus iniciales, igual que las
 * marcas: dos letras distinguen; siete iconos iguales, no.
 */
function iconoDe(nombre: string): ComponentType<{ sx?: object }> | null {
  // Sin tildes y en minúsculas: «Antimicóticos» y «antimicoticos» son la misma
  // palabra, y el catálogo real trae las dos formas.
  const limpio = nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  for (const [palabras, Icono] of ICONOS) {
    if (palabras.some((palabra) => limpio.includes(palabra))) return Icono
  }
  return null
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
          const tinte = tintFor(category.name)
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
                borderRadius: 'var(--sf-radius)',
                // Fondo de color, opaco: en una fila de doce cajas grises
                // ninguna se distingue de la de al lado, y no hay donde volver
                // la vista para «la que mire antes».
                border: `1px solid ${tinte.line}`,
                bgcolor: tinte.bg,
                color: tinte.fg,
                boxShadow: 'var(--sf-shadow)',
                transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
                '@media (hover: hover)': {
                  '&:hover': {
                    transform: 'translateY(-2px)',
                    boxShadow: 'var(--sf-shadow-hover)',
                    borderColor: tinte.fg,
                  },
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transition: 'none',
                  '&:hover': { transform: 'none' },
                },
              }}
            >
              {/* El icono, con peso: relleno, sobre un disco del color del
                  tinte y en blanco. A 22 px y en linea fina se leia como un
                  pictograma de formulario, no como la cara de una familia. */}
              <Box
                aria-hidden
                sx={{
                  width: 46,
                  height: 46,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '50%',
                  bgcolor: tinte.fg,
                  color: tinte.bg,
                  boxShadow: `0 6px 16px -8px ${tinte.fg}`,
                }}
              >
                {Icono ? (
                  <Icono sx={{ fontSize: 26 }} />
                ) : (
                  <Box component="span" sx={{ fontSize: 15, fontWeight: 800 }}>
                    {initials(category.name)}
                  </Box>
                )}
              </Box>

              <Typography
                sx={{
                  fontSize: 14,
                  fontWeight: 800,
                  lineHeight: 1.3,
                  mt: 'auto',
                  color: tinte.fg,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {category.name}
              </Typography>

              {category.count === null ? null : (
                <Typography
                  sx={{ fontSize: T.label, color: tinte.fg, opacity: 0.75, fontWeight: 600 }}
                >
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
