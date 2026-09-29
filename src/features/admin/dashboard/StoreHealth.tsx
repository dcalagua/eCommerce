import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import { Box, Button, Card, CardContent, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { C } from '@/theme/tokens'
import { Meter } from '../Meter'
import type { DashboardKpis } from '../useDashboardKpis'

/**
 * Salud de la tienda: lo que el cliente ve (catálogo publicado) y lo que ya
 * se cobró. Medidores y no anillos, por lo que explica `Meter`: una razón
 * contra un límite se lee mejor por largo que por ángulo.
 */
export function StoreHealth({ kpis }: { kpis: DashboardKpis }) {
  const { t } = useI18n()
  // Se deriva del desglose, no de otra consulta: dos fuentes para la misma
  // cifra acaban siempre discrepando.
  const paidOrders = kpis.by_status.find((row) => row.status === 'paid')?.count ?? 0

  return (
    <Card component="section" aria-labelledby="store-health-title" sx={{ height: '100%' }}>
      <CardContent sx={{ p: { xs: 2, md: 3 } }}>
        <Stack direction="row" sx={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: 1, mb: 2.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography id="store-health-title" component="h2" sx={{ fontSize: 17, fontWeight: 800 }}>
              {t('admin.dashboard.health')}
            </Typography>
            <Typography sx={{ fontSize: 12, color: C.muted }}>{t('admin.dashboard.health.hint')}</Typography>
          </Box>
          {/* Una cifra sin salida obliga a buscarla en el menú. */}
          <Button component={RouterLink} to="/app/products" size="small" endIcon={<ArrowForwardRoundedIcon />}>
            {t('admin.dashboard.seeProducts')}
          </Button>
        </Stack>
        <Stack sx={{ gap: 3 }}>
          <Meter
            label={t('admin.dashboard.meter.published')}
            value={kpis.published}
            total={kpis.products}
            caption={`${kpis.published} / ${kpis.products}`}
          />
          <Meter
            label={t('admin.dashboard.meter.paid')}
            value={paidOrders}
            total={kpis.orders}
            caption={`${paidOrders} / ${kpis.orders}`}
          />
        </Stack>
      </CardContent>
    </Card>
  )
}
