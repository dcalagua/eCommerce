import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded'
import { Box, Button, Container, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { TS } from '@/theme/tokens'
import type { PublicStore } from '../types'
import { StoreBrandLockup } from './StoreBrandLockup'

/**
 * La cabecera del pago: la marca, «pago seguro» y la vuelta al carrito.
 *
 * En el checkout la cabecera completa —buscador, categorías, cuenta, carrito—
 * es una fila de puertas de salida en el paso donde menos conviene abrir
 * ninguna. Lo que queda es lo que da confianza (de quién es la tienda y que el
 * pago es seguro) y la única salida que tiene sentido: volver al carrito.
 */
export function CheckoutHeader({ store, storeSlug }: { store: PublicStore; storeSlug: string }) {
  const { t } = useI18n()
  return (
    <Box
      component="header"
      className="sf-header"
      data-header-variant="checkout"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        bgcolor: 'var(--card)',
        borderBottom: '1px solid var(--sf-line)',
      }}
    >
      <Container maxWidth={false} disableGutters sx={{ maxWidth: 'var(--sf-content-w)', mx: 'auto' }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', gap: { xs: 1, md: 2 }, px: { xs: 2, md: 3 }, minHeight: { xs: 56, md: 64 } }}
        >
          <StoreBrandLockup store={store} storeSlug={storeSlug} size="md" />
          <Box sx={{ flex: 1 }} />
          <Stack
            direction="row"
            sx={{ alignItems: 'center', gap: 0.5, color: 'var(--accent-deep)', display: { xs: 'none', sm: 'flex' } }}
          >
            <VerifiedUserRoundedIcon aria-hidden sx={{ fontSize: 18 }} />
            <Typography sx={{ fontSize: TS.label, fontWeight: 800 }}>{t('store.checkout.secure')}</Typography>
          </Stack>
          <Button
            component={Link}
            to={`/s/${storeSlug}/cart`}
            size="small"
            startIcon={<ArrowBackRoundedIcon />}
            sx={{ textTransform: 'none', fontWeight: 700 }}
          >
            {t('store.checkout.backToCart')}
          </Button>
        </Stack>
      </Container>
    </Box>
  )
}
