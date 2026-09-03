import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import PersonOffRoundedIcon from '@mui/icons-material/PersonOffRounded'
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
import { RowActions } from '@/shared/ui/RowActions'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TablePager } from '@/shared/ui/TablePager'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { usePagedRows } from '@/shared/ui/usePagedRows'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { SalesError } from './errors'
import { useDeactivateSalesRep, useSalesReps } from './hooks'
import { RepDrawer } from './RepDrawer'
import type { SalesRep } from './types'

/**
 * La fuerza de ventas.
 *
 * Un buscador general y una tabla, como el resto del backoffice (§8): nada de
 * un panel de filtros multi-campo para una lista que en un distribuidor real
 * tiene decenas de filas, no miles.
 *
 * ## La baja desactiva, no borra
 *
 * De un vendedor cuelgan sus visitas, su cartera y sus liquidaciones, y
 * `commission_statements` lo referencia con `on delete restrict` justo para que
 * un borrado no se lleve por delante un pago ya hecho. Desactivar conserva la
 * historia y le quita el acceso, que es lo que de verdad se quiere al dar de
 * baja a alguien.
 */
export function RepsSection() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, can } = useTenant()
  const canWrite = can('sales.manage')

  const [search, setSearch] = useState('')
  const [drawer, setDrawer] = useState<{ open: boolean; rep: SalesRep | null }>({
    open: false,
    rep: null,
  })

  const query = useSalesReps()
  const deactivate = useDeactivateSalesRep()

  const reps = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (rep) =>
        rep.full_name.toLowerCase().includes(term) ||
        rep.employee_code.toLowerCase().includes(term) ||
        (rep.email ?? '').toLowerCase().includes(term),
    )
  }, [query.data, search])

  const porId = useMemo(
    () => new Map((query.data ?? []).map((rep) => [rep.id, rep])),
    [query.data],
  )

  const isEmpty = !query.isPending && !query.isError && reps.length === 0

  // Antes de cualquier `return`: un hook detrás de una guarda cambia de orden
  // entre renders. Misma nota que en `BusinessAccountsSection`.
  const pager = usePagedRows(reps)

  async function darDeBaja(rep: SalesRep) {
    try {
      await deactivate.mutateAsync(rep.id)
      notify(t('sales.toast.deactivated'), 'success')
    } catch (error) {
      notify(t(error instanceof SalesError ? error.key : 'sales.error.generic'), 'error')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('sales.reps.help')}</Typography>

      <FilterBar
        actions={
          canWrite && (
            <Button variant="contained" onClick={() => setDrawer({ open: true, rep: null })}>
              {t('sales.reps.new')}
            </Button>
          )
        }
      >
        <Box sx={{ minWidth: { xs: '100%', sm: 280 } }}>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('sales.reps.search')}
            ariaLabel={t('sales.reps.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={5} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('sales.noResults') : t('sales.reps.empty')}
            description={search ? undefined : t('sales.reps.emptyBody')}
            icon={<BadgeRoundedIcon fontSize="small" />}
          />
        )}

        {!query.isPending && !query.isError && reps.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('sales.field.code')}</TableCell>
                <TableCell>{t('sales.field.name')}</TableCell>
                <TableCell>{t('sales.field.manager')}</TableCell>
                <TableCell>{t('sales.field.access')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pager.rows.map((rep) => {
                const jefe = rep.manager_id ? porId.get(rep.manager_id) : null
                return (
                  <TableRow key={rep.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{rep.employee_code}</TableCell>
                    <TableCell>
                      <Box>
                        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                          {rep.full_name}
                        </Typography>
                        {rep.email && (
                          <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                            {rep.email}
                          </Typography>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>{jefe ? jefe.full_name : '—'}</TableCell>
                    <TableCell>
                      {/* Existir en el maestro y tener acceso a la aplicación son
                          dos cosas distintas: muchos preventistas nunca entran. */}
                      <StatusChip
                        tone={rep.user_id ? 'success' : 'default'}
                        label={rep.user_id ? t('sales.access.yes') : t('sales.access.no')}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        tone={rep.status === 'active' ? 'success' : 'default'}
                        label={t(`sales.status.${rep.status}` as MessageKey)}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <RowActions
                        actions={[
                          {
                            id: 'edit',
                            icon: <EditRoundedIcon fontSize="small" />,
                            label: `${t('common.edit')}: ${rep.full_name}`,
                            tone: 'neutral',
                            onClick: () => setDrawer({ open: true, rep }),
                          },
                          {
                            id: 'off',
                            icon: <PersonOffRoundedIcon fontSize="small" />,
                            label: `${t('sales.reps.deactivate')}: ${rep.full_name}`,
                            tone: 'danger',
                            disabled:
                              !canWrite || rep.status === 'disabled' || deactivate.isPending,
                            onClick: () => void darDeBaja(rep),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}

        {pager.total > 0 && (
          <TablePager
            page={pager.page}
            pageSize={pager.pageSize}
            total={pager.total}
            onPageChange={pager.setPage}
          />
        )}
      </Card>

      <RepDrawer
        open={drawer.open}
        rep={drawer.rep}
        canWrite={canWrite}
        scope={
          tenant && activeCompanyId
            ? { organizationId: tenant.organization_id, companyId: activeCompanyId }
            : null
        }
        onClose={() => setDrawer({ open: false, rep: null })}
      />
    </Stack>
  )
}
