import {
  Button,
  Card,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined'
import { useI18n } from '@/shared/i18n/i18n-context'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { formatDate, formatMoney } from '@/shared/lib/format'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import {
  useAnalyticsWindow,
  useAnalyticsKpis,
  useChannelPerformance,
  useTimeseries,
  useTopProducts,
} from './hooks'
import { ANALYTICS_RANGES, type AnalyticsRange } from './types'

/**
 * Resumen comercial: lo que sale de los PEDIDOS.
 *
 * Todo lo de esta pestaña es baseline (`analytics.basic`) porque todo sale de
 * `orders`, `order_items`, `checkout_intents` y `carts`, que existen en
 * cualquier tenant. El comportamiento del comprador —lo que hay que instrumentar
 * en la vitrina— vive en la otra pestaña y sí se vende.
 *
 * ## El guion
 *
 * Un `null` se pinta como «—» y NUNCA como 0. La base devuelve `null` cuando el
 * denominador es cero, y traducirlo a 0 % convertiría «todavía no hay con qué
 * calcularlo» en «tu tienda no convierte». Es la misma decisión que el guion de
 * moneda mezclada que `dashboard_kpis` lleva desde P03.
 */

function dash(value: string | null | undefined): string {
  return value ?? '—'
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card sx={{ p: 2, flex: '1 1 180px', minWidth: 160 }}>
      <Typography sx={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>{label}</Typography>
      <Typography sx={{ fontSize: 24, fontWeight: 800, lineHeight: 1.2 }}>{value}</Typography>
      {hint && <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</Typography>}
    </Card>
  )
}

export function OverviewSection({
  storeId,
  days,
  onDaysChange,
}: {
  storeId: string | null
  days: AnalyticsRange
  onDaysChange: (next: AnalyticsRange) => void
}) {
  const { t, locale } = useI18n()
  const window = useAnalyticsWindow(storeId, days)
  const kpis = useAnalyticsKpis(window)
  const top = useTopProducts(window)
  const channels = useChannelPerformance(window)
  const series = useTimeseries(window)

  function money(value: string | null, currency: string | null): string {
    if (value === null || currency === null) return '—'
    return formatMoney(Number(value), currency, locale)
  }

  /**
   * La exportación es la SERIE DIARIA, no la foto.
   *
   * Un CSV con cuatro totales no se puede cruzar con nada; uno con una fila por
   * día se pega en una hoja de cálculo al lado de las cifras del ERP. Por eso
   * `analytics_timeseries` devuelve filas y no un jsonb: la exportación es la
   * misma consulta que pinta el listado, sin una segunda ruta que se
   * desincronice.
   */
  function exportCsv(): void {
    const rows = (series.data ?? []).map((row) => [
      row.day,
      String(row.orders),
      String(row.units),
      row.revenue ?? '',
      row.currency ?? '',
    ])
    downloadCsv(
      `analytics-${days}d.csv`,
      toCsv(
        [
          t('analytics.csv.day'),
          t('analytics.csv.orders'),
          t('analytics.csv.units'),
          t('analytics.csv.revenue'),
          t('analytics.csv.currency'),
        ],
        rows,
      ),
    )
  }

  if (kpis.isError) return <ErrorState error={kpis.error} onRetry={() => void kpis.refetch()} />
  if (kpis.isPending) return <TableSkeleton columns={4} />

  const data = kpis.data

  return (
    <Stack sx={{ gap: 2.5 }}>
      <Stack
        direction="row"
        sx={{ gap: 1.5, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <ToggleButtonGroup
          exclusive
          size="small"
          value={days}
          aria-label={t('analytics.range.label')}
          onChange={(_, next: AnalyticsRange | null) => next && onDaysChange(next)}
        >
          {ANALYTICS_RANGES.map((range) => (
            <ToggleButton key={range} value={range}>
              {t('analytics.range.days').replace('{n}', String(range))}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button
          size="small"
          startIcon={<DownloadOutlinedIcon />}
          onClick={exportCsv}
          disabled={(series.data ?? []).length === 0}
        >
          {t('common.export')}
        </Button>
      </Stack>

      <Stack direction="row" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
        <Metric label={t('analytics.kpi.sales')} value={money(data.paid_sales, data.currency)} />
        <Metric label={t('analytics.kpi.orders')} value={String(data.orders)} />
        <Metric
          label={t('analytics.kpi.ticket')}
          value={money(data.average_ticket, data.currency)}
        />
        <Metric
          label={t('analytics.kpi.conversion')}
          value={data.conversion_rate === null ? '—' : `${data.conversion_rate} %`}
          hint={t('analytics.kpi.conversionHint')
            .replace('{done}', String(data.checkouts_completed))
            .replace('{total}', String(data.checkouts_started))}
        />
        <Metric
          label={t('analytics.kpi.abandonment')}
          value={data.abandonment_rate === null ? '—' : `${data.abandonment_rate} %`}
          hint={t('analytics.kpi.abandonmentHint')
            .replace('{abandoned}', String(data.carts_abandoned))
            .replace('{converted}', String(data.carts_converted))}
        />
        <Metric label={t('analytics.kpi.units')} value={String(data.units)} />
      </Stack>

      <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
        {t('analytics.window')
          .replace('{from}', formatDate(data.from, locale))
          .replace('{to}', formatDate(data.to, locale))}
      </Typography>

      <Card>
        <Typography component="h3" sx={{ p: 2, pb: 0, fontSize: 14, fontWeight: 800 }}>
          {t('analytics.top.title')}
        </Typography>
        {top.isPending ? (
          <TableSkeleton columns={4} />
        ) : (top.data ?? []).length === 0 ? (
          <EmptyState title={t('analytics.top.empty')} description={t('analytics.top.emptyBody')} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('analytics.top.sku')}</TableCell>
                <TableCell>{t('analytics.top.name')}</TableCell>
                <TableCell align="right">{t('analytics.top.units')}</TableCell>
                <TableCell align="right">{t('analytics.top.revenue')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(top.data ?? []).map((row) => (
                <TableRow key={row.sku}>
                  <TableCell>{row.sku}</TableCell>
                  <TableCell>{dash(row.name)}</TableCell>
                  <TableCell align="right">{row.units}</TableCell>
                  <TableCell align="right">{money(row.revenue, row.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <Typography component="h3" sx={{ p: 2, pb: 0, fontSize: 14, fontWeight: 800 }}>
          {t('analytics.channels.title')}
        </Typography>
        {channels.isPending ? (
          <TableSkeleton columns={4} />
        ) : (channels.data ?? []).length === 0 ? (
          <EmptyState
            title={t('analytics.channels.empty')}
            description={t('analytics.channels.emptyBody')}
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('analytics.channels.channel')}</TableCell>
                <TableCell align="right">{t('analytics.kpi.orders')}</TableCell>
                <TableCell align="right">{t('analytics.top.units')}</TableCell>
                <TableCell align="right">{t('analytics.top.revenue')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(channels.data ?? []).map((row) => (
                <TableRow key={row.channel_id}>
                  <TableCell>{row.channel_name}</TableCell>
                  <TableCell align="right">{row.orders}</TableCell>
                  <TableCell align="right">{row.units}</TableCell>
                  <TableCell align="right">{money(row.revenue, row.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}
