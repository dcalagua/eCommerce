import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  fetchStoreSettings,
  saveStoreSettings,
  signOwnAssets,
  uploadStoreAsset,
  type SaveSettingsInput,
} from './api'
import type { StoreSettings } from './types'

export const storeSettingsKey = (storeId: string) => ['store-settings', storeId] as const
export const assetUrlsKey = (values: Array<string | null>) =>
  ['store-settings', 'assets', values] as const

export function useStoreSettings(storeId: string | null): UseQueryResult<StoreSettings | null> {
  return useQuery({
    queryKey: storeSettingsKey(storeId ?? ''),
    queryFn: () => fetchStoreSettings(storeId),
    enabled: Boolean(storeId),
  })
}

/** Vistas previas del backoffice: el bucket es privado, así que se firman. */
export function useAssetUrls(values: Array<string | null>): Record<string, string> {
  const present = values.filter((value): value is string => Boolean(value))
  const { data } = useQuery({
    queryKey: assetUrlsKey(present),
    queryFn: () => signOwnAssets(present),
    enabled: present.length > 0,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })
  return data ?? {}
}

/**
 * Guardar.
 *
 * Al terminar se invalida la configuración y el espacio de trabajo: el nombre
 * comercial vive en `stores` y lo lee el `TenantProvider`, así que sin esto el
 * sidebar seguiría enseñando el nombre viejo hasta recargar.
 */
export function useSaveStoreSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SaveSettingsInput) => saveStoreSettings(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['store-settings'] })
      void queryClient.invalidateQueries({ queryKey: ['workspace'] })
    },
  })
}

export function useUploadStoreAsset() {
  return useMutation({ mutationFn: uploadStoreAsset })
}
