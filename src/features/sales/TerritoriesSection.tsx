import MapRoundedIcon from '@mui/icons-material/MapRounded'
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
import { FilterBar } from '@/shared/ui/FilterBar'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { TerritoryDrawer } from './TerritoryDrawer'
import { useTerritories } from './hooks'
import type { Territory } from './types'

/**
 * Territorios comerciales.
 *
 * ## El territorio es SUYO, no de logística
 *
 * No reutiliza `delivery_zones`: atar la cartera de un vendedor al recorrido de
 * un camión haría que cambiar una ruta de reparto moviera clientes de dueño, y
 * con ellos las comisiones.
 *
 * ## La jerarquía se lee sangrada
 *
 * Un árbol pintado como lista plana obliga a reconstruirlo mentalmente leyendo
 * la columna «padre» fila por fila. La sangría cuesta una función y lo dice de
 * un vistazo. La profundidad se calcula sobre lo que llegó: la base garantiza
 * que no hay ciclos (`sales_territory_tree_guard`), pero el corte a 12 saltos
 * está por si acaso — colgar el navegador no es una forma aceptable de
 * enterarse de que un dato viene mal.
 */
function depthOf(territory: Territory, byId: Map<string, Territory>): number {
  let saltos = 0
  let actual = territory.parent_id
  while (actual && saltos < 12) {
    actual = byId.get(actual)?.parent_id ?? null
    saltos += 1
  }
  return saltos
}

export function TerritoriesSection() {
  const { t } = useI18n()
  const { tenant, activeCompanyId, can } = useTenant()
  // Definir territorios es ADMINISTRACIÓN: decide de quién es cada cliente y,
  // con ello, quién cobra la comisión. No es una tarea de campo.
  const canWrite = can('sales.manage')

  const [search, setSearch] = useState('')
  const [abierto, setAbierto] = useState<Territory | null>(null)
  const [creando, setCreando] = useState(false)

  const query = useTerritories()

  const { filas, byId } = useMemo(() => {
    const todos = query.data ?? []
    const indice = new Map(todos.map((row) => [row.id, row]))
    const term = search.trim().toLowerCase()
    const visibles = term
      ? todos.filter(
          (row) => row.code.toLowerCase().includes(term) || row.name.toLowerCase().includes(term),
        )
      : todos
    return { filas: visibles, byId: indice }
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && filas.length === 0

  const scope =
    tenant && activeCompanyId
      ? { organizationId: tenant.organization_id, companyId: activeCompanyId }
      : null

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('sales.territories.help')}</Typography>

      {!canWrite && <Alert severity="info">{t('sales.readOnly')}</Alert>}

      <FilterBar
        actions={
          <Button
            variant="contained"
            disabled={!canWrite || !scope}
            onClick={() => {
              setAbierto(null)
              setCreando(true)
            }}
          >
            {t('sales.territories.new')}
          </Button>
        }
      >
        <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('sales.territories.search')}
            ariaLabel={t('sales.territories.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={4} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('sales.noResults') : t('sales.territories.empty')}
            description={search ? undefined : t('sales.territories.emptyBody')}
            icon={<MapRoundedIcon fontSize="small" />}
          />
        )}

        {!query.isPending && !query.isError && filas.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('sales.field.code')}</TableCell>
                <TableCell>{t('sales.field.name')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filas.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{row.code}</TableCell>
                  <TableCell>
                    {/* La sangría dice de quién cuelga sin tener que cruzar la
                        columna «padre» fila por fila. */}
                    <Box sx={{ pl: depthOf(row, byId) * 2 }}>{row.name}</Box>
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
                        setAbierto(row)
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <TerritoryDrawer
        open={creando || abierto !== null}
        territory={abierto}
        territories={query.data ?? []}
        scope={scope}
        canWrite={canWrite}
        onClose={() => {
          setCreando(false)
          setAbierto(null)
        }}
      />
    </Stack>
  )
}
