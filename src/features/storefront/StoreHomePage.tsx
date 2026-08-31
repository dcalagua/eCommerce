import { Box, Button, Card, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import type { SearchQuery, SearchSort } from '@/domain'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useDocumentMeta } from '@/shared/seo/useDocumentMeta'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { CategoryBar } from './components/CategoryBar'
import { ContentBlocks } from './components/ContentBlocks'
import { ProductGrid, ProductGridSkeleton } from './components/ProductGrid'
import { ProductQuickView } from './components/ProductQuickView'
import { useFavorites } from './useFavorites'
import { StoreFilterPanel } from './components/StoreFilterPanel'
import { StoreHero } from './components/StoreHero'
import { StoreSortMenu } from './components/StoreSortMenu'
import {
  useCatalogPages,
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
  const { pathname } = useLocation()
  const [params, setParams] = useSearchParams()

  const categorySlug = params.get('c')
  const brand = params.get('b')
  const availability = params.get('d') === '1' ? 'in-stock' : 'all'
  const sortParam = params.get('sort')
  const sort: SearchSort = (SORTS as readonly string[]).includes(sortParam ?? '')
    ? (sortParam as SearchSort)
    : 'relevance'

  /**
   * El término ya no se teclea aquí: lo escribe el buscador de la cabecera y
   * llega por la URL. Antes esta pantalla tenía su propia caja, su rebote y un
   * efecto que sincronizaba `?q=`; con dos buscadores en pantalla —el de la
   * cabecera y el del cuerpo— cualquiera de los dos podía quedarse enseñando
   * algo distinto de lo que el catálogo estaba mostrando.
   */
  const search = params.get('q') ?? ''

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

  /**
   * Opciones del panel lateral.
   *
   * Las CATEGORIAS salen de la lista completa de la tienda, no de las facetas.
   * Comprobado contra la base: `catalog_search_for_slug` calcula las facetas
   * sobre el resultado YA filtrado, asi que al elegir «Sillas» vuelve una sola
   * categoria. Un panel alimentado solo por facetas se convertiria en un
   * callejon sin salida: eliges una y ya no puedes cambiar a otra.
   *
   * Por lo mismo el CONTADOR solo se ensena cuando no hay filtro de ese eje.
   * Con un filtro puesto, el resto sale a cero, y ese cero no significa «no hay
   * nada» sino «no te lo he contado». `null` es «no se sabe», y no se pinta.
   */
  const categoryCounts = new Map(
    (first?.facets.categories ?? []).map((facet) => [facet.code, facet.count]),
  )
  const categoryOptions = (categories.data ?? []).map((category) => ({
    code: category.slug,
    name: category.name,
    count: categorySlug ? null : (categoryCounts.get(category.slug) ?? 0),
  }))
  const brandOptions = brandFacets.map((facet) => ({
    code: facet.code,
    name: facet.name,
    count: brand ? null : facet.count,
  }))

  // Los favoritos se cargan UNA vez por tienda y se reparten a las tarjetas.
  const favorites = useFavorites(store.store_id)

  const resultCount = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PE').format(total)

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

      {/* Las categorías siguen aquí, en horizontal, ADEMÁS de en el panel: son
          el atajo de quien llega sin saber qué busca, y en el móvil el panel
          queda debajo del catálogo. */}
      <CategoryBar
        categories={categories.data ?? []}
        selected={categorySlug}
        onSelect={(slug) => update('c', slug)}
      />

      <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: { xs: 2, md: 3 }, alignItems: 'flex-start' }}>
        <Box sx={{ width: { xs: '100%', md: 280 }, flexShrink: 0 }}>
          <StoreFilterPanel
            brands={brandOptions}
            categories={categoryOptions}
            selectedBrand={brand}
            selectedCategory={categorySlug}
            inStockOnly={availability === 'in-stock'}
            onBrand={(code) => update('b', code)}
            onCategory={(slug) => update('c', slug)}
            onInStock={(only) => update('d', only ? '1' : null)}
            onClear={() => setParams(new URLSearchParams())}
          />
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          {/* Cuántos resultados hay y en qué orden se miran, en la misma línea
              y encima de la rejilla: son las dos preguntas que se hacen antes
              de empezar a recorrerla. */}
          <Stack
            direction="row"
            sx={{ gap: 1.5, alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap' }}
          >
            <Stack direction="row" sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Typography
                aria-live="polite"
                sx={{ fontSize: T.label, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}
              >
                {`${resultCount} ${total === 1 ? t('store.catalog.result') : t('store.catalog.results')}`}
              </Typography>
              {/* Un resultado por tolerancia a erratas no es lo mismo que uno
                  exacto, y decirlo es la diferencia entre ayudar y fingir. */}
              {first?.mode === 'fuzzy' && (
                <Typography sx={{ fontSize: T.label, color: 'var(--amber)', fontWeight: 700 }}>
                  {t('store.search.fuzzy')}
                </Typography>
              )}
            </Stack>
            <StoreSortMenu value={sort} onChange={(next) => update('sort', next)} />
          </Stack>

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
                    <Button variant="contained" onClick={() => setParams(new URLSearchParams())}>
                      {t('store.catalog.clear')}
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          )}

          {results.isSuccess && total > 0 && (
            <Box>
              <ProductGrid
                products={products}
                storeSlug={storeSlug}
                thumbnails={thumbnails}
                onPrefetch={prefetchProduct}
                onQuickView={(slug) => update('p', slug)}
                favorites={favorites.ids}
                onToggleFavorite={(productId) => void favorites.toggle(productId)}
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
        </Box>
      </Stack>

      {/* El producto abierto vive en `?p=`: el boton de atras cierra el
          dialogo y el enlace se puede pegar en un chat. */}
      <ProductQuickView
        storeId={store.store_id}
        storeSlug={storeSlug}
        slug={params.get('p')}
        onClose={() => update('p', null)}
      />
    </Stack>
  )
}
