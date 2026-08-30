import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded'
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatDateTime } from '@/shared/lib/format'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { PaymentsError } from './errors'
import {
  usePaymentAttempts,
  usePaymentEvents,
  usePaymentIntents,
  usePaymentsOf,
  useRefundsOf,
  useRequestRefund,
} from './hooks'
import { INTENT_STATUSES, newIdempotencyKey, type PaymentIntent } from './types'

const STATUS_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  open: 'default',
  processing: 'info',
  requires_action: 'warning',
  authorized: 'info',
  captured: 'success',
  failed: 'error',
  cancelled: 'default',
  expired: 'default',
}

/**
 * Los cobros: estado, intentos, fallos, referencia y devolución.
 *
 * Es la pantalla que el criterio 10 de la fase describe punto por punto, y cada
 * columna existe por una pregunta concreta que alguien hace un lunes:
 *
 *   estado           «¿cobró o no?»
 *   intentos/fallos  «¿se intentó una vez o cinco?»
 *   referencia       «¿qué número le doy al banco?»
 *   código de error  el del proveedor, SIN traducir: es el que ellos entienden
 *
 * Lo que NO sale: ni un secreto, ni el sobre crudo del proveedor, ni un token.
 * Y ningún botón que mueva un cobro a mano — no hay policy que lo permitiera y
 * un botón que siempre falla es peor que ningún botón.
 *
 * La devolución es lo único que se puede pedir desde aquí, con su clave de
 * idempotencia generada en el navegador: pulsar dos veces devuelve una vez.
 */
