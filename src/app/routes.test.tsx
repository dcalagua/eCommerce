import { describe, expect, it } from 'vitest'
import type { RouteObject } from 'react-router-dom'
import { routes } from './routes'

function paths(list: RouteObject[], prefix = ''): string[] {
  return list.flatMap((route) => {
    const base = route.path
      ? `${prefix}/${route.path}`.replace(/\/+/g, '/')
      : prefix || '/'
    const self = route.index ? [prefix || '/'] : [base]
    return route.children ? [...self, ...paths(route.children, base)] : self
  })
}

/** La rama sin `path` es la que agrupa todo lo que exige sesión. */
function protectedArea(): RouteObject | undefined {
  return routes.find((route) => !route.path && Boolean(route.children))
}

describe('rutas base', () => {
  const all = paths(routes)

  it('expone las rutas del backoffice bajo /app', () => {
    expect(all).toEqual(
      expect.arrayContaining(['/app', '/app/products', '/app/orders', '/app/settings']),
    )
  })

  it('expone las rutas del storefront bajo /s/:storeSlug', () => {
    expect(all).toEqual(
      expect.arrayContaining([
        '/s/:storeSlug',
        '/s/:storeSlug/product/:productSlug',
        '/s/:storeSlug/cart',
        '/s/:storeSlug/checkout',
      ]),
    )
  })

  it('tiene raíz, login, recuperación de clave y catch-all', () => {
    expect(all).toEqual(
      expect.arrayContaining(['/', '/login', '/recuperar', '/nueva-clave', '/*']),
    )
  })

  it('el backoffice y el alta de espacio cuelgan del guard de sesión', () => {
    const area = protectedArea()
    const children = area?.children ?? []
    expect(children.map((child) => child.path).sort()).toEqual(['/app', '/onboarding'])
  })

  it('login y recuperación quedan FUERA del guard: si no, no habría forma de entrar', () => {
    const area = protectedArea()
    const guarded = paths(area?.children ?? [])
    expect(guarded).not.toContain('/login')
    expect(guarded).not.toContain('/recuperar')
    expect(guarded).not.toContain('/nueva-clave')
  })

  it('el storefront público no cuelga del guard de sesión', () => {
    const area = protectedArea()
    const guarded = paths(area?.children ?? [])
    expect(guarded.some((path) => path.startsWith('/s/'))).toBe(false)
  })

  it('separa las áreas: ninguna ruta del storefront cuelga del backoffice', () => {
    const admin = protectedArea()?.children?.find((route) => route.path === '/app')
    const storefront = routes.find((route) => route.path === '/s/:storeSlug')
    expect(admin?.children?.length).toBe(4)
    expect(storefront?.children?.length).toBe(4)
    expect(paths(admin?.children ?? [], '/app')).not.toContain('/app/cart')
  })
})
