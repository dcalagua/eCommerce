import { usePagedRows } from '@/shared/ui/usePagedRows'
import { TablePager } from '@/shared/ui/TablePager'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import { RowActions } from '@/shared/ui/RowActions'
import { FilterBar } from '@/shared/ui/FilterBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import { zodResolver } from '@hookform/resolvers/zod'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
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

  // Pagina lo que YA esta cargado: es para poder leer la tabla, no para
  // aligerar la consulta. Va ANTES de la primera guarda con retorno,
  // porque un hook detras de un `return` cambia de orden entre renders.
  // Ver `usePagedRows`.
  const pager = usePagedRows(items)

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t(copy.help)}</Typography>

      <FilterBar
        actions={
          canWrite && (
            <Button variant="contained" onClick={() => setEditing({ open: true, entry: null })}>
              {t(copy.create)}
            </Button>
          )
        }
      >
        <Box sx={{ minWidth: { xs: '100%', sm: 280 } }}>
          <SearchField value={search} onChange={setSearch} placeholder={t('pim.search')} />
        </Box>
      </FilterBar>

      <Card>
        {query.isPending && <TableSkeleton columns={3} />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {isEmpty && (
          <EmptyState
            title={search ? t('pim.noResults') : t(copy.empty)}
            icon={<LocalOfferRoundedIcon fontSize="small" />}
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
              {pager.rows.map((entry) => (
                <TableRow key={entry.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{entry.code}</TableCell>
                  <TableCell>{entry.name}</TableCell>
                  <TableCell>
                    <StatusChip
                      tone={entry.is_active ? 'success' : 'default'}
                      label={entry.is_active ? t('pim.field.active') : t('common.no')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <RowActions
                      actions={[
                        {
                          id: '0',
                          icon: <EditRoundedIcon fontSize="small" />,
                          label: `${t('common.edit')}: ${entry.name}`,
                          tone: 'neutral',
                          onClick: () => setEditing({ open: true, entry }),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {/* El paginador solo aparece cuando hay algo que paginar: un
            "0-0 de 0" bajo un estado vacio es ruido que contradice al
            propio estado vacio. */}
        {pager.total > 0 && (
          <TablePager
            page={pager.page}
            pageSize={pager.pageSize}
            total={pager.total}
            onPageChange={pager.setPage}
          />
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