export function IntentsSection() {
  const { t, locale } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, can } = useTenant()
  const canRefund = can('orders.write')

  const [status, setStatus] = useState('')
  const [term, setTerm] = useState('')
  const [selected, setSelected] = useState<PaymentIntent | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [refundKey, setRefundKey] = useState('')

  const intents = usePaymentIntents({ storeId: activeStore?.id ?? null, status, term })
  const attempts = usePaymentAttempts(selected?.intent_id ?? null)
  const events = usePaymentEvents(selected?.intent_id ?? null)
  const payments = usePaymentsOf(selected?.intent_id ?? null)
  const paymentIds = useMemo(() => (payments.data ?? []).map((p) => p.id), [payments.data])
  const refunds = useRefundsOf(paymentIds)
  const requestRefund = useRequestRefund()

  const list = intents.data ?? []
  const isEmpty = !intents.isPending && !intents.isError && list.length === 0
  const refundable = (payments.data ?? []).find((p) => p.status !== 'refunded') ?? null

  function open(intent: PaymentIntent) {
    setSelected(intent)
    setRefundAmount('')
    setRefundReason('')
    // Una clave por apertura del panel: es lo que ancla ESTA devolución.
    setRefundKey(newIdempotencyKey('refund'))
  }

  async function submitRefund() {
    if (!refundable) return
    try {
      await requestRefund.mutateAsync({
        paymentId: refundable.id,
        amount: refundAmount.trim(),
        reason: refundReason,
        idempotencyKey: refundKey,
      })
      notify(t('payments.refund.created'), 'success')
      setRefundAmount('')
      setRefundReason('')
    } catch (error) {
      const key: MessageKey =
        error instanceof PaymentsError ? error.key : 'payments.error.generic'
      notify(t(key), 'error')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('payments.intents.help')}</Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="center">
        <Box sx={{ flex: 1, width: '100%' }}>
          <SearchField
            value={term}
            onChange={setTerm}
            placeholder={t('payments.intents.search')}
          />
        </Box>
        <TextField
          select
          size="small"
          label={t('common.status')}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          sx={{ minWidth: 200 }}
          SelectProps={{ native: true }}
        >
          <option value="">{t('payments.status.all')}</option>
          {INTENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(`payments.status.${value}` as MessageKey)}
            </option>
          ))}
        </TextField>
      </Stack>

      <Card>
        {intents.isPending && <TableSkeleton columns={6} />}
        {intents.isError && (
          <ErrorState error={intents.error} onRetry={() => void intents.refetch()} />
        )}
        {isEmpty && (
          <EmptyState
            title={t('payments.intents.empty')}
            description={t('payments.intents.emptyBody')}
            icon={<PaymentsRoundedIcon fontSize="small" />}
          />
        )}
        {!intents.isPending && !intents.isError && list.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('common.date')}</TableCell>
                <TableCell>{t('payments.field.order')}</TableCell>
                <TableCell>{t('payments.field.method')}</TableCell>
                <TableCell align="right">{t('payments.field.amount')}</TableCell>
                <TableCell align="right">{t('payments.field.attempts')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((intent) => (
                <TableRow
                  key={intent.intent_id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => open(intent)}
                >
                  <TableCell>{formatDateTime(intent.created_at, locale)}</TableCell>
                  <TableCell>
                    {intent.order_number ?? (
                      <Chip size="small" label={t('payments.intents.noOrder')} />
                    )}
                  </TableCell>
                  <TableCell>{intent.method_name}</TableCell>
                  <TableCell align="right">
                    {intent.amount} {intent.currency}
                  </TableCell>
                  <TableCell align="right">
                    {intent.attempt_count}
                    {intent.failed_attempt_count > 0 && (
                      <Chip
                        size="small"
                        color="error"
                        sx={{ ml: 1 }}
                        label={intent.failed_attempt_count}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={STATUS_COLOR[intent.status] ?? 'default'}
                      label={t(`payments.status.${intent.status}` as MessageKey)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <FormDrawer
        open={selected !== null}
        title={t('payments.detail.title')}
        subtitle={selected?.order_number ?? selected?.method_name}
        width={640}
        onClose={() => setSelected(null)}
        actions={<Button onClick={() => setSelected(null)}>{t('common.close')}</Button>}
      >
        {selected && (
          <Stack spacing={3}>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{t('payments.detail.summary')}</Typography>
              <Typography sx={{ color: 'var(--muted)' }}>
                {selected.amount} {selected.currency} ·{' '}
                {t(`payments.status.${selected.status}` as MessageKey)}
              </Typography>
              <Typography sx={{ color: 'var(--muted)' }}>
                {t('payments.field.reference')}: {selected.provider_reference ?? '—'}
              </Typography>
              {selected.last_error_code && (
                <Alert severity="warning">
                  {t('payments.field.providerCode')}: {selected.last_error_code}
                </Alert>
              )}
            </Stack>

            <Divider />

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t('payments.detail.attempts')}</Typography>
              {(attempts.data ?? []).length === 0 && (
                <Typography sx={{ color: 'var(--muted)' }}>{t('payments.detail.none')}</Typography>
              )}
              {(attempts.data ?? []).map((attempt) => (
                <Stack key={attempt.id} direction="row" spacing={1} alignItems="center">
                  <Chip size="small" label={`#${attempt.attempt_no}`} />
                  <Typography variant="body2">{attempt.operation}</Typography>
                  <Chip
                    size="small"
                    color={attempt.status === 'succeeded' ? 'success' : 'error'}
                    label={t(`payments.attempt.${attempt.status}` as MessageKey)}
                  />
                  <Typography variant="body2" sx={{ color: 'var(--muted)' }}>
                    {attempt.provider_result_code ?? attempt.error_code ?? ''}
                  </Typography>
                </Stack>
              ))}
            </Stack>

            <Divider />

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t('payments.detail.timeline')}</Typography>
              {(events.data ?? []).map((event) => (
                <Stack key={event.id} direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" sx={{ color: 'var(--muted)', minWidth: 140 }}>
                    {formatDateTime(event.created_at, locale)}
                  </Typography>
                  <Typography variant="body2">{event.event_type}</Typography>
                  <Chip
                    size="small"
                    label={t(`payments.source.${event.source}` as MessageKey)}
                  />
                  {event.source === 'provider_webhook' && (
                    <Chip
                      size="small"
                      color={event.signature_verified ? 'success' : 'error'}
                      label={t(
                        event.signature_verified
                          ? 'payments.detail.signed'
                          : 'payments.detail.unsigned',
                      )}
                    />
                  )}
                </Stack>
              ))}
            </Stack>

            <Divider />

            <Stack spacing={1.5}>
              <Typography variant="subtitle2">{t('payments.detail.refunds')}</Typography>
              {(refunds.data ?? []).map((refund) => (
                <Stack key={refund.id} direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2">
                    {refund.amount} {refund.currency}
                  </Typography>
                  <Chip
                    size="small"
                    label={t(`payments.refund.${refund.status}` as MessageKey)}
                  />
                  <Typography variant="body2" sx={{ color: 'var(--muted)' }}>
                    {refund.requested_email ?? ''}
                  </Typography>
                </Stack>
              ))}

              {refundable && canRefund && (
                <Stack spacing={1.5}>
                  <Alert severity="info">{t('payments.refund.help')}</Alert>
                  <TextField
                    label={t('payments.field.refundAmount')}
                    value={refundAmount}
                    onChange={(event) => setRefundAmount(event.target.value)}
                    placeholder={refundable.amount}
                    size="small"
                  />
                  <TextField
                    label={t('payments.field.refundReason')}
                    value={refundReason}
                    onChange={(event) => setRefundReason(event.target.value)}
                    size="small"
                  />
                  <Button
                    variant="outlined"
                    color="error"
                    disabled={requestRefund.isPending || refundAmount.trim() === ''}
                    onClick={() => void submitRefund()}
                  >
                    {t('payments.refund.request')}
                  </Button>
                </Stack>
              )}
              {!canRefund && (
                <Typography sx={{ color: 'var(--muted)' }}>
                  {t('payments.refund.noPermission')}
                </Typography>
              )}
            </Stack>
          </Stack>
        )}
      </FormDrawer>
    </Stack>
  )
}
