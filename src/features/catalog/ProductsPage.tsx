import { RowActions } from '@/shared/ui/RowActions'
import ArchiveRoundedIcon from '@mui/icons-material/ArchiveRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import { FilterBar } from '@/shared/ui/FilterBar'
import { TablePager } from '@/shared/ui/TablePager'
import { StatusChip } from '@/shared/ui/StatusChip'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import {
  Box,
  Button,
  Card,
  Chip,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,  TableRow,
  Tabs,
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { ConfirmDeleteDialog } from '@/shared/ui/ConfirmDeleteDialog'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { PRODUCTS_PAGE_SIZE, type ProductStatusFilter } from './api/products'
import { CatalogError } from './api/errors'
import { ProductDrawer } from './ProductDrawer'
import { downloadCsv, productsToCsv } from './exportCsv'
import type { Product, ProductKind, ProductStatus } from './types'
import { useCategories } from './useCategories'
import { useDeleteProduct, useProductUsage, useProducts, useSetProductStatus } from './useProducts'

const STATUS_LABEL: Record<ProductStatus, MessageKey> = {
  draft: 'catalog.status.draft',
  published: 'catalog.status.published',
  archived: 'catalog.status.archived',
}

const STATUS_COLOR: Record<ProductStatus, 'default' | 'success' | 'warning'> = {
  draft: 'warning',
  published: 'success',
  archived: 'default',
}

const KIND_LABEL: Record<ProductKind, MessageKey> = {
  simple: 'catalog.kind.simple',
  variant: 'catalog.kind.variant',
  bundle: 'catalog.kind.bundle',
}

const TABS: Array<{ value: ProductStatusFilter; label: MessageKey }> = [
  { value: 'all', label: 'common.all' },
  { value: 'draft', label: 'catalog.status.draft' },
  { value: 'published', label: 'catalog.status.published' },
  { value: 'archived', label: 'catalog.status.archived' },
]

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof CatalogError ? error.key : 'catalog.error.generic'
}

/**
 * Listado de productos del backoffice.
 *
 * Un buscador general + tabs de estado + Exportar; sin paneles de filtros
 * multi-campo (contrato §8). La pantalla no toca Supabase: todo pasa por los
 * hooks de `useProducts`/`useCategories`.
 */
