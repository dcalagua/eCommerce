import { FilterBar } from '@/shared/ui/FilterBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import { zodResolver } from '@hookform/resolvers/zod'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
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
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { CatalogError } from '../api/errors'
import { useSaveUnit, useUnits } from './hooks'
import { unitFormSchema, unitToForm, type UnitFormValues, type UnitOfMeasure } from './types'

/**
 * Unidades de medida de la sociedad.
 *
 * Aquí solo se declaran: "Caja" existe. Cuántas unidades base entrega una caja
 * DE ESTE producto es otra cosa y vive en la pestaña Unidades del producto —
 * porque una caja de jabón y una de televisores no traen lo mismo.
 */
export function UnitsSection() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, can } = useTenant()
  const canWrite = can('catalog.write')

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ open: boolean; unit: UnitOfMeasure | null }>({
    open: false,
    unit: null,
  })

  const units = useUnits()
  const save = useSaveUnit()

  const items = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = units.data ?? []
    if (!term) return all
    return all.filter(
      (unit) => unit.name.toLowerCase().includes(term) || unit.code.toLowerCase().includes(term),
    )
  }, [units.data, search])

  const isEmpty = !units.isPending && !units.isError && items.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('pim.units.help')}</Typography>

      <FilterBar>
        <Box sx={{ flex: 1 }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('pim.search')} />
        </Box>
        {canWrite && (
          <Button variant="contained" onClick={() => setEditing({ open: true, unit: null })}>
            {t('pim.units.new')}
          </Button>
        )}
      </FilterBar>

      <Card>
        {units.isPending && <TableSkeleton columns={4} />}
        {units.isError && <ErrorState error={units.error} onRetry={() => void units.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('pim.noResults') : t('pim.units.empty')}
            icon={<StraightenRoundedIcon fontSize="small" />}
          />
        )}
        {!units.isPending && !units.isError && items.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('pim.field.code')}</TableCell>
                <TableCell>{t('pim.field.name')}</TableCell>
                <TableCell>{t('pim.field.symbol')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((unit) => (
                <TableRow key={unit.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{unit.code}</TableCell>
                  <TableCell>{unit.name}</TableCell>
                  <TableCell sx={{ color: 'var(--muted)' }}>
                    {unit.symbol ?? t('common.none')}
                  </TableCell>
                  <TableCell>
                    <StatusChip
                      tone={unit.is_active ? 'success' : 'default'}
                      label={unit.is_active ? t('pim.field.active') : t('common.no')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => setEditing({ open: true, unit })}
                      aria-label={`${t('common.edit')}: ${unit.name}`}
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

      <UnitDrawer
        open={editing.open}
        unit={editing.unit}
        canWrite={canWrite}
        onClose={() => setEditing({ open: false, unit: null })}
        onSubmit={async (values) => {
          if (!tenant || !activeCompanyId) return
          await save.mutateAsync({
            id: editing.unit?.id ?? null,
            scope: { organizationId: tenant.organization_id, companyId: activeCompanyId },
            values,
          })
          notify(t('pim.toast.saved'))
          setEditing({ open: false, unit: null })
        }}
      />
    </Stack>
  )
}

function UnitDrawer({
  open,
  unit,
  canWrite,
  onClose,
  onSubmit,
}: {
  open: boolean
  unit: UnitOfMeasure | null
  canWrite: boolean
  onClose: () => void
  onSubmit: (values: UnitFormValues) => Promise<void>
}) {
  const { t } = useI18n()
  const [serverError, setServerError] = useState<MessageKey | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<UnitFormValues>({
    resolver: zodResolver(unitFormSchema),
    defaultValues: unitToForm(unit),
  })

  useEffect(() => {
    if (!open) return
    reset(unitToForm(unit))
    setServerError(null)
  }, [open, unit, reset])

  const fieldError = (key: keyof UnitFormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

  async function submit(values: UnitFormValues) {
    setServerError(null)
    try {
      await onSubmit(values)
    } catch (error) {
      setServerError(error instanceof CatalogError ? error.key : 'catalog.error.generic')
    }
  }

  return (
    <FormDrawer
      open={open}
      title={unit ? unit.name : t('pim.units.new')}
      onClose={onClose}
      busy={isSubmitting}
      actions={
        <>
          <Button onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="pim-unit-form"
            variant="contained"
            disabled={isSubmitting || !canWrite}
          >
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <Box component="form" id="pim-unit-form" onSubmit={handleSubmit(submit)} noValidate>
        <Stack spacing={2.5}>
          {serverError && <Alert severity="error">{t(serverError)}</Alert>}

          <TextField
            label={t('pim.field.code')}
            fullWidth
            autoFocus
            disabled={!canWrite}
            error={Boolean(errors.code)}
            helperText={fieldError('code')}
            inputProps={{ spellCheck: false }}
            {...register('code')}
          />

          <TextField
            label={t('pim.field.name')}
            fullWidth
            disabled={!canWrite}
            error={Boolean(errors.name)}
            helperText={fieldError('name')}
            {...register('name')}
          />

          <TextField
            label={t('pim.field.symbol')}
            fullWidth
            disabled={!canWrite}
            error={Boolean(errors.symbol)}
            helperText={fieldError('symbol') ?? t('common.optional')}
            {...register('symbol')}
          />

          <FormControlLabel
            control={
              <Switch
                checked={watch('is_active')}
                disabled={!canWrite}
                onChange={(_, checked) => setValue('is_active', checked)}
              />
            }
            label={t('pim.field.active')}
          />
        </Stack>
      </Box>
    </FormDrawer>
  )
}
