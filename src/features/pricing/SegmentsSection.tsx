import { FilterBar } from '@/shared/ui/FilterBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Alert,
  Box,
  Button,
  Card,
  FormControlLabel,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { useForm } from 'react-hook-form'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { PricingError } from './errors'
import { useSaveSegment, useSegments } from './hooks'
import { segmentFormSchema, type CustomerSegment, type SegmentFormValues } from './types'

/**
 * Segmentos comerciales.
 *
 * Es vocabulario de la SOCIEDAD, no de la tienda: «mayorista» significa lo
 * mismo en todas sus tiendas, igual que una marca o una unidad de medida. La
 * ficha del cliente que se le cuelga llega en P05; aquí nace porque el segmento
 * es antes una dimensión de precio que un dato de cliente.
 */
export function SegmentsSection() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, can } = useTenant()
  const canWrite = can('catalog.write')

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ open: boolean; segment: CustomerSegment | null }>({
    open: false,
    segment: null,
  })

  const query = useSegments()
  const save = useSaveSegment()

  const segments = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (segment) =>
        segment.name.toLowerCase().includes(term) || segment.code.toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && segments.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('pricing.segments.help')}</Typography>

      <FilterBar>
        <Box sx={{ flex: 1 }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('pricing.search')} />
        </Box>
        {canWrite && (
          <Button variant="contained" onClick={() => setEditing({ open: true, segment: null })}>
            {t('pricing.segments.new')}
          </Button>
        )}
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={3} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('pricing.noResults') : t('pricing.segments.empty')}
            icon={<GroupsRoundedIcon fontSize="small" />}
          />
        )}
        {!query.isPending && !query.isError && segments.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('pricing.field.code')}</TableCell>
                <TableCell>{t('pricing.field.name')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {segments.map((segment) => (
                <TableRow key={segment.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{segment.code}</TableCell>
                  <TableCell>{segment.name}</TableCell>
                  <TableCell>
                    <StatusChip
                      tone={segment.is_active ? 'success' : 'default'}
                      label={segment.is_active ? t('pricing.field.active') : t('common.no')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => setEditing({ open: true, segment })}
                      aria-label={`${t('common.edit')}: ${segment.name}`}
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

      <SegmentDrawer
        open={editing.open}
        segment={editing.segment}
        canWrite={canWrite}
        onClose={() => setEditing({ open: false, segment: null })}
        onSubmit={async (values) => {
          if (!tenant || !activeCompanyId) return
          await save.mutateAsync({
            id: editing.segment?.id ?? null,
            scope: { organizationId: tenant.organization_id, companyId: activeCompanyId },
            values,
          })
          notify(t('pricing.toast.saved'))
          setEditing({ open: false, segment: null })
        }}
      />
    </Stack>
  )
}

function SegmentDrawer({
  open,
  segment,
  canWrite,
  onClose,
  onSubmit,
}: {
  open: boolean
  segment: CustomerSegment | null
  canWrite: boolean
  onClose: () => void
  onSubmit: (values: SegmentFormValues) => Promise<void>
}) {
  const { t } = useI18n()
  const [serverError, setServerError] = useState<MessageKey | null>(null)
  const [codeEdited, setCodeEdited] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SegmentFormValues>({
    resolver: zodResolver(segmentFormSchema),
    defaultValues: {
      code: segment?.code ?? '',
      name: segment?.name ?? '',
      is_active: segment?.is_active ?? true,
    },
  })

  useEffect(() => {
    if (!open) return
    reset({
      code: segment?.code ?? '',
      name: segment?.name ?? '',
      is_active: segment?.is_active ?? true,
    })
    setCodeEdited(Boolean(segment))
    setServerError(null)
  }, [open, segment, reset])

  const fieldError = (key: keyof SegmentFormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

  async function submit(values: SegmentFormValues) {
    setServerError(null)
    try {
      await onSubmit(values)
    } catch (error) {
      setServerError(error instanceof PricingError ? error.key : 'pricing.error.generic')
    }
  }

  return (
    <FormDrawer
      open={open}
      title={segment ? segment.name : t('pricing.segments.new')}
      onClose={onClose}
      busy={isSubmitting}
      actions={
        <>
          <Button onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="segment-form"
            variant="contained"
            disabled={isSubmitting || !canWrite}
          >
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <Box component="form" id="segment-form" onSubmit={handleSubmit(submit)} noValidate>
        <Stack spacing={2.5}>
          {serverError && <Alert severity="error">{t(serverError)}</Alert>}

          <TextField
            label={t('pricing.field.name')}
            fullWidth
            autoFocus
            disabled={!canWrite}
            error={Boolean(errors.name)}
            helperText={fieldError('name')}
            {...register('name', {
              onChange: (event: ChangeEvent<HTMLInputElement>) => {
                if (!codeEdited) {
                  setValue(
                    'code',
                    event.target.value
                      .normalize('NFD')
                      .replace(/[̀-ͯ]/g, '')
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-+|-+$/g, '')
                      .slice(0, 41),
                  )
                }
              },
            })}
          />

          <TextField
            label={t('pricing.field.code')}
            fullWidth
            disabled={!canWrite}
            error={Boolean(errors.code)}
            helperText={fieldError('code')}
            inputProps={{ spellCheck: false }}
            {...register('code', { onChange: () => setCodeEdited(true) })}
          />

          <FormControlLabel
            control={
              <Switch
                checked={watch('is_active')}
                disabled={!canWrite}
                onChange={(_, checked) => setValue('is_active', checked)}
              />
            }
            label={t('pricing.field.active')}
          />
        </Stack>
      </Box>
    </FormDrawer>
  )
}
