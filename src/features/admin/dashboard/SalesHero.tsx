import PaidRoundedIcon from '@mui/icons-material/PaidRounded'
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded'
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded'
import { Box, Card, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { Locale, MessageKey } from '@/shared/i18n/messages'
import { formatCalendarDate, formatMoney } from '@/shared/lib/format'
import { C, SH, T } from '@/theme/tokens'
import type { DashboardKpis } from '../useDashboardKpis'
import { SALES_PERIODS, salesDelta, type SalesPeriod, type SalesTrend } from '../useSalesTrend'

const WHITE_82 = `color-mix(in srgb, ${C.white} 82%, transparent)`
const WHITE_64 = `color-mix(in srgb, ${C.white} 64%, transparent)`

const bucketLabel = (date: string, unit: SalesTrend['unit'], locale: Locale) =>
  formatCalendarDate(date, unit === 'month' ? 'month' : 'day', locale)

/**
 * Barras por día o por mes. Se dibujan con cajas y no con una librería de
 * gráficos: son treinta rectángulos, y así heredan los tokens y el modo oscuro
 * sin configurar nada.
 *
 * El gráfico es UNA imagen con nombre (`role="img"`), no treinta: quien usa
 * lector de pantalla recibe el resumen —tipo de serie y mejor punto—, y las
 * cifras exactas de cada barra van en su tooltip para quien pasa el ratón.
 * El último punto (hoy / este mes) se resalta: es el que todavía se mueve.
 */
function TrendBars({ trend, label }: { trend: SalesTrend; label: string }) {
  const { t, locale } = useI18n()
  const max = Math.max(...trend.series.map((p) => Number(p.sales)), 0)
  const currency = trend.currency ?? 'PEN'
  const last = trend.series.length - 1
  const middle = Math.floor(last / 2)

  return (
    <Stack spacing={0.75} sx={{ flex: 1, minHeight: 0, justifyContent: 'flex-end' }}>
      <Box
        role="img"
        aria-label={label}
        sx={{ display: 'flex', alignItems: 'flex-end', gap: { xs: '3px', md: '5px' }, height: { xs: 96, md: 132 } }}
      >
        {trend.series.map((point, index) => {
          const value = Number(point.sales)
          const pct = max > 0 ? (value / max) * 100 : 0
          return (
            <Tooltip
              key={point.date}
              title={`${bucketLabel(point.date, trend.unit, locale)} · ${formatMoney(value, currency, locale)}`}
              placement="top"
              disableInteractive
            >
              <Box
                sx={{
                  flex: 1,
                  minWidth: 0,
                  // Un día sin ventas se ve como una raya, no como un hueco:
                  // el hueco se lee como «falta el dato».
                  height: `${Math.max(pct, 2)}%`,
                  borderRadius: '4px 4px 1px 1px',
                  bgcolor: index === last ? C.white : `color-mix(in srgb, ${C.white} 26%, transparent)`,
                  transition: 'height 240ms ease',
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                }}
              />
            </Tooltip>
          )
        })}
      </Box>
      <Stack direction="row" sx={{ justifyContent: 'space-between' }} aria-hidden>
        {[0, middle, last].map((index) => (
          <Typography key={index} sx={{ fontSize: 11, color: WHITE_64 }}>
            {index === last
              ? t(trend.unit === 'month' ? 'admin.dashboard.sales.thisMonth' : 'admin.dashboard.sales.today')
              : bucketLabel(trend.series[index]?.date ?? '', trend.unit, locale)}
          </Typography>
        ))}
      </Stack>
    </Stack>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 600, color: WHITE_82 }}>{label}</Typography>
      <Typography
        className="tnum"
        sx={{ fontSize: T.kpiCard, fontWeight: 800, color: C.white, lineHeight: 1.15, whiteSpace: 'nowrap' }}
      >
        {value}
      </Typography>
      <Typography sx={{ fontSize: 12, color: WHITE_64 }}>{hint}</Typography>
    </Stack>
  )
}

/**
 * La protagonista del Resumen: cuánto se vendió en el periodo y cómo va contra
 * el anterior.
 *
 * Todo sale de `dashboard_sales_trend`. Si esa función todavía no existe en la
 * base (migración sin aplicar) o falla, la tarjeta NO se cae: enseña las ventas
 * acumuladas de `dashboard_kpis` y lo dice, en vez de dejar un hueco rojo en
 * el sitio más visible de la pantalla.
 *
 * La variación solo aparece con base: con el periodo anterior en cero, «+∞ %»
 * no informa de nada.
 */
