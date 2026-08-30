import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import {
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { T } from '@/theme/tokens'
import type { RecentOrder } from '../useDashboardKpis'

/**
 * Últimos pedidos: lo que convierte un panel de cifras en un panel operativo.
 *
 * Cinco filas y un enlace a la pantalla completa. No es un listado recortado
 * —no tiene filtros, ni orden, ni paginación a propósito—: es un vistazo, y en
 * cuanto alguien necesita más, el sitio es Pedidos.
 *
 * El estado va en `Chip` con su texto traducido, nunca un punto de color: los
 * tokens de estado de esta paleta no se distinguen entre sí lo suficiente para
 * cargar significado a solas.
 */
export function RecentOrders({ orders }: { orders: RecentOrder[] }) {
  const { t, locale } = useI18n()

  return (
    <Card>
      <CardContent>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1.5 }}
        >
          <Stack>
            <Typography component="h2" sx={{ fontSize: T.cardTitle, fontWeight: 800 }}>
              {t('admin.dashboard.recentOrders')}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {t('admin.dashboard.recentOrders.hint')}
            </Typography>
          </Stack>
          <Button
            component={RouterLink}
            to="/app/orders"
            size="small"
            endIcon={<ArrowForwardRoundedIcon />}
          >
            {t('admin.dashboard.seeAll')}
          </Button>
        </Stack>

        {orders.length === 0 ? (
          <Typography sx={{ fontSize: T.body, color: 'var(--muted)', py: 2 }}>
            {t('admin.dashboard.noOrders')}
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('admin.dashboard.col.order')}</TableCell>
                <TableCell>{t('admin.dashboard.col.customer')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('admin.dashboard.col.total')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.order_number}>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12.5 }}>
                    {order.order_number}
                  </TableCell>
                  <TableCell
                    sx={{
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {order.customer ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={t(`orders.status.${order.status}` as MessageKey)}
                      sx={{ fontWeight: 700 }}
                    />
                  </TableCell>
                  <TableCell align="right" className="tnum" sx={{ fontWeight: 700 }}>
                    {formatMoney(Number(order.total), order.currency, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
