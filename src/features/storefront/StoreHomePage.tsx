import {
  Box,
  Button,
  Card,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { SearchField } from '@/shared/ui/SearchField'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { CategoryBar } from './components/CategoryBar'
import { ProductGrid, ProductGridSkeleton } from './components/ProductGrid'
import { StoreHero } from './components/StoreHero'
import { usePublicCategories, usePublicProducts, useStorefront, useThumbnails } from './hooks'
import { PRODUCT_SORTS, type CatalogQuery, type ProductSort } from './types'

/**
 * Portada de la vitrina: banner, categorías, buscador y catálogo.
 *
 * Los filtros viven en la **URL** (`?q=&c=&d=&sort=`), no en un estado suelto:
 * así una búsqueda se puede compartir, el botón de atrás hace lo que se espera
 * y recargar no borra lo que el comprador acababa de elegir.
 *
 * Un solo buscador general + filtros simples (categoría y disponibilidad), como
 * manda la regla de suite: nada de paneles de filtros multi-campo.
 */
export function StoreHomePage() {
  const { t, locale } = useI18n()
  const { store, storeSlug } = useStorefront()
  const [params, setParams] = useSearchParams()

  const categorySlug = params.get('c')
  const availability = params.get('d') === '1' ? 'in-stock' : 'all'
  const sortParam = params.get('sort')
  const sort: ProductSort = (PRODUCT_SORTS as readonly string[]).includes(sortParam ?? '')
    ? (sortParam as ProductSort)
    : 'recent'

  const [term, setTerm] = useState(() => params.get('q') ?? '')
  const search = useDebouncedValue(term, 300)

  // El término sale a la URL solo cuando deja de escribirse, y con `replace`
  // para no dejar una entrada de historial por cada letra.
  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (search.trim()) next.set('q', search.trim())
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }, [search, setParams])

  function update(key: string, value: string | null) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const categories = usePublicCategories(store.store_id)

  const query: CatalogQuery = useMemo(
    () => ({ storeId: store.store_id, search, categorySlug, availability, sort }),
    [store.store_id, search, categorySlug, availability, sort],
  )
  const products = usePublicProducts(query)
  const thumbnails = useThumbnails(products.data ?? [])

  const filtered = Boolean(search.trim() || categorySlug || availability === 'in-stock')
  const count = products.data?.length ?? 0

  return (
    <Stack sx={{ gap: { xs: 2, md: 3 } }}>
      <StoreHero store={store} />

      <CategoryBar
        categories={categories.data ?? []}
        selected={categorySlug}
        onSelect={(slug) => update('c', slug)}
      />

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        sx={{ gap: 1.5, alignItems: { md: 'center' }, justifyContent: 'space-between' }}
      >
        <SearchField
          value={term}
          onChange={setTerm}
          placeholder={t('store.catalog.search')}
          ariaLabel={t('store.catalog.search')}
        />
        <Stack direction="row" sx={{ gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={availability === 'in-stock'}
                onChange={(event) => update('d', event.target.checked ? '1' : null)}
              />
            }
            label={
              <Typography sx={{ fontSize: T.body, fontWeight: 700 }}>
                {t('store.filter.inStock')}
              </Typography>
            }
          />
          <TextField
            select
            size="small"
            value={sort}
            onChange={(event) => update('sort', event.target.value)}
            label={t('store.sort.label')}
            sx={{ minWidth: 190 }}
          >
            <MenuItem value="recent">{t('store.sort.recent')}</MenuItem>
            <MenuItem value="price-asc">{t('store.sort.priceAsc')}</MenuItem>
            <MenuItem value="price-desc">{t('store.sort.priceDesc')}</MenuItem>
            <MenuItem value="name">{t('store.sort.name')}</MenuItem>
          </TextField>
        </Stack>
      </Stack>

      {products.isPending && <ProductGridSkeleton />}

      {products.isError && (
        <Card>
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        </Card>
      )}

      {products.isSuccess && count === 0 && (
        <Card>
          <EmptyState
            title={filtered ? t('store.catalog.noResults') : t('store.catalog.empty')}
            description={
              filtered ? t('store.catalog.noResultsBody') : t('store.catalog.emptyBody')
            }
            action={
              filtered ? (
                <Button
                  variant="contained"
                  onClick={() => {
                    setTerm('')
                    setParams(new URLSearchParams())
                  }}
                >
                  {t('store.catalog.clear')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      {products.isSuccess && count > 0 && (
        <Box>
          <Typography
            aria-live="polite"
            sx={{ fontSize: T.label, fontWeight: 700, color: 'var(--muted)', mb: 1.5 }}
          >
            {`${new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PE').format(count)} ${
              count === 1 ? t('store.catalog.item') : t('store.catalog.items')
            }`}
          </Typography>
          <ProductGrid
            products={products.data}
            storeSlug={storeSlug}
            thumbnails={thumbnails}
          />
        </Box>
      )}
    </Stack>
  )
}
