import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import { Box, Stack, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { Countdown } from './Countdown'

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
export function CatalogOffersBand({
  title,
  subtitle,
  kicker = null,
  endsAt = null,
}: {
  title: string
  subtitle: string | null
  /** Resumen v2 · El nombre de la campaña que antes termina, encima del título. */
  kicker?: string | null
  /** Resumen v2 · Su fin REAL: con él, la cuenta regresiva a la derecha. */
  endsAt?: string | null
}) {
  const { t } = useI18n()
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
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {kicker ? (
            <Box
              component="span"
              sx={{ display: 'inline-block', mb: 0.5, px: 1, borderRadius: 'var(--sf-pill)', bgcolor: '#fff', color: 'var(--accent-deep)', fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              {kicker}
            </Box>
          ) : null}
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
        {endsAt ? (
          <Stack sx={{ alignItems: 'flex-end', gap: 0.5, display: { xs: 'none', sm: 'flex' } }}>
            <Typography sx={{ fontSize: 11.5, fontWeight: 700, opacity: 0.9 }}>{t('store.catalog.endsIn')}</Typography>
            <Countdown endsAt={endsAt} />
          </Stack>
        ) : null}
      </Stack>
    </Box>
  )
}
