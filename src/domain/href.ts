/**
 * Enlaces que vienen de datos, no del código (P16-SaaS).
 *
 * La autoridad sigue siendo la base: `ebim.is_safe_href` es un CHECK y un CHECK
 * no se puede desplegar a medias. Esto es la segunda capa, y existe porque el
 * SUMIDERO está aquí: quien resuelve el enlace es el navegador, no Postgres, y
 * el navegador no piensa como el `like '/%'` de un CHECK.
 *
 * ## El fallo que da nombre al archivo
 *
 * En el analizador de URL de WHATWG, para los esquemas especiales (`http` y
 * `https`) **la barra invertida es una barra**. Medido:
 *
 * ```
 * new URL('/\evil.com', 'https://tienda.com').href  ->  https://evil.com/
 * ```
 *
 * Una cadena que empieza por `/` y no por `//` parece una ruta interna y no lo
 * es: sale del dominio. Con eso, quien pueda escribir contenido del CMS deja
 * publicado en la vitrina un botón que lleva al comprador a otro sitio con la
 * marca del comercio todavía en la barra de direcciones. Es un redirector
 * abierto ALMACENADO, y para eso sirve el phishing.
 *
 * No hace falta React Router para llegar: un `<a href>` normal lo resuelve
 * igual. Por eso el guard va aquí abajo, en el dato, y no en el componente que
 * lo pinta.
 *
 * ## Por qué lista blanca
 *
 * `javascript:` es el que todo el mundo recuerda; `vbscript:`, `data:text/html`
 * y el protocolo-relativo `//otro-dominio` hacen daño igual. Con lista blanca,
 * el esquema que nadie ha pensado todavía cae del lado de "no".
 *
 * Y los caracteres de control se **eliminan** del medio de un esquema al
 * analizar la URL: `java\tscript:alert(1)` es `javascript:alert(1)` para el
 * navegador. Se rechazan antes de mirar el prefijo.
 */

/** Longitud máxima, la misma que el CHECK de la base. */
const MAX_LENGTH = 2048

/**
 * Espacios y caracteres de control: los dos se pierden o se normalizan al
 * analizar la URL. Se escriben con escapes `\u` a proposito -- un tabulador
 * literal dentro de una clase de caracteres es invisible en la revision, y es
 * exactamente el caracter del que va este guard.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007F]/

const BACKSLASH = '\\'
const EXECUTABLE_SCHEME = /javascript:|vbscript:|data:/i

function isRenderable(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length < 1 || value.length > MAX_LENGTH) return false
  if (CONTROL_OR_SPACE.test(value)) return false
  if (value.includes(BACKSLASH)) return false
  return !EXECUTABLE_SCHEME.test(value)
}

/**
 * Ruta INTERNA: la que se le puede pasar al router sin salir del sitio.
 *
 * Espejo exacto de la rama `like '/%' and not like '//%'` de
 * `ebim.is_safe_href`, con las dos condiciones que a aquella le faltaban.
 */
export function isInternalPath(value: unknown): value is string {
  if (!isRenderable(value)) return false
  return value.startsWith('/') && !value.startsWith('//')
}

/**
 * Espejo de `ebim.is_safe_href`: `https`, ruta interna, `mailto:` o `tel:`.
 * Lo que escribe el tenant en el CMS pasa por aquí antes de llegar al DOM.
 */
export function isSafeHref(value: unknown): value is string {
  if (!isRenderable(value)) return false
  return (
    value.startsWith('https://') ||
    (value.startsWith('/') && !value.startsWith('//')) ||
    value.startsWith('mailto:') ||
    value.startsWith('tel:')
  )
}

/**
 * Referencia a un sistema de terceros del backoffice (`order_external_refs`).
 * Admite `http://` además de `https://` porque un ERP en red interna no siempre
 * tiene TLS —el CHECK de la base ya lo admite—, y NO admite ruta interna: una
 * referencia "externa" que apunte a este mismo sitio es un enlace engañoso.
 */
export function isSafeExternalUrl(value: unknown): value is string {
  if (!isRenderable(value)) return false
  return value.startsWith('https://') || value.startsWith('http://')
}

/** El enlace, o `null` si no es publicable. Un botón sin destino no se pinta. */
export function safeHref(value: unknown): string | null {
  return isSafeHref(value) ? value : null
}

/** La URL externa, o `null`. */
export function safeExternalUrl(value: unknown): string | null {
  return isSafeExternalUrl(value) ? value : null
}

/**
 * Destino de una navegación interna, con suelo. Se usa donde NO hay opción de
 * no navegar (la vuelta después del login): si el destino no vale, se va al
 * `fallback` en vez de a donde diga el dato.
 */
export function internalPathOr(value: unknown, fallback: string): string {
  return isInternalPath(value) ? value : fallback
}
