import { useEffect, useMemo, useState } from 'react'

/** El mismo tamaño con el que el servidor pagina Pedidos, Productos y Clientes. */
export const ROWS_PER_PAGE = 25

/**
 * Paginación de una lista que YA está en memoria.
 *
 * **Esto no acelera nada, y no pretende hacerlo.** Estas pantallas se traen sus
 * filas de una vez y este hook solo corta lo que se enseña: sirve para poder
 * leer una tabla de ochenta filas, no para que la consulta pese menos.
 *
 * Donde el volumen crece sin techo con el negocio del cliente —pedidos,
 * productos, clientes— la paginación es del SERVIDOR (`range()` + `count`), y
 * ahí este hook no se usa. Confundir las dos cosas es lo que hace que un día
 * una consulta deje de volver, así que conviene que se distingan a simple vista.
 *
 * Cuando la lista encoge —alguien escribe en el buscador— la página actual
 * puede dejar de existir, y quedarse en ella enseña una tabla vacía que se lee
 * como «no hay nada» cuando sí lo hay. Por eso el efecto la devuelve al rango.
 */
export function usePagedRows<T>(rows: readonly T[], pageSize: number = ROWS_PER_PAGE) {
  const [page, setPage] = useState(0)
  const total = rows.length
  const lastPage = Math.max(Math.ceil(total / pageSize) - 1, 0)

  useEffect(() => {
    if (page > lastPage) setPage(lastPage)
  }, [page, lastPage])

  const visible = useMemo(
    () => rows.slice(page * pageSize, page * pageSize + pageSize),
    [rows, page, pageSize],
  )

  return { rows: visible, page, setPage, pageSize, total }
}
