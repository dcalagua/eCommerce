import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded'
import { Box, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'
import { initials } from '../branding'
import { tintFor } from '../tint'

/**
 * Las marcas que respaldan la tienda, al cierre de la portada.
 *
 * No es la fila de «Compra por marca» —esa es navegación, con su contador y su
 * filtro—: esto es una prueba social. Quien duda de una botica en línea deja de
 * dudar cuando reconoce los nombres que ya compra en la farmacia de la esquina,
 * y por eso va abajo, que es donde se decide comprar o cerrar.
 *
 * Sale de las MARCAS REALES del catálogo, en orden de tamaño: nadie mantiene
 * una lista de logos aparte, y una lista escrita a mano acabaría enseñando una
 * marca que la tienda dejó de vender.
 */
export function BrandTrustStrip({
  brands,
  storeSlug,
}: {
  brands: readonly { code: string; name: string }[]
  storeSlug: string
}) {
  const { t } = useI18n()
  if (brands.length === 0) return null

  return (
    <Box
      component="section"
      aria-label={t('store.trust.title')}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: { xs: 1.5, md: 2.5 },
        p: { xs: 2, md: 2.5 },
        borderRadius: 'var(--sf-radius)',
        border: '1px solid var(--sf-line)',
        bgcolor: 'var(--card)',
      }}
    >
      <Typography sx={{ fontSize: 13.5, fontWeight: 800, mr: { md: 1 } }}>
        {t('store.trust.title')}
      </Typography>

      {brands.slice(0, 8).map((brand) => {
        const tinte = tintFor(brand.name)
        return (
          <Box
            key={brand.code}
            component={Link}
            to={`/s/${storeSlug}?b=${encodeURIComponent(brand.code)}`}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              textDecoration: 'none',
              color: 'var(--muted)',
              transition: 'color .15s ease',
              '&:hover': { color: tinte.fg },
            }}
          >
            {/* Mientras la marca no traiga logo, sus iniciales sobre su tinte:
                una fila de nombres en gris no se distingue de un pie de página,
                y lo que aquí hace falta es RECONOCER de un vistazo. */}
            <Box
              aria-hidden
              sx={{
                width: 26,
                height: 26,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '50%',
                bgcolor: tinte.bg,
                color: tinte.fg,
                fontSize: 10.5,
                fontWeight: 800,
              }}
            >
              {initials(brand.name)}
            </Box>
            <Typography sx={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {brand.name}
            </Typography>
          </Box>
        )
      })}

      <Stack
        direction="row"
        sx={{ gap: 0.75, alignItems: 'center', ml: 'auto', color: 'var(--accent-deep)' }}
      >
        <VerifiedRoundedIcon sx={{ fontSize: 18 }} />
        <Typography sx={{ fontSize: TS.label, fontWeight: 700 }}>
          {t('store.trust.original')}
        </Typography>
      </Stack>
    </Box>
  )
}
