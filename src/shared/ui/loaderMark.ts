import { createContext, useContext } from 'react'

/**
 * La imagen con la que espera `BrandLoader` (2026-10-02).
 *
 * Sin proveedor —el backoffice—, el isotipo de la suite. La vitrina provee el
 * de la TIENDA cuando el comercio subió uno (Ajustes › Marca › Indicador de
 * carga): en una tienda de marca blanca, la suite girando era lo único que no
 * era del comercio. Contexto y no prop: así las catorce esperas que ya usan
 * `BrandLoader` cambian a la vez, sin tocar ninguna.
 */
export type LoaderAnimation = 'spin' | 'pulse' | 'none'

export interface LoaderMark {
  /** URL ya pintable (firmada); `null` = el de la suite. */
  readonly url: string | null
  readonly animation: LoaderAnimation
}

export const LoaderMarkContext = createContext<LoaderMark | null>(null)

export function useLoaderMark(): LoaderMark | null {
  return useContext(LoaderMarkContext)
}
