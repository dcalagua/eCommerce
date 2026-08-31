import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionContext } from '@/features/auth/session-context'
import {
  fetchServerFavorites,
  mergeLocalFavorites,
  readLocalFavorites,
  toggleLocalFavorite,
  toggleServerFavorite,
} from './favorites'

/**
 * Los favoritos de la tienda abierta, vengan de donde vengan.
 *
 * El componente que pinta un corazón no debería saber si hay sesión: pregunta
 * «¿está guardado?» y dice «alterna». Aquí se decide el almacén —servidor con
 * sesión, navegador sin ella— y se resuelve la subida de lo local al entrar.
 *
 * ## Optimista, y con vuelta atrás
 *
 * El corazón se pinta ANTES de que el servidor conteste. Un corazón que tarda
 * 300 ms en encenderse se pulsa dos veces, y dos pulsaciones sobre un
 * interruptor son ninguna. Si la llamada falla, se revierte: es mejor un
 * corazón que se apaga solo que una lista que dice guardar cosas que no guardó.
 *
 * No usa React Query a propósito: esto no es dato de servidor que se comparta
 * entre pantallas ni que caduque, es un conjunto pequeño que se lee una vez por
 * tienda y se muta con una pulsación. Un `useState` con su efecto de carga es
 * menos maquinaria para exactamente el mismo resultado.
 */
export function useFavorites(storeId: string | null) {
  const { status } = useSessionContext()
  const authenticated = status === 'authenticated'
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())
  const [ready, setReady] = useState(false)
  // Evita que una carga vieja pise a una nueva cuando se cambia de tienda o se
  // inicia sesion mientras la anterior estaba en vuelo.
  const load = useRef(0)

  useEffect(() => {
    if (!storeId) {
      setIds(new Set())
      setReady(true)
      return
    }

    const token = ++load.current
    setReady(false)

    const run = authenticated
      ? // Al entrar, lo del navegador sube y el rincon local queda vacio.
        mergeLocalFavorites(storeId)
      : Promise.resolve(readLocalFavorites(storeId))

    void run
      .then((list) => {
        if (load.current !== token) return
        setIds(new Set(list))
      })
      .catch(() => {
        if (load.current !== token) return
        setIds(new Set())
      })
      .finally(() => {
        if (load.current === token) setReady(true)
      })
  }, [storeId, authenticated])

  const toggle = useCallback(
    async (productId: string) => {
      if (!storeId) return

      const saved = ids.has(productId)
      const next = new Set(ids)
      if (saved) next.delete(productId)
      else next.add(productId)
      setIds(next)

      if (!authenticated) {
        toggleLocalFavorite(storeId, productId)
        return
      }

      try {
        await toggleServerFavorite(productId)
      } catch {
        // Vuelta atras: el corazon no puede decir que guardo algo que el
        // servidor rechazo.
        const rollback = await fetchServerFavorites(storeId)
        setIds(new Set(rollback))
      }
    },
    [authenticated, ids, storeId],
  )

  return useMemo(
    () => ({
      /** `true` si el producto está guardado. */
      isFavorite: (productId: string) => ids.has(productId),
      /** Alterna y persiste donde corresponda. */
      toggle,
      /** Los ids guardados, para pintar una lista. */
      ids,
      /** `false` mientras se cargan: evita el parpadeo del corazón vacío. */
      ready,
      /** Con sesión viajan con la persona; sin ella, solo en este navegador. */
      persisted: authenticated,
    }),
    [authenticated, ids, ready, toggle],
  )
}
