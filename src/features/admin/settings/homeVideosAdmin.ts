import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { STORE_ASSETS_BUCKET } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import {
  evaluateHomeVideo,
  HOME_VIDEO_RULES,
  sanitizeHomeVideos,
  storedSeconds,
  type HomeVideo,
  type HomeVideoIssue,
} from '@/features/storefront/homeVideos'
import { resolveAssetUrls } from './api'

/**
 * Videos de la portada en el backoffice (2026-10-04 · migración 20261004100000).
 *
 * Su propia lectura y su propio guardado, como «Datos de atención» y el
 * indicador de carga: `store_settings.home_videos` no depende del formulario
 * principal. Cada video se comprueba ANTES de subir (formato, duración, peso);
 * la base vuelve a exigirlo al guardar la lista.
 */
const key = (storeId: string | null) => ['admin', 'home-videos', storeId] as const

export interface AdminHomeVideo extends HomeVideo {
  /** URL firmada para la vista previa en la pantalla. */
  readonly preview: string | null
}

export function useHomeVideos(storeId: string | null) {
  return useQuery({
    queryKey: key(storeId),
    enabled: Boolean(storeId),
    queryFn: async (): Promise<AdminHomeVideo[]> => {
      const client = tryGetSupabaseClient()
      if (!client || !storeId) throw new Error('SIN_BACKEND')
      const { data, error } = await client
        .from('store_settings')
        .select('home_videos')
        .eq('store_id', storeId)
        .maybeSingle()
      if (error) throw error
      const videos = sanitizeHomeVideos((data as { home_videos?: unknown } | null)?.home_videos)
      const urls =
        videos.length > 0
          ? await resolveAssetUrls(
              client,
              videos.map((video) => video.path),
            )
          : {}
      return videos.map((video) => ({
        ...video,
        preview: urls[video.path] ?? null,
      }))
    },
  })
}

export function useSaveHomeVideos(storeId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (videos: readonly HomeVideo[]) => {
      const client = tryGetSupabaseClient()
      if (!client || !storeId) throw new Error('SIN_BACKEND')
      const { error } = await client
        .from('store_settings')
        .update({
          home_videos: videos.map((video) => ({
            path: video.path,
            title: video.title?.trim() ? video.title.trim() : null,
            duration: video.duration,
          })),
        })
        .eq('store_id', storeId)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(storeId) }),
  })
}

/** Lee la duración de un archivo de video en el navegador; `null` si no se puede. */
export function readVideoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const fin = (valor: number | null) => {
      URL.revokeObjectURL(url)
      resolve(valor)
    }
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => fin(Number.isFinite(video.duration) ? video.duration : null)
    video.onerror = () => fin(null)
    video.src = url
  })
}

/** Comprueba un archivo: lo que falla, o los segundos si cumple. */
export async function inspectHomeVideo(file: File): Promise<{ issues: HomeVideoIssue[]; seconds: number | null }> {
  const tipoValido = (HOME_VIDEO_RULES.types as readonly string[]).includes(file.type)
  const seconds = tipoValido ? await readVideoSeconds(file) : null
  return {
    issues: evaluateHomeVideo({ type: file.type, bytes: file.size, seconds }),
    seconds,
  }
}

const EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** Sube un video que YA cumple; devuelve la entrada para la lista. */
export async function uploadHomeVideo(input: {
  organizationId: string
  storeId: string
  file: File
  seconds: number
}): Promise<AdminHomeVideo> {
  const client = tryGetSupabaseClient()
  if (!client) throw new Error('SIN_BACKEND')
  const extension = EXTENSION[input.file.type]
  if (!extension) throw new Error('MIME_NO_ADMITIDO')
  // `content/`: lo que ilustra la tienda, como las fotos de las campañas. Los
  // dos primeros segmentos son los que autorizan (`ebim.can_write_store_object`).
  const path = `${input.organizationId}/${input.storeId}/content/video-${crypto.randomUUID()}.${extension}`
  const { error } = await client.storage.from(STORE_ASSETS_BUCKET).upload(path, input.file, {
    contentType: input.file.type,
    upsert: false,
    cacheControl: '604800',
  })
  if (error) throw error
  const urls = await resolveAssetUrls(client, [path])
  const nombre = input.file.name.replace(/\.[^.]+$/, '').slice(0, HOME_VIDEO_RULES.titleMax)
  return {
    path,
    title: nombre || null,
    duration: storedSeconds(input.seconds),
    preview: urls[path] ?? null,
  }
}
