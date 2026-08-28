import { zodResolver } from '@hookform/resolvers/zod'
import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined'
import { Alert, AlertTitle, Box, Button, Card, Chip, Divider, Stack, TextField, Typography } from '@mui/material'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'
import { useSessionContext } from '@/features/auth/session-context'
import { useCartQuote } from '@/features/pricing/useCartQuote'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { useCart } from './cart/cart-context'
import {
  CheckoutError,
  checkoutSchema,
  clearPendingAttempt,
  mapCheckoutStage,
  newIdempotencyKey,
  readPendingAttempt,
  startCheckout,
  writePendingAttempt,
  type CheckoutStage,
  type CheckoutValues,
} from './checkout'
import { useStorefront } from './hooks'

/**
 * Checkout: nombre, correo, teléfono, dirección y una referencia opcional.
 * **Sin pasarela de pago**: el pedido queda en `pending` y la tienda cobra por
 * su canal.
 *
 * El importe que se ve aquí se lo pregunta al SERVIDOR (P04-SaaS): la misma
 * función que va a cobrar el pedido. El subtotal del carrito es de escaparate;
 * con listas de precio por canal y escalas por cantidad, enseñar ese número al
 * lado del botón de comprar es prometer un importe que no se ha calculado. Si
 * la cotización no llega, se cae al subtotal local, se dice, y la confirmación
 * sigue mostrando los números del servidor, que son los que mandan.
 *
 * ## Lo que P07 añade a esta pantalla
 *
 * 1. **Una clave de idempotencia por intento de compra.** Se genera al montar y
 *    se conserva mientras dure el intento: los reintentos —el del comprador y
 *    el de la red— viajan con la MISMA clave, así que el servidor devuelve el
 *    mismo pedido en vez de crear el segundo. El botón deshabilitado sigue
 *    estando, pero como cortesía: la garantía es del servidor.
 *
 * 2. **Recuperación después de recargar.** Si quedó un intento a medias en esta
 *    pestaña, se recupera su clave y se le dice al comprador que volver a
 *    enviar no duplica nada. Lo único que se guarda es la clave y la hora — ni
 *    el nombre, ni el correo, ni la dirección.
 *
 * 3. **El error dice en qué etapa murió.** «No pudimos apartar el stock» en vez
 *    de «algo salió mal», porque el servidor manda la etapa con el código. Y el
 *    aviso recibe el foco: sin eso, quien navega con lector de pantalla pulsa
 *    comprar y no se entera de que no pasó nada.
 *
 * 4. **Un cambio de precio detiene la compra UNA vez.** El servidor lo detecta
 *    comparando su cotización con el snapshot del carrito —el navegador no
 *    manda ni un céntimo— y la pantalla ofrece confirmar con el precio nuevo,
 *    que reintenta con la misma clave y `accept_price_changes`.
 */
