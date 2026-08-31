import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ROWS_PER_PAGE, usePagedRows } from './usePagedRows'

const rows = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('usePagedRows', () => {
  it('corta la lista al tamaño de página', () => {
    const { result } = renderHook(() => usePagedRows(rows(60), 25))

    expect(result.current.rows).toHaveLength(25)
    expect(result.current.rows[0]).toBe(0)
    expect(result.current.total).toBe(60)
  })

  it('la última página lleva solo el resto, no se rellena', () => {
    const { result } = renderHook(() => usePagedRows(rows(60), 25))

    act(() => result.current.setPage(2))

    expect(result.current.rows).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59])
  })

  it('el total es el de la lista COMPLETA, no el de la página', () => {
    // Es lo que lee el paginador para decir cuántas páginas hay. Si aquí
    // devolviéramos las filas visibles, siempre diría «1 de 1».
    const { result } = renderHook(() => usePagedRows(rows(60), 25))

    act(() => result.current.setPage(1))

    expect(result.current.total).toBe(60)
    expect(result.current.rows).toHaveLength(25)
  })

  it('si la lista encoge, vuelve a la última página que existe', () => {
    // El caso real: alguien está en la página 3 y escribe en el buscador. Sin
    // esto se queda mirando una tabla vacía que se lee como «no hay nada»
    // cuando sí lo hay, y el único arreglo es adivinar que hay que retroceder.
    const { result, rerender } = renderHook(({ list }) => usePagedRows(list, 25), {
      initialProps: { list: rows(80) },
    })

    act(() => result.current.setPage(3))
    expect(result.current.page).toBe(3)

    rerender({ list: rows(10) })

    expect(result.current.page).toBe(0)
    expect(result.current.rows).toHaveLength(10)
  })

  it('una lista vacía no deja la página en un número imposible', () => {
    const { result, rerender } = renderHook(({ list }) => usePagedRows(list, 25), {
      initialProps: { list: rows(80) },
    })

    act(() => result.current.setPage(2))
    rerender({ list: rows(0) })

    expect(result.current.page).toBe(0)
    expect(result.current.total).toBe(0)
    expect(result.current.rows).toEqual([])
  })

  it('el tamaño por defecto es el mismo con el que pagina el servidor', () => {
    // Pedidos, Productos y Clientes paginan en el servidor de 25 en 25. Que
    // aquí fuera otro número haría que la misma tabla se leyera distinto según
    // quién la pagine, sin ninguna razón visible para quien la usa.
    const { result } = renderHook(() => usePagedRows(rows(60)))

    expect(ROWS_PER_PAGE).toBe(25)
    expect(result.current.rows).toHaveLength(25)
  })
})
