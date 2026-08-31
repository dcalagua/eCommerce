import { FilterBar } from '@/shared/ui/FilterBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded'
import {
  Box,
  Card,
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
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { FulfillmentDrawer } from './FulfillmentDrawer'
import { useFulfillments } from './hooks'
import type { FulfillmentRow, FulfillmentState } from './types'

/**
 * Los estados que la cola ofrece como pestaña.
 *
 * NO son los nueve del enum. Un filtro por cada estado posible es una fila de
 * pestañas que nadie lee; estos cuatro son las preguntas que una persona de
 * operaciones se hace de verdad al abrir la pantalla: qué hay sin preparar, qué
 * está listo, qué va en camino y qué salió mal.
 */
const TABS: ReadonlyArray<{ id: string; label: MessageKey }> = [
  { id: '', label: 'fulfillment.tab.all' },
  { id: 'pending', label: 'fulfillment.state.pending' },
  { id: 'ready', label: 'fulfillment.state.ready' },
  { id: 'in_transit', label: 'fulfillment.state.in_transit' },
  { id: 'failed', label: 'fulfillment.state.failed' },
]

const TONE: Record<FulfillmentState, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  pending: 'default',
  allocated: 'info',
  picking: 'info',
  packed: 'info',
  ready: 'warning',
  in_transit: 'info',
  delivered: 'success',
  failed: 'error',
  cancelled: 'default',
}

/**
 * La cola de preparación: qué hay que despachar y en qué punto está.
 *
 * Un solo buscador general y pestañas de estado (regla de suite §8): ni panel
 * de filtros multi-campo, ni un selector por columna. El buscador cubre las
 * tres cosas por las que se busca una entrega —número de pedido, correo del
 * comprador y guía— y lo hace en el SERVIDOR, no filtrando en memoria una
 * página que ya vino recortada.
 *
 * Ninguna acción vive en la fila: todas están en el detalle. Mover una entrega
 * es un acto con motivo y con consecuencias en el pedido, y un botón «entregar»
 * al final de una tabla es la forma más rápida de entregarlo en la fila
 * equivocada.
 */
export function QueueSection() {
  const { t, locale } = useI18n()
  const { activeStore } = useTenant()
  const [state, setState] = useState('')
  const [term, setTerm] = useState('')
  const debounced = useDebouncedValue(term, 300)
  const [selected, setSelected] = useState<FulfillmentRow | null>(null)

  const filter = { storeId: activeStore?.id ?? null, state, term: debounced }
  const queue = useFulfillments(filter)
  const list = queue.data ?? []
  const isEmpty = !queue.isPending && !queue.isError && list.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('fulfillment.queue.help')}</Typography>

      <Tabs
        value={state}
        onChange={(_event, next: string) => setState(next)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label={t('fulfillment.queue.filter')}
      >
        {TABS.map((tab) => (
          <Tab key={tab.id || 'todas'} value={tab.id} label={t(tab.label)} />
        ))}
      </Tabs>

      <FilterBar>
        <Box sx={{ minWidth: { xs: '100%', sm: 280 } }}>
          <SearchField
            value={term}
            onChange={setTerm}
            placeholder={t('fulfillment.queue.search')}
            ariaLabel={t('fulfillment.queue.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {queue.isPending && <TableSkeleton columns={6} />}
        {queue.isError && <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={t('fulfillment.queue.empty')}
            description={t('fulfillment.queue.emptyBody')}
            icon={<LocalShippingRoundedIcon fontSize="small" />}
          />
        )}
        {!queue.isPending && !queue.isError && list.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('fulfillment.field.order')}</TableCell>
                <TableCell>{t('fulfillment.field.method')}</TableCell>
                <TableCell>{t('fulfillment.field.origin')}</TableCell>
                <TableCell align="right">{t('fulfillment.field.units')}</TableCell>
                <TableCell align="right">{t('fulfillment.field.shippingCost')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((row) => (
                <TableRow
                  key={row.fulfillment_id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => setSelected(row)}
                >
                  <TableCell>
                    <Stack>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {row.order_number}
                        {row.sequence > 1 ? ` · ${row.sequence}` : ''}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'var(--muted)' }}>
                        {row.customer_email}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack>
                      <Typography variant="body2">{row.method_name}</Typography>
                      <Typography variant="caption" sx={{ color: 'var(--muted)' }}>
                        {t(`fulfillment.strategy.${row.strategy}` as MessageKey)}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {row.pickup_point_name ?? row.warehouse_code ?? (
                      <Typography variant="caption" sx={{ color: 'var(--muted)' }}>
                        {t('fulfillment.field.noOrigin')}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">{row.unit_count}</TableCell>
                  <TableCell align="right">
                    {formatMoney(Number(row.shipping_cost), row.currency, locale)}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <StatusChip
                        tone={TONE[row.state]}
                        label={t(`fulfillment.state.${row.state}` as MessageKey)}
                      />
                      {/* Se llegó tarde. Lo calcula la vista comparando la
                          promesa con hoy: dos fechas que viven juntas en la
                          entrega, no una resta hecha en el navegador. */}
                      {row.is_late && (
                        <StatusChip tone="error" label={t('fulfillment.field.late')} />
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <FulfillmentDrawer
        fulfillment={selected}
        onClose={() => setSelected(null)}
      />
    </Stack>
  )
}
