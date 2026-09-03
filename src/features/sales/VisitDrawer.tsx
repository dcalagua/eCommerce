import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, Box, Button, Grid, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useCustomerOptions } from '@/features/customers/hooks'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { SearchField } from '@/shared/ui/SearchField'
import { useFeedback } from '@/shared/ui/feedback-context'
import type { SalesScope } from './api'
import { SalesError } from './errors'
import { useRoutes, useSalesReps, useSaveVisit } from './hooks'
import { emptyVisitForm, visitFormSchema, type VisitFormValues } from './types'

/**
 * Agendar una visita.
 *
 * Solo se AGENDA: la entrada, la salida y el resultado se registran desde la
 * lista, cuando ocurren. Dejar que se creen ya cerradas convertiría la agenda en
 * un formulario de relleno a posteriori, que es exactamente lo que hace inútil
 * medir la cobertura de una fuerza de campo.
 */
export function VisitDrawer({
  open,
  scope,
  canWrite,
  onClose,
}: {
  open: boolean
  scope: SalesScope | null
  canWrite: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const [serverError, setServerError] = useState<MessageKey | null>(null)
  const [customerSearch, setCustomerSearch] = useState('')

  const reps = useSalesReps()
  const routes = useRoutes()
  const save = useSaveVisit()

  const customers = useCustomerOptions({
    term: customerSearch,
    enabled: open && customerSearch.trim().length >= 2,
  })

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<VisitFormValues>({
    resolver: zodResolver(visitFormSchema),
    defaultValues: emptyVisitForm(),
  })

  useEffect(() => {
    if (!open) return
    reset(emptyVisitForm())
    setCustomerSearch('')
    setServerError(null)
  }, [open, reset])

  const customerId = watch('customer_id')

  async function submit(values: VisitFormValues) {
    if (!scope) return
    setServerError(null)
    try {
      await save.mutateAsync({ scope, values })
      notify(t('sales.toast.visitSaved'), 'success')
      onClose()
    } catch (error) {
      setServerError(error instanceof SalesError ? error.key : 'sales.error.generic')
    }
  }

  return (
    <FormDrawer
      open={open}
      title={t('sales.visits.new')}
      subtitle={t('sales.visits.newHint')}
      onClose={onClose}
      busy={isSubmitting}
      width={560}
      actions={
        <>
          <Button onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="visit-form"
            variant="contained"
            disabled={isSubmitting || !canWrite}
          >
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <Box component="form" id="visit-form" onSubmit={handleSubmit(submit)} noValidate>
        <Stack spacing={2.5}>
          {serverError && <Alert severity="error">{t(serverError)}</Alert>}

          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <Controller
                control={control}
                name="sales_rep_id"
                render={({ field }) => (
                  <TextField
                    select
                    fullWidth
                    required
                    label={t('sales.field.rep')}
                    disabled={!canWrite}
                    error={Boolean(errors.sales_rep_id)}
                    helperText={
                      errors.sales_rep_id
                        ? t(errors.sales_rep_id.message as MessageKey)
                        : undefined
                    }
                    slotProps={{ inputLabel: { shrink: true } }}
                    value={field.value}
                    onChange={field.onChange}
                  >
                    {(reps.data ?? [])
                      .filter((rep) => rep.status !== 'disabled')
                      .map((rep) => (
                        <MenuItem key={rep.id} value={rep.id}>
                          {`${rep.employee_code} · ${rep.full_name}`}
                        </MenuItem>
                      ))}
                  </TextField>
                )}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                type="datetime-local"
                label={t('sales.field.plannedAt')}
                required
                disabled={!canWrite}
                error={Boolean(errors.planned_at)}
                slotProps={{ inputLabel: { shrink: true } }}
                {...register('planned_at')}
              />
            </Grid>

            <Grid item xs={12}>
              <Controller
                control={control}
                name="route_id"
                render={({ field }) => (
                  <TextField
                    select
                    fullWidth
                    label={t('sales.field.route')}
                    disabled={!canWrite}
                    helperText={t('sales.field.routeHint')}
                    slotProps={{ inputLabel: { shrink: true } }}
                    value={field.value}
                    onChange={field.onChange}
                  >
                    <MenuItem value="">{t('common.none')}</MenuItem>
                    {(routes.data ?? []).map((route) => (
                      <MenuItem key={route.id} value={route.id}>
                        {`${route.code} · ${route.name}`}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </Grid>

            <Grid item xs={12}>
              <input type="hidden" {...register('customer_id')} />
              <Stack spacing={1}>
                <SearchField
                  value={customerSearch}
                  onChange={setCustomerSearch}
                  placeholder={t('sales.routes.searchCustomer')}
                  ariaLabel={t('sales.routes.searchCustomer')}
                />
                {errors.customer_id && (
                  <Typography sx={{ color: 'var(--red)', fontSize: 12 }}>
                    {t(errors.customer_id.message as MessageKey)}
                  </Typography>
                )}
                <Stack spacing={0.5}>
                  {(customers.data ?? []).map((option) => (
                    <Stack
                      key={option.id}
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      justifyContent="space-between"
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontWeight: 700, fontSize: 13 }}>
                          {option.name}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                          {option.code}
                        </Typography>
                      </Box>
                      <Button
                        size="small"
                        variant={customerId === option.id ? 'contained' : 'text'}
                        onClick={() => setValue('customer_id', option.id, { shouldValidate: true })}
                      >
                        {customerId === option.id
                          ? t('trade.quotes.chosen')
                          : t('trade.quotes.choose')}
                      </Button>
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                multiline
                minRows={2}
                label={t('sales.field.notes')}
                disabled={!canWrite}
                slotProps={{ inputLabel: { shrink: true } }}
                {...register('notes')}
              />
            </Grid>
          </Grid>
        </Stack>
      </Box>
    </FormDrawer>
  )
}
