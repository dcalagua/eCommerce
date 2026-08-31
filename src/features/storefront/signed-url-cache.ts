/**
 * Caché de URLs firmadas. Lo que hace que una foto ya vista no se vuelva a
 * descargar.
 *
 * ## El problema que resuelve
 *
 * El bucket es privado, así que cada foto se sirve por una URL firmada. Y una
 * URL firmada es distinta CADA VEZ que se firma: mismo objeto, token nuevo,
 * y para el navegador eso es otro recurso. La caché del navegador se indexa por
 * URL, de modo que firmar otra vez la misma foto equivale a decirle «descárgala
 * de nuevo». Con las firmas de una hora que hacía la vitrina, volver al
 * catálogo, entrar en una ficha y salir bastaba para bajar tres veces los
 * mismos bytes: no es un problema de caché del navegador, es que le estábamos
 * cambiando la clave.
 *
 * Aquí se guarda `ruta → { url, expiresAt }` en `localStorage`. Mientras la
 * firma siga viva se devuelve **la misma URL**, y entonces sí: el navegador la
 * sirve de su caché de disco, al instante y sin red. Solo se firma lo que falta
 * o lo que está por caducar, y en una sola llamada para todo el lote.
 *
 * ## Los dos plazos, y por qué no son el mismo
 *
 * - `SIGN_TTL_SECONDS` (6 h): cuánto vale el token. Largo para que una sesión de
 *   compra entera reutilice la misma URL; no eterno, porque quien copie el
 *   enlace de una foto está compartiendo un objeto de un bucket privado.
 * - `RENEW_MARGIN_MS` (30 min): se re-firma antes de caducar. Sin margen, una
 *   foto abierta justo en el límite se queda a medio cargar con un 400, que es
 *   el fallo más difícil de reproducir de todos.
 *
 * ## Qué NO hace
 *
 * No guarda los bytes de la imagen: eso ya lo hace el navegador mucho mejor —y
 * `localStorage` tiene 5 MB, que no da ni para dos fotos—. Aquí solo vive la
 * URL, que es la llave de esa caché.
 *
 * Cuando `localStorage` no está disponible (modo privado, cookies bloqueadas,
 * SSR) todo sigue funcionando: se firma cada vez, como antes. La caché es una
 * mejora, nunca un requisito.
 */

const PREFIX = 'ebim.signed.'
/** Vida del token. La firma se pide con este mismo valor. */
export const SIGN_TTL_SECONDS = 6 * 60 * 60
/** Se re-firma con esta antelación para que nada caduque a medio cargar. */
const RENEW_MARGIN_MS = 30 * 60 * 1000

type Entry = { url: string; expiresAt: number }
type Store = Record<string, Entry>

function read(bucket: string): Store {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + bucket)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {}
  } catch {
    // Un JSON corrupto o un almacenamiento cerrado no pueden dejar sin fotos a
    // la tienda: se sigue como si no hubiera caché.
    return {}
  }
}

function write(bucket: string, store: Store): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + bucket, JSON.stringify(store))
  } catch {
    // Cuota llena o almacenamiento bloqueado: la caché es opcional.
  }
}

/**
 * Devuelve la URL de cada ruta, firmando SOLO lo que no está en caché.
 *
 * `sign` es quien sabe hablar con Storage —el cliente de la vitrina o el del
 * backoffice, cada uno con su sesión y su policy—: este módulo no elige bucket
 * ni credencial, solo decide qué hace falta pedir.
 *
 * Si la firma falla, se devuelve lo que hubiera en caché en vez de vaciar el
 * mapa: media galería es mejor que ninguna, y es exactamente lo que ya hacía
 * `signPaths` cuando la llamada se caía.
 */
export async function signedUrls(
  bucket: string,
  paths: string[],
  sign: (missing: string[]) => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))]
  if (unique.length === 0) return {}

  const now = Date.now()
  const store = read(bucket)
  const result: Record<string, string> = {}
  const missing: string[] = []

  for (const path of unique) {
    const entry = store[path]
    if (entry && entry.expiresAt - RENEW_MARGIN_MS > now) result[path] = entry.url
    else missing.push(path)
  }

  if (missing.length === 0) return result

  const fresh = await sign(missing)
  const expiresAt = now + SIGN_TTL_SECONDS * 1000
  for (const [path, url] of Object.entries(fresh)) {
    result[path] = url
    store[path] = { url, expiresAt }
  }

  // Poda: sin esto el mapa crece con cada foto que se haya visto alguna vez
  // hasta reventar la cuota de `localStorage`.
  for (const [path, entry] of Object.entries(store)) {
    if (entry.expiresAt <= now) delete store[path]
  }
  write(bucket, store)

  return result
}

/** Para las pruebas y para el cierre de sesión: deja el bucket sin caché. */
export function clearSignedUrls(bucket: string): void {
  try {
    globalThis.localStorage?.removeItem(PREFIX + bucket)
  } catch {
    /* nada que limpiar si no hay almacenamiento */
  }
}
