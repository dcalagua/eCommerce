import { zodResolver } from '@hookform/resolvers/zod'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
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
import { CatalogError } from '../api/errors'
import { useBrands, useFamilies, useSaveBrand, useSaveFamily } from './hooks'
import {
  catalogEntryFormSchema,
  catalogEntryToForm,
  type Brand,
  type CatalogEntryFormValues,
} from './types'

/**
 * Marcas y familias: dos catálogos de la sociedad con exactamente la misma
 * forma —código, nombre, activo— y la misma pantalla.
 *
 * Están en un solo componente y no en dos casi idénticos a propósito: lo que
 * cambia entre ellos son cuatro textos y el hook de escritura. Dos copias de
 * esta pantalla se separarían el día que una de las dos arregle un detalle de
 * accesibilidad.
 */
type EntryKind = 'brands' | 'families'

const COPY: Record<EntryKind, { help: MessageKey; empty: MessageKey; create: MessageKey }> = {
  brands: { help: 'pim.brands.help', empty: 'pim.brands.empty', create: 'pim.brands.new' },
  families: {
    help: 'pim.families.help',
    empty: 'pim.families.empty',
    create: 'pim.families.new',
  },
}

export function CatalogEntrySection({ kind }: { kind: EntryKind }) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, can } = useTenant()
  const canWrite = can('catalog.write')
  const copy = COPY[kind]

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ open: boolean; entry: Brand | null }>({
    open: false,
    entry: null,
  })

  const brands = useBrands(kind === 'brands')
  const families = useFamilies(kind === 'families')
  const query = kind === 'brands' ? brands : families

  const saveBrand = useSaveBrand()
  const saveFamily = useSaveFamily()
  const save = kind === 'brands' ? saveBrand : saveFamily

  const items = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = query.data ?? []
    if (!term) return all
    return all.filter(
      (entry) =>
        entry.name.toLowerCase().includes(term) || entry.code.toLowerCase().includes(term),
    )
  }, [query.data, search])

  const isEmpty = !query.isPending && !query.isError && items.length === 0

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t(copy.help)}</Typography>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Box sx={{ flex: 1 }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('pim.search')} />
        </Box>
        {canWrite && (
          <Button variant="contained" onClick={() => setEditing({ open: true, entry: null })}>
            {t(copy.create)}
          </Button>
        )}
      </Stack>

      <Card>
        {query.isPending && <TableSkeleton columns={3} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('pim.noResults') : t(copy.empty)}
            icon={<LocalOfferOutlinedIcon fontSize="small" />}
          />
        )}
        {!query.isPending && !query.isError && items.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('pim.field.code')}</TableCell>
                <TableCell>{t('pim.field.name')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((entry) => (
                <TableRow key={entry.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{entry.code}</TableCell>
                  <TableCell>{entry.name}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={entry.is_active ? 'success' : 'default'}
                      label={entry.is_active ? t('pim.field.active') : t('common.no')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => setEditing({ open: true, entry })}
                      aria-label={`${t('common.edit')}: ${entry.name}`}
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

      <CatalogEntryDrawer
        open={editing.open}
        entry={editing.entry}
        title={t(copy.create)}
        canWrite={canWrite}
        onClose={() => setEditing({ open: false, entry: null })}
        onSubmit={async (values) => {
          if (!tenant || !activeCompanyId) return
          await save.mutateAsync({
            id: editing.entry?.id ?? null,
            scope: { organizationId: tenant.organization_id, companyId: activeCompanyId },
            values,
          })
          notify(t('pim.toast.saved'))
          setEditing({ open: false, entry: null })
        }}
      />
    </Stack>
  )
}

/** Alta y edición. El código se sugiere a partir del nombre, como el slug. */
function CatalogEntryDrawer({
  open,
  entry,
  title,
  canWrite,
  onClose,
  onSubmit,
}: {
  open: boolean
  entry: Brand | null
  title: string
  canWrite: boolean
  onClose: () => void
  onSubmit: (values: CatalogEntryFormValues) => Promise<void>
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
  } = useForm<CatalogEntryFormValues>({
    resolver: zodResolver(catalogEntryFormSchema),
    defaultValues: catalogEntryToForm(entry),
  })

  useEffect(() => {
    if (!open) return
    reset(catalogEntryToForm(entry))
    setCodeEdited(Boolean(entry))
    setServerError(null)
  }, [open, entry, reset])

  const fieldError = (key: keyof CatalogEntryFormValues) => {
    const message = errors[key]?.message
    return message ? t(message as MessageKey) : undefined
  }

  async function submit(values: CatalogEntryFormValues) {
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
      title={entry ? entry.name : title}
      onClose={onClose}
      busy={isSubmitting}
      actions={
        <>
          <Button onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="pim-entry-form"
            variant="contained"
            disabled={isSubmitting || !canWrite}
          >
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <Box component="form" id="pim-entry-form" onSubmit={handleSubmit(submit)} noValidate>
        <Stack spacing={2.5}>
          {serverError && <Alert severity="error">{t(serverError)}</Alert>}

          <TextField
            label={t('pim.field.name')}
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
            label={t('pim.field.code')}
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
            label={t('pim.field.active')}
          />
        </Stack>
      </Box>
    </FormDrawer>
  )
}
