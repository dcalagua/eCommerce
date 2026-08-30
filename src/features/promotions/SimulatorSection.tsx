import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import {
  Alert,
  Button,
  Card,
  Chip,
  Divider,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState } from '@/shared/ui/states'
import { PromotionsError } from './errors'
import { useSimulate } from './hooks'
import type { Simulation } from './types'

interface Line {
  productId: string
  quantity: string
}

/**
 * El simulador: «¿qué le pasaría a este carrito?» (regla 9 del encargo).
 *
 * Es la única forma de comprobar una prioridad, una exclusión o un solapamiento
 * ANTES de que lo descubra un comprador — y la única de comprobar una campaña
 * programada, porque acepta una FECHA y responde qué pasaría ese día.
 *
 * Lo que hace que sirva de algo: **usa el mismo motor**. `promotion_simulate`
 * llama a `ebim.evaluate_promotions`, exactamente igual que el carrito de la
 * vitrina y que `create_order`. Un simulador con su propia lógica responde lo
 * que el programador creía, no lo que el sistema hace, y eso es peor que no
 * tener simulador.
 *
 * Y enseña las dos mitades: qué se aplicó **y qué no, con su motivo**. La
 * segunda es la que resuelve el ticket de soporte de verdad («¿por qué mi
 * cupón no hace nada?»).
 */
