import { useQuery } from '@tanstack/react-query'
import { fetchStoreBranding } from './api'
import type { TenantBranding } from './types'

export const storeBrandingKey = (slug: string) => ['store-branding', slug] as const

/** Resuelve la marca de la tienda pública a partir del slug de la URL. */
export function useStoreBranding(slug: string | undefined) {
  return useQuery<TenantBranding | null>({
    queryKey: storeBrandingKey(slug ?? ''),
    queryFn: () => fetchStoreBranding(slug as string),
    enabled: Boolean(slug),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
