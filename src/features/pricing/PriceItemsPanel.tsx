import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
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
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { R } from '@/theme/tokens'
import { PricingError } from './errors'
import {
  useDeletePriceItem,
  useImportPriceItems,
  usePriceItems,
  usePricingCatalog,
  useProductSearch,
  useProductUoms,
  useProductVariants,
  useSavePriceItem,
} from './hooks'
import {
  PRICE_CSV_HEADERS,
  parsePriceCsv,
  resolvePriceCsv,
  type CsvIssue,
  type ResolvedPriceRow,
} from './importCsv'
import type { PriceList, PricedProduct } from './types'

/**
 * Los precios de una lista.
 *
 * Dos caminos de carga, y los dos hacen falta:
 *
 *  · **Fila a fila**, para corregir tres precios. El selector de producto busca
 *    EN EL SERVIDOR con límite: traerse el catálogo entero para filtrarlo en
 *    memoria rompe justo en el cliente que más SKU tiene.
 *  · **CSV**, para cargar un acuerdo entero. Se resuelve por SKU y se enseña el
 *    resultado ANTES de escribir: una importación que no se puede revisar es
 *    una importación que nadie se atreve a aprobar.
 */
export function PriceItemsPanel({ list, canWrite }: { list: PriceList; canWrite: boolean }) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, activeStore } = useTenant()

  const items = usePriceItems(list.id)
  const save = useSavePriceItem()
  const remove = useDeletePriceItem()

  const [product, setProduct] = useState<PricedProduct | null>(null)
  const [term, setTerm] = useState('')
  const debounced = useDebouncedValue(term, 300)
  const search = useProductSearch(activeStore?.id ?? null, debounced)
  const variants = useProductVariants(product?.id ?? null)
  const uoms = useProductUoms(product?.id ?? null)

  const [variantId, setVariantId] = useState('')
  const [uomId, setUomId] = useState('')
  const [minQuantity, setMinQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [compareAt, setCompareAt] = useState('')
  const [formError, setFormError] = useState<MessageKey | null>(null)

  const scope = useMemo(
    () =>
      tenant && activeCompanyId && activeStore
        ? {
            organizationId: tenant.organization_id,
            companyId: activeCompanyId,
            storeId: activeStore.id,
          }
        : null,
    [tenant, activeCompanyId, activeStore],
  )

  const productLabel = useMemo(() => {
    const names = new Map<string, string>()
    for (const row of search.data ?? []) names.set(row.id, `${row.sku} · ${row.name}`)
    if (product) names.set(product.id, `${product.sku} · ${product.name}`)
    return names
  }, [search.data, product])

  const DECIMAL = /^\d{1,10}(\.\d{1,6})?$/

  async function addItem() {
    if (!scope || !product) {
      setFormError('pricing.error.product')
      return
    }
    if (!DECIMAL.test(unitPrice) || !DECIMAL.test(minQuantity) || Number(minQuantity) <= 0) {
      setFormError('pricing.error.amount')
      return
    }
    if (compareAt && !DECIMAL.test(compareAt)) {
      setFormError('pricing.error.amount')
      return
    }

    setFormError(null)
    try {
      await save.mutateAsync({
        scope,
        listId: list.id,
        values: {
          productId: product.id,
          variantId: variantId || null,
          uomId: uomId || null,
          minQuantity,
          unitPrice,
          compareAtPrice: compareAt || null,
        },
      })
      notify(t('pricing.toast.saved'))
      setUnitPrice('')
      setCompareAt('')
      setMinQuantity('1')
    } catch (error) {
      setFormError(error instanceof PricingError ? error.key : 'pricing.error.generic')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography sx={{ color: 'var(--muted)' }}>{t('pricing.items.help')}</Typography>

      {canWrite && (
        <Stack spacing={1.5}>
          {formError && <Alert severity="error">{t(formError)}</Alert>}

          <Autocomplete
            options={search.data ?? []}
            value={product}
            onChange={(_, next) => {
              setProduct(next)
              setVariantId('')
              setUomId('')
            }}
            onInputChange={(_, next) => setTerm(next)}
            getOptionLabel={(option) => productLabel.get(option.id) ?? option.sku}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            loading={search.isFetching}
            noOptionsText={t('pricing.noResults')}
            renderInput={(params) => (
              <TextField {...params} label={t('pricing.field.product')} size="small" />
            )}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              select
              size="small"
              fullWidth
              label={t('pricing.field.variant')}
              value={variantId}
              disabled={!product || (variants.data ?? []).length === 0}
              onChange={(event) => setVariantId(event.target.value)}
              helperText={t('pricing.field.variantHint')}
            >
              <MenuItem value="">{t('pricing.field.allVariants')}</MenuItem>
              {(variants.data ?? []).map((variant) => (
                <MenuItem key={variant.id} value={variant.id}>
                  {variant.name}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              size="small"
              fullWidth
              label={t('pricing.field.uom')}
              value={uomId}
              disabled={!product || (uoms.data ?? []).length === 0}
              onChange={(event) => setUomId(event.target.value)}
              helperText={t('pricing.field.uomHint')}
            >
              <MenuItem value="">{t('pricing.field.baseUnit')}</MenuItem>
              {(uoms.data ?? []).map((uom) => (
                <MenuItem key={uom.uom_id} value={uom.uom_id}>
                  {uom.code} (× {uom.factor})
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={t('pricing.field.minQuantity')}
              value={minQuantity}
              onChange={(event) => setMinQuantity(event.target.value)}
              helperText={t('pricing.field.minQuantityHint')}
            />
            <TextField
              size="small"
              fullWidth
              label={t('pricing.field.unitPrice')}
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label={t('pricing.field.compareAt')}
              value={compareAt}
              onChange={(event) => setCompareAt(event.target.value)}
            />
            <Button variant="contained" onClick={() => void addItem()} disabled={save.isPending}>
              {t('common.add')}
            </Button>
          </Stack>
        </Stack>
      )}

      <ImportPanel list={list} canWrite={canWrite} />

      {items.isError && <ErrorState error={items.error} onRetry={() => void items.refetch()} />}
      {!items.isPending && !items.isError && (items.data ?? []).length === 0 && (
        <EmptyState title={t('pricing.items.empty')} description={t('pricing.items.emptyBody')} />
      )}

      {(items.data ?? []).length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('pricing.field.product')}</TableCell>
              <TableCell align="right">{t('pricing.field.minQuantity')}</TableCell>
              <TableCell align="right">{t('pricing.field.unitPrice')}</TableCell>
              <TableCell align="right">{t('pricing.field.compareAt')}</TableCell>
              <TableCell align="right">{t('common.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(items.data ?? []).map((item) => (
              <TableRow key={item.id} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {productLabel.get(item.product_id) ?? item.product_id.slice(0, 8)}
                  {item.variant_id ? ` · ${t('pricing.field.variant')}` : ''}
                  {item.uom_id ? ` · ${t('pricing.field.uom')}` : ''}
                </TableCell>
                <TableCell align="right">{Number(item.min_quantity)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  {item.unit_price} {list.currency}
                </TableCell>
                <TableCell align="right">{item.compare_at_price ?? '—'}</TableCell>
                <TableCell align="right">
                  <IconButton
                    size="small"
                    disabled={!canWrite || remove.isPending}
                    aria-label={`${t('common.delete')} ${item.unit_price}`}
                    onClick={() => {
                      void remove.mutateAsync(item.id).then(() => notify(t('pricing.toast.deleted')))
                    }}
                  >
                    <DeleteRoundedIcon fontSize="small" />
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

/**
 * Importación y plantilla.
 *
 * La plantilla se descarga con las cabeceras exactas que el lector espera: es
 * la diferencia entre «se puede importar» y «se puede importar sin llamar a
 * soporte».
 */
function ImportPanel({ list, canWrite }: { list: PriceList; canWrite: boolean }) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { tenant, activeCompanyId, activeStore } = useTenant()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState<{ rows: ResolvedPriceRow[]; issues: CsvIssue[] } | null>(
    null,
  )
  const catalog = usePricingCatalog(activeStore?.id ?? null, enabled)
  const importItems = useImportPriceItems()

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setEnabled(true)
    const data = catalog.data ?? (await catalog.refetch()).data
    if (!data) return

    const text = await file.text()
    const parsed = parsePriceCsv(text)
    const resolved = resolvePriceCsv(parsed.rows, data)
    setPending({ rows: resolved.resolved, issues: [...parsed.issues, ...resolved.issues] })
  }

  async function confirm() {
    if (!pending || !tenant || !activeCompanyId || !activeStore) return
    const written = await importItems.mutateAsync({
      scope: {
        organizationId: tenant.organization_id,
        companyId: activeCompanyId,
        storeId: activeStore.id,
      },
      listId: list.id,
      rows: pending.rows,
    })
    notify(`${t('pricing.import.done')} (${written})`)
    setPending(null)
  }

  return (
    <Box sx={{ border: '1px dashed var(--border)', borderRadius: `${R.md}px`, p: 2 }}>
      <Stack spacing={1.5}>
        <Typography sx={{ fontWeight: 700 }}>{t('pricing.import.title')}</Typography>
        <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
          {t('pricing.import.help')}
        </Typography>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <Button
            size="small"
            onClick={() =>
              downloadCsv(
                `plantilla-precios-${list.code}.csv`,
                toCsv([...PRICE_CSV_HEADERS], [['SKU-EJEMPLO', '', '', '1', '0.00', '']]),
              )
            }
          >
            {t('pricing.import.template')}
          </Button>
          <Button size="small" disabled={!canWrite} onClick={() => fileRef.current?.click()}>
            {t('pricing.import.choose')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            aria-label={t('pricing.import.choose')}
            onChange={(event) => void onFile(event)}
          />
        </Stack>

        {pending && (
          <Stack spacing={1}>
            <Alert severity={pending.issues.length > 0 ? 'warning' : 'success'}>
              {t('pricing.import.summary')}: {pending.rows.length} / {t('pricing.import.rejected')}:{' '}
              {pending.issues.length}
            </Alert>
            {pending.issues.slice(0, 10).map((issue) => (
              <Typography key={`${issue.line}-${issue.reason}`} sx={{ fontSize: 12, color: 'var(--muted)' }}>
                {t('pricing.import.line')} {issue.line}: {t(`pricing.import.reason.${issue.reason}`)}{' '}
                {issue.value}
              </Typography>
            ))}
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="contained"
                disabled={pending.rows.length === 0 || importItems.isPending}
                onClick={() => void confirm()}
              >
                {t('pricing.import.confirm')}
              </Button>
              <Button size="small" onClick={() => setPending(null)}>
                {t('common.cancel')}
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Box>
  )
}
