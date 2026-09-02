import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import { Box, Button, Card, Drawer, IconButton, Stack, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/states'
import { TS } from '@/theme/tokens'
import { CartLineList } from './CartLineList'
import { useCart } from './cart-context'

/**
 * Panel lateral del carrito.
 *
 * Se abre solo al añadir algo: el comprador ve qué acaba de meter sin perder la
 * página en la que estaba, que es justo lo que se pierde al mandarlo al carrito
 * a página completa. La página `/cart` sigue existiendo para revisar con calma.
 */
export function CartDrawer({ storeSlug }: { storeSlug: string }) {
  const { t, locale } = useI18n()
  const { cart, count, subtotal, currency, isOpen, closeCart } = useCart()
  const empty = cart.lines.length === 0

  return (
    <Drawer
      anchor="right"
      open={isOpen}
      onClose={closeCart}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 400 }, bgcolor: 'var(--card)' } } }}
      aria-label={t('store.cart.title')}
    >
      <Stack sx={{ height: '100%' }}>
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            px: 2,
            py: 1.5,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Typography component="h2" sx={{ fontSize: 16, fontWeight: 800 }}>
            {t('store.cart.title')}
            {count > 0 && (
              <Box component="span" sx={{ color: 'var(--muted)', fontWeight: 700 }}>
                {' '}
                ({count})
              </Box>
            )}
          </Typography>
          <IconButton onClick={closeCart} aria-label={t('common.cancel')} size="small">
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* `--bg` y no `--card`: la zona de las líneas se hunde un tono y las
            líneas se ven sobre ella, en vez de flotar en un panel blanco donde
            un carrito de un solo producto parece medio vacío. */}
        <Box sx={{ flex: 1, overflowY: 'auto', px: 2, py: 2, bgcolor: 'var(--bg)' }}>
          {empty ? (
            <EmptyState
              title={t('store.cart.empty')}
              description={t('store.cart.emptyBody')}
              icon={<ShoppingCartRoundedIcon fontSize="small" />}
            />
          ) : (
            <Card sx={{ p: 1.5 }}>
              <CartLineList cart={cart} storeSlug={storeSlug} onNavigate={closeCart} compact />
            </Card>
          )}
        </Box>

        {!empty && (
          /* El pie se ancla abajo con su propia sombra: sin ella, con una sola
             línea, el subtotal y el botón quedaban colgando al final de un
             hueco y no se leían como el cierre del panel. */
          <Box
            sx={{
              px: 2,
              py: 2,
              bgcolor: 'var(--card)',
              borderTop: '1px solid var(--border)',
              boxShadow: '0 -8px 20px -18px rgba(0,0,0,0.45)',
            }}
          >
            <Stack
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}
            >
              <Typography sx={{ fontWeight: 700, fontSize: TS.bodyStrong }}>
                {t('store.cart.subtotal')}
              </Typography>
              <Typography className="tnum" sx={{ fontWeight: 800, fontSize: 20 }}>
                {formatMoney(Number(subtotal), currency, locale)}
              </Typography>
            </Stack>
            {/* El impuesto y el total definitivos los calcula el servidor al
                confirmar: aquí no se promete un número que no es el de cobro. */}
            <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', mt: 0.5, mb: 1.75 }}>
              {t('store.cart.taxNote')}
            </Typography>
            <Stack sx={{ gap: 0.5 }}>
              <Button
                component={Link}
                to={`/s/${storeSlug}/checkout`}
                variant="contained"
                size="large"
                onClick={closeCart}
                fullWidth
                sx={{ textTransform: 'none', fontWeight: 800 }}
              >
                {t('store.cart.checkout')}
              </Button>
              <Button
                component={Link}
                to={`/s/${storeSlug}/cart`}
                onClick={closeCart}
                fullWidth
                sx={{ textTransform: 'none', fontWeight: 700 }}
              >
                {t('store.cart.view')}
              </Button>
            </Stack>
          </Box>
        )}
      </Stack>
    </Drawer>
  )
}
