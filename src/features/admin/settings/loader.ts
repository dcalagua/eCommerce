import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { STORE_ASSETS_BUCKET } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import type { LoaderAnimation } from '@/shared/ui/loaderMark'
import { resolveAssetUrls } from './api'
import { buildAssetPath } from './types'

/**
 * Indicador de carga propio de la tienda (2026-10-02 · migración 20261002120700).
 *
 * Dos columnas de `store_settings` con su propio guardado, como «Datos de
 * atención»: el formulario principal de Ajustes ya es grande y esto no depende
 * de él. La imagen se comprueba ANTES de subir (`loaderImage.ts`) y la base
 * vuelve a exigir ruta propia y PNG/WebP aunque alguien se salte la pantalla.
 */
export interface StoreLoader {
  readonly loader_url: string | null
  readonly loader_animation: LoaderAnimation
}

const rowSchema = z.object({
  loader_url: z.string().nullable().catch(null),
  loader_animation: z.enum(['spin', 'pulse', 'none']).catch('spin'),
})

const key = (storeId: string | null) => ['admin', 'store-loader', storeId] as const

export function useStoreLoader(storeId: string | null) {
  return useQuery({
    queryKey: key(storeId),
    enabled: Boolean(storeId),
    queryFn: async (): Promise<StoreLoader & { preview: string | null }> => {
      const client = tryGetSupabaseClient()
      if (!client || !storeId) throw new Error('SIN_BACKEND')
      const { data, error } = await client
        .from('store_settings')
        .select('loader_url, loader_animation')
        .eq('store_id', storeId)
        .maybeSingle()
      if (error) throw error
      const row = rowSchema.parse(data ?? {})
      const urls = row.loader_url ? await resolveAssetUrls(client, [row.loader_url]) : {}
      return { ...row, preview: row.loader_url ? (urls[row.loader_url] ?? null) : null }
    },
  })
}

/** Sube la imagen TAL CUAL (sin reducir: ya cumple los requisitos) y devuelve ruta y vista previa. */
export async function uploadLoaderImage(input: {
  organizationId: string
  storeId: string
  file: File
}): Promise<{ path: string; preview: string | null }> {
  const client = tryGetSupabaseClient()
  if (!client) throw new Error('SIN_BACKEND')
  const path = buildAssetPath({ ...input, kind: 'loader', mimeType: input.file.type })
  const { error } = await client.storage.from(STORE_ASSETS_BUCKET).upload(path, input.file, {
    contentType: input.file.type,
    upsert: false,
    cacheControl: '604800',
  })
  if (error) throw error
  const urls = await resolveAssetUrls(client, [path])
  return { path, preview: urls[path] ?? null }
}

export function useSaveStoreLoader(storeId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: StoreLoader) => {
      const client = tryGetSupabaseClient()
      if (!client || !storeId) throw new Error('SIN_BACKEND')
      const { error } = await client
        .from('store_settings')
        .update({ loader_url: values.loader_url, loader_animation: values.loader_animation })
        .eq('store_id', storeId)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(storeId) }),
  })
}
