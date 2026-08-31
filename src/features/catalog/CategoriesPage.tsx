import { FilterBar } from '@/shared/ui/FilterBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import {
  Box,
  Button,
  Card,  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { ConfirmDeleteDialog } from '@/shared/ui/ConfirmDeleteDialog'
import { PageHeader } from '@/shared/ui/PageHeader'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { CatalogError } from './api/errors'
import { CategoryDrawer } from './CategoryDrawer'
import type { Category } from './types'
import {
  useCategories,
  useCategoryUsage,
  useDeleteCategory,
  useSetCategoryActive,
} from './useCategories'

function errorKeyOf(error: unknown): MessageKey {
  return error instanceof CatalogError ? error.key : 'catalog.error.generic'
}

/**
 * Categorías del catálogo — CRUD mínimo.
 *
 * El buscador filtra en memoria: son decenas de filas, no miles, y pedirle a
 * PostgREST una consulta por letra para eso es gasto sin beneficio.
 */
export function CategoriesPage() {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, activeCompanyId, tenant, status: tenantStatus, can } = useTenant()
  const canWrite = can('catalog.write')

  const [search, setSearch] = useState('')
  const [drawer, setDrawer] = useState<{ open: boolean; category: Category | null }>({
    open: false,
    category: null,
  })
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)

  const storeId = activeStore?.id ?? null
  const categories = useCategories(storeId)
  const usage = useCategoryUsage(deleteTarget?.id ?? null)
  const toggleActive = useSetCategoryActive()
  const removeCategory = useDeleteCategory()

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    const list = categories.data ?? []
    if (!term) return list
    return list.filter(
      (category) =>
        category.name.toLowerCase().includes(term) || category.slug.includes(term),
    )
  }, [categories.data, search])

  if (tenantStatus === 'loading') {
    return (
      <>
        <PageHeader icon={<CategoryRoundedIcon />} title={t('catalog.categories.title')} />
        <Card>
          <TableSkeleton columns={4} />
        </Card>
      </>
    )
  }

  if (!storeId || !activeCompanyId || !tenant) {
    return (
      <>
        <PageHeader icon={<CategoryRoundedIcon />} title={t('catalog.categories.title')} />
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

  async function onToggleActive(category: Category) {
    try {
      await toggleActive.mutateAsync({ categoryId: category.id, isActive: !category.is_active })
      notify(t(category.is_active ? 'catalog.toast.categoryInactive' : 'catalog.toast.categoryActive'))
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  async function onDelete() {
    if (!deleteTarget) return
    try {
      await removeCategory.mutateAsync(deleteTarget.id)
      notify(t('catalog.toast.categoryDeleted'))
      setDeleteTarget(null)
    } catch (error) {
      notify(t(errorKeyOf(error)), 'error')
    }
  }

  const isEmpty = !categories.isPending && !categories.isError && visible.length === 0

  return (
    <>
      <PageHeader
        icon={<CategoryRoundedIcon />}
        title={t('catalog.categories.title')}
        subtitle={activeStore?.name}
        actions={
          canWrite ? (
            <Button variant="contained" onClick={() => setDrawer({ open: true, category: null })}>
              {t('catalog.categories.new')}
            </Button>
          ) : undefined
        }
      />

      <Stack spacing={2}>
        <FilterBar>
          <Box sx={{ minWidth: { xs: '100%', sm: 280 } }}>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={t('catalog.categories.search')}
            />
          </Box>
        </FilterBar>

        <Card>
          {categories.isPending && <TableSkeleton columns={4} />}

          {categories.isError && (
            <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
          )}

          {isEmpty && (
            <EmptyState
              title={t('catalog.categories.empty')}
              icon={<CategoryRoundedIcon fontSize="small" />}
              action={
                canWrite && !search ? (
                  <Button
                    variant="contained"
                    onClick={() => setDrawer({ open: true, category: null })}
                  >
                    {t('catalog.categories.new')}
                  </Button>
                ) : undefined
              }
            />
          )}

          {!categories.isPending && !categories.isError && visible.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('catalog.field.name')}</TableCell>
                  <TableCell>{t('catalog.field.slug')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map((category) => (
                  <TableRow key={category.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{category.name}</TableCell>
                    <TableCell sx={{ color: 'var(--muted)' }}>{category.slug}</TableCell>
                    <TableCell>
                      <StatusChip
                        tone={category.is_active ? 'success' : 'default'}
                        label={t(
                          category.is_active
                            ? 'catalog.categories.active'
                            : 'catalog.categories.inactive',
                        )}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                        <Button
                          size="small"
                          onClick={() => setDrawer({ open: true, category })}
                        >
                          {t('common.edit')}
                        </Button>
                        {canWrite && (
                          <Button
                            size="small"
                            onClick={() => void onToggleActive(category)}
                            disabled={toggleActive.isPending}
                          >
                            {t(
                              category.is_active
                                ? 'catalog.categories.deactivate'
                                : 'catalog.categories.activate',
                            )}
                          </Button>
                        )}
                        {canWrite && (
                          <Button
                            size="small"
                            color="error"
                            onClick={() => setDeleteTarget(category)}
                          >
                            {t('common.delete')}
                          </Button>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Stack>

      <CategoryDrawer
        open={drawer.open}
        category={drawer.category}
        organizationId={tenant.organization_id}
        companyId={activeCompanyId}
        storeId={storeId}
        canWrite={canWrite}
        onClose={() => setDrawer({ open: false, category: null })}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        title={t('catalog.delete.title')}
        entityName={deleteTarget?.name ?? ''}
        isLoadingUsage={usage.isPending && Boolean(deleteTarget)}
        usageError={usage.isError ? t(errorKeyOf(usage.error)) : null}
        usage={[
          { label: t('catalog.delete.usage.products'), count: usage.data?.products ?? 0 },
          { label: t('catalog.delete.usage.children'), count: usage.data?.children ?? 0 },
        ]}
        safeActionLabel={
          deleteTarget?.is_active ? t('catalog.categories.deactivate') : undefined
        }
        safeActionHint={t('catalog.delete.deactivateHint')}
        onSafeAction={() => {
          if (!deleteTarget) return
          void onToggleActive(deleteTarget)
          setDeleteTarget(null)
        }}
        onDelete={() => void onDelete()}
        onClose={() => setDeleteTarget(null)}
        isBusy={removeCategory.isPending || toggleActive.isPending}
      />
    </>
  )
}
