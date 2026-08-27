import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatDateTime, formatMoney } from '@/shared/lib/format'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { OrderError } from './errors'
import { STATUS_COLOR, STATUS_LABEL } from './status'
import { nextStatuses, type Order, type OrderStatus } from './types'
import { useOrder, useOrderEvents, useOrderItems, useUpdateOrderStatus } from './useOrders'

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof OrderError ? error.key : 'orders.error.generic'
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section">
      <Typography
        component="h3"
        sx={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, color: 'var(--muted)', mb: 1 }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', py: 0.4 }}>
      <Typography sx={{ color: 'var(--muted)', fontSize: 13 }}>{label}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: 600, textAlign: 'right' }}>{value}</Typography>
    </Stack>
  )
}

/**
 * Detalle del pedido en panel lateral: el listado sigue detrás, así que quien
 * revisa un pedido no pierde la búsqueda ni la pestaña de estado (mismo criterio
 * que el alta de producto en P04).
 *
 * El **único** camino de escritura es la Edge Function `update-order-status`.
 * Las transiciones que ofrece el desplegable salen de la copia local de la
 * máquina de estados, pero quien decide sigue siendo el trigger de la base: si
 * las dos se separaran, el servidor responde 409 y aquí se ve el motivo.
 */
export function OrderDrawer({
  order,
  open,
  canWrite,
  onClose,
}: {
  order: Order | null
  open: boolean
  canWrite: boolean
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  const { notify } = useFeedback()
  const orderId = order?.id ?? null

  // El pedido se relee: la fila del listado se queda vieja en cuanto cambia el
  // estado, y al lado se estaría pintando una bitácora que sí está al día.
  const detail = useOrder(open ? orderId : null, order ?? undefined)
  const items = useOrderItems(open ? orderId : null)
  const events = useOrderEvents(open ? orderId : null)
  const update = useUpdateOrderStatus()

  const [nextStatus, setNextStatus] = useState<OrderStatus | ''>('')
  const [note, setNote] = useState('')

  // Al abrir otro pedido el formulario arranca limpio: arrastrar la nota del
  // anterior la pegaría en la bitácora del nuevo.
  useEffect(() => {
    setNextStatus('')
    setNote('')
  }, [orderId])

  const current = detail.data ?? order
  if (!current) return null

  const allowed = nextStatuses(current.status)
  const money = (value: string) => formatMoney(Number(value), current.currency, locale)

  const orderRef = current.id

  async function apply() {
    if (!nextStatus) return
    try {
      await update.mutateAsync({ orderId: orderRef, status: nextStatus, note })
      notify(t('orders.toast.updated'))
      setNextStatus('')
      setNote('')
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      busy={update.isPending}
      width={620}
      title={current.order_number}
      subtitle={formatDateTime(current.placed_at, locale)}
      actions={
        <>
          <Button variant="text" onClick={onClose} disabled={update.isPending}>
            {t('common.close')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void apply()}
            disabled={!canWrite || !nextStatus || update.isPending}
          >
            {t('orders.applyStatus')}
          </Button>
        </>
      }
    >
      <Stack spacing={3} divider={<Divider flexItem />}>
        <Section title={t('common.status')}>
          <Stack spacing={1.5}>
            <Box>
              <Chip
                size="small"
                color={STATUS_COLOR[current.status]}
                label={t(STATUS_LABEL[current.status])}
              />
            </Box>

            {!canWrite && <Alert severity="info">{t('orders.status.readOnly')}</Alert>}

            {canWrite && allowed.length === 0 && (
              <Alert severity="info">{t('orders.status.final')}</Alert>
            )}

            {canWrite && allowed.length > 0 && (
              <>
                <TextField
                  select
                  size="small"
                  label={t('orders.newStatus')}
                  value={nextStatus}
                  onChange={(event) => setNextStatus(event.target.value as OrderStatus)}
                >
                  {allowed.map((status) => (
                    <MenuItem key={status} value={status}>
                      {t(STATUS_LABEL[status])}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  label={t('orders.note')}
                  helperText={t('orders.noteHelp')}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  multiline
                  minRows={2}
                  inputProps={{ maxLength: 1000 }}
                />
              </>
            )}
          </Stack>
        </Section>

        <Section title={t('common.customer')}>
          <Field label={t('orders.customer.name')} value={current.customer_name ?? '—'} />
          <Field label={t('orders.customer.email')} value={current.customer_email} />
          <Field label={t('orders.customer.phone')} value={current.customer_phone ?? '—'} />
        </Section>

        <Section title={t('orders.delivery')}>
          <Field
            label={t('orders.delivery.address')}
            value={current.shipping_address?.address || '—'}
          />
          <Field
            label={t('orders.delivery.reference')}
            value={current.shipping_address?.reference || '—'}
          />
        </Section>

        <Section title={t('orders.items')}>
          {items.isPending && <LoadingState />}
          {items.isError && <ErrorState error={items.error} onRetry={() => void items.refetch()} />}
          {items.isSuccess && items.data.length === 0 && (
            <EmptyState title={t('orders.items.empty')} />
          )}
          {items.isSuccess && items.data.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('orders.item.name')}</TableCell>
                  <TableCell align="right">{t('orders.item.qty')}</TableCell>
                  <TableCell align="right">{t('orders.item.unit')}</TableCell>
                  <TableCell align="right">{t('common.total')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.data.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{item.name}</Typography>
                      <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                        {item.sku}
                      </Typography>
                    </TableCell>
                    <TableCell align="right" className="tnum">
                      {item.quantity}
                    </TableCell>
                    <TableCell align="right" className="tnum">
                      {money(item.unit_price)}
                    </TableCell>
                    <TableCell align="right" className="tnum">
                      {money(item.line_total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

        <Section title={t('orders.totals')}>
          <Field label={t('orders.totals.subtotal')} value={money(current.subtotal)} />
          <Field label={t('orders.totals.tax')} value={money(current.tax_total)} />
          <Field label={t('orders.totals.shipping')} value={money(current.shipping_total)} />
          <Field label={t('orders.totals.discount')} value={money(current.discount_total)} />
          <Divider sx={{ my: 1 }} />
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography sx={{ fontWeight: 800 }}>{t('common.total')}</Typography>
            <Typography sx={{ fontWeight: 800 }} className="tnum">
              {money(current.grand_total)}
            </Typography>
          </Stack>
        </Section>

        <Section title={t('orders.history')}>
          {events.isPending && <LoadingState />}
          {events.isError && (
            <ErrorState error={events.error} onRetry={() => void events.refetch()} />
          )}
          {events.isSuccess && events.data.length === 0 && (
            <EmptyState
              title={t('orders.history.empty')}
              description={t('orders.history.emptyBody')}
            />
          )}
          {events.isSuccess && events.data.length > 0 && (
            <Stack spacing={1.5} component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {events.data.map((event) => (
                <Stack key={event.id} component="li" spacing={0.25}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                      {event.from_status
                        ? `${t(STATUS_LABEL[event.from_status])} → ${t(STATUS_LABEL[event.to_status])}`
                        : t('orders.history.created')}
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
                      {formatDateTime(event.created_at, locale)}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
                    {event.actor_email ?? t('orders.history.storefront')}
                  </Typography>
                  {event.note && <Typography sx={{ fontSize: 13 }}>{event.note}</Typography>}
                </Stack>
              ))}
            </Stack>
          )}
        </Section>
      </Stack>
    </FormDrawer>
  )
}
