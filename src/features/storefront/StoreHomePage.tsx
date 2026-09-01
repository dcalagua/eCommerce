import { Box, Breadcrumbs, Button, Card, Link as MuiLink, Stack, Typography } from '@mui/material'
import { visuallyHidden } from '@mui/utils'
import { useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import type { SearchQuery, SearchSort } from '@/domain'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useDocumentMeta } from '@/shared/seo/useDocumentMeta'
import { BrandLoader } from '@/shared/ui/BrandLoader'
import { CONTENT_ANCHOR } from '@/shared/ui/SkipToContentLink'
import { EmptyState, ErrorState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { BackToTop } from './components/BackToTop'
import { BrandRow } from './components/BrandRow'
import { CategoryBar } from './components/CategoryBar'
import { ProductRow } from './components/ProductRow'
import { PromoCarousel } from './components/PromoCarousel'
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
  useStorePromotions,
} from './hooks'
import { categoryBarItems, categoryTrail, rollUpCategoryCounts } from './categoryTree'
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
  const promotions = useStorePromotions(storeSlug)

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

  const filtered = Boolean(search.trim() || categorySlug || brand || availability === 'in-stock')

  /**
   * Portada o catálogo.
   *
   * La rejilla de 400 productos con su panel de filtros es lo que se quiere
   * cuando YA se sabe qué se busca. Quien acaba de entrar necesita antes saber
   * QUÉ HAY, y eso son filas cortas con nombre: ofertas, categorías, marcas,
   * novedades. La rejilla aparece al pedirla —«Ver todo»— o en cuanto hay un
   * filtro, una búsqueda o una marca elegida, que es la misma intención dicha
   * de otra forma.
   *
   * Vive en la URL (`?ver=todo`) como el resto: se comparte, el botón de atrás
   * devuelve a la portada y recargar no cambia lo que se estaba mirando.
   */
  const catalogo = filtered || params.get('ver') === 'todo'

  const results = useCatalogPages(storeSlug, query)

  /**
   * Novedades, solo para la portada.
   *
   * `storeSlug` a `undefined` en el catálogo es lo que APAGA esta consulta: la
   * fila no se pinta ahí, y pedir doce productos que nadie va a ver es pagar
   * una llamada por cada filtro que alguien toca.
   */
  const novedadesQuery: SearchQuery = useMemo(
    () => ({ term: '', filters: {}, sort: 'recent', limit: 12, offset: 0 }),
    [],
  )
  const novedadesPages = useCatalogPages(catalogo ? undefined : storeSlug, novedadesQuery)
  const novedades = useMemo(
    () =>
      (novedadesPages.data?.pages[0]?.items ?? []).map((hit) =>
        hitToPublicProduct(hit, store.store_id),
      ),
    [novedadesPages.data, store.store_id],
  )
  const novedadesThumbs = useSignedThumbnails(novedades.map((p) => p.primary_image_path))

  const pages = useMemo(() => results.data?.pages ?? [], [results.data])
  const products = useMemo(
    () => pages.flatMap((page) => page.items.map((hit) => hitToPublicProduct(hit, store.store_id))),
    [pages, store.store_id],
  )
  const thumbnails = useSignedThumbnails(products.map((product) => product.primary_image_path))
  const prefetchProduct = usePrefetchProduct(store.store_id)

  /**
   * La segunda fila no repite la primera.
   *
   * «Novedades» y «Lo más vendido» son dos consultas distintas, pero en una
   * tienda pequeña devuelven casi lo mismo — y una portada que enseña el mismo
   * producto dos veces con dos títulos distintos parece rota. Si al quitar lo
   * repetido no queda nada, la fila entera desaparece: mejor una fila menos que
   * una fila que miente.
   */
  const destacados = useMemo(() => {
    const yaVistos = new Set(novedades.map((p) => p.product_id))
    return products.filter((p) => !yaVistos.has(p.product_id)).slice(0, 12)
  }, [products, novedades])

  const blocks = content.data?.cms ? (content.data.blocks ?? []) : []
  const hasCmsHero = blocks.some((block) => block.type === 'hero')
  /**
   * ¿Trae el CMS su propia cubierta?
   *
   * `StoreHero` es la cabecera de RESERVA: existe para que una tienda que
   * todavía no ha compuesto nada tenga portada. Un carrusel de imágenes arriba
   * YA es esa cubierta, y que apareciera el hero de reserva justo al apagar el
   * bloque del CMS es lo que hace pensar que el interruptor no funciona —se
   * apaga una cabecera y sale otra, con otro texto.
   *
   * El carrusel solo cuenta si tiene diapositivas: uno vacío no pinta nada, y
   * quitar la reserva por él dejaría la portada sin nada arriba.
   */
  const cmsTraePortada = blocks.some(
    (block) => block.type === 'hero' || (block.type === 'slider' && block.items.length > 0),
  )
  const cmsTraeProductos = blocks.some((block) => block.items.length > 0)

  /**
   * El carrusel no repite lo que el comercio ya puso a mano.
   *
   * Una campaña puede salir por dos caminos: el bloque que el comercio escribió
   * para ella y la lista automática de campañas vigentes. Las dos a la vez, una
   * encima de otra, se leen como un fallo de la tienda — la misma oferta
   * anunciada dos veces.
   *
   * Gana el bloque escrito: lleva la foto, el texto y el botón que el comercio
   * eligió. El carrusel se queda con las que nadie ha anunciado, que son
   * justamente las que sin él no se verían en ninguna parte.
   */
  const anunciadas = new Set(
    blocks.map((block) => block.campaign?.id).filter((id): id is string => Boolean(id)),
  )
  const promosVigentes = (promotions.data ?? []).filter((promo) => !anunciadas.has(promo.id))
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
  /**
   * P18 · Las cifras SUMAN lo que cuelga.
   *
   * Las facetas cuentan por la categoría exacta del producto, que es lo único
   * que el producto declara. Con árbol eso deja a las madres a cero: «Nutrición»
   * reparte sus 81 productos entre sus hijas y no tiene ninguno propio. Un cero
   * al lado de una puerta que sí lleva a algún sitio dice «vacío» de algo lleno.
   */
  const categoryCounts = useMemo(() => {
    const propias = new Map<string, number | null>(
      (first?.facets.categories ?? []).map((facet) => [facet.code, facet.count]),
    )
    return rollUpCategoryCounts(categories.data ?? [], propias)
  }, [first, categories.data])
  /**
   * P18 · La barra enseña el nivel en el que se está: raíces en la portada,
   * hijas al entrar en una, hermanas dentro de una hoja. Con treinta categorías
   * planas la barra era un muro; con el árbol es una ruta.
   */
  const categoryOptions = categoryBarItems(categories.data ?? [], categorySlug).map(
    (category) => ({
      code: category.slug,
      name: category.name,
      count: categorySlug ? null : (categoryCounts.get(category.slug) ?? 0),
    }),
  )

  /** Por dónde ha llegado. Sin esto, entrar desde el buscador no dice dónde estás. */
  const trail = useMemo(
    () => categoryTrail(categories.data ?? [], categorySlug),
    [categories.data, categorySlug],
  )
  const brandOptions = brandFacets.map((facet) => ({
    code: facet.code,
    name: facet.name,
    count: brand ? null : facet.count,
  }))

  // Los favoritos se cargan UNA vez por tienda y se reparten a las tarjetas.
  const favorites = useFavorites(store.store_id)

  /**
   * Carga al bajar.
   *
   * Un centinela invisible bajo la rejilla: cuando entra en pantalla, se pide
   * la pagina siguiente. Se dispara 400 px ANTES de llegar (`rootMargin`) para
   * que la siguiente tanda ya este puesta cuando el ojo llega, en vez de
   * enseñar un hueco y luego rellenarlo.
   *
   * El boton «Ver mas» NO se quita: es lo que funciona con teclado, con lector
   * de pantalla y cuando el observador no existe. El desplazamiento infinito
   * sin boton es una trampa para quien no navega con rueda.
   */
  const sentinel = useRef<HTMLDivElement | null>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results

  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasNextPage || isFetchingNextPage) return
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage()
      },
      { rootMargin: '400px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, products.length])

  /**
   * Cambiar de lista empieza por el principio.
   *
   * «Ver todo» no cambia de ruta —solo de parámetro—, así que el navegador
   * conserva el desplazamiento: se pulsaba desde media página y el catálogo
   * aparecía empezado por la mitad, con la cabecera y los filtros arriba, fuera
   * de la vista. Lo mismo al volver a la portada y al cambiar de categoría o de
   * marca: es OTRA lista, y una lista nueva que empieza por su fila 40 no se
   * entiende.
   *
   * No entra el ORDEN ni la disponibilidad a propósito: ahí se está mirando lo
   * mismo de otra forma, y devolver el scroll al principio haría perder el
   * sitio a quien solo quería reordenar.
   */
  const listaVista = `${catalogo}|${categorySlug ?? ''}|${brand ?? ''}|${search.trim()}`
  const listaPrevia = useRef(listaVista)
  useEffect(() => {
    if (listaPrevia.current === listaVista) return
    listaPrevia.current = listaVista
    try {
      window.scrollTo({ top: 0, behavior: 'auto' })
    } catch {
      // jsdom no implementa `scrollTo` y lo grita por consola en cada test que
      // monta la portada. Que un entorno sin scroll no pueda desplazarse no es
      // un error: es que no hay a dónde.
    }
  }, [listaVista])

  const resultCount = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PE').format(total)

  /**
   * Qué se está mirando, dicho con sus palabras.
   *
   * «Todo el catálogo» solo cuando de verdad no hay filtro: si se llegó por una
   * marca o una categoría, el título es esa marca o esa categoría — es la
   * respuesta a «¿dónde estoy?», que en una lista de 400 filas es la primera
   * pregunta.
   */
  const tituloCatalogo = search.trim()
    ? `${t('store.catalog.resultsFor')} "${search.trim()}"`
    : (trail.at(-1)?.name ??
       brandOptions.find((b) => b.code === brand)?.name ??
       t('store.catalog.all'))

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
      {/* El hero y lo que compuso el comercio son la PORTADA. Al pedir «Ver
          todo» estorban: quien va al catálogo tiene que volver a pasar por
          delante de todo lo que ya vio para llegar a la rejilla. */}
      {catalogo || cmsTraePortada ? null : <StoreHero store={store} />}

      {/* El `<h1>` cuando la cubierta es un carrusel.
          Un carrusel son imágenes: no tiene texto que pueda ser el encabezado
          de nivel 1, y sin esto la portada se quedaría sin él en cuanto el
          comercio cambiara el hero por un banner rotatorio. Va oculto a la
          vista y no al lector: quien navega por encabezados necesita saber
          dónde empieza el documento, y el nombre de la tienda ya está escrito
          arriba en la cabecera. */}
      {!catalogo && cmsTraePortada && !hasCmsHero && (
        <Typography component="h1" sx={visuallyHidden}>
          {store.name}
        </Typography>
      )}

      {/* Cabecera del catálogo: de dónde se viene, qué se está mirando y cómo
          se vuelve. Sin esto, «Ver todo» dejaba una rejilla sin título y sin
          camino de vuelta que no fuera el botón de atrás del navegador. */}
      {catalogo ? (
        <Stack sx={{ gap: 0.5 }}>
          <MuiLink
            component={Link}
            to={`/s/${storeSlug}`}
            sx={{
              fontSize: T.label,
              fontWeight: 700,
              color: 'var(--muted)',
              textDecoration: 'none',
              alignSelf: 'flex-start',
              '&:hover': { color: 'var(--accent-deep)' },
            }}
          >
            {`\u2190 ${t('store.catalog.back')}`}
          </MuiLink>
          <Typography
            component="h1"
            sx={{ fontSize: { xs: 22, md: 26 }, fontWeight: 800, letterSpacing: '-0.02em' }}
          >
            {tituloCatalogo}
          </Typography>
        </Stack>
      ) : null}

      {/* `leadingHeading`: cuando el hero del CMS sustituye al de
          `store_settings`, es él quien tiene que llevar el `<h1>`. Sin esto la
          portada se quedaba sin encabezado de nivel 1 en cuanto el comercio
          publicaba una portada — y quien navega por encabezados perdía la
          única referencia de dónde empieza el documento. */}
      {catalogo ? null : (
      <ContentBlocks
        blocks={blocks}
        storeSlug={storeSlug}
        assets={assets}
        images={images}
        currency={store.currency}
        leadingHeading={hasCmsHero}
      />
      )}

{/* Las ofertas vigentes, ANTES del catálogo y pasando solas.
          Salen del motor de promociones, no de un cartel escrito a mano: si
          está descontando, se anuncia; si caduca, desaparece sola. */}
      {promosVigentes.length > 0 && (
        <PromoCarousel
          promotions={promosVigentes}
          storeSlug={storeSlug}
          currency={store.currency}
        />
      )}

      {/* Dos formas de la misma lista, y la diferencia no es de adorno.
          En el CATÁLOGO son píldoras: ahí son un filtro, se comparan de un
          vistazo y se encienden y apagan. En la PORTADA son puertas, y una
          puerta tiene que decir a dónde lleva —de ahí el icono, que separa una
          familia de otra antes de leerla— y cuánto hay detrás. */}
      {catalogo ? (
        <Stack sx={{ gap: 1 }}>
          {/* Las migas: sin ellas, quien abre «Desodorantes» desde el buscador
              no sabe que esta dentro de «Cuidado personal» ni como subir. */}
          {trail.length > 0 && (
            <Breadcrumbs
              aria-label={t('store.categories.title')}
              separator="›"
              sx={{ fontSize: T.label, color: 'var(--muted)' }}
            >
              <MuiLink
                component="button"
                type="button"
                underline="hover"
                onClick={() => update('c', null)}
                sx={{ fontSize: T.label, color: 'var(--muted)' }}
              >
                {/* «Todo el catálogo» y no «Todo»: la píldora de la barra ya se
                    llama así, y dos controles con el mismo nombre en la misma
                    pantalla no se distinguen ni con el ratón ni con un lector. */}
                {t('store.catalog.all')}
              </MuiLink>
              {trail.map((node, index) =>
                index === trail.length - 1 ? (
                  <Box key={node.category_id} component="span" sx={{ fontWeight: 700, color: 'var(--text)' }}>
                    {node.name}
                  </Box>
                ) : (
                  <MuiLink
                    key={node.category_id}
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => update('c', node.slug)}
                    sx={{ fontSize: T.label, color: 'var(--muted)' }}
                  >
                    {node.name}
                  </MuiLink>
                ),
              )}
            </Breadcrumbs>
          )}
          <CategoryBar
            categories={categoryBarItems(categories.data ?? [], categorySlug)}
            selected={categorySlug}
            onSelect={(slug) => update('c', slug)}
          />
        </Stack>
      ) : null}

      {/* Las marcas, al lado de las categorías: en una botica se compra por
          marca tanto como por familia. Solo en la portada sin filtrar — con un
          filtro puesto, la faceta se queda en la marca elegida y la fila
          dejaría de ser una puerta para ser un espejo. */}
      {catalogo ? null : (
        <BrandRow
          brands={brandOptions}
          selected={brand}
          onSelect={(code) => update('b', code)}
          seeAllHref={`/s/${storeSlug}?ver=todo`}
        />
      )}

      {/* Lo nuevo y lo de siempre, en filas cortas con su puerta al catálogo.
          Una fila se recorre de un vistazo; una rejilla infinita, no. */}
      {catalogo ? null : (
        <>
          <ProductRow
            title={t('store.row.new')}
            products={novedades}
            loading={novedadesPages.isPending}
            storeSlug={storeSlug}
            thumbnails={novedadesThumbs}
            seeAllHref={`/s/${storeSlug}?ver=todo&sort=recent`}
            onPrefetch={prefetchProduct}
            onQuickView={(slug) => update('p', slug)}
            favorites={favorites.ids}
            onToggleFavorite={(productId) => void favorites.toggle(productId)}
          />

          {/* Solo si el comercio no compuso ya sus propias filas: repetir «Lo
              más vendido» dos veces con productos distintos no es más tienda,
              es una portada que se contradice. */}
          {cmsTraeProductos ? null : (
          <ProductRow
            title={t('store.row.featured')}
            products={destacados}
            loading={results.isPending}
            storeSlug={storeSlug}
            thumbnails={thumbnails}
            seeAllHref={`/s/${storeSlug}?ver=todo`}
            onPrefetch={prefetchProduct}
            onQuickView={(slug) => update('p', slug)}
            favorites={favorites.ids}
            onToggleFavorite={(productId) => void favorites.toggle(productId)}
          />
          )}
        </>
      )}

      {/* Una tienda sin catalogo publicado no puede quedarse en una portada
          muda: sin filas ni bloques, aqui no habria NADA, y una pantalla vacia
          sin explicacion parece rota. */}
      {!catalogo && results.isSuccess && total === 0 && blocks.length === 0 && (
        <Card>
          <EmptyState
            title={t('store.catalog.empty')}
            description={t('store.catalog.emptyBody')}
          />
        </Card>
      )}

      {catalogo ? (
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
              {/* Invisible y sin alto: solo marca el punto a partir del cual
                  vale la pena pedir la siguiente pagina. */}
              <Box ref={sentinel} aria-hidden sx={{ height: 1, width: '100%' }} />

              {results.isFetchingNextPage ? (
                <BrandLoader label={t('store.catalog.loadingMore')} compact />
              ) : (
                <Button variant="outlined" onClick={() => void results.fetchNextPage()}>
                  {t('store.catalog.more')}
                </Button>
              )}
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
      ) : null}

      {/* El producto abierto vive en `?p=`: el boton de atras cierra el
          dialogo y el enlace se puede pegar en un chat. */}
      <BackToTop anchorId={CONTENT_ANCHOR} />

      <ProductQuickView
        storeId={store.store_id}
        storeSlug={storeSlug}
        slug={params.get('p')}
        onClose={() => update('p', null)}
      />
    </Stack>
  )
}
