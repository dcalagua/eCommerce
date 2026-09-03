import CancelRoundedIcon from '@mui/icons-material/CancelRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded'
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
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
import { useMemo, useState, type ReactNode } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FilterBar } from '@/shared/ui/FilterBar'
import { RowActions, type RowActionTone } from '@/shared/ui/RowActions'
import { SearchField } from '@/shared/ui/SearchField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { PlanDrawer } from './PlanDrawer'
import { FulfillmentError } from './errors'
import { usePlans, useSetPlanStatus } from './routing-hooks'
import { nextPlanStatuses, type Plan, type PlanStatus } from './routing-types'

/**
 * Cómo se ve cada transición de la hoja.
 *
 * El tono lo pone lo que la acción HACE: despachar y cerrar avanzan el reparto
 * y van en el acento; cancelar tumba la hoja y va en rojo; volver a borrador
 * solo deshace y es neutro.
 */
function accionVisual(status: PlanStatus): { icon: ReactNode; tone: RowActionTone } {
  if (status === 'dispatched') {
    return { icon: <LocalShippingRoundedIcon fontSize="small" />, tone: 'accent' }
  }
  if (status === 'closed') return { icon: <TaskAltRoundedIcon fontSize="small" />, tone: 'accent' }
  if (status === 'cancelled') {
    return { icon: <CancelRoundedIcon fontSize="small" />, tone: 'danger' }
  }
  return { icon: <UndoRoundedIcon fontSize="small" />, tone: 'neutral' }
}

/**
 * Reparto propio: hojas de ruta y evidencia de entrega.
 *
 * ## La hoja agrupa despachos que YA existen
 *
 * No crea ninguno. Si lo hiciera habría dos verdades sobre lo que salió del
 * almacén, y la que gana sería la última que alguien miró.
 *
 * ## El estado lo decide esta pantalla, y se dice
 *
 * `delivery_plans` **no tiene trigger de estado**: el orden —se arma, sale, se
 * cierra— es criterio de pantalla, no una barrera del servidor. Se anota aquí
 * para que nadie lo confunda con una garantía. Lo que sí es inmutable es la
 * evidencia: `pod_is_immutable` rechaza cualquier cambio.
 */
export function RoutingSection() {
  const { t } = useI18n()
  const { tenant, activeStore, activeCompanyId, can } = useTenant()
  const canWrite = can('orders.write')

  const [search, setSearch] = useState('')
  const [abierta, setAbierta] = useState<Plan | null>(null)
  const [creando, setCreando] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)

  const query = usePlans()
  const setStatus = useSetPlanStatus()

  const hojas = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (row) =>
        row.code.toLowerCase().includes(term) ||
        (row.driver_name ?? '').toLowerCase().includes(term) ||
        (row.vehicle_code ?? '').toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && hojas.length === 0

  const scope =
    tenant && activeCompanyId && activeStore
      ? {
          organizationId: tenant.organization_id,
          companyId: activeCompanyId,
          storeId: activeStore.id,
        }
      : null

  function tono(status: PlanStatus) {
    if (status === 'closed') return 'success' as const
    if (status === 'cancelled') return 'error' as const
    if (status === 'dispatched') return 'info' as const
    return 'default' as const
  }

  async function avanzar(id: string, status: PlanStatus) {
    setError(null)
    try {
      await setStatus.mutateAsync({ id, status })
    } catch (err) {
      setError(err instanceof FulfillmentError ? err.key : 'fulfillment.error.generic')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('fulfillment.routing.help')}</Typography>

      {error && <Alert severity="error">{t(error)}</Alert>}

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
            {t('fulfillment.routing.new')}
          </Button>
        }
      >
        <Box sx={{ minWidth: { xs: '100%', sm: 300 } }}>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('fulfillment.routing.search')}
            ariaLabel={t('fulfillment.routing.search')}
          />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={5} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('fulfillment.noResults') : t('fulfillment.routing.empty')}
            description={search ? undefined : t('fulfillment.routing.emptyBody')}
            icon={<LocalShippingRoundedIcon fontSize="small" />}
          />
        )}

        {!query.isPending && !query.isError && hojas.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('fulfillment.field.planCode')}</TableCell>
                <TableCell>{t('fulfillment.field.planDate')}</TableCell>
                <TableCell>{t('fulfillment.field.vehicle')}</TableCell>
                <TableCell>{t('fulfillment.field.driver')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {hojas.map((plan) => (
                <TableRow key={plan.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{plan.code}</TableCell>
                  <TableCell>{plan.plan_date}</TableCell>
                  <TableCell>{plan.vehicle_code ?? '—'}</TableCell>
                  <TableCell>{plan.driver_name ?? '—'}</TableCell>
                  <TableCell>
                    <StatusChip
                      tone={tono(plan.status)}
                      label={t(`fulfillment.plan.${plan.status}` as MessageKey)}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <RowActions
                      actions={[
                        ...nextPlanStatuses(plan.status).map((status) => ({
                          id: status,
                          ...accionVisual(status),
                          label:
                            `${t(`fulfillment.plan.action.${status}` as MessageKey)}: ` +
                            `${plan.code}`,
                          disabled: !canWrite || setStatus.isPending,
                          onClick: () => void avanzar(plan.id, status),
                        })),
                        {
                          id: 'open',
                          icon: <ChevronRightRoundedIcon fontSize="small" />,
                          label: `${t('common.open')}: ${plan.code}`,
                          tone: 'neutral' as const,
                          onClick: () => {
                            setCreando(false)
                            setAbierta(plan)
                          },
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <PlanDrawer
        open={creando || abierta !== null}
        plan={abierta}
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
