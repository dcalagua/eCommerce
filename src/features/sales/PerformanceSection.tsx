import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import FlagRoundedIcon from '@mui/icons-material/FlagRounded'
import PaidRoundedIcon from '@mui/icons-material/PaidRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import {
  Alert,
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
import { useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { RowActions, type RowAction } from '@/shared/ui/RowActions'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { GoalDrawer } from './GoalDrawer'
import { SalesError } from './errors'
import { useAdvanceCommission, useCommissions, useGoals } from './hooks'
import { nextCommissionStatuses, type CommissionStatus, type Goal } from './types'

/**
 * El icono dice a DÓNDE lleva la acción, no de dónde viene: visto bueno para
 * aprobar, moneda para pagar, y la flecha de vuelta para devolver a borrador.
 */
function iconoDeComision(status: CommissionStatus) {
  if (status === 'approved') return <CheckCircleRoundedIcon fontSize="small" />
  if (status === 'paid') return <PaidRoundedIcon fontSize="small" />
  return <UndoRoundedIcon fontSize="small" />
}

/**
 * Metas y comisiones.
 *
 * ## La meta se guarda en la unidad en que se mide
 *
 * «Vendiste 1.200» no significa nada si no se sabe si son soles, cajas o
 * pedidos. Por eso la métrica sale en la propia columna del objetivo y la
 * moneda solo aparece cuando la métrica es importe: en las demás sería ruido, y
 * `sales_goals_currency_when_amount` la rechazaría.
 *
 * ## Una liquidación pagada no se reabre
 *
 * `ebim.commission_statement_guard` cierra `paid` y prohíbe volver de
 * `approved` a borrador. Los botones salen de `nextCommissionStatuses`, que
 * calca ese trigger: reabrir una liquidación pagada es dinero que ya salió y
 * una cifra que dice que no.
 *
 * ## Lo que esta pantalla NO hace
 *
 * No CALCULA la comisión. Las liquidaciones llegan con su base y su tasa ya
 * puestas; aquí se aprueban y se pagan. Un segundo motor de cálculo en el
 * navegador sería una segunda verdad sobre lo que se le debe a alguien.
 */
export function PerformanceSection() {
  const { t, locale } = useI18n()
  const { tenant, activeStore, activeCompanyId, can } = useTenant()
  // Aprobar y pagar una liquidación mueve dinero: administración, no campo.
  const canWrite = can('sales.manage')

  const [abierta, setAbierta] = useState<Goal | null>(null)
  const [creando, setCreando] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)

  const goals = useGoals()
  const commissions = useCommissions()
  const advance = useAdvanceCommission()

  const scope =
    tenant && activeCompanyId
      ? { organizationId: tenant.organization_id, companyId: activeCompanyId }
      : null

  const metas = goals.data ?? []
  const liquidaciones = commissions.data ?? []

  function tono(status: CommissionStatus) {
    if (status === 'paid') return 'success' as const
    if (status === 'approved') return 'info' as const
    return 'default' as const
  }

  /** El objetivo, en la unidad en que se midió. */
  function objetivo(goal: Goal): string {
    if (goal.metric === 'amount') {
      return formatMoney(Number(goal.target_value), goal.currency ?? 'PEN', locale)
    }
    return `${goal.target_value} ${t(`sales.metric.${goal.metric}` as MessageKey)}`
  }

  async function avanzar(id: string, status: CommissionStatus) {
    setError(null)
    try {
      await advance.mutateAsync({ id, status })
    } catch (err) {
      setError(err instanceof SalesError ? err.key : 'sales.error.generic')
    }
  }

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{t(error)}</Alert>}

      <Stack spacing={2}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap">
          <Typography sx={{ fontWeight: 800 }}>{t('sales.goals.title')}</Typography>
          <Button
            variant="contained"
            size="small"
            disabled={!canWrite || !scope}
            onClick={() => {
              setAbierta(null)
              setCreando(true)
            }}
          >
            {t('sales.goals.new')}
          </Button>
        </Stack>

        <Typography sx={{ color: 'var(--muted)' }}>{t('sales.goals.help')}</Typography>

        <Card>
          {goals.isPending && <TableSkeleton columns={5} />}
          {goals.isError && <ErrorState error={goals.error} onRetry={() => void goals.refetch()} />}
          {!goals.isPending && !goals.isError && metas.length === 0 && (
            <EmptyState
              title={t('sales.goals.empty')}
              description={t('sales.goals.emptyBody')}
              icon={<FlagRoundedIcon fontSize="small" />}
            />
          )}

          {!goals.isPending && !goals.isError && metas.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('sales.field.owner')}</TableCell>
                  <TableCell>{t('sales.field.metric')}</TableCell>
                  <TableCell>{t('sales.field.period')}</TableCell>
                  <TableCell align="right">{t('sales.field.target')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {metas.map((goal) => (
                  <TableRow key={goal.id} hover>
                    <TableCell>
                      {/* De un vendedor o de un territorio, nunca de los dos:
                          lo impone `sales_goals_one_owner`. */}
                      {goal.rep_name ?? t('sales.goals.territoryOwner')}
                    </TableCell>
                    <TableCell>{t(`sales.metric.${goal.metric}` as MessageKey)}</TableCell>
                    <TableCell>{`${goal.period_start} → ${goal.period_end}`}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>
                      {objetivo(goal)}
                    </TableCell>
                    <TableCell align="right">
                      <RowActions
                        actions={[
                          {
                            id: 'edit',
                            icon: <EditRoundedIcon fontSize="small" />,
                            label: `${t('common.edit')}: ${goal.rep_name ?? t('sales.goals.territoryOwner')}`,
                            tone: 'neutral',
                            onClick: () => {
                              setCreando(false)
                              setAbierta(goal)
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
      </Stack>

      <Stack spacing={2}>
        <Typography sx={{ fontWeight: 800 }}>{t('sales.commissions.title')}</Typography>
        <Typography sx={{ color: 'var(--muted)' }}>{t('sales.commissions.help')}</Typography>

        <Card>
          {commissions.isPending && <TableSkeleton columns={6} />}
          {commissions.isError && (
            <ErrorState error={commissions.error} onRetry={() => void commissions.refetch()} />
          )}
          {!commissions.isPending && !commissions.isError && liquidaciones.length === 0 && (
            <EmptyState
              title={t('sales.commissions.empty')}
              description={t('sales.commissions.emptyBody')}
              icon={<PaidRoundedIcon fontSize="small" />}
            />
          )}

          {!commissions.isPending && !commissions.isError && liquidaciones.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('sales.field.rep')}</TableCell>
                  <TableCell>{t('sales.field.period')}</TableCell>
                  <TableCell align="right">{t('sales.field.base')}</TableCell>
                  <TableCell align="right">{t('sales.field.rate')}</TableCell>
                  <TableCell align="right">{t('sales.field.commission')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {liquidaciones.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.rep_name ?? '—'}</TableCell>
                    <TableCell>{`${row.period_start} → ${row.period_end}`}</TableCell>
                    <TableCell align="right">
                      {formatMoney(Number(row.base_amount), row.currency, locale)}
                    </TableCell>
                    <TableCell align="right">
                      {`${(Number(row.rate) * 100).toFixed(2)} %`}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>
                      {formatMoney(Number(row.amount), row.currency, locale)}
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        tone={tono(row.status)}
                        label={t(`sales.commission.${row.status}` as MessageKey)}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <RowActions
                        actions={nextCommissionStatuses(row.status).map(
                          (status): RowAction => ({
                            id: status,
                            icon: iconoDeComision(status),
                            label: `${t(`sales.commission.action.${status}` as MessageKey)}: ${row.rep_name ?? ''}`,
                            tone: status === 'draft' ? 'neutral' : 'accent',
                            disabled: !canWrite || advance.isPending,
                            onClick: () => void avanzar(row.id, status),
                          }),
                        )}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>

      <GoalDrawer
        open={creando || abierta !== null}
        goal={abierta}
        scope={scope}
        currency={activeStore?.currency ?? 'PEN'}
        canWrite={canWrite}
        onClose={() => {
          setCreando(false)
          setAbierta(null)
        }}
      />
    </Stack>
  )
}
