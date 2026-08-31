import { FilterBar } from '@/shared/ui/FilterBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import SellRoundedIcon from '@mui/icons-material/SellRounded'
import {
  Box,
  Button,
  Card,  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatDate } from '@/shared/lib/format'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { PriceListDrawer } from './PriceListDrawer'
import { usePriceLists } from './hooks'
import { validityOf, type PriceList, type Validity } from './types'

/**
 * Las listas de la tienda activa, ordenadas como las mira el motor: primero la
 * prioridad, y a igualdad el código.
 */
const VALIDITY_COLOR: Record<Validity, 'success' | 'info' | 'warning' | 'default'> = {
  active: 'success',
  scheduled: 'info',
  expired: 'warning',
  off: 'default',
}

export function PriceListsSection() {
  const { t, locale } = useI18n()
  const { activeStore, can } = useTenant()
  const canWrite = can('catalog.write')

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ open: boolean; list: PriceList | null }>({
    open: false,
    list: null,
  })

  const query = usePriceLists(activeStore?.id ?? null)

  const lists = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (list) =>
        list.name.toLowerCase().includes(term) ||
        list.code.toLowerCase().includes(term) ||
        list.currency.toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && lists.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('pricing.lists.help')}</Typography>

      <FilterBar>
        <Box sx={{ flex: 1 }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('pricing.search')} />
        </Box>
        {canWrite && (
          <Button variant="contained" onClick={() => setEditing({ open: true, list: null })}>
            {t('pricing.lists.new')}
          </Button>
        )}
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={5} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('pricing.noResults') : t('pricing.lists.empty')}
            description={search ? undefined : t('pricing.lists.emptyBody')}
            icon={<SellRoundedIcon fontSize="small" />}
          />
        )}
        {!query.isPending && !query.isError && lists.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('pricing.field.code')}</TableCell>
                <TableCell>{t('pricing.field.name')}</TableCell>
                <TableCell>{t('pricing.field.currency')}</TableCell>
                <TableCell align="right">{t('pricing.field.priority')}</TableCell>
                <TableCell>{t('pricing.field.validity')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lists.map((list) => {
                const validity = validityOf(list)
                return (
                  <TableRow key={list.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{list.code}</TableCell>
                    <TableCell>{list.name}</TableCell>
                    <TableCell>{list.currency}</TableCell>
                    <TableCell align="right">{list.priority}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <StatusChip
                          tone={VALIDITY_COLOR[validity]}
                          label={t(`pricing.validity.${validity}`)}
                        />
                        <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
                          {formatDate(list.valid_from, locale)}
                          {list.valid_to ? ` → ${formatDate(list.valid_to, locale)}` : ''}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => setEditing({ open: true, list })}
                        aria-label={`${t('common.edit')}: ${list.name}`}
                      >
                        {t('common.edit')}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <PriceListDrawer
        open={editing.open}
        list={editing.list}
        canWrite={canWrite}
        onClose={() => setEditing({ open: false, list: null })}
      />
    </Stack>
  )
}
