import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import {
  Alert,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
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
import { useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState } from '@/shared/ui/states'
import type { TenantScope } from './api'
import { CustomersError } from './errors'
import { useAddresses, useDeleteAddress, useSaveAddress } from './hooks'
import {
  ADDRESS_VERIFICATIONS,
  addressFormSchema,
  addressToForm,
  formatAddress,
  type AddressFormValues,
  type CustomerAddress,
} from './types'

const VERIFICATION_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  unverified: 'default',
  pending: 'warning',
  verified: 'success',
  rejected: 'error',
}

/**
 * Direcciones de entrega y de facturación.
 *
 * Tres cosas que la pantalla tiene que dejar claras porque la base las exige:
 *
 *  · el USO son dos casillas y hace falta al menos una — una dirección que no
 *    sirve ni para entregar ni para facturar no aparece en ningún formulario;
 *  · «por defecto» solo se puede marcar sobre un uso que la dirección tiene;
 *  · la VERIFICACIÓN es un estado con cuatro valores y no una casilla. «No se
 *    preguntó» y «el proveedor la rechazó» son cosas distintas, y con un
 *    booleano las dos serían «no» — que es como se reintenta para siempre una
 *    dirección que ya está rechazada. Para un ERP que solo entrega en destinos
 *    autorizados, `verificada` ES autorizada.
 *
 * `verified_at` no se edita: lo estampa la base. Una fecha de verificación
 * escrita a mano es una fecha inventada.
 */