export function StoreCheckoutPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { storeSlug } = useStorefront()
  const { cart, subtotal, currency, cartToken, clear } = useCart()
  const { status: sessionStatus } = useSessionContext()
  const authenticated = sessionStatus === 'authenticated'

  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const [errorStage, setErrorStage] = useState<CheckoutStage | null>(null)
  const [priceChanged, setPriceChanged] = useState(false)
  const alertRef = useRef<HTMLDivElement | null>(null)

  /**
   * La clave del intento. Se recupera la pendiente de esta pestaña si la hay
   * —para que reenviar devuelva el pedido que quizá ya existe— y si no, se
   * genera una nueva. `useState` con inicializador: una clave nueva por render
   * convertiría cada reintento en un pedido distinto, que es justo lo contrario
   * de lo que hace falta.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => readPendingAttempt(storeSlug)?.key ?? newIdempotencyKey(),
  )
  const [resuming] = useState(() => readPendingAttempt(storeSlug) !== null)

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
      couponCode: '',
    },
  })

  const mutation = useMutation({
    mutationFn: (input: { values: CheckoutValues; acceptPriceChanges: boolean }) => {
      writePendingAttempt(storeSlug, { key: idempotencyKey, startedAt: Date.now() })
      return startCheckout({
        ...input.values,
        storeSlug,
        cart,
        idempotencyKey,
        cartToken,
        acceptPriceChanges: input.acceptPriceChanges,
        authenticated,
      })
    },
    onSuccess: (order) => {
      // El intento se cierra y el carrito se vacía SOLO cuando el servidor
      // confirmó el pedido. Si se vaciara al enviar, un error de red dejaría al
      // comprador sin carrito y sin pedido.
      clearPendingAttempt(storeSlug)
      clear()
      // El token va en la URL, no solo en el state del router: es lo que hace
      // que la confirmacion sobreviva a una recarga y se pueda guardar.
      const permalink = order.access_token
        ? `/s/${storeSlug}/order/${order.order_number}?t=${order.access_token}`
        : `/s/${storeSlug}/order/${order.order_number}`
      navigate(permalink, { replace: true, state: { order } })
    },
    onError: (error) => {
      const checkoutError = error instanceof CheckoutError ? error : null
      setErrorKey(checkoutError?.key ?? 'store.checkout.error.generic')
      setErrorStage(checkoutError?.stage ?? null)
      setPriceChanged(checkoutError?.code === 'PRECIO_CAMBIADO')

      if (checkoutError?.code === 'PRECIO_CAMBIADO') {
        // Los precios que se ven al lado del botón dejaron de ser los buenos.
        void quote.refetch()
      }
      if (checkoutError?.code === 'IDEMPOTENCIA_EN_CONFLICTO') {
        // Esa clave ya está atada a otra petición: seguir usándola es garantía
        // de fallar otra vez. Se empieza un intento nuevo.
        clearPendingAttempt(storeSlug)
        setIdempotencyKey(newIdempotencyKey())
      }
    },
  })

  /**
   * Foco accesible en el error. Sin esto, quien usa lector de pantalla pulsa
   * «Confirmar pedido», no pasa nada visible para él y no tiene forma de saber
   * que hay un aviso arriba. El `role="alert"` lo anuncia; el foco es lo que
   * deja el cursor donde está la explicación y el botón de reintento.
   */
  useEffect(() => {
    if (errorKey) alertRef.current?.focus()
  }, [errorKey])

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

  const submit = (acceptPriceChanges: boolean) =>
    handleSubmit((values) => {
      // Doble candado contra el doble envío: el botón se deshabilita mientras la
      // mutación está en vuelo y, además, un segundo submit (Enter repetido, doble
      // clic rápido) no llega a disparar nada. Ninguno de los dos es la garantía:
      // la garantía es la clave de idempotencia del servidor.
      if (mutation.isPending) return
      setErrorKey(null)
      setErrorStage(null)
      mutation.mutate({ values, acceptPriceChanges })
    })

  const stageKey = mapCheckoutStage(errorStage)

  return (
    <>
      <PageHeader title={t('store.checkout.title')} subtitle={t('store.checkout.subtitle')} />

      {resuming && !mutation.isSuccess && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>{t('store.checkout.resumeTitle')}</AlertTitle>
          {t('store.checkout.resumeBody')}
        </Alert>
      )}

      <Box
        component="form"
        onSubmit={submit(false)}
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
            {/* P10 · el cupón. Un solo campo, y lo que se manda es TEXTO: si
                descuenta y cuánto lo decide el servidor, que vuelve a evaluar
                con la fila delante y bloqueada. Aquí no se valida contra nada:
                comprobarlo en el navegador sería una segunda autoridad sobre el
                mismo dato, y la del navegador siempre acaba desactualizada. */}
            <TextField
              label={t('store.checkout.coupon')}
              error={Boolean(errors.couponCode)}
              helperText={
                errors.couponCode
                  ? t(errors.couponCode.message as MessageKey)
                  : t('store.checkout.couponHint')
              }
              inputProps={{ style: { textTransform: 'uppercase' } }}
              {...register('couponCode')}
            />
          </Stack>
        </Card>

        <Card sx={{ p: { xs: 2, md: 2.5 } }}>
          <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 1.5 }}>
            {t('store.cart.summary')}
          </Typography>

          {/* Resumen previo COMPLETO: qué, cuántas, a cuánto la unidad y cuánto
              suma la línea. Un resumen que solo enseña el total obliga a
              confiar; este se puede comprobar. */}
          <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0, gap: 1 }}>
            {cart.lines.map((line) => {
              const quotedLine = quoted?.lines.find(
                (item) =>
                  item.productId === line.product_id &&
                  (item.variantId ?? null) === line.variant_id,
              )
              const unitPrice = quotedLine?.unitPrice.amount ?? line.unit_price
              const lineCurrency = quoted?.currency ?? line.currency
              return (
                <Stack
                  component="li"
                  key={`${line.product_id}|${line.variant_id ?? ''}`}
                  direction="row"
                  sx={{ justifyContent: 'space-between', gap: 1, fontSize: T.body }}
                >
                  <Stack sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontSize: T.body, color: 'var(--muted)', fontWeight: 600 }}>
                      {line.quantity} × {line.name}
                    </Typography>
                    <Typography sx={{ fontSize: T.label, color: 'var(--muted)' }}>
                      {formatMoney(Number(unitPrice), lineCurrency, locale)} · {t('store.cart.each')}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontSize: T.body, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {formatMoney(Number(unitPrice) * line.quantity, lineCurrency, locale)}
                  </Typography>
                </Stack>
              )
            })}
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

          {/* Estado de la cotización: siempre uno de los tres, nunca el vacío.
              «Confirmando precios…» tiene que poder distinguirse de «este es el
              precio» y de «no pudimos confirmarlo». */}
          <Typography sx={{ fontSize: T.label, color: 'var(--muted)', mt: 0.5 }}>
            {quote.isFetching
              ? t('store.cart.quoting')
              : quoted
                ? t('store.cart.quoted')
                : quote.isError
                  ? t('store.cart.quoteFailed')
                  : t('store.cart.taxNote')}
          </Typography>

          {priceChanged && (
            <Chip
              size="small"
              color="warning"
              label={t('store.cart.priceChanged')}
              sx={{ mt: 1 }}
            />
          )}

          {errorKey && (
            <Alert
              severity="error"
              sx={{ mt: 2 }}
              role="alert"
              tabIndex={-1}
              ref={alertRef}
            >
              {t(errorKey)}
              {stageKey && (
                <Typography component="span" sx={{ display: 'block', fontSize: T.label, mt: 0.5 }}>
                  {t(stageKey)}
                </Typography>
              )}
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

          {/* Confirmar el precio nuevo reintenta con la MISMA clave: es la misma
              compra, no una segunda. */}
          {priceChanged && !mutation.isPending && (
            <Button
              type="button"
              variant="outlined"
              fullWidth
              sx={{ mt: 1 }}
              onClick={() => void submit(true)()}
            >
              {t('store.checkout.acceptPrices')}
            </Button>
          )}

          <Typography sx={{ fontSize: T.label, color: 'var(--muted)', mt: 1.5 }}>
            {t('store.checkout.noPayment')}
          </Typography>
        </Card>
      </Box>
    </>
  )
}
