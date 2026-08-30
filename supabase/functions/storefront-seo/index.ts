/**
 * storefront-seo — `sitemap.xml` y `robots.txt` por tienda (P15-SaaS).
 *
 * Cableado puro: resuelve la tienda por SLUG, pide catálogo y páginas con el
 * cliente **anónimo** y delega el texto a `_shared/seo/sitemap.ts`, que es
 * donde están las decisiones y los tests.
 *
 * Tres reglas que esta función no puede romper:
 *
 *  1. **Nada de `service_role`.** Lee con `anonClient`, exactamente igual que
 *     la vitrina. Lo que puede publicar es lo que ya publica el catálogo: si
 *     mañana una policy cambia, el sitemap cambia con ella. Con `service_role`
 *     un despiste aquí publicaría en Google el catálogo sin publicar de un
 *     tenant, y eso no lo arregla revisar el código: hay que hacerlo imposible.
 *  2. **El tenant sale del SLUG de la URL**, resuelto contra `public_stores`,
 *     que solo devuelve tiendas activas. Ni `store_id`, ni `organization_id`,
 *     ni `company_id` se aceptan de nadie.
 *  3. **El origen se valida.** Llega de la petición y sirve para construir URLs
 *     absolutas: sin comprobarlo, cualquiera podría hacer que el sitemap de un
 *     tenant apuntase a su propio dominio.
 *
 * Rutas (`/functions/v1/storefront-seo/...`):
 *   GET  /s/:slug/sitemap.xml
 *   GET  /s/:slug/robots.txt
 *
 * Cómo se publica en `https://tienda/s/:slug/sitemap.xml` es una regla de
 * reescritura del hosting; esta fase no despliega (contrato §11). Ver el ADR
 * 015 para el pendiente.
 */
import { corsHeaders } from '../_shared/cors.ts'
import { normalizeOrigin, renderRobots, renderSitemap } from '../_shared/seo/sitemap.ts'
import { anonClient } from '../_runtime/clients.ts'
import { edgeSecurityHeaders } from '../_shared/securityHeaders.ts'

/** Techo de filas que se piden al catálogo. Coherente con `SITEMAP_MAX_URLS`. */
const PRODUCT_LIMIT = 5_000

/** Un sitemap no cambia por minuto y lo pide un robot: se puede cachear. */
const CACHE = 'public, max-age=3600, s-maxage=21600'

function textResponse(
  body: string,
  contentType: string,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      // Cacheable: el sitemap trae su propio `Cache-Control` mas abajo, asi que
      // el `no-store` del resto del borde no puede entrar aqui (P16-SaaS).
      ...edgeSecurityHeaders({ cacheable: true }),
      'Content-Type': contentType,
      'Cache-Control': status === 200 ? CACHE : 'no-store',
      // Nada de este contenido depende de quién pregunte.
      'X-Robots-Tag': 'noindex',
    },
  })
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request.headers.get('origin'), { methods: ['GET', 'OPTIONS'] })
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'GET') {
    return textResponse('Method Not Allowed', 'text/plain; charset=utf-8', 405, cors)
  }

  const url = new URL(request.url)
  // `x-forwarded-host` es lo que ve el visitante cuando hay un dominio del
  // tenant por delante; la URL de la función es el fallback. Los dos pasan por
  // el mismo validador.
  const forwarded = request.headers.get('x-forwarded-host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  const origin =
    normalizeOrigin(forwarded ? `${proto}://${forwarded}` : null) ??
    normalizeOrigin(request.headers.get('origin')) ??
    normalizeOrigin(url.origin)

  if (!origin) return textResponse('Bad Request', 'text/plain; charset=utf-8', 400, cors)

  const match = url.pathname.match(/\/s\/([^/]+)\/(sitemap\.xml|robots\.txt)$/)
  if (!match) return textResponse('Not Found', 'text/plain; charset=utf-8', 404, cors)

  const storeSlug = decodeURIComponent(match[1])
  const what = match[2]

  const supabase = anonClient()

  // La tienda tiene que EXISTIR y estar activa. `public_stores` ya filtra
  // `status = 'active'`: un slug que no resuelve responde 404, no un sitemap
  // vacío que el buscador guardaría como válido.
  const { data: store, error } = await supabase
    .from('public_stores')
    .select('store_id, slug')
    .eq('slug', storeSlug)
    .maybeSingle()

  if (error || !store) return textResponse('Not Found', 'text/plain; charset=utf-8', 404, cors)

  if (what === 'robots.txt') {
    return textResponse(
      renderRobots({ origin, storeSlug: store.slug }),
      'text/plain; charset=utf-8',
      200,
      cors,
    )
  }

  const [{ data: products }, { data: pages }] = await Promise.all([
    supabase
      .from('public_products')
      .select('slug, published_at')
      .eq('store_id', store.store_id)
      .order('published_at', { ascending: false })
      .limit(PRODUCT_LIMIT),
    // Las páginas del CMS salen de la misma función que alimenta el menú de la
    // vitrina: sin `content.cms` devuelve lista vacía y el sitemap se queda con
    // la portada y el catálogo. Se degrada, no se rompe.
    supabase.rpc('store_navigation_for_slug', { p_store_slug: store.slug }),
  ])

  const xml = renderSitemap({
    origin,
    storeSlug: store.slug,
    products: (products ?? []) as { slug: string; published_at: string | null }[],
    pages: (pages ?? []) as { slug: string }[],
  })

  return textResponse(xml, 'application/xml; charset=utf-8', 200, cors)
})
