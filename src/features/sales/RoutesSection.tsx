import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded'
import {
  Box,
  Button,
  Card,
  Stack,
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
import type { MessageKey } from '@/shared/i18n/messages'
import { FilterBar } from '@/shared/ui/FilterBar'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { RouteDrawer } from './RouteDrawer'
import { useRoutes } from './hooks'
import type { Route } from './types'

/**
 * Rutas de visita: quién recorre qué, qué día y cada cuántas semanas.
 *
 * El día y la frecuencia salen en la propia lista porque son la pregunta que se
 * hace de verdad —«¿quién pasa hoy por esta zona?»— y esconderlas dentro del
 * cajón obligaría a abrir una por una para responderla.
 */
export function RoutesSection() {
  const { t } = useI18n()
  const { tenant, activeCompanyId, can } = useTenant()
  const canWrite = can('sales.manage')

  const [search, setSearch] = useState('')
  const [abierta, setAbierta] = useState<Route | null>(null)
  const [creando, setCreando] = useState(false)

  const query = useRoutes()

  const rutas = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (row) =>
        row.code.toLowerCase().includes(term) ||
        row.name.toLowerCase().includes(term) ||
        (row.rep_name ?? '').toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && rutas.length === 0

  const scope =
    tenant && activeCompanyId
      ? { organizationId: tenant.organization_id, companyId: activeCompanyId }
      : null

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('sales.routes.help')}</Typography>

      <FilterBar
        actions={
          <Button
            variant="contained"
            disabled={!canWrite || !scope}
            onClick={() => {
              setAbierta(null)
              setCreando(true)
            }}
          >
            {t('sales.routes.new')}
          </Button>
        }
      >
        <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('sales.routes.search')}
            ariaLabel={t('sales.routes.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={5} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('sales.noResults') : t('sales.routes.empty')}
            description={search ? undefined : t('sales.routes.emptyBody')}
            icon={<AltRouteRoundedIcon fontSize="small" />}
          />
        )}

        {!query.isPending && !query.isError && rutas.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('sales.field.code')}</TableCell>
                <TableCell>{t('sales.field.name')}</TableCell>
                <TableCell>{t('sales.field.rep')}</TableCell>
                <TableCell>{t('sales.field.weekday')}</TableCell>
                <TableCell>{t('sales.field.frequency')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rutas.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{row.code}</TableCell>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.rep_name ?? '—'}</TableCell>
                  <TableCell>{t(`sales.weekday.${row.weekday}` as MessageKey)}</TableCell>
                  <TableCell>
                    {row.frequency_weeks === 1
                      ? t('sales.frequency.weekly')
                      : t('sales.frequency.every').replace('{n}', String(row.frequency_weeks))}
                  </TableCell>
                  <TableCell>
                    <StatusChip
                      tone={row.is_active ? 'success' : 'default'}
                      label={row.is_active ? t('common.active') : t('common.inactive')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => {
                        setCreando(false)
                        setAbierta(row)
                      }}
                    >
                      {t('common.open')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <RouteDrawer
        open={creando || abierta !== null}
        route={abierta}
        scope={scope}
        canWrite={canWrite}
        onClose={() => {
          setCreando(false)
          setAbierta(null)
        }}
      />
    </Stack>
  )
}
