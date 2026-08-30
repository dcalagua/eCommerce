// @vitest-environment node
/**
 * P16-SaaS · Las cabeceras de seguridad del BORDE.
 *
 * Lo que se comprueba no es la lista de cabeceras —eso sería un test que copia
 * la constante—, sino las dos cosas que de verdad se rompen solas:
 *
 *  1. Que viajan en **todas** las respuestas de `serveJson`, incluidas la del
 *     preflight y la de error. Una cabecera de seguridad presente solo en el
 *     camino feliz protege justo la respuesta que menos falta hace.
 *  2. Que **ninguna función del borde construye sus cabeceras a mano** sin
 *     pasar por el módulo compartido. Es la comprobación estructural: una
 *     función nueva que se olvide se separa aquí y no en una auditoría.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EDGE_SECURITY_HEADERS, edgeSecurityHeaders } from '../functions/_shared/securityHeaders.ts'
import { serveJson } from '../functions/_shared/http.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = join(HERE, '..', 'functions')

const post = (body: unknown = {}) =>
  new Request('https://borde.test/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://tienda.test' },
    body: JSON.stringify(body),
  })

describe('edgeSecurityHeaders', () => {
  it('trae las cinco, y `no-store` entre ellas', () => {
    expect(Object.keys(EDGE_SECURITY_HEADERS).sort()).toEqual([
      'Cache-Control',
      'Content-Security-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ])
    expect(EDGE_SECURITY_HEADERS['Cache-Control']).toBe('no-store')
  })

  /**
   * Una respuesta que nunca es un documento no necesita poder cargar nada. Si
   * algún día una de estas funciones devolviera HTML, esta política lo dejaría
   * en blanco — y eso es lo que se quiere que pase antes de que lo vea nadie.
   */
  it('la CSP del borde no permite cargar absolutamente nada', () => {
    const csp = EDGE_SECURITY_HEADERS['Content-Security-Policy'] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain('sandbox')
  })

  it('la variante cacheable renuncia SOLO a `Cache-Control`', () => {
    const cacheable = edgeSecurityHeaders({ cacheable: true })
    expect(cacheable['Cache-Control']).toBeUndefined()
    expect(Object.keys(cacheable).sort()).toEqual([
      'Content-Security-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ])
  })

  it('devolver una copia: nadie puede mutar la constante compartida', () => {
    const copia = edgeSecurityHeaders()
    copia['X-Content-Type-Options'] = 'roto'
    expect(EDGE_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff')
  })

  it('el referente no sale nunca de una función de borde', () => {
    expect(EDGE_SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer')
  })
})

describe('serveJson las pone SIEMPRE', () => {
  const handler = serveJson({ service: 'prueba', sinks: [] }, async () => ({
    status: 200,
    body: { ok: true },
  }))

  async function headersOf(request: Request): Promise<Headers> {
    return (await handler(request)).headers
  }

  it('en la respuesta correcta', async () => {
    const headers = await headersOf(post())
    for (const [name, value] of Object.entries(EDGE_SECURITY_HEADERS)) {
      expect(`${name}: ${headers.get(name)}`).toBe(`${name}: ${value}`)
    }
  })

  it('en el preflight, que no pasa por el handler', async () => {
    const response = await handler(
      new Request('https://borde.test/x', {
        method: 'OPTIONS',
        headers: { origin: 'https://tienda.test' },
      }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('en la respuesta de ERROR, que es la que suele quedarse sin ellas', async () => {
    const response = await handler(
      new Request('https://borde.test/x', { method: 'GET', headers: { origin: 'https://x.test' } }),
    )
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
  })

  it('no pisa el `Content-Type` de la respuesta JSON', async () => {
    const headers = await headersOf(post())
    expect(headers.get('Content-Type')).toBe('application/json; charset=utf-8')
  })

  /**
   * Con lista blanca de orígenes y un origen que no está, la respuesta sale sin
   * `Access-Control-Allow-Origin` — y aun así con las de seguridad puestas.
   */
  it('conviven con el CORS restringido del backoffice', async () => {
    const restringido = serveJson(
      { service: 'prueba', sinks: [], allowedOrigins: ['https://admin.test'] },
      async () => ({ status: 200, body: {} }),
    )
    const response = await restringido(post())
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })
})

describe('ninguna función del borde se las salta', () => {
  const entries = readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)

  it('hay funciones que revisar', () => {
    expect(entries.length).toBeGreaterThan(5)
  })

  /**
   * Dos caminos válidos y ninguno más: o la función usa `serveJson` —que las
   * pone por dentro— o importa `edgeSecurityHeaders` y las pone ella. Una
   * tercera forma sería una función sirviendo respuestas sin cabeceras.
   */
  it.each(
    readdirSync(FUNCTIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name),
  )('%s pasa por el módulo compartido', (name) => {
    const code = readFileSync(join(FUNCTIONS, name, 'index.ts'), 'utf8')
    const viaServeJson = code.includes('serveJson')
    const viaModulo = code.includes('edgeSecurityHeaders')
    expect(`${name}: ${viaServeJson || viaModulo}`).toBe(`${name}: true`)
  })
})
