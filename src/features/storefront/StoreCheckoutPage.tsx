import { zodResolver } from '@hookform/resolvers/zod'
import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Alert, Box, Button, Card, Divider, Stack, TextField, Typography } from '@mui/material'
import { useMutation } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'
import { useCartQuote } from '@/features/pricing/useCartQuote'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { useCart } from './cart/cart-context'
import { CheckoutError, checkoutSchema, createOrder, type CheckoutValues } from './checkout'
import { useStorefront } from './hooks'

/**
 * Checkout mínimo: nombre, correo, teléfono, dirección y una referencia
 * opcional. **Sin pasarela de pago** (P06 no la incluye): el pedido queda en
 * `pending` y la tienda cobra por su canal.
 *
 * El importe que se ve aquí se lo pregunta al SERVIDOR (P04-SaaS): la misma
 * función que va a cobrar el pedido. Antes era el subtotal del carrito, que es
 * de escaparate; con listas de precio por canal y escalas por cantidad, enseñar
 * ese número al lado del botón de comprar es prometer un importe que no se ha
 * calculado. Si la cotización no llega, se cae al subtotal local y la
 * confirmación sigue mostrando los números del servidor, que son los que mandan.
 */
export function StoreCheckoutPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { storeSlug } = useStorefront()
  const { cart, subtotal, currency, clear } = useCart()
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)

  // El array entra en la clave de la consulta: uno nuevo por render la
  // invalidaría en bucle. Se arma con la forma del PUERTO, no con la del
  // transporte: quien cotiza puede ser mañana el ERP del tenant.
  const requests = useMemo(
    () =>
      cart.lines.map((line) => ({
        productId: line.product_id,
        variantId: line.variant_id,
        uomCode: null,
        quantity: line.quantity,
      })),
    [cart.lines],
  )
  const quote = useCartQuote(storeSlug, currency, requests)
  const quoted = quote.data ?? null

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CheckoutValues>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      customerName: '',
      customerEmail: '',
      customerPhone: '',
      address: '',
      reference: '',
    },
  })

  const mutation = useMutation({
    mutationFn: (values: CheckoutValues) => createOrder({ ...values, storeSlug, cart }),
    onSuccess: (order) => {
      // El carrito se vacía SOLO cuando el servidor confirmó el pedido. Si se
      // vaciara al enviar, un error de red dejaría al comprador sin carrito y
      // sin pedido.
      clear()
      // El token va en la URL, no solo en el state del router: es lo que hace
      // que la confirmacion sobreviva a una recarga y se pueda guardar.
      const permalink = order.access_token
        ? `/s/${storeSlug}/order/${order.order_number}?t=${order.access_token}`
        : `/s/${storeSlug}/order/${order.order_number}`
      navigate(permalink, {
        replace: true,
        state: { order },
      })
    },
    onError: (error) => {
      setErrorKey(error instanceof CheckoutError ? error.key : 'store.checkout.error.generic')
    },
  })

  if (cart.lines.length === 0 && !mutation.isPending) {
    return (
      <>
        <PageHeader title={t('store.checkout.title')} />
        <Card>
          <EmptyState
            title={t('store.cart.empty')}
            description={t('store.cart.emptyBody')}
            icon={<ShoppingCartOutlinedIcon fontSize="small" />}
            action={
              <Button component={Link} to={`/s/${storeSlug}`} variant="contained">
                {t('store.cart.continue')}
              </Button>
            }
          />
        </Card>
      </>
    )
  }

  const onSubmit = handleSubmit((values) => {
    // Doble candado contra el doble envío: el botón se deshabilita mientras la
    // mutación está en vuelo y, además, un segundo submit (Enter repetido, doble
    // clic rápido) no llega a disparar nada.
    if (mutation.isPending) return
    setErrorKey(null)
    mutation.mutate(values)
  })

  return (
    <>
      <PageHeader title={t('store.checkout.title')} subtitle={t('store.checkout.subtitle')} />

      <Box
        component="form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          display: 'grid',
          gap: { xs: 2, md: 3 },
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.4fr) minmax(0, 1fr)' },
          alignItems: 'start',
        }}
      >
        <Card sx={{ p: { xs: 2, md: 3 } }}>
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 2 }}>
            {t('store.checkout.contact')}
          </Typography>

          <Stack sx={{ gap: 2 }}>
            <TextField
              label={t('store.checkout.name')}
              autoComplete="name"
              required
              error={Boolean(errors.customerName)}
              helperText={errors.customerName ? t(errors.customerName.message as MessageKey) : ' '}
              {...register('customerName')}
            />
            <TextField
              label={t('store.checkout.email')}
              type="email"
              autoComplete="email"
              required
              error={Boolean(errors.customerEmail)}
              helperText={
                errors.customerEmail
                  ? t(errors.customerEmail.message as MessageKey)
                  : t('store.checkout.emailHint')
              }
              {...register('customerEmail')}
            />
            <TextField
              label={t('store.checkout.phone')}
              type="tel"
              autoComplete="tel"
              required
              error={Boolean(errors.customerPhone)}
              helperText={errors.customerPhone ? t(errors.customerPhone.message as MessageKey) : ' '}
              {...register('customerPhone')}
            />
            <TextField
              label={t('store.checkout.address')}
              autoComplete="street-address"
              required
              error={Boolean(errors.address)}
              helperText={errors.address ? t(errors.address.message as MessageKey) : ' '}
              {...register('address')}
            />
            <TextField
              label={t('store.checkout.reference')}
              error={Boolean(errors.reference)}
              helperText={
                errors.reference
                  ? t(errors.reference.message as MessageKey)
                  : t('store.checkout.referenceHint')
              }
              {...register('reference')}
            />
          </Stack>
        </Card>

        <Card sx={{ p: { xs: 2, md: 2.5 } }}>
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 1.5 }}>
            {t('store.cart.summary')}
          </Typography>

          <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0, gap: 0.75 }}>
            {cart.lines.map((line) => (
              <Stack
                component="li"
                key={line.product_id}
                direction="row"
                sx={{ justifyContent: 'space-between', gap: 1, fontSize: T.body }}
              >
                <Typography sx={{ fontSize: T.body, color: 'var(--muted)', fontWeight: 600 }}>
                  {line.quantity} × {line.name}
                </Typography>
                <Typography sx={{ fontSize: T.body, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {formatMoney(Number(line.unit_price) * line.quantity, line.currency, locale)}
                </Typography>
              </Stack>
            ))}
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography sx={{ fontWeight: 700 }}>{t('store.cart.subtotal')}</Typography>
            <Typography sx={{ fontWeight: 800 }}>
              {formatMoney(
                Number(quoted?.netTotal ?? subtotal),
                quoted?.currency ?? currency,
                locale,
              )}
            </Typography>
          </Stack>

          {quoted && Number(quoted.taxTotal) > 0 && (
            <Stack direction="row" sx={{ justifyContent: 'space-between', mt: 0.5 }}>
              <Typography sx={{ color: 'var(--muted)' }}>{t('store.cart.tax')}</Typography>
              <Typography sx={{ color: 'var(--muted)' }}>
                {formatMoney(Number(quoted.taxTotal), quoted.currency, locale)}
              </Typography>
            </Stack>
          )}

          {quoted && (
            <Stack direction="row" sx={{ justifyContent: 'space-between', mt: 1 }}>
              <Typography sx={{ fontWeight: 800 }}>{t('store.cart.total')}</Typography>
              <Typography sx={{ fontWeight: 800 }}>
                {formatMoney(Number(quoted.grossTotal), quoted.currency, locale)}
              </Typography>
            </Stack>
          )}

          <Typography sx={{ fontSize: T.label, color: 'var(--muted)', mt: 0.5 }}>
            {quote.isPending
              ? t('store.cart.quoting')
              : quoted
                ? t('store.cart.quoted')
                : t('store.cart.taxNote')}
          </Typography>

          {errorKey && (
            <Alert severity="error" sx={{ mt: 2 }} role="alert">
              {t(errorKey)}
            </Alert>
          )}

          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={mutation.isPending}
            sx={{ mt: 2 }}
          >
            {mutation.isPending ? t('store.checkout.sending') : t('store.checkout.submit')}
          </Button>

          <Typography sx={{ fontSize: T.label, color: 'var(--muted)', mt: 1.5 }}>
            {t('store.checkout.noPayment')}
          </Typography>
        </Card>
      </Box>
    </>
  )
}
