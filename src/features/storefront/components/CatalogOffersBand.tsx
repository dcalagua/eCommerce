import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import { Box, Stack, Typography } from '@mui/material'

/**
 * La cabecera de «Ofertas» dentro del catálogo.
 *
 * Antes «Ver todo» de la banda de ofertas encendía un interruptor y el título
 * seguía diciendo «Todo el catálogo»: el comprador llegaba a las ofertas sin
 * que la pantalla se lo dijera. Aquí es una página con nombre propio —el
 * `<h1>` es «Ofertas»— y con la cifra real de lo rebajado.
 *
 * El degradado es el del tenant (`--hero-grad`): cada tienda la ve en su color.
 */
export function CatalogOffersBand({ title, subtitle }: { title: string; subtitle: string | null }) {
  return (
    <Box
      data-catalog-band="offers"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 'var(--sf-radius)',
        background: 'var(--hero-grad)',
        color: '#fff',
        px: { xs: 2.5, md: 4 },
        py: { xs: 2.5, md: 3.5 },
        '&::after': {
          content: '""',
          position: 'absolute',
          right: -80,
          top: -120,
          width: 300,
          height: 300,
          borderRadius: '50%',
          background: 'color-mix(in srgb, #fff 10%, transparent)',
          pointerEvents: 'none',
        },
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, position: 'relative', zIndex: 1 }}>
        <Box
          aria-hidden
          sx={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'color-mix(in srgb, #fff 18%, transparent)',
            flexShrink: 0,
          }}
        >
          <LocalOfferRoundedIcon />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="h1"
            sx={{ fontSize: { xs: 26, md: 34 }, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1 }}
          >
            {title}
          </Typography>
          {subtitle ? (
            <Typography sx={{ fontSize: { xs: 13.5, md: 15 }, opacity: 0.88, mt: 0.25 }}>{subtitle}</Typography>
          ) : null}
        </Box>
      </Stack>
    </Box>
  )
}
