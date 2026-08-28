import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import {
  Alert,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState } from '@/shared/ui/states'
import { PricingError } from './errors'
import { useAddAssignment, useAssignments, useChannels, useDeleteAssignment, useSegments } from './hooks'
import { PRICE_SCOPES, SCOPE_RANK, assignmentFormSchema, type PriceList, type PriceScope } from './types'

/**
 * A quién se le aplica esta lista.
 *
 * La tabla enseña el RANGO de cada alcance junto al nombre, y no por adorno:
 * la precedencia es la única regla del motor que no se puede configurar, así
 * que la pantalla tiene que decirla en vez de dejar que se descubra vendiendo.
 *
 * El alcance «cliente» pide un identificador de cuenta a mano porque la ficha
 * de cliente todavía no existe (es P05). Está declarado así, con su aviso, en
 * lugar de esconderlo: un motor de precios sin precio negociado por cuenta no
 * es un motor de precios B2B, y dejar el hueco visible es más honesto que
 * fingir que la dimensión no está.
 */
export function AssignmentsPanel({ list, canWrite }: { list: PriceList; canWrite: boolean }) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, activeStore } = useTenant()

  const assignments = useAssignments(list.id)
  const channels = useChannels(activeStore?.id ?? null)
  const segments = useSegments()
  const add = useAddAssignment()
  const remove = useDeleteAssignment()

  const [scope, setScope] = useState<PriceScope>('store')
  const [channelId, setChannelId] = useState('')
  const [segmentId, setSegmentId] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [error, setError] = useState<MessageKey | null>(null)

  const targetName = useMemo(() => {
    const names = new Map<string, string>()
    for (const channel of channels.data ?? []) names.set(channel.id, `${channel.code} · ${channel.name}`)
    for (const segment of segments.data ?? []) names.set(segment.id, segment.name)
    return names
  }, [channels.data, segments.data])

  async function submit() {
    if (!tenant || !activeCompanyId || !activeStore) return
    const parsed = assignmentFormSchema.safeParse({
      scope,
      channel_id: channelId,
      segment_id: segmentId,
      customer_id: customerId.trim(),
    })
    if (!parsed.success) {
      setError('pricing.error.target')
      return
    }

    setError(null)
    try {
      await add.mutateAsync({
        scope: {
          organizationId: tenant.organization_id,
          companyId: activeCompanyId,
          storeId: activeStore.id,
        },
        listId: list.id,
        values: parsed.data,
      })
      notify(t('pricing.toast.saved'))
      setChannelId('')
      setSegmentId('')
      setCustomerId('')
    } catch (caught) {
      setError(caught instanceof PricingError ? caught.key : 'pricing.error.generic')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('pricing.assignments.help')}</Typography>

      {canWrite && (
        <Stack spacing={1.5}>
          {error && <Alert severity="error">{t(error)}</Alert>}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              select
              size="small"
              fullWidth
              label={t('pricing.field.scope')}
              value={scope}
              onChange={(event) => setScope(event.target.value as PriceScope)}
            >
              {PRICE_SCOPES.map((option) => (
                <MenuItem key={option} value={option}>
                  {t(`pricing.scope.${option}`)} ({SCOPE_RANK[option]})
                </MenuItem>
              ))}
            </TextField>

            {scope === 'channel' && (
              <TextField
                select
                size="small"
                fullWidth
                label={t('pricing.field.channel')}
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
              >
                {(channels.data ?? []).map((channel) => (
                  <MenuItem key={channel.id} value={channel.id}>
                    {channel.code} · {channel.name}
                  </MenuItem>
                ))}
              </TextField>
            )}

            {scope === 'segment' && (
              <TextField
                select
                size="small"
                fullWidth
                label={t('pricing.field.segment')}
                value={segmentId}
                onChange={(event) => setSegmentId(event.target.value)}
              >
                {(segments.data ?? []).map((segment) => (
                  <MenuItem key={segment.id} value={segment.id}>
                    {segment.name}
                  </MenuItem>
                ))}
              </TextField>
            )}

            {scope === 'customer' && (
              <TextField
                size="small"
                fullWidth
                label={t('pricing.field.customer')}
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
                helperText={t('pricing.field.customerHint')}
              />
            )}

            <Button variant="contained" onClick={() => void submit()} disabled={add.isPending}>
              {t('common.add')}
            </Button>
          </Stack>
        </Stack>
      )}

      {!assignments.isPending && (assignments.data ?? []).length === 0 && (
        <EmptyState
          title={t('pricing.assignments.empty')}
          description={t('pricing.assignments.emptyBody')}
        />
      )}

      {(assignments.data ?? []).length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('pricing.field.scope')}</TableCell>
              <TableCell>{t('pricing.field.target')}</TableCell>
              <TableCell align="right">{t('pricing.field.rank')}</TableCell>
              <TableCell align="right">{t('common.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(assignments.data ?? []).map((assignment) => {
              const target =
                assignment.channel_id ?? assignment.segment_id ?? assignment.customer_id ?? null
              return (
                <TableRow key={assignment.id} hover>
                  <TableCell>
                    <Chip size="small" label={t(`pricing.scope.${assignment.scope}`)} />
                  </TableCell>
                  <TableCell>
                    {target ? (targetName.get(target) ?? target) : t('pricing.scope.storeAll')}
                  </TableCell>
                  <TableCell align="right">{SCOPE_RANK[assignment.scope]}</TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      disabled={!canWrite || remove.isPending}
                      aria-label={`${t('common.delete')} ${t(`pricing.scope.${assignment.scope}`)}`}
                      onClick={() => {
                        void remove
                          .mutateAsync(assignment.id)
                          .then(() => notify(t('pricing.toast.deleted')))
                      }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </Stack>
  )
}
