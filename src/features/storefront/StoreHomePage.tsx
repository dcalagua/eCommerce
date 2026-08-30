import {
  Box,
  Button,
  Card,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { SearchQuery, SearchSort } from '@/domain'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { useDocumentMeta } from '@/shared/seo/useDocumentMeta'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { CategoryBar } from './components/CategoryBar'
import { ContentBlocks } from './components/ContentBlocks'
import { ProductGrid, ProductGridSkeleton } from './components/ProductGrid'
import { StoreHero } from './components/StoreHero'
import { StoreSearchField } from './components/StoreSearchField'
import {
  useCatalogPages,
  useCatalogSuggestions,
  useContentAssets,
  usePrefetchProduct,
  usePublicCategories,
  useSignedThumbnails,
  useStoreContent,
  useStorefront,
} from './hooks'
import { hitToPublicProduct } from './search'
import { homeMeta } from './seo'

/** Cuántos resultados por página. El «ver más» suma otra tanda. */
const PAGE_SIZE = 24

const SORTS: readonly SearchSort[] = ['relevance', 'price-asc', 'price-desc', 'name', 'recent']

/**
 * Portada de la vitrina: contenido administrable + catálogo buscable.
 *
 * ## Lo que P11-SaaS cambia aquí, y por qué
 *
 * 1. **El catálogo ya no se descarga entero.** Hasta P10 la portada pedía
 *    `public_products` sin límite y filtraba en el navegador; el encargo de esta
 *    fase lo prohíbe con esas palabras («evita cargar catálogo completo al
 *    browser para buscar»). Ahora pregunta al `SearchPort`, que devuelve una
 *    PÁGINA y los contadores de las facetas.
 * 2. **La portada la escribe el comercio.** Si la sociedad tiene `content.cms`
 *    y hay una página `home` publicada, sus bloques se pintan encima del
 *    catálogo. Y si esos bloques traen un `hero`, el hero de `store_settings`
 *    NO se pinta: dos portadas apiladas no son una portada más completa.
 * 3. **Sin `content.cms` todo se ve igual que antes.** `cms: false` es una
 *    respuesta válida, no un error: hero de `store_settings` y catálogo. Se
 *    degrada, no se rompe.
 *
 * Los filtros siguen viviendo en la **URL** (`?q=&c=&d=&sort=&b=`): una
 * búsqueda se comparte, el botón de atrás hace lo que se espera y recargar no
 * borra lo que el comprador acababa de elegir.
 */
export function StoreHomePage() {
  const { t, locale } = useI18n()
  const { store, storeSlug } = useStorefront()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params, setParams] = useSearchParams()

  const categorySlug = params.get('c')
  const brand = params.get('b')
  const availability = params.get('d') === '1' ? 'in-stock' : 'all'
  const sortParam = params.get('sort')
  const sort: SearchSort = (SORTS as readonly string[]).includes(sortParam ?? '')
    ? (sortParam as SearchSort)
    : 'relevance'

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

  // Cambiar de término o de filtro vuelve a la primera página. Ya no hace
  // falta un `useEffect` que lo fuerce: el filtro entra en la clave de la
  // consulta paginada, así que otra combinación es otra consulta y empieza en
  // su primera página por construcción.

  function update(key: string, value: string | null) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const content = useStoreContent(storeSlug)
  const { assets, images } = useContentAssets(content.data)
  const categories = usePublicCategories(store.store_id)
  const suggestions = useCatalogSuggestions(storeSlug, search)

  const query: SearchQuery = useMemo(
    () => ({
      term: search,
      filters: {
        category: categorySlug,
        brands: brand ? [brand] : [],
        availability,
      },
      sort,
      limit: PAGE_SIZE,
      offset: 0,
    }),
    [search, categorySlug, brand, availability, sort],
  )

  const results = useCatalogPages(storeSlug, query)
  const pages = useMemo(() => results.data?.pages ?? [], [results.data])
  const products = useMemo(
    () => pages.flatMap((page) => page.items.map((hit) => hitToPublicProduct(hit, store.store_id))),
    [pages, store.store_id],
  )
  const thumbnails = useSignedThumbnails(products.map((product) => product.primary_image_path))
  const prefetchProduct = usePrefetchProduct(store.store_id)

  const blocks = content.data?.cms ? (content.data.blocks ?? []) : []
  const hasCmsHero = blocks.some((block) => block.type === 'hero')
  const filtered = Boolean(search.trim() || categorySlug || brand || availability === 'in-stock')
  const first = pages[0]
  const total = first?.total ?? 0
  const brandFacets = first?.facets.brands ?? []

  // Metadatos de la portada. Cuelgan de la tienda YA RESUELTA, así que el
  // nombre, el banner y el contacto que se le enseñan a un buscador son los del
  // tenant. Se recalculan si cambia el filtro porque el canonical conserva la
  // categoría y la marca (ver `shared/seo/meta.ts`).
  useDocumentMeta(
    homeMeta(
      { store, storeSlug, locale, pathname, search: params.toString() },
      t('store.seo.catalogOf'),
    ),
  )

  return (
    <Stack sx={{ gap: { xs: 2, md: 3 } }}>
      {/* El hero del CMS SUSTITUYE al de `store_settings`, no se suma a él. */}
      {hasCmsHero ? null : <StoreHero store={store} />}

      {/* `leadingHeading`: cuando el hero del CMS sustituye al de
          `store_settings`, es él quien tiene que llevar el `<h1>`. Sin esto la
          portada se quedaba sin encabezado de nivel 1 en cuanto el comercio
          publicaba una portada — y quien navega por encabezados perdía la
          única referencia de dónde empieza el documento. */}
      <ContentBlocks
        blocks={blocks}
        storeSlug={storeSlug}
        assets={assets}
        images={images}
        leadingHeading={hasCmsHero}
      />

      <CategoryBar
        categories={categories.data ?? []}
        selected={categorySlug}
        onSelect={(slug) => update('c', slug)}
      />

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        sx={{ gap: 1.5, alignItems: { md: 'center' }, justifyContent: 'space-between' }}
      >
        {/* `role="search"` convierte la caja en un LANDMARK: un lector de
            pantalla la lista junto a la cabecera y el pie, y se llega a ella
            sin recorrer la portada. Sin esto, el buscador de una tienda con
            hero y bloques de contenido queda a diez saltos del principio. */}
        <Box role="search" sx={{ width: '100%', maxWidth: { sm: 420 } }}>
        <StoreSearchField
          value={term}
          onChange={setTerm}
          suggestions={suggestions.data ?? []}
          loading={suggestions.isFetching}
          onPick={(suggestion) => {
            // Cada tipo de sugerencia lleva a un sitio distinto: el producto a
            // su ficha, la categoría y la marca a un catálogo ya filtrado. Que
            // las tres rellenaran la caja de texto sería tratar una respuesta
            // exacta como si fuera una conjetura.
            if (suggestion.kind === 'product') {
              navigate(`/s/${storeSlug}/product/${suggestion.slug}`)
              return
            }
            setTerm('')
            update(suggestion.kind === 'category' ? 'c' : 'b', suggestion.slug)
          }}
        />
        </Box>
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
            <MenuItem value="relevance">{t('store.sort.relevance')}</MenuItem>
            <MenuItem value="recent">{t('store.sort.recent')}</MenuItem>
            <MenuItem value="price-asc">{t('store.sort.priceAsc')}</MenuItem>
            <MenuItem value="price-desc">{t('store.sort.priceDesc')}</MenuItem>
            <MenuItem value="name">{t('store.sort.name')}</MenuItem>
          </TextField>
        </Stack>
      </Stack>

      {/* Faceta de marca: chips, no un panel multi-campo. Solo aparece cuando
          hay más de una marca que elegir; con una sola, el filtro no filtra. */}
      {brandFacets.length > 1 && (
        <Stack
          direction="row"
          sx={{ gap: 1, flexWrap: 'wrap' }}
          role="group"
          aria-label={t('store.filter.brand')}
        >
          {brandFacets.map((facet) => (
            <Chip
              key={facet.code}
              label={`${facet.name} (${facet.count})`}
              size="small"
              clickable
              color={brand === facet.code ? 'primary' : 'default'}
              onClick={() => update('b', brand === facet.code ? null : facet.code)}
            />
          ))}
        </Stack>
      )}

      {results.isPending && <ProductGridSkeleton />}

      {results.isError && (
        <Card>
          <ErrorState error={results.error} onRetry={() => void results.refetch()} />
        </Card>
      )}

      {results.isSuccess && total === 0 && (
        <Card>
          <EmptyState
            title={filtered ? t('store.catalog.noResults') : t('store.catalog.empty')}
            description={filtered ? t('store.catalog.noResultsBody') : t('store.catalog.emptyBody')}
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

      {results.isSuccess && total > 0 && (
        <Box>
          <Stack
            direction="row"
            sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap', mb: 1.5 }}
          >
            <Typography
              aria-live="polite"
              sx={{ fontSize: T.label, fontWeight: 700, color: 'var(--muted)' }}
            >
              {`${new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PE').format(total)} ${
                total === 1 ? t('store.catalog.item') : t('store.catalog.items')
              }`}
            </Typography>
            {/* Un resultado por tolerancia a erratas no es lo mismo que uno
                exacto, y decirlo es la diferencia entre ayudar y fingir. */}
            {first?.mode === 'fuzzy' && (
              <Typography sx={{ fontSize: T.label, color: 'var(--amber)', fontWeight: 700 }}>
                {t('store.search.fuzzy')}
              </Typography>
            )}
          </Stack>

          <ProductGrid
            products={products}
            storeSlug={storeSlug}
            thumbnails={thumbnails}
            onPrefetch={prefetchProduct}
          />

          {/* La siguiente página se PIDE al servidor: 24 filas, no las 48 o 72
              que costaba subir el techo y volver a pedir desde cero. */}
          {results.hasNextPage && (
            <Stack sx={{ alignItems: 'center', gap: 1, mt: 2 }}>
              <Button
                variant="outlined"
                onClick={() => void results.fetchNextPage()}
                disabled={results.isFetchingNextPage}
              >
                {t('store.catalog.more')}
              </Button>
              {/* Que hay más cargando no se puede contar solo con el botón
                  deshabilitado: quien no ve la pantalla no se entera de nada. */}
              <Typography
                aria-live="polite"
                sx={{ fontSize: T.label, color: 'var(--muted)', minHeight: 18 }}
              >
                {results.isFetchingNextPage ? t('store.catalog.loadingMore') : ''}
              </Typography>
            </Stack>
          )}

          {!results.hasNextPage && products.length > PAGE_SIZE && (
            <Typography
              sx={{ fontSize: T.label, color: 'var(--muted)', textAlign: 'center', mt: 2 }}
            >
              {t('store.catalog.endOfList')}
            </Typography>
          )}
        </Box>
      )}
    </Stack>
  )
}
