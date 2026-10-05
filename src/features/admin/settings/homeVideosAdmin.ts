import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ADMIN_PRODUCT_MASTERS_VIEW, STORE_ASSETS_BUCKET } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import {
  evaluateHomeVideo,
  evaluatePromoVideo,
  HOME_VIDEO_RULES,
  PROMO_VIDEO_RULES,
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
            product_id: video.product_id ?? null,
          })),
        })
        .eq('store_id', storeId)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(storeId) }),
  })
}

interface VideoFacts {
  readonly seconds: number | null
  readonly width: number | null
  readonly height: number | null
}

/** Duración y medidas de un archivo de video, leídas en el navegador. */
export function readVideoFacts(file: File): Promise<VideoFacts> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const fin = (valor: VideoFacts) => {
      URL.revokeObjectURL(url)
      resolve(valor)
    }
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () =>
      fin({
        seconds: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      })
    video.onerror = () => fin({ seconds: null, width: null, height: null })
    video.src = url
  })
}

/** Comprueba un archivo: lo que falla, o los segundos si cumple. */
export async function inspectHomeVideo(file: File): Promise<{ issues: HomeVideoIssue[]; seconds: number | null }> {
  const tipoValido = (HOME_VIDEO_RULES.types as readonly string[]).includes(file.type)
  const facts = tipoValido ? await readVideoFacts(file) : { seconds: null, width: null, height: null }
  return {
    issues: evaluateHomeVideo({ type: file.type, bytes: file.size, ...facts }),
    seconds: facts.seconds,
  }
}

/** Un producto de la sociedad para enlazar a un video. */
export interface VideoProductOption {
  readonly id: string
  readonly name: string
  readonly sku: string | null
}

/**
 * Busca productos de la SOCIEDAD por nombre o SKU (2026-10-04). El
 * `company_id` va en la consulta como alcance de la pantalla —la RLS ya limita
 * al tenant del JWT—, igual que la carga masiva de fotos.
 */
export function useVideoProductSearch(companyId: string | null, term: string) {
  const limpio = term.trim().replace(/[%_,()]/g, ' ').trim()
  return useQuery({
    queryKey: ['admin', 'video-products', companyId, limpio] as const,
    enabled: Boolean(companyId) && limpio.length >= 2,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<VideoProductOption[]> => {
      const client = tryGetSupabaseClient()
      if (!client || !companyId) throw new Error('SIN_BACKEND')
      const { data, error } = await client
        .from(ADMIN_PRODUCT_MASTERS_VIEW)
        .select('id, name, sku')
        .eq('company_id', companyId)
        .or(`name.ilike.%${limpio}%,sku.ilike.%${limpio}%`)
        .order('name')
        .limit(20)
      if (error) throw error
      return (data ?? []) as VideoProductOption[]
    },
  })
}

/** Nombre y SKU de los productos ya enlazados, para pintarlos al abrir. */
export function useVideoProductLabels(ids: readonly string[]) {
  const unicos = [...new Set(ids)].sort()
  return useQuery({
    queryKey: ['admin', 'video-product-labels', unicos] as const,
    enabled: unicos.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<VideoProductOption[]> => {
      const client = tryGetSupabaseClient()
      if (!client) throw new Error('SIN_BACKEND')
      const { data, error } = await client.from(ADMIN_PRODUCT_MASTERS_VIEW).select('id, name, sku').in('id', unicos)
      if (error) throw error
      return (data ?? []) as VideoProductOption[]
    },
  })
}

const EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** Sube un video que YA cumple; devuelve la entrada para la lista. */
/**
 * Sube un video que YA cumple sus requisitos y devuelve su ruta y una URL
 * firmada para verlo en la pantalla. Lo usan el carrusel de portada y el
 * fondo de las promociones (2026-10-04).
 */
export async function uploadStoreVideo(input: {
  organizationId: string
  storeId: string
  file: File
}): Promise<{ path: string; preview: string | null }> {
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
  return { path, preview: urls[path] ?? null }
}

/** Comprueba un video para el FONDO de una promoción (horizontal, 5 a 30 s, 15 MB). */
export async function inspectPromoVideo(file: File): Promise<HomeVideoIssue[]> {
  const tipoValido = (PROMO_VIDEO_RULES.types as readonly string[]).includes(file.type)
  const facts = tipoValido ? await readVideoFacts(file) : { seconds: null, width: null, height: null }
  return evaluatePromoVideo({ type: file.type, bytes: file.size, ...facts })
}

/** URL firmada de un video ya subido, para la vista previa. */
export function useStoreVideoPreview(path: string | null) {
  return useQuery({
    queryKey: ['admin', 'store-video-preview', path] as const,
    enabled: Boolean(path),
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<string | null> => {
      const client = tryGetSupabaseClient()
      if (!client || !path) return null
      const urls = await resolveAssetUrls(client, [path])
      return urls[path] ?? null
    },
  })
}

export async function uploadHomeVideo(input: {
  organizationId: string
  storeId: string
  file: File
  seconds: number
}): Promise<AdminHomeVideo> {
  const { path, preview } = await uploadStoreVideo(input)
  const nombre = input.file.name.replace(/\.[^.]+$/, '').slice(0, HOME_VIDEO_RULES.titleMax)
  return {
    path,
    title: nombre || null,
    duration: storedSeconds(input.seconds),
    product_id: null,
    preview,
  }
}
