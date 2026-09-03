import {
  Alert,
  Box,
  Button,
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
import { useEffect, useState } from 'react'
import { useCustomerOptions } from '@/features/customers/hooks'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { SearchField } from '@/shared/ui/SearchField'
import { useFeedback } from '@/shared/ui/feedback-context'
import type { PlanningScope } from './api'
import { PlanningError } from './errors'
import { usePreviewSuggestion, useSaveSuggestion } from './hooks'
import { SUGGEST_WINDOWS, type SuggestedLine } from './types'

/**
 * Generar un sugerido: dos pasos, y el segundo lo da una persona.
 *
 * ## Primero se ve, después se guarda
 *
 * `ebim.suggest_order` devuelve FILAS y no crea nada. Aquí se enseñan, con su
 * motivo, y hace falta un segundo clic para que existan. Un sistema que pide
 * por ti es un sistema que se equivoca por ti, y en distribución eso se paga en
 * devoluciones y mercadería vencida.
 *
 * ## El motivo va al lado de la cifra
 *
 * «12 unidades» no se defiende delante de un cliente; «compró 12 en los últimos
 * 30 días» sí. Una cifra que nadie discute es una cifra que nadie corrige, y un
 * sugerido que no se discute acaba pidiéndose entero o ignorándose entero.
 */
export function GenerateDrawer({
  open,
  scope,
  canWrite,
  onClose,
}: {
  open: boolean
  scope: PlanningScope | null
  canWrite: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const [serverError, setServerError] = useState<MessageKey | null>(null)
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [days, setDays] = useState('30')
  const [lineas, setLineas] = useState<SuggestedLine[] | null>(null)

  const preview = usePreviewSuggestion()
  const save = useSaveSuggestion()

  const customers = useCustomerOptions({
    term: customerSearch,
    enabled: open && customerSearch.trim().length >= 2,
  })

  useEffect(() => {
    if (!open) return
    setCustomerSearch('')
    setCustomerId('')
    setCustomerName('')
    setDays('30')
    setLineas(null)
    setServerError(null)
  }, [open])

  async function calcular() {
    if (!scope || !customerId) return
    setServerError(null)
    try {
      const filas = await preview.mutateAsync({
        storeId: scope.storeId,
        customerId,
        days: Number(days),
      })
      setLineas(filas)
    } catch (error) {
      setServerError(error instanceof PlanningError ? error.key : 'planning.error.generic')
    }
  }

  async function guardar() {
    if (!scope || !customerId || !lineas) return
    setServerError(null)
    try {
      await save.mutateAsync({ scope, customerId, lines: lineas })
      notify(t('planning.toast.saved'), 'success')
      onClose()
    } catch (error) {
      setServerError(error instanceof PlanningError ? error.key : 'planning.error.generic')
    }
  }

  return (
    <FormDrawer
      open={open}
      title={t('planning.generate.title')}
      subtitle={t('planning.generate.subtitle')}
      onClose={onClose}
      busy={preview.isPending || save.isPending}
      width={640}
      actions={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          {/* El segundo clic es el que crea algo. Hasta que hay líneas a la
              vista, no hay nada que guardar. */}
          <Button
            variant="contained"
            disabled={!canWrite || lineas === null || lineas.length === 0 || save.isPending}
            onClick={() => void guardar()}
          >
            {save.isPending ? t('common.saving') : t('planning.generate.save')}
          </Button>
        </>
      }
    >
      <Stack spacing={2.5}>
        {serverError && <Alert severity="error">{t(serverError)}</Alert>}

        <Stack spacing={1}>
          <SearchField
            value={customerSearch}
            onChange={setCustomerSearch}
            placeholder={t('planning.generate.searchCustomer')}
            ariaLabel={t('planning.generate.searchCustomer')}
          />
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
                  onClick={() => {
                    setCustomerId(option.id)
                    setCustomerName(option.name)
                    // Cambiar de cliente invalida lo calculado: enseñar las
                    // líneas del anterior junto al nombre del nuevo sería una
                    // pantalla que miente.
                    setLineas(null)
                  }}
                >
                  {customerId === option.id
                    ? t('trade.quotes.chosen')
                    : t('trade.quotes.choose')}
                </Button>
              </Stack>
            ))}
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <TextField
            select
            label={t('planning.field.window')}
            value={days}
            onChange={(event) => {
              setDays(event.target.value)
              setLineas(null)
            }}
            helperText={t('planning.field.windowHint')}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 180 }}
          >
            {SUGGEST_WINDOWS.map((option) => (
              <MenuItem key={option} value={String(option)}>
                {t('planning.field.days').replace('{n}', String(option))}
              </MenuItem>
            ))}
          </TextField>

          <Button
            variant="outlined"
            disabled={!customerId || preview.isPending}
            onClick={() => void calcular()}
            sx={{ mt: 1 }}
          >
            {preview.isPending ? t('planning.generate.calculating') : t('planning.generate.calculate')}
          </Button>
        </Stack>

        {customerId !== '' && (
          <Typography sx={{ color: 'var(--muted)', fontSize: 13 }}>
            {`${t('planning.field.customer')}: ${customerName}`}
          </Typography>
        )}

        {lineas !== null && lineas.length === 0 && (
          <Alert severity="info">{t('planning.generate.nothing')}</Alert>
        )}

        {lineas !== null && lineas.length > 0 && (
          <Box>
            <Typography sx={{ fontWeight: 800, mb: 1 }}>
              {t('planning.generate.proposal')}
            </Typography>
            <Typography sx={{ color: 'var(--muted)', fontSize: 13, mb: 1 }}>
              {t('planning.generate.proposalHint')}
            </Typography>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell align="right">{t('planning.field.quantity')}</TableCell>
                  <TableCell>{t('planning.field.reason')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lineas.map((line) => (
                  <TableRow key={`${line.product_id}-${line.variant_id ?? ''}`} hover>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>
                      {line.suggested_quantity}
                    </TableCell>
                    {/* El motivo al lado de la cifra, no escondido: es lo que
                        permite discutirla, y una cifra que no se discute no se
                        corrige. */}
                    <TableCell sx={{ color: 'var(--muted)' }}>{line.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Stack>
    </FormDrawer>
  )
}
