import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined'
import { Card, CardContent, Grid, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { Button } from '@mui/material'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { useDashboardKpis, type DashboardKpis } from './useDashboardKpis'

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent>
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
        <Typography className="tnum" sx={{ fontSize: T.kpiCard, fontWeight: 800, mt: 0.5 }}>
          {value}
        </Typography>
        {hint && <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</Typography>}
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
  const cards: Array<{ key: string; label: MessageKey; value: string; hint?: string }> = [
    { key: 'products', label: 'admin.kpi.products', value: String(kpis.products) },
    { key: 'published', label: 'admin.kpi.published', value: String(kpis.published) },
    { key: 'orders', label: 'admin.kpi.orders', value: String(kpis.orders) },
    {
      key: 'sales',
      label: 'admin.kpi.sales',
      value:
        kpis.sales !== null && kpis.currency
          ? formatMoney(Number(kpis.sales), kpis.currency, locale)
          : '—',
      ...(kpis.sales === null ? { hint: t('admin.kpi.sales.none') } : {}),
    },
  ]

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
