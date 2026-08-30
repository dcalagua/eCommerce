/**
 * El redirector abierto de la barra invertida, y sus vecinos (P16-SaaS).
 *
 * Este archivo existe por un fallo CONCRETO, no por completitud: hasta P16 las
 * tres capas de validación de enlaces del proyecto —esta, la del borde del
 * storefront y el CHECK de Postgres— compartían la misma condición
 * `startsWith('/') && !startsWith('//')`, y esa condición acepta `/\evil.com`,
 * que el navegador resuelve a `https://evil.com/`.
 *
 * Los casos de abajo son el ataque, no una tabla de verdad: cada uno es una
 * cadena que se guardaba en `content_blocks.cta_href` sin que nada se quejara.
 */
import { describe, expect, it } from 'vitest'
import {
  internalPathOr,
  isInternalPath,
  isSafeExternalUrl,
  isSafeHref,
  safeExternalUrl,
  safeHref,
} from './href'

const B = String.fromCharCode(92)
const TAB = String.fromCharCode(9)
const NUL = String.fromCharCode(0)

/**
 * La prueba de que el ataque es real y no una precaución teórica: `URL` es el
 * mismo analizador que usa el navegador para resolver un `href`. Si algún día
 * el estándar dejara de tratar la barra invertida como barra, este test se
 * pondría rojo y el guard podría relajarse — con evidencia, no por opinión.
 */
describe('el navegador trata la barra invertida como barra', () => {
  const base = 'https://tienda.ejemplo.com'

  it.each([
    [`/${B}evil.com`, 'https://evil.com/'],
    [`/${B}/evil.com`, 'https://evil.com/'],
    [`/${B}${B}evil.com`, 'https://evil.com/'],
    ['//evil.com', 'https://evil.com/'],
  ])('%s se resuelve a %s — sale del dominio', (input, expected) => {
    expect(new URL(input, base).href).toBe(expected)
  })

  it('una ruta interna de verdad se queda dentro', () => {
    expect(new URL('/s/tienda/cart', base).href).toBe(`${base}/s/tienda/cart`)
  })
})

describe('isInternalPath', () => {
  it.each([
    `/${B}evil.com`,
    `/${B}/evil.com`,
    `/${B}${B}evil.com`,
    '//evil.com',
    `/ruta${B}con-barra-invertida`,
  ])('rechaza %s', (value) => {
    expect(isInternalPath(value)).toBe(false)
  })

  it.each(['/', '/app', '/s/tienda/product/silla', '/app/orders?tab=open#detalle'])(
    'acepta %s',
    (value) => {
      expect(isInternalPath(value)).toBe(true)
    },
  )

  it('rechaza lo que no es una cadena', () => {
    expect(isInternalPath(null)).toBe(false)
    expect(isInternalPath(undefined)).toBe(false)
    expect(isInternalPath(42)).toBe(false)
    expect(isInternalPath({ toString: () => '/app' })).toBe(false)
  })

  it('rechaza una URL absoluta aunque sea https: interna significa interna', () => {
    expect(isInternalPath('https://tienda.ejemplo.com/app')).toBe(false)
  })
})

describe('isSafeHref', () => {
  it.each(['https://proveedor.com/catalogo', '/s/tienda', 'mailto:hola@tienda.com', 'tel:+51999888777'])(
    'acepta %s',
    (value) => {
      expect(isSafeHref(value)).toBe(true)
    },
  )

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'http://sin-tls.com',
    '//evil.com',
    `/${B}evil.com`,
    'ftp://archivo',
  ])('rechaza %s', (value) => {
    expect(isSafeHref(value)).toBe(false)
  })

  /**
   * Los caracteres de control se ELIMINAN al analizar la URL, así que sirven
   * para partir por la mitad un esquema que la lista negra sí reconocería. Es
   * el motivo de que el guard los rechace antes de mirar el prefijo.
   */
  it('rechaza un esquema partido con un carácter de control', () => {
    expect(isSafeHref(`java${TAB}script:alert(1)`)).toBe(false)
    expect(isSafeHref(`https://ok.com/a${NUL}b`)).toBe(false)
  })

  it('rechaza un espacio en cualquier posición', () => {
    expect(isSafeHref(' https://ok.com')).toBe(false)
    expect(isSafeHref('https://ok.com/a b')).toBe(false)
  })

  it('rechaza la cadena vacía y lo que pase de 2048 caracteres', () => {
    expect(isSafeHref('')).toBe(false)
    expect(isSafeHref(`https://ok.com/${'a'.repeat(2048)}`)).toBe(false)
  })

  it('safeHref devuelve null en vez del valor cuando no vale', () => {
    expect(safeHref('https://ok.com')).toBe('https://ok.com')
    expect(safeHref(`/${B}evil.com`)).toBeNull()
    expect(safeHref(null)).toBeNull()
  })
})

describe('isSafeExternalUrl — la referencia a un sistema de terceros', () => {
  it('admite http porque un ERP en red interna no siempre tiene TLS', () => {
    expect(isSafeExternalUrl('http://erp.interno/pedido/1')).toBe(true)
    expect(isSafeExternalUrl('https://erp.saas.com/pedido/1')).toBe(true)
  })

  it('NO admite una ruta interna: una referencia externa a este mismo sitio engaña', () => {
    expect(isSafeExternalUrl('/app/orders')).toBe(false)
  })

  it.each(['javascript:alert(1)', `http://ok.com/${B}..`, 'mailto:a@b.com', ''])(
    'rechaza %s',
    (value) => {
      expect(isSafeExternalUrl(value)).toBe(false)
    },
  )

  it('safeExternalUrl devuelve null cuando no vale', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('https://ok.com')).toBe('https://ok.com')
  })
})

describe('internalPathOr — la vuelta después del login', () => {
  it('devuelve el destino cuando de verdad es interno', () => {
    expect(internalPathOr('/app/orders', '/app')).toBe('/app/orders')
  })

  it('cae al suelo cuando el destino sale del dominio', () => {
    expect(internalPathOr(`/${B}evil.com`, '/app')).toBe('/app')
    expect(internalPathOr('//evil.com', '/app')).toBe('/app')
    expect(internalPathOr('https://evil.com', '/app')).toBe('/app')
  })

  it('cae al suelo cuando no hay destino', () => {
    expect(internalPathOr(undefined, '/app')).toBe('/app')
    expect(internalPathOr(null, '/app')).toBe('/app')
  })
})