export function SalesHero({
  trend,
  trendFailed,
  period,
  onPeriodChange,
  kpis,
}: {
  trend: SalesTrend | undefined
  trendFailed: boolean
  period: SalesPeriod
  onPeriodChange: (period: SalesPeriod) => void
  kpis: DashboardKpis
}) {
  const { t, locale } = useI18n()

  const money = (raw: string | null, currency: string | null) =>
    raw !== null && currency ? formatMoney(Number(raw), currency, locale) : '—'

  const fallback = trendFailed || !trend
  const title = fallback ? t('admin.dashboard.sales.allTime') : t(`admin.dashboard.sales.title.${period}` as MessageKey)
  const amount = fallback ? money(kpis.sales, kpis.currency) : money(trend.sales, trend.currency)
  const delta = fallback ? null : salesDelta(trend)
  const up = (delta ?? 0) >= 0
  const deltaText = delta === null ? null : `${up ? '+' : '−'}${Math.abs(delta).toFixed(1)} %`

  const chartLabel = (() => {
    if (!trend || trend.series.length === 0) return ''
    const serie = t(trend.unit === 'month' ? 'admin.dashboard.sales.chart.month' : 'admin.dashboard.sales.chart.day')
    if (!trend.best || !trend.currency) return serie
    const best = t(trend.unit === 'month' ? 'admin.dashboard.sales.best.month' : 'admin.dashboard.sales.best.day')
    return `${serie}. ${best}: ${bucketLabel(trend.best.date, trend.unit, locale)}, ${formatMoney(Number(trend.best.sales), trend.currency, locale)}`
  })()

  return (
    <Card
      component="section"
      aria-labelledby="sales-hero-title"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        height: '100%',
        border: 'none',
        borderRadius: 4,
        background: C.heroGrad,
        color: C.white,
        boxShadow: SH.hero,
        p: { xs: 2.25, md: 3.5 },
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        gap: { xs: 2.5, md: 4 },
        // Resplandor decorativo, del mismo acento del tenant.
        '&::after': {
          content: '""',
          position: 'absolute',
          right: -120,
          top: -160,
          width: 420,
          height: 420,
          borderRadius: '50%',
          background: `radial-gradient(closest-side, color-mix(in srgb, ${C.white} 14%, transparent), transparent)`,
          pointerEvents: 'none',
        },
      }}
    >
      <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box
              aria-hidden
              sx={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                bgcolor: `color-mix(in srgb, ${C.white} 18%, transparent)`,
                '& .MuiSvgIcon-root': { fontSize: 17 },
              }}
            >
              <PaidRoundedIcon />
            </Box>
            <Typography
              id="sales-hero-title"
              component="h2"
              sx={{ fontSize: T.label, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: WHITE_82 }}
            >
              {title}
            </Typography>
          </Stack>

          {!trendFailed && (
            <ToggleButtonGroup
              exclusive
              size="small"
              value={period}
              aria-label={t('admin.dashboard.period.label')}
              onChange={(_, next: SalesPeriod | null) => next && onPeriodChange(next)}
              sx={{
                bgcolor: `color-mix(in srgb, ${C.white} 12%, transparent)`,
                borderRadius: 999,
                p: 0.4,
                '& .MuiToggleButton-root': {
                  border: 'none',
                  borderRadius: '999px !important',
                  px: 1.4,
                  py: 0.4,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'none',
                  color: WHITE_82,
                  '&.Mui-selected, &.Mui-selected:hover': { bgcolor: C.white, color: C.accentDeep },
                },
              }}
            >
              {SALES_PERIODS.map((p) => (
                <ToggleButton key={p} value={p}>
                  {t(`admin.dashboard.period.${p}` as MessageKey)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
        </Stack>

        <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography
            className="tnum"
            sx={{ fontSize: { xs: 34, md: 46 }, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05 }}
          >
            {amount}
          </Typography>
          {deltaText && (
            <Stack
              direction="row"
              spacing={0.5}
              aria-label={t('admin.dashboard.sales.delta').replace('{pct}', deltaText)}
              sx={{
                alignItems: 'center',
                px: 1.1,
                py: 0.35,
                borderRadius: 999,
                bgcolor: `color-mix(in srgb, ${C.white} 18%, transparent)`,
                '& .MuiSvgIcon-root': { fontSize: 16 },
              }}
            >
              {up ? <TrendingUpRoundedIcon aria-hidden /> : <TrendingDownRoundedIcon aria-hidden />}
              <Typography className="tnum" aria-hidden sx={{ fontSize: 13, fontWeight: 800 }}>
                {deltaText}
              </Typography>
            </Stack>
          )}
        </Stack>

        <Typography sx={{ fontSize: 13, color: WHITE_82 }}>
          {fallback
            ? kpis.sales === null
              ? t('admin.kpi.sales.none')
              : t('admin.dashboard.sales.unavailable')
            : delta === null
              ? t('admin.dashboard.sales.noPrevious')
              : t('admin.dashboard.sales.vsPrevious').replace('{amount}', money(trend.previous_sales, trend.currency))}
        </Typography>

        {!fallback && trend.series.length > 0 && <TrendBars trend={trend} label={chartLabel} />}
      </Stack>

      <Stack
        sx={{
          position: 'relative',
          zIndex: 1,
          width: { md: 230 },
          flexShrink: 0,
          justifyContent: 'space-between',
          gap: 2,
          pl: { md: 3.5 },
          pt: { xs: 2, md: 0 },
          borderLeft: { md: `1px solid color-mix(in srgb, ${C.white} 18%, transparent)` },
          borderTop: { xs: `1px solid color-mix(in srgb, ${C.white} 18%, transparent)`, md: 'none' },
          display: { xs: 'grid', md: 'flex' },
          gridTemplateColumns: { xs: 'repeat(auto-fit, minmax(140px, 1fr))' },
        }}
      >
        <Stat
          label={t('admin.kpi.avgTicket')}
          value={fallback ? money(kpis.avg_ticket, kpis.currency) : money(trend.avg_ticket, trend.currency)}
          hint={t('admin.kpi.avgTicket.hint')}
        />
        <Stat
          label={t('admin.kpi.orders')}
          value={String(fallback ? kpis.orders : trend.orders)}
          hint={fallback ? t('admin.dashboard.sales.allTime') : t('admin.dashboard.sales.ordersHint')}
        />
        {!fallback && (
          <Stat
            label={t(trend.unit === 'month' ? 'admin.dashboard.sales.best.month' : 'admin.dashboard.sales.best.day')}
            value={trend.best && trend.currency ? formatMoney(Number(trend.best.sales), trend.currency, locale) : '—'}
            hint={trend.best ? bucketLabel(trend.best.date, trend.unit, locale) : t('admin.dashboard.sales.noBest')}
          />
        )}
      </Stack>
    </Card>
  )
}
