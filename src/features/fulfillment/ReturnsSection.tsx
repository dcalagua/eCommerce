import AssignmentReturnOutlinedIcon from '@mui/icons-material/AssignmentReturnOutlined'
import {
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
  Typography,
} from '@mui/material'
import { useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { ReturnDrawer } from './ReturnDrawer'
import { useReturns } from './hooks'
import type { ReturnRow, ReturnState } from './types'

/**
 * Las cuatro preguntas de una cola de devoluciones: qué hay que decidir, qué
 * está aprobado y no ha llegado, qué llegó y falta revisar, y qué está cerrado.
 * No hay una pestaña por estado del enum: eso es una fila de pestañas que nadie
 * lee (regla de suite §8).
 */
const TABS: ReadonlyArray<{ id: string; label: MessageKey }> = [
  { id: '', label: 'fulfillment.tab.all' },
  { id: 'requested', label: 'returns.state.requested' },
  { id: 'approved', label: 'returns.state.approved' },
  { id: 'received', label: 'returns.state.received' },
  { id: 'completed', label: 'returns.state.completed' },
]

const TONE: Record<ReturnState, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'error',
  in_transit: 'info',
  received: 'info',
  inspected: 'info',
  completed: 'success',
  cancelled: 'default',
}

export function ReturnsSection() {
  const { t, locale } = useI18n()
  const { activeStore } = useTenant()
  const [state, setState] = useState('')
  const [term, setTerm] = useState('')
  const debounced = useDebouncedValue(term, 300)
  const [selected, setSelected] = useState<ReturnRow | null>(null)

  const filter = { storeId: activeStore?.id ?? null, state, term: debounced }
  const queue = useReturns(filter)
  const list = queue.data ?? []
  const isEmpty = !queue.isPending && !queue.isError && list.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('returns.help')}</Typography>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
      >
        <SearchField
          value={term}
          onChange={setTerm}
          placeholder={t('returns.search')}
          ariaLabel={t('returns.search')}
        />
        <Tabs
          value={state}
          onChange={(_event, next: string) => setState(next)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label={t('returns.filter')}
        >
          {TABS.map((tab) => (
            <Tab key={tab.id || 'todas'} value={tab.id} label={t(tab.label)} />
          ))}
        </Tabs>
      </Stack>

      <Card>
        {queue.isPending && <TableSkeleton columns={6} />}
        {queue.isError && <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={t('returns.empty')}
            description={t('returns.emptyBody')}
            icon={<AssignmentReturnOutlinedIcon fontSize="small" />}
          />
        )}
        {!queue.isPending && !queue.isError && list.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('returns.field.rma')}</TableCell>
                <TableCell>{t('fulfillment.field.order')}</TableCell>
                <TableCell>{t('returns.field.reason')}</TableCell>
                <TableCell align="right">{t('returns.field.units')}</TableCell>
                <TableCell align="right">{t('returns.field.refund')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((row) => (
                <TableRow
                  key={row.return_request_id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => setSelected(row)}
                >
                  <TableCell sx={{ fontWeight: 600 }}>{row.rma_number}</TableCell>
                  <TableCell>
                    <Stack>
                      <Typography variant="body2">{row.order_number}</Typography>
                      <Typography variant="caption" sx={{ color: 'var(--muted)' }}>
                        {row.customer_email}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>{row.reason_label}</TableCell>
                  <TableCell align="right">
                    {row.received_count}/{row.unit_count}
                  </TableCell>
                  <TableCell align="right">
                    {formatMoney(Number(row.refund_amount), row.currency, locale)}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={TONE[row.state]}
                      label={t(`returns.state.${row.state}` as MessageKey)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <ReturnDrawer request={selected} onClose={() => setSelected(null)} />
    </Stack>
  )
}