export function SimulatorSection() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { activeStore } = useTenant()

  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '1' }])
  const [coupons, setCoupons] = useState('')
  const [at, setAt] = useState('')
  const [result, setResult] = useState<Simulation | null>(null)

  const simulate = useSimulate()

  function update(index: number, patch: Partial<Line>) {
    setLines((previous) =>
      previous.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    )
  }

  async function run() {
    if (!activeStore) return
    const items = lines
      .filter((line) => line.productId.trim() !== '' && Number(line.quantity) > 0)
      .map((line) => ({
        productId: line.productId.trim(),
        variantId: null,
        quantity: Number(line.quantity),
      }))
    if (items.length === 0) {
      notify(t('promotions.simulator.needLines'), 'error')
      return
    }
    try {
      setResult(
        await simulate.mutateAsync({
          storeId: activeStore.id,
          items,
          // Los códigos se separan por coma o espacio: es como los pega quien
          // está probando, no como los formatearía un programador.
          couponCodes: coupons
            .split(/[\s,]+/)
            .map((code) => code.trim())
            .filter((code) => code !== ''),
          channelId: null,
          segmentId: null,
          customerId: null,
          at: at === '' ? null : at,
        }),
      )
    } catch (error) {
      const key: MessageKey =
        error instanceof PromotionsError ? error.key : 'promotions.error.generic'
      notify(t(key), 'error')
      setResult(null)
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('promotions.simulator.help')}</Typography>

      <Card sx={{ p: 2 }}>
        <Stack spacing={2}>
          {lines.map((line, index) => (
            <Stack key={index} direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                label={t('promotions.simulator.product')}
                value={line.productId}
                onChange={(event) => update(index, { productId: event.target.value })}
                helperText={index === 0 ? t('promotions.hint.target') : undefined}
                fullWidth
              />
              <TextField
                size="small"
                label={t('promotions.simulator.quantity')}
                value={line.quantity}
                onChange={(event) => update(index, { quantity: event.target.value })}
                sx={{ width: 120 }}
              />
              <IconButton
                aria-label={t('promotions.simulator.removeLine')}
                onClick={() => setLines((previous) => previous.filter((_, i) => i !== index))}
                disabled={lines.length === 1}
              >
                <span aria-hidden>×</span>
              </IconButton>
            </Stack>
          ))}
          <Button
            size="small"
            onClick={() => setLines((previous) => [...previous, { productId: '', quantity: '1' }])}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('promotions.simulator.addLine')}
          </Button>

          <Divider />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              size="small"
              label={t('promotions.simulator.coupons')}
              value={coupons}
              onChange={(event) => setCoupons(event.target.value)}
              helperText={t('promotions.hint.simulatorCoupons')}
              fullWidth
            />
            <TextField
              size="small"
              type="datetime-local"
              label={t('promotions.simulator.at')}
              value={at}
              onChange={(event) => setAt(event.target.value)}
              helperText={t('promotions.hint.simulatorAt')}
              InputLabelProps={{ shrink: true }}
              fullWidth
            />
          </Stack>

          <Button
            variant="contained"
            onClick={() => void run()}
            disabled={simulate.isPending}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('promotions.simulator.run')}
          </Button>
        </Stack>
      </Card>

      {!result && (
        <Card>
          <EmptyState
            title={t('promotions.simulator.empty')}
            description={t('promotions.simulator.emptyBody')}
            icon={<ScienceRoundedIcon fontSize="small" />}
          />
        </Card>
      )}

      {result && (
        <Card sx={{ p: 2 }}>
          <Stack spacing={2}>
            {!result.promotions.entitled && (
              <Alert severity="warning">{t('promotions.error.notEntitled')}</Alert>
            )}

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('promotions.simulator.line')}</TableCell>
                  <TableCell align="right">{t('promotions.simulator.quantity')}</TableCell>
                  <TableCell align="right">{t('common.price')}</TableCell>
                  <TableCell align="right">{t('promotions.field.discount')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {result.lines.map((line) => (
                  <TableRow key={`${line.product_id}-${line.name}`}>
                    <TableCell>{line.name}</TableCell>
                    <TableCell align="right">{line.quantity}</TableCell>
                    <TableCell align="right">{line.net_amount}</TableCell>
                    <TableCell align="right">−{line.discount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Divider />

            <Stack spacing={0.5} sx={{ alignSelf: 'flex-end', minWidth: 260 }}>
              <Row label={t('promotions.field.subtotal')} value={`${result.subtotal} ${result.currency}`} />
              <Row
                label={t('promotions.field.discount')}
                value={`−${result.discount_total} ${result.currency}`}
              />
              <Row label={t('promotions.field.tax')} value={`${result.tax_total} ${result.currency}`} />
              <Row
                label={t('common.total')}
                value={`${result.grand_total} ${result.currency}`}
                strong
              />
            </Stack>

            {result.promotions.applied.length > 0 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{t('promotions.simulator.applied')}</Typography>
                {result.promotions.applied.map((entry) => (
                  <Stack
                    key={entry.promotion_id}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip size="small" color="success" label={entry.code} />
                      <Typography>{entry.label}</Typography>
                      {entry.coupon_code && (
                        <Chip size="small" variant="outlined" label={entry.coupon_code} />
                      )}
                    </Stack>
                    <Typography sx={{ fontWeight: 700 }}>−{entry.amount}</Typography>
                  </Stack>
                ))}
              </Stack>
            )}

            {/* La mitad que casi nunca se enseña, y la que resuelve el ticket. */}
            {result.promotions.skipped.length > 0 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{t('promotions.simulator.skipped')}</Typography>
                {result.promotions.skipped.map((entry) => (
                  <Stack key={entry.code} direction="row" spacing={1} alignItems="center">
                    <Chip size="small" label={entry.code} />
                    <Typography sx={{ color: 'var(--muted)' }}>
                      {t(`promotions.reason.${entry.reason}` as MessageKey)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}

            {result.promotions.coupons.length > 0 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{t('promotions.simulator.coupons')}</Typography>
                {result.promotions.coupons.map((entry) => (
                  <Stack key={entry.code} direction="row" spacing={1} alignItems="center">
                    <Chip
                      size="small"
                      color={entry.status === 'aplicado' ? 'success' : 'default'}
                      label={entry.code}
                    />
                    <Typography sx={{ color: 'var(--muted)' }}>
                      {t(`promotions.couponStatus.${entry.status}` as MessageKey)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between">
      <Typography sx={{ color: 'var(--muted)' }}>{label}</Typography>
      <Typography sx={{ fontWeight: strong ? 800 : 600 }}>{value}</Typography>
    </Stack>
  )
}
