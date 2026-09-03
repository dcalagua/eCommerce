import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'
import {
  Alert,
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
import { TablePager } from '@/shared/ui/TablePager'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { usePagedRows } from '@/shared/ui/usePagedRows'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { GenerateDrawer } from './GenerateDrawer'
import { SuggestionDrawer } from './SuggestionDrawer'
import { PlanningError } from './errors'
import { useSetSuggestionStatus, useSuggestions } from './hooks'
import { nextSuggestionStatuses, type Suggestion, type SuggestionStatus } from './types'

/**
 * Sugerido de pedido: qué convendría pedir, y por qué.
 *
 * ## No crea pedidos
 *
 * Produce una lista que una persona confirma. Un sistema que pide por ti es un
 * sistema que se equivoca por ti, y en distribución eso se paga en devoluciones
 * y mercadería vencida.
 *
 * ## El modelo se ve
 *
 * `model_code` sale en la tabla porque permite comparar dos generaciones y
 * retirar un modelo que sugiere mal **sin borrar lo que ya sugirió**. Un
 * sugerido sin modelo a la vista es una cifra de procedencia desconocida.
 */
export function SuggestionsSection() {
  const { t } = useI18n()
  const { tenant, activeStore, activeCompanyId, can } = useTenant()
  const canWrite = can('sales.operate')

  const [search, setSearch] = useState('')
  const [abierta, setAbierta] = useState<Suggestion | null>(null)
  const [generando, setGenerando] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)

  const query = useSuggestions()
  const setStatus = useSetSuggestionStatus()

  const sugerencias = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (row) =>
        (row.customer_name ?? '').toLowerCase().includes(term) ||
        (row.customer_code ?? '').toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && sugerencias.length === 0
  const pager = usePagedRows(sugerencias)

  const scope =
    tenant && activeCompanyId && activeStore
      ? {
          organizationId: tenant.organization_id,
          companyId: activeCompanyId,
          storeId: activeStore.id,
        }
      : null

  function tono(status: SuggestionStatus) {
    if (status === 'accepted') return 'success' as const
    if (status === 'discarded') return 'default' as const
    if (status === 'sent') return 'info' as const
    return 'warning' as const
  }

  async function avanzar(id: string, status: SuggestionStatus) {
    setError(null)
    try {
      await setStatus.mutateAsync({ id, status })
    } catch (err) {
      setError(err instanceof PlanningError ? err.key : 'planning.error.generic')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('planning.suggestions.help')}</Typography>

      {error && <Alert severity="error">{t(error)}</Alert>}

      <FilterBar
        actions={
          <Button
            variant="contained"
            disabled={!canWrite || !scope}
            onClick={() => setGenerando(true)}
          >
            {t('planning.generate.title')}
          </Button>
        }
      >
        <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('planning.suggestions.search')}
            ariaLabel={t('planning.suggestions.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={5} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('planning.noResults') : t('planning.suggestions.empty')}
            description={search ? undefined : t('planning.suggestions.emptyBody')}
            icon={<AutoAwesomeRoundedIcon fontSize="small" />}
          />
        )}

        {!query.isPending && !query.isError && sugerencias.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('planning.field.customer')}</TableCell>
                <TableCell>{t('planning.field.generatedAt')}</TableCell>
                <TableCell>{t('planning.field.model')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pager.rows.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>{row.customer_name ?? '—'}</Typography>
                      <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                        {row.customer_code ?? ''}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>{row.generated_at.slice(0, 10)}</TableCell>
                  {/* El modelo a la vista: sin él, la cifra no tiene procedencia. */}
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {row.model_code}
                  </TableCell>
                  <TableCell>
                    <StatusChip
                      tone={tono(row.status)}
                      label={t(`planning.status.${row.status}` as MessageKey)}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      {nextSuggestionStatuses(row.status).map((status) => (
                        <Button
                          key={status}
                          size="small"
                          disabled={!canWrite || setStatus.isPending}
                          onClick={() => void avanzar(row.id, status)}
                        >
                          {t(`planning.action.${status}` as MessageKey)}
                        </Button>
                      ))}
                      <Button size="small" onClick={() => setAbierta(row)}>
                        {t('common.open')}
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
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

      <GenerateDrawer
        open={generando}
        scope={scope}
        canWrite={canWrite}
        onClose={() => setGenerando(false)}
      />

      <SuggestionDrawer
        open={abierta !== null}
        suggestion={abierta}
        onClose={() => setAbierta(null)}
      />
    </Stack>
  )
}