export function ProductsPage() {
  const { t, locale } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, activeCompanyId, tenant, status: tenantStatus, can } = useTenant()
  const canWrite = can('catalog.write')

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ProductStatusFilter>('all')
  const [page, setPage] = useState(0)
  const [drawer, setDrawer] = useState<{ open: boolean; product: Product | null }>({
    open: false,
    product: null,
  })
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)

  const storeId = activeStore?.id ?? null

  // Cambiar el filtro tiene que volver a la primera página: quedarse en la
  // página 4 de un resultado que ahora tiene una sola es una tabla vacía que se
  // lee como "no hay nada".
  useEffect(() => {
    setPage(0)
  }, [search, status, storeId])

  const products = useProducts({ storeId, search, status, page })
  const categories = useCategories(storeId)
  const usage = useProductUsage(deleteTarget?.id ?? null)
  const changeStatus = useSetProductStatus()
  const removeProduct = useDeleteProduct()

  const categoryName = useMemo(
    () => new Map((categories.data ?? []).map((category) => [category.id, category.name])),
    [categories.data],
  )

  // Mientras el espacio de trabajo se resuelve NO se dice "no tienes tiendas":
  // sería afirmar algo que todavía no se sabe (mismo criterio que la sesión).
  if (tenantStatus === 'loading') {
    return (
      <>
        <PageHeader icon={<Inventory2RoundedIcon />} title={t('admin.products.title')} />
        <Card>
          <TableSkeleton columns={6} />
        </Card>
      </>
    )
  }

  if (!storeId || !activeCompanyId || !tenant) {
    return (
      <>
        <PageHeader icon={<Inventory2RoundedIcon />} title={t('admin.products.title')} />
        <Card>
          <EmptyState
            title={t('admin.store.none')}
            description={t('admin.store.noneBody')}
            icon={<StorefrontRoundedIcon fontSize="small" />}
          />
        </Card>
      </>
    )
  }

  async function onChangeStatus(product: Product, next: ProductStatus, toast: MessageKey) {
    try {
      await changeStatus.mutateAsync({ productId: product.id, status: next })
      notify(t(toast))
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  async function onDelete() {
    if (!deleteTarget) return
    try {
      await removeProduct.mutateAsync(deleteTarget.id)
      notify(t('catalog.toast.deleted'))
      setDeleteTarget(null)
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  const list = products.data?.rows ?? []
  const total = products.data?.total ?? 0
  const isEmpty = !products.isPending && !products.isError && list.length === 0

  return (
    <>
      <PageHeader
        icon={<Inventory2RoundedIcon />}
        title={t('admin.products.title')}
        subtitle={activeStore?.name}
        actions={
          <>
            <Button
              variant="outlined"
              disabled={list.length === 0}
              onClick={() =>
                downloadCsv(
                  `productos-${activeStore?.slug ?? 'tienda'}.csv`,
                  productsToCsv(list, categories.data ?? []),
                )
              }
            >
              {t('common.export')}
            </Button>
            {canWrite && (
              <Button
                variant="contained"
                onClick={() => setDrawer({ open: true, product: null })}
              >
                {t('catalog.products.new')}
              </Button>
            )}
          </>
        }
      />

      <Stack spacing={2}>
        <Tabs
          value={status}
          onChange={(_, next: ProductStatusFilter) => setStatus(next)}
          centered
          aria-label={t('common.status')}
          sx={{
            borderBottom: '1px solid var(--border)',
            '& .MuiTab-root': { fontWeight: 700, textTransform: 'none', minHeight: 44 },
          }}
        >
          {TABS.map((tab) => (
            <Tab key={tab.value} value={tab.value} label={t(tab.label)} />
          ))}
        </Tabs>

        <FilterBar>
          <Box sx={{ minWidth: { xs: '100%', sm: 280 } }}>
            <SearchField value={search} onChange={setSearch} placeholder={t('admin.products.search')} />
          </Box>
        </FilterBar>

        <Card>
          {products.isPending && <TableSkeleton columns={6} />}

          {products.isError && (
            <ErrorState error={products.error} onRetry={() => void products.refetch()} />
          )}

          {isEmpty && (
            <EmptyState
              title={search ? t('catalog.products.emptySearch') : t('admin.products.empty')}
              icon={<Inventory2RoundedIcon fontSize="small" />}
              action={
                canWrite && !search ? (
                  <Button variant="contained" onClick={() => setDrawer({ open: true, product: null })}>
                    {t('catalog.products.new')}
                  </Button>
                ) : undefined
              }
            />
          )}

          {!products.isPending && !products.isError && list.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('catalog.field.sku')}</TableCell>
                  <TableCell>{t('catalog.field.name')}</TableCell>
                  <TableCell>{t('catalog.field.category')}</TableCell>
                  <TableCell align="right">{t('common.price')}</TableCell>
                  <TableCell align="right">{t('catalog.field.stock')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {list.map((product) => (
                  <TableRow key={product.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{product.sku}</TableCell>
                    <TableCell>
                      {product.name}
                      {/* El tipo solo se anuncia cuando NO es simple: una
                          etiqueta en cada fila de un catálogo que casi todo es
                          simple deja de leerse a la tercera pantalla. */}
                      {product.kind !== 'simple' && (
                        <Chip
                          size="small"
                          variant="outlined"
                          sx={{ ml: 1 }}
                          label={t(KIND_LABEL[product.kind])}
                        />
                      )}
                    </TableCell>
                    <TableCell sx={{ color: 'var(--muted)' }}>
                      {product.category_id
                        ? (categoryName.get(product.category_id) ?? t('common.none'))
                        : t('common.none')}
                    </TableCell>
                    <TableCell align="right" className="tnum">
                      {formatMoney(Number(product.price), product.currency, locale)}
                    </TableCell>
                    <TableCell align="right" className="tnum">
                      {/* Un maestro de variantes y un kit no llevan existencia
                          propia: enseñar su cero sería afirmar que no hay. */}
                      {product.kind === 'simple' ? product.stock : '—'}
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        tone={STATUS_COLOR[product.status]}
                        label={t(STATUS_LABEL[product.status])}
                      />
                    </TableCell>
                    {/* El menu de tres puntos escondia CUATRO acciones detras de
                        un icono que no dice ninguna: para saber si un producto
                        se puede despublicar habia que abrirlo. Aqui se ven, y
                        el color lo pone lo que cada una HACE.

                        Archivar va en neutro y no en rojo aunque retire el
                        producto: es reversible y conserva el registro. El rojo
                        se guarda para lo que no tiene vuelta —despublicar, que
                        lo saca de la tienda ya mismo, y borrar—, porque un rojo
                        que sale en todo deja de avisar de nada. */}
                    <TableCell align="right">
                      <RowActions
                        actions={[
                          {
                            id: 'edit',
                            icon: <EditRoundedIcon fontSize="small" />,
                            label: `${t('common.edit')}: ${product.name}`,
                            tone: 'neutral',
                            onClick: () => setDrawer({ open: true, product }),
                          },
                          {
                            id: 'publish',
                            icon:
                              product.status === 'published' ? (
                                <VisibilityOffRoundedIcon fontSize="small" />
                              ) : (
                                <VisibilityRoundedIcon fontSize="small" />
                              ),
                            label:
                              product.status === 'published'
                                ? t('catalog.action.unpublish')
                                : t('catalog.action.publish'),
                            tone: product.status === 'published' ? 'danger' : 'accent',
                            disabled: !canWrite,
                            onClick: () =>
                              product.status === 'published'
                                ? void onChangeStatus(product, 'draft', 'catalog.toast.unpublished')
                                : void onChangeStatus(product, 'published', 'catalog.toast.published'),
                          },
                          {
                            id: 'archive',
                            icon: <ArchiveRoundedIcon fontSize="small" />,
                            label: t('catalog.action.archive'),
                            tone: 'neutral',
                            disabled: !canWrite || product.status === 'archived',
                            onClick: () =>
                              void onChangeStatus(product, 'archived', 'catalog.toast.archived'),
                          },
                          {
                            id: 'delete',
                            icon: <DeleteRoundedIcon fontSize="small" />,
                            label: `${t('common.delete')}: ${product.name}`,
                            tone: 'danger',
                            disabled: !canWrite,
                            onClick: () => setDeleteTarget(product),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!products.isError && total > 0 && (
            <TablePager
              page={page}
              pageSize={PRODUCTS_PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          )}
        </Card>
      </Stack>



      <ProductDrawer
        open={drawer.open}
        product={drawer.product}
        categories={categories.data ?? []}
        // El catálogo de la página en curso: es lo que las pestañas de kit y de
        // relacionados ofrecen como candidatos, sin una segunda consulta.
        products={list}
        organizationId={tenant.organization_id}
        companyId={activeCompanyId}
        storeId={storeId}
        currency={activeStore?.currency ?? 'PEN'}
        canWrite={canWrite}
        onClose={() => setDrawer({ open: false, product: null })}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        title={t('catalog.delete.title')}
        entityName={deleteTarget?.name ?? ''}
        isLoadingUsage={usage.isPending && Boolean(deleteTarget)}
        usageError={usage.isError ? t(errorKeyOf(usage.error)) : null}
        usage={[
          { label: t('catalog.delete.usage.orderLines'), count: usage.data?.order_lines ?? 0 },
          { label: t('catalog.delete.usage.images'), count: usage.data?.images ?? 0 },
          { label: t('catalog.delete.usage.variants'), count: usage.data?.variants ?? 0 },
          { label: t('catalog.delete.usage.bundles'), count: usage.data?.bundles ?? 0 },
        ]}
        safeActionLabel={
          deleteTarget?.status === 'archived' ? undefined : t('catalog.action.archive')
        }
        safeActionHint={t('catalog.delete.archiveHint')}
        onSafeAction={() => {
          if (!deleteTarget) return
          void onChangeStatus(deleteTarget, 'archived', 'catalog.toast.archived')
          setDeleteTarget(null)
        }}
        onDelete={() => void onDelete()}
        onClose={() => setDeleteTarget(null)}
        isBusy={removeProduct.isPending || changeStatus.isPending}
      />
    </>
  )
}
