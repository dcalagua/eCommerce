import { Card, CardContent, Grid, Typography } from '@mui/material'
import { useI18n } from '@/shared/i18n/i18n-context'
import { PageHeader } from '@/shared/ui/PageHeader'
import { T } from '@/theme/tokens'

const KPIS = [
  { key: 'products', label: 'nav.products' },
  { key: 'orders', label: 'nav.orders' },
] as const

/** Resumen del backoffice. Sin backend conectado los KPIs muestran guion, no ceros falsos. */
export function DashboardPage() {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t('admin.dashboard.title')} />
      <Grid container spacing={2}>
        {KPIS.map((kpi) => (
          <Grid item xs={12} sm={6} md={3} key={kpi.key}>
            <Card>
              <CardContent>
                <Typography sx={{ fontSize: T.label, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                  {t(kpi.label)}
                </Typography>
                <Typography className="tnum" sx={{ fontSize: T.kpiCard, fontWeight: 800, mt: 0.5 }}>
                  —
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </>
  )
}