export function AddressesPanel({
  customerId,
  scope,
  canWrite,
}: {
  customerId: string
  scope: TenantScope
  canWrite: boolean
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const addresses = useAddresses(customerId)
  const save = useSaveAddress()
  const remove = useDeleteAddress()

  const [editing, setEditing] = useState<CustomerAddress | null>(null)
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<AddressFormValues>(addressToForm(null))
  const [error, setError] = useState<MessageKey | null>(null)

  function set<K extends keyof AddressFormValues>(key: K, value: AddressFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  function startNew() {
    setEditing(null)
    setValues(addressToForm(null))
    setError(null)
    setOpen(true)
  }

  function startEdit(address: CustomerAddress) {
    setEditing(address)
    setValues(addressToForm(address))
    setError(null)
    setOpen(true)
  }

  function cancel() {
    setOpen(false)
    setEditing(null)
    setValues(addressToForm(null))
    setError(null)
  }

  async function submit() {
    const parsed = addressFormSchema.safeParse(values)
    if (!parsed.success) {
      setError((parsed.error.issues[0]?.message as MessageKey) ?? 'customers.error.invalid')
      return
    }
    setError(null)
    try {
      await save.mutateAsync({ id: editing?.id ?? null, scope, customerId, values: parsed.data })
      notify(t('customers.toast.saved'))
      cancel()
    } catch (caught) {
      setError(caught instanceof CustomersError ? caught.key : 'customers.error.generic')
    }
  }

  const rows = addresses.data ?? []

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('customers.addresses.help')}</Typography>

      {canWrite && !open && (
        <Stack direction="row">
          <Button variant="contained" onClick={startNew}>
            {t('customers.addresses.new')}
          </Button>
        </Stack>
      )}

      {canWrite && open && (
        <Stack spacing={1.5}>
          {error && <Alert severity="error">{t(error)}</Alert>}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.label')}
              value={values.label}
              onChange={(event) => set('label', event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.recipient')}
              value={values.recipient}
              onChange={(event) => set('recipient', event.target.value)}
            />
          </Stack>

          <TextField
            size="small"
            fullWidth
            label={t('customers.field.line1')}
            value={values.line1}
            onChange={(event) => set('line1', event.target.value)}
          />
          <TextField
            size="small"
            fullWidth
            label={t('customers.field.line2')}
            value={values.line2}
            onChange={(event) => set('line2', event.target.value)}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.city')}
              value={values.city}
              onChange={(event) => set('city', event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.region')}
              value={values.region}
              onChange={(event) => set('region', event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.postalCode')}
              value={values.postal_code}
              onChange={(event) => set('postal_code', event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.country')}
              value={values.country}
              onChange={(event) => set('country', event.target.value.toUpperCase())}
              inputProps={{ maxLength: 2, spellCheck: false }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.phone')}
              value={values.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
            <TextField
              select
              size="small"
              fullWidth
              label={t('customers.field.verification')}
              value={values.verification}
              onChange={(event) =>
                set('verification', event.target.value as AddressFormValues['verification'])
              }
              helperText={t('customers.field.verificationHint')}
            >
              {ADDRESS_VERIFICATIONS.map((state) => (
                <MenuItem key={state} value={state}>
                  {t(`customers.verification.${state}`)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.verificationSource')}
              value={values.verification_source}
              onChange={(event) => set('verification_source', event.target.value)}
              helperText={t('customers.field.verificationSourceHint')}
            />
            <TextField
              size="small"
              fullWidth
              label={t('customers.field.externalRef')}
              value={values.external_ref}
              onChange={(event) => set('external_ref', event.target.value)}
              helperText={t('customers.field.externalRefHint')}
            />
          </Stack>

          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
            <FormControlLabel
              control={
                <Switch
                  checked={values.is_shipping}
                  onChange={(_, checked) => set('is_shipping', checked)}
                />
              }
              label={t('customers.address.shipping')}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={values.is_billing}
                  onChange={(_, checked) => set('is_billing', checked)}
                />
              }
              label={t('customers.address.billing')}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={values.is_default_shipping}
                  onChange={(_, checked) => set('is_default_shipping', checked)}
                />
              }
              label={t('customers.address.defaultShipping')}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={values.is_default_billing}
                  onChange={(_, checked) => set('is_default_billing', checked)}
                />
              }
              label={t('customers.address.defaultBilling')}
            />
          </Stack>

          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => void submit()} disabled={save.isPending}>
              {editing ? t('common.save') : t('common.add')}
            </Button>
            <Button onClick={cancel}>{t('common.cancel')}</Button>
          </Stack>
        </Stack>
      )}

      {!addresses.isPending && rows.length === 0 && (
        <EmptyState title={t('customers.addresses.empty')} />
      )}

      {rows.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('customers.field.label')}</TableCell>
              <TableCell>{t('customers.field.address')}</TableCell>
              <TableCell>{t('customers.field.use')}</TableCell>
              <TableCell>{t('customers.field.verification')}</TableCell>
              <TableCell align="right">{t('common.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((address) => (
              <TableRow key={address.id} hover>
                <TableCell sx={{ fontWeight: 700 }}>{address.label}</TableCell>
                <TableCell>{formatAddress(address)}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                    {address.is_shipping && (
                      <Chip
                        size="small"
                        color={address.is_default_shipping ? 'primary' : 'default'}
                        label={t('customers.address.shipping')}
                      />
                    )}
                    {address.is_billing && (
                      <Chip
                        size="small"
                        color={address.is_default_billing ? 'primary' : 'default'}
                        label={t('customers.address.billing')}
                      />
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    color={VERIFICATION_COLOR[address.verification] ?? 'default'}
                    label={t(`customers.verification.${address.verification}`)}
                  />
                </TableCell>
                <TableCell align="right">
                  <Button
                    size="small"
                    disabled={!canWrite}
                    onClick={() => startEdit(address)}
                    aria-label={`${t('common.edit')}: ${address.label}`}
                  >
                    {t('common.edit')}
                  </Button>
                  <IconButton
                    size="small"
                    disabled={!canWrite || remove.isPending}
                    aria-label={`${t('common.delete')}: ${address.label}`}
                    onClick={() => {
                      void remove
                        .mutateAsync(address.id)
                        .then(() => notify(t('customers.toast.deleted')))
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  )
}
