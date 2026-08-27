import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined'
import {
  Button,
  Card,
  Chip,
  MenuItem,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatDate, formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { OrderDrawer } from './OrderDrawer'
import { downloadCsv, ordersToCsv } from './exportCsv'
import { STATUS_COLOR, STATUS_LABEL } from './status'
import {
  ORDER_DATE_RANGES,
  ORDER_STATUSES,
  type Order,
  type OrderDateRange,
  type OrderStatusFilter,
} from './types'
import { useOrders } from './useOrders'

const TABS: Array<{ value: OrderStatusFilter; label: MessageKey }> = [
  { value: 'all', label: 'common.all' },
  ...ORDER_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
]

const RANGE_LABEL: Record<OrderDateRange, MessageKey> = {
  all: 'orders.range.all',
  today: 'orders.range.today',
  week: 'orders.range.week',
  month: 'orders.range.month',
  quarter: 'orders.range.quarter',
}

/** `YYYY-MM-DD` local: el filtro de fecha no puede depender del huso del servidor. */
function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Listado de pedidos del backoffice.
 *
 * Un buscador general + tabs de estado + Exportar (regla de suite §8). El
 * encargo pide además filtrar por fecha: se resuelve con UN control de rangos
 * cerrados, no con un panel de filtros multi-campo.
 *
 * La pantalla no toca Supabase ni cambia estados: pide a los hooks y delega el
 * cambio de estado en el panel de detalle, que llama a `update-order-status`.
 */
export function OrdersPage() {
  const { t, locale } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, status: tenantStatus, can } = useTenant()
  const canWrite = can('orders.write')

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<OrderStatusFilter>('all')
  const [range, setRange] = useState<OrderDateRange>('all')
  const [selected, setSelected] = useState<Order | null>(null)

  const storeId = activeStore?.id ?? null
  const today = useMemo(todayKey, [])
  const orders = useOrders({ storeId, search, status, range, today })
  const rows = orders.data ?? []

  function exportCsv() {
    if (rows.length === 0) {
      notify(t('orders.export.empty'), 'error')
      return
    }
    downloadCsv(`pedidos-${today}.csv`, ordersToCsv(rows))
  }

  // Mientras el espacio de trabajo se resuelve NO se dice "no tienes tiendas":
  // sería afirmar algo que todavía no se sabe (criterio P04 #37).
  if (tenantStatus === 'loading') {
    return (
      <>
        <PageHeader title={t('admin.orders.title')} />
        <Card>
          <TableSkeleton columns={5} />
        </Card>
      </>
    )
  }

  if (!storeId) {
    return (
      <>
        <PageHeader title={t('admin.orders.title')} />
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

  return (
    <>
      <PageHeader
        title={t('admin.orders.title')}
        actions={
          <Button variant="outlined" onClick={exportCsv}>
            {t('common.export')}
          </Button>
        }
      />
      <Stack spacing={2}>
        <Tabs
          value={status}
          onChange={(_, next: OrderStatusFilter) => setStatus(next)}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label={t('common.status')}
          sx={{ '& .MuiTab-root': { textTransform: 'none', fontWeight: 700 } }}
        >
          {TABS.map((tab) => (
            <Tab key={tab.value} value={tab.value} label={t(tab.label)} />
          ))}
        </Tabs>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: 'center' }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('admin.orders.search')} />
          <TextField
            select
            size="small"
            label={t('orders.range')}
            value={range}
            onChange={(event) => setRange(event.target.value as OrderDateRange)}
            sx={{ minWidth: 190 }}
          >
            {ORDER_DATE_RANGES.map((value) => (
              <MenuItem key={value} value={value}>
                {t(RANGE_LABEL[value])}
              </MenuItem>
            ))}
          </TextField>
        </Stack>

        <Card>
          {orders.isPending && <TableSkeleton columns={5} />}
          {orders.isError && (
            <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
          )}
          {orders.isSuccess && rows.length === 0 && (
            <EmptyState
              title={t('admin.orders.empty')}
              description={t('admin.orders.emptyBody')}
              icon={<ReceiptLongOutlinedIcon fontSize="small" />}
            />
          )}
          {orders.isSuccess && rows.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('common.number')}</TableCell>
                  <TableCell>{t('common.customer')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell>{t('common.date')}</TableCell>
                  <TableCell align="right">{t('common.total')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((order) => (
                  <TableRow
                    key={order.id}
                    hover
                    tabIndex={0}
                    role="button"
                    aria-label={`${t('orders.open')} ${order.order_number}`}
                    onClick={() => setSelected(order)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelected(order)
                      }
                    }}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell sx={{ fontWeight: 700 }}>{order.order_number}</TableCell>
                    <TableCell>
                      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                        {order.customer_name ?? order.customer_email}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                        {order.customer_email}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={STATUS_COLOR[order.status]}
                        label={t(STATUS_LABEL[order.status])}
                      />
                    </TableCell>
                    <TableCell>{formatDate(order.placed_at, locale)}</TableCell>
                    <TableCell align="right" className="tnum">
                      {formatMoney(Number(order.grand_total), order.currency, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>

      <OrderDrawer
        order={selected}
        open={selected !== null}
        canWrite={canWrite}
        onClose={() => setSelected(null)}
      />
    </>
  )
}
