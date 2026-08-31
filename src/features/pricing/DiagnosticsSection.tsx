import { StatusChip } from '@/shared/ui/StatusChip'
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded'
import {
  Alert,
  Card,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatDate } from '@/shared/lib/format'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { useConflicts, usePriceChanges } from './hooks'
import { conflictSeverity } from './types'

/**
 * Diagnóstico: lo que va a salir mal antes de que salga mal, y lo que ya se
 * cambió.
 *
 * Los conflictos los calcula el servidor (`price_list_conflicts`). El que
 * importa de verdad es `ambiguous_priority`: dos acuerdos con el mismo alcance,
 * la misma prioridad y vigencias solapadas obligan al motor a desempatar por el
 * id de la lista. El desempate existe para que el precio no dependa del plan de
 * ejecución, pero un precio decidido por un uuid es un precio que nadie eligió,
 * y aquí se denuncia como error y no como aviso.
 *
 * Los otros cuatro no rompen el precio: dejan la lista sin efecto. Son avisos
 * porque el fallo típico es creer que un acuerdo está puesto cuando la lista
 * está en otra moneda, caducada, sin asignar o vacía.
 */
export function DiagnosticsSection() {
  const { t, locale } = useI18n()
  const { activeStore } = useTenant()

  const conflicts = useConflicts(activeStore?.id ?? null)
  const changes = usePriceChanges(activeStore?.id ?? null)

  const rows = conflicts.data ?? []
  const errors = rows.filter((row) => conflictSeverity(row.kind) === 'error')

  return (
    <Stack spacing={3}>
      <Stack spacing={2}>
        <Typography sx={{ color: 'var(--muted)' }}>{t('pricing.diagnostics.help')}</Typography>

        {errors.length > 0 && (
          <Alert severity="error">{t('pricing.diagnostics.ambiguousWarning')}</Alert>
        )}

        <Card>
          {conflicts.isPending && <TableSkeleton columns={3} />}
          {conflicts.isError && (
            <ErrorState error={conflicts.error} onRetry={() => void conflicts.refetch()} />
          )}
          {!conflicts.isPending && !conflicts.isError && rows.length === 0 && (
            <EmptyState
              title={t('pricing.diagnostics.clean')}
              description={t('pricing.diagnostics.cleanBody')}
              icon={<FactCheckRoundedIcon fontSize="small" />}
            />
          )}
          {rows.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('pricing.field.issue')}</TableCell>
                  <TableCell>{t('pricing.field.list')}</TableCell>
                  <TableCell>{t('pricing.field.detail')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={`${row.kind}-${row.price_list_id ?? index}-${row.other_list_id ?? ''}`} hover>
                    <TableCell>
                      <StatusChip
                        tone={conflictSeverity(row.kind) === 'error' ? 'error' : 'warning'}
                        label={t(`pricing.conflict.${row.kind}`)}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>
                      {row.price_list_code}
                      {row.other_list_code ? ` ↔ ${row.other_list_code}` : ''}
                    </TableCell>
                    <TableCell sx={{ color: 'var(--muted)' }}>{row.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>

      <Stack spacing={2}>
        <Typography sx={{ fontWeight: 800 }}>{t('pricing.audit.title')}</Typography>
        <Typography sx={{ color: 'var(--muted)' }}>{t('pricing.audit.help')}</Typography>

        <Card>
          {changes.isPending && <TableSkeleton columns={4} />}
          {changes.isError && (
            <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />
          )}
          {!changes.isPending && !changes.isError && (changes.data ?? []).length === 0 && (
            <EmptyState title={t('pricing.audit.empty')} />
          )}
          {(changes.data ?? []).length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('common.date')}</TableCell>
                  <TableCell>{t('pricing.field.action')}</TableCell>
                  <TableCell align="right">{t('pricing.field.change')}</TableCell>
                  <TableCell>{t('pricing.field.actor')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(changes.data ?? []).map((event) => (
                  <TableRow key={event.id} hover>
                    <TableCell>{formatDate(event.occurred_at, locale)}</TableCell>
                    <TableCell>{t(`pricing.action.${event.action}`)}</TableCell>
                    <TableCell align="right">
                      {event.old_unit_price ?? '—'} → {event.new_unit_price ?? '—'}
                    </TableCell>
                    <TableCell sx={{ color: 'var(--muted)' }}>
                      {event.actor_email ?? t('pricing.audit.server')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>
    </Stack>
  )
}
