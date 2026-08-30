import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import LocalMallOutlinedIcon from '@mui/icons-material/LocalMallOutlined'
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined'
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined'
import { Box, Card, CardContent, Grid, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Button } from '@mui/material'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { BarList, type BarRow } from './BarList'
import { useDashboardKpis, type DashboardKpis } from './useDashboardKpis'

/**
 * Tarjeta de cifra.
 *
 * El icono es DECORATIVO (`aria-hidden`): la etiqueta ya nombra la cifra, y un
 * icono anunciado por el lector seria ruido repetido. Va en gris de texto, no
 * en el acento: el acento es del dato, y si lo llevan icono y cifra a la vez
 * deja de senalar nada.
 */
function KpiCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string
  value: string
  hint?: string
  icon?: ReactNode
}) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ color: 'var(--muted)', display: 'flex' }} aria-hidden>
            {icon}
          </Box>
          <Typography
            sx={{
              fontSize: T.label,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
            }}
          >
            {label}
          </Typography>
        </Stack>
        <Typography className="tnum" sx={{ fontSize: T.kpiCard, fontWeight: 800, mt: 0.5 }}>
          {value}
        </Typography>
        {hint && <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</Typography>}
      </CardContent>
    </Card>
  )
}

/** Panel con titulo, para que cada desglose diga que responde. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800, mb: 2 }}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  )
}

/**
 * Resumen del backoffice.
 *
 * Cuatro cifras y todas reales: salen de `dashboard_kpis`, que cuenta bajo la
 * RLS del usuario. Lo que la base no puede afirmar —ventas cuando la tienda
 * mezcla monedas o cuando todavía no hay pedidos— se muestra como guion. Un
 * cero inventado en un panel se lee como un dato.
 */
export function DashboardPage() {
  const { t, locale } = useI18n()
  const { activeStore, tenant } = useTenant()
  const storeId = activeStore?.id ?? null
  const { data, isPending, isError, error, refetch } = useDashboardKpis(storeId)

  const subtitle = [tenant?.name, activeStore?.name].filter(Boolean).join(' · ')

  if (!storeId) {
    return (
      <>
        <PageHeader title={t('admin.dashboard.title')} subtitle={tenant?.name} />
        <Card>
          <EmptyState
            title={t('admin.store.none')}
            description={t('admin.store.noneBody')}
            icon={<StorefrontOutlinedIcon fontSize="small" />}
          />
        </Card>
      </>
    )
  }

  if (isPending) return <LoadingState />
  if (isError) {
    return (
      <>
        <PageHeader title={t('admin.dashboard.title')} subtitle={subtitle} />
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      </>
    )
  }

  const kpis: DashboardKpis = data
  const money = (raw: string | null) =>
    raw !== null && kpis.currency ? formatMoney(Number(raw), kpis.currency, locale) : '—'

  const cards: Array<{
    key: string
    label: MessageKey
    value: string
    hint?: string
    icon: ReactNode
  }> = [
    {
      key: 'sales',
      label: 'admin.kpi.sales',
      value: money(kpis.sales),
      icon: <PaidOutlinedIcon fontSize="small" />,
      ...(kpis.sales === null ? { hint: t('admin.kpi.sales.none') } : {}),
    },
    {
      key: 'avgTicket',
      label: 'admin.kpi.avgTicket',
      value: money(kpis.avg_ticket),
      icon: <TrendingUpOutlinedIcon fontSize="small" />,
      hint: t('admin.kpi.avgTicket.hint'),
    },
    {
      key: 'orders',
      label: 'admin.kpi.orders',
      value: String(kpis.orders),
      icon: <ReceiptLongOutlinedIcon fontSize="small" />,
    },
    {
      key: 'products',
      label: 'admin.kpi.products',
      value: String(kpis.products),
      icon: <LocalMallOutlinedIcon fontSize="small" />,
      // Publicados deja de ser una tarjeta propia: como cifra suelta no dice
      // nada, y junto a total responde «cuanto catalogo esta vivo».
      hint: `${kpis.published} ${t('admin.kpi.publishedTotal')}`,
    },
  ]

  const statusRows: BarRow[] = kpis.by_status.map((row) => ({
    id: row.status,
    label: t(`orders.status.${row.status}` as MessageKey),
    value: row.count,
    display: String(row.count),
  }))

  const productRows: BarRow[] = kpis.top_products.map((row) => ({
    id: row.sku,
    label: row.name,
    value: Number(row.revenue),
    display: kpis.currency
      ? formatMoney(Number(row.revenue), kpis.currency, locale)
      : String(row.units),
  }))

  const isFresh = kpis.products === 0 && kpis.orders === 0

  return (
    <>
      <PageHeader title={t('admin.dashboard.title')} subtitle={subtitle} />
      <Stack spacing={3}>
        <Grid container spacing={2}>
          {cards.map((card) => (
            <Grid item xs={12} sm={6} md={3} key={card.key}>
              <KpiCard label={t(card.label)} value={card.value} {...(card.hint ? { hint: card.hint } : {})} />
            </Grid>
          ))}
        </Grid>

        {!isFresh && (
          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Panel title={t('admin.dashboard.byStatus')}>
                <BarList rows={statusRows} emptyLabel={t('admin.dashboard.noOrders')} />
              </Panel>
            </Grid>
            <Grid item xs={12} md={6}>
              <Panel title={t('admin.dashboard.topProducts')}>
                <BarList rows={productRows} emptyLabel={t('admin.dashboard.noSales')} />
              </Panel>
            </Grid>
          </Grid>
        )}

        {isFresh && (
          <Card>
            <EmptyState
              title={t('admin.dashboard.fresh.title')}
              description={t('admin.dashboard.fresh.body')}
              icon={<Inventory2OutlinedIcon fontSize="small" />}
              action={
                <Button component={RouterLink} to="/app/products" variant="contained">
                  {t('admin.dashboard.fresh.cta')}
                </Button>
              }
            />
          </Card>
        )}
      </Stack>
    </>
  )
}
