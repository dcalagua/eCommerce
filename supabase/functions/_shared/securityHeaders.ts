/**
 * Cabeceras de seguridad de las respuestas del BORDE (P16-SaaS).
 *
 * Una Edge Function no devuelve documentos, devuelve JSON o texto. Aun así
 * necesita cuatro cosas, y las cuatro por una razón concreta:
 *
 *  - **`X-Content-Type-Options: nosniff`.** Sin ella, un navegador puede decidir
 *    que la respuesta "parece" HTML y tratarla como tal. Estas funciones
 *    devuelven dentro del JSON datos que escribe un tercero —el nombre de un
 *    producto, el error de una pasarela—, así que la adivinación de tipo es
 *    exactamente el camino de un XSS reflejado.
 *  - **`Cache-Control: no-store`.** Casi todas estas respuestas son de UN tenant
 *    y de UNA sesión: el contexto de plataforma, el pedido, la cola de
 *    integraciones. Un intermediario que las guarde puede servírselas a otro.
 *    Las que sí son cacheables (el sitemap público) ponen la suya y no usan
 *    esto.
 *  - **`Referrer-Policy: no-referrer`.** Nada de lo que hace una función de
 *    borde necesita saber de dónde venía la petición, y la ruta de origen
 *    lleva el slug de la tienda y, en `/order/`, el token del pedido.
 *  - **`X-Frame-Options` + `frame-ancestors 'none'`.** Una respuesta de error
 *    que alguien enmarque sigue siendo enmarcable. Cuesta dos líneas.
 *
 * `Content-Security-Policy` va con `default-src 'none'` y `sandbox`: una
 * respuesta que nunca es un documento no necesita poder cargar nada. Si algún
 * día una de estas funciones devuelve HTML, esta política lo dejará en blanco
 * — y eso es lo que se quiere que pase antes de que lo vea un usuario.
 */
export const EDGE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'Cache-Control': 'no-store',
})

/**
 * Las mismas menos `Cache-Control`, para las respuestas que SÍ se pueden
 * cachear y traen la suya (`storefront-seo`). Se expone como función y no como
 * segunda constante para que no puedan separarse al editar una sola.
 */
export function edgeSecurityHeaders(options: { cacheable?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = { ...EDGE_SECURITY_HEADERS }
  if (options.cacheable) delete headers['Cache-Control']
  return headers
}
