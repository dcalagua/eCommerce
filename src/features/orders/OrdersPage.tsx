import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import {
  Button,
  Card,
  Chip,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
} from '@mui/material'
import { useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatDate, formatMoney } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { ORDER_STATUSES, type OrderStatus } from './types'
import { useOrders } from './useOrders'

const TABS: Array<OrderStatus | 'all'> = ['all', ...ORDER_STATUSES]

/** Listado de pedidos: buscador general + tabs de estado + Exportar (contrato §8). */
export function OrdersPage() {
  const { t, locale } = useI18n()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<OrderStatus | 'all'>('all')
  const { activeStore } = useTenant()
  const storeId = activeStore?.id ?? null
  const { data, isPending, isError, error, refetch } = useOrders({ search, status, storeId })

  return (
    <>
      <PageHeader
        title={t('admin.orders.title')}
        actions={<Button variant="outlined">{t('common.export')}</Button>}
      />
      <Stack spacing={2}>
        <Tabs
          value={status}
          onChange={(_, next: OrderStatus | 'all') => setStatus(next)}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label={t('common.status')}
        >
          {TABS.map((tab) => (
            <Tab key={tab} value={tab} label={tab} sx={{ textTransform: 'none', fontWeight: 700 }} />
          ))}
        </Tabs>
        <SearchField value={search} onChange={setSearch} placeholder={t('admin.orders.search')} />
        <Card>
          {isPending && <LoadingState />}
          {!isPending && isError && <ErrorState error={error} onRetry={() => void refetch()} />}
          {!isPending && !isError && (data?.length ?? 0) === 0 && (
            <EmptyState title={t('admin.orders.empty')} icon={<ReceiptLongOutlinedIcon fontSize="small" />} />
          )}
          {!isPending && !isError && (data?.length ?? 0) > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('common.number')}</TableCell>
                  <TableCell>{t('common.customer')}</TableCell>
                  <TableCell>{t('common.date')}</TableCell>
                  <TableCell align="right">{t('common.total')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data?.map((order) => (
                  <TableRow key={order.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{order.order_number}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <span>{order.customer_name ?? order.customer_email}</span>
                        <Chip size="small" label={order.status} />
                      </Stack>
                    </TableCell>
                    <TableCell>{formatDate(order.placed_at, locale)}</TableCell>
                    <TableCell align="right" className="tnum">
                      {formatMoney(order.grand_total, order.currency, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>
    </>
  )
}
