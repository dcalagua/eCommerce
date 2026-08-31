import { StatusChip } from '@/shared/ui/StatusChip'
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import {
  Alert,
  Button,
  Card,
  FormControlLabel,
  MenuItem,
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
import { useEffect, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { PaymentsError } from './errors'
import {
  useDeletePaymentMethod,
  usePaymentMethods,
  usePaymentProviders,
  useSavePaymentMethod,
} from './hooks'
import {
  PAYMENT_METHOD_KINDS,
  type PaymentMethod,
  type PaymentMethodFormValues,
} from './types'

const EMPTY: PaymentMethodFormValues = {
  code: '',
  displayName: '',
  kind: 'card',
  providerCode: '',
  captureMode: 'automatic',
  isActive: false,
  position: 100,
  instructions: '',
}

/**
 * Los medios de pago del tenant: qué puede elegir el comprador.
 *
 * Es la ÚNICA tabla del dominio de pagos que se escribe desde aquí, y no es
 * casualidad: es configuración, no dinero. Los cobros, las devoluciones y la
 * conciliación se leen y se mueven con comandos.
 *
 * Dos cosas que la pantalla hace cumplir porque la base también las exige, y
 * que conviene ver antes de guardar y no en el error:
 *
 *  · **Sin pasarela, la captura es manual.** Una transferencia la confirma una
 *    persona cuando ve el dinero. El selector se bloquea solo.
 *  · **Un medio nace apagado.** Publicar un medio de pago es una decisión, no
 *    el efecto secundario de crearlo.
 *
 * Aquí no se pide ni se enseña una credencial. Las del proveedor viven en el
 * vault y en la base solo está su referencia; si esta pantalla tuviera un campo
 * de contraseña, esa promesa dejaría de ser cierta el primer día.
 */
export function MethodsSection() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, activeStore, can } = useTenant()
  const canWrite = can('tenant.manage')

  const [drawer, setDrawer] = useState<{ open: boolean; method: PaymentMethod | null }>({
    open: false,
    method: null,
  })
  const [values, setValues] = useState<PaymentMethodFormValues>(EMPTY)

  const methods = usePaymentMethods(activeStore?.id ?? null)
  const providers = usePaymentProviders()
  const save = useSavePaymentMethod(
    tenant && activeCompanyId && activeStore
      ? {
          organizationId: tenant.organization_id,
          companyId: activeCompanyId,
          storeId: activeStore.id,
        }
      : null,
  )
  const remove = useDeletePaymentMethod()

  useEffect(() => {
    if (!drawer.open) return
    setValues(
      drawer.method
        ? {
            id: drawer.method.id,
            code: drawer.method.code,
            displayName: drawer.method.display_name,
            kind: drawer.method.kind,
            providerCode: drawer.method.provider_code ?? '',
            captureMode: drawer.method.capture_mode,
            isActive: drawer.method.is_active,
            position: drawer.method.position,
            instructions: drawer.method.instructions ?? '',
          }
        : EMPTY,
    )
  }, [drawer])

  const offline = values.providerCode === ''
  const list = methods.data ?? []
  const isEmpty = !methods.isPending && !methods.isError && list.length === 0

  function report(error: unknown) {
    const key: MessageKey =
      error instanceof PaymentsError ? error.key : 'payments.error.generic'
    notify(t(key), 'error')
  }

  async function submit() {
    try {
      await save.mutateAsync(values)
      notify(t('payments.methods.saved'), 'success')
      setDrawer({ open: false, method: null })
    } catch (error) {
      report(error)
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('payments.methods.help')}</Typography>

      <Stack direction="row" justifyContent="flex-end">
        <Button
          variant="contained"
          disabled={!canWrite || !activeStore}
          onClick={() => setDrawer({ open: true, method: null })}
        >
          {t('payments.methods.new')}
        </Button>
      </Stack>

      <Card>
        {methods.isPending && <TableSkeleton columns={5} />}
        {methods.isError && (
          <ErrorState error={methods.error} onRetry={() => void methods.refetch()} />
        )}
        {isEmpty && (
          <EmptyState
            title={t('payments.methods.empty')}
            description={t('payments.methods.emptyBody')}
            icon={<CreditCardRoundedIcon fontSize="small" />}
          />
        )}
        {!methods.isPending && !methods.isError && list.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('payments.field.code')}</TableCell>
                <TableCell>{t('payments.field.methodName')}</TableCell>
                <TableCell>{t('payments.field.provider')}</TableCell>
                <TableCell>{t('payments.field.captureMode')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((method) => (
                <TableRow key={method.id} hover>
                  <TableCell>{method.code}</TableCell>
                  <TableCell>{method.display_name}</TableCell>
                  <TableCell>
                    {method.provider_code ?? (
                      <StatusChip label={t('payments.method.offline')} />
                    )}
                  </TableCell>
                  <TableCell>{t(`payments.capture.${method.capture_mode}` as MessageKey)}</TableCell>
                  <TableCell>
                    <StatusChip
                      tone={method.is_active ? 'success' : 'default'}
                      label={t(method.is_active ? 'payments.state.active' : 'payments.state.inactive')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      disabled={!canWrite}
                      onClick={() => setDrawer({ open: true, method })}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      disabled={!canWrite}
                      onClick={async () => {
                        try {
                          await remove.mutateAsync(method.id)
                          notify(t('payments.methods.deleted'), 'success')
                        } catch (error) {
                          report(error)
                        }
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <FormDrawer
        open={drawer.open}
        title={drawer.method ? t('payments.methods.edit') : t('payments.methods.new')}
        subtitle={activeStore?.name}
        busy={save.isPending}
        onClose={() => setDrawer({ open: false, method: null })}
        actions={
          <>
            <Button onClick={() => setDrawer({ open: false, method: null })}>
              {t('common.cancel')}
            </Button>
            <Button variant="contained" disabled={save.isPending} onClick={() => void submit()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Stack spacing={2}>
          <TextField
            label={t('payments.field.code')}
            value={values.code}
            disabled={Boolean(values.id)}
            onChange={(event) => setValues((v) => ({ ...v, code: event.target.value }))}
            helperText={t('payments.field.codeHelp')}
          />
          <TextField
            label={t('payments.field.methodName')}
            value={values.displayName}
            onChange={(event) => setValues((v) => ({ ...v, displayName: event.target.value }))}
          />
          <TextField
            select
            label={t('payments.field.kind')}
            value={values.kind}
            onChange={(event) =>
              setValues((v) => ({ ...v, kind: event.target.value as typeof v.kind }))
            }
          >
            {PAYMENT_METHOD_KINDS.map((kind) => (
              <MenuItem key={kind} value={kind}>
                {t(`payments.kind.${kind}` as MessageKey)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label={t('payments.field.provider')}
            value={values.providerCode}
            onChange={(event) => setValues((v) => ({ ...v, providerCode: event.target.value }))}
            helperText={t('payments.field.providerHelp')}
          >
            <MenuItem value="">{t('payments.method.offline')}</MenuItem>
            {(providers.data ?? []).map((provider) => (
              <MenuItem key={provider.code} value={provider.code}>
                {provider.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label={t('payments.field.captureMode')}
            value={offline ? 'manual' : values.captureMode}
            disabled={offline}
            onChange={(event) =>
              setValues((v) => ({
                ...v,
                captureMode: event.target.value as typeof v.captureMode,
              }))
            }
          >
            <MenuItem value="automatic">{t('payments.capture.automatic')}</MenuItem>
            <MenuItem value="manual">{t('payments.capture.manual')}</MenuItem>
          </TextField>
          {offline && <Alert severity="info">{t('payments.field.offlineHelp')}</Alert>}
          <TextField
            label={t('payments.field.instructions')}
            value={values.instructions}
            multiline
            minRows={2}
            onChange={(event) => setValues((v) => ({ ...v, instructions: event.target.value }))}
            helperText={t('payments.field.instructionsHelp')}
          />
          <TextField
            label={t('payments.field.position')}
            type="number"
            value={values.position}
            onChange={(event) =>
              setValues((v) => ({ ...v, position: Number(event.target.value) || 0 }))
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={values.isActive}
                onChange={(event) => setValues((v) => ({ ...v, isActive: event.target.checked }))}
              />
            }
            label={t('payments.field.active')}
          />
        </Stack>
      </FormDrawer>
    </Stack>
  )
}
