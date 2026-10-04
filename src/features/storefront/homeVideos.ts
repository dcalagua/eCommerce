import { z } from 'zod'

/**
 * Videos de la portada (2026-10-04 · migración 20261004100000).
 *
 * El comercio sube clips de 30 s a 1 min y la portada los enseña en un
 * carrusel que reproduce uno, pasa al siguiente al terminar y vuelve a empezar.
 * Viven en `store_settings.home_videos` (una lista), no dentro de `home_layout`:
 * la composición de la portada dice QUÉ secciones y en qué orden, el contenido
 * de cada una vive en su sitio — igual que `value_props` para «Servicios».
 *
 * Las reglas son las mismas que impone la base (`ebim.home_videos_are_valid`):
 * la pantalla las comprueba antes de subir para decir qué falla; la base, para
 * que nadie se las salte.
 */
export const HOME_VIDEO_RULES = {
  /** MP4 (H.264) y WebM: los dos que reproduce cualquier navegador sin plugin. */
  types: ['video/mp4', 'video/webm'] as const,
  minSeconds: 30,
  maxSeconds: 60,
  /** Un clip de 1 min bien exportado a 720p pesa 10–20 MB. */
  maxBytes: 30 * 1024 * 1024,
  maxVideos: 8,
  titleMax: 80,
}

/** Ruta de un video de ESTA tienda: `{org}/{tienda}/content/video-….mp4|webm`. */
const VIDEO_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/content\/video-[0-9a-f-]{36}\.(mp4|webm)$/i

export const homeVideoSchema = z.object({
  path: z.string().regex(VIDEO_PATH_RE),
  title: z.string().trim().max(HOME_VIDEO_RULES.titleMax).nullable().default(null),
  /** Segundos, entero, 30..60. */
  duration: z.number().int().min(HOME_VIDEO_RULES.minSeconds).max(HOME_VIDEO_RULES.maxSeconds),
  /**
   * 2026-10-04 · El producto que enseña el video: su tarjeta sale debajo del
   * video activo y lleva a la ficha. Opcional; si ya no está publicado, la
   * tarjeta simplemente no sale.
   */
  product_id: z.string().uuid().nullable().default(null),
})
export type HomeVideo = z.infer<typeof homeVideoSchema>

/**
 * La lista tal como llega de la base, limpia: lo que no cumple se descarta en
 * vez de romper la portada (la base ya lo impide; esto es la segunda red).
 */
export function sanitizeHomeVideos(raw: unknown): HomeVideo[] {
  if (!Array.isArray(raw)) return []
  const videos: HomeVideo[] = []
  for (const item of raw) {
    const parsed = homeVideoSchema.safeParse(item)
    if (parsed.success) videos.push(parsed.data)
    if (videos.length === HOME_VIDEO_RULES.maxVideos) break
  }
  return videos
}

export type HomeVideoIssue = 'type' | 'weight' | 'short' | 'long' | 'unreadable' | 'orientation'

/**
 * La regla pura sobre lo que se sabe de un archivo (la parte que se prueba).
 *
 * VERTICAL (2026-10-04): el carrusel es de formato Reels/TikTok, 9:16, varios
 * a la vez con el activo al centro. Un video apaisado ahí se recortaría por
 * los lados hasta no reconocerse, así que se exige alto mayor que ancho.
 */
export function evaluateHomeVideo(facts: {
  type: string
  bytes: number
  seconds: number | null
  width?: number | null
  height?: number | null
}): HomeVideoIssue[] {
  const issues: HomeVideoIssue[] = []
  if (facts.width && facts.height && facts.height <= facts.width) issues.push('orientation')
  if (!(HOME_VIDEO_RULES.types as readonly string[]).includes(facts.type)) issues.push('type')
  if (facts.bytes > HOME_VIDEO_RULES.maxBytes) issues.push('weight')
  if (facts.seconds === null || !Number.isFinite(facts.seconds)) {
    if (!issues.includes('type')) issues.push('unreadable')
    return issues
  }
  // Medio segundo de holgura: un clip «de 30 s» exportado dura 29,97.
  if (facts.seconds < HOME_VIDEO_RULES.minSeconds - 0.5) issues.push('short')
  if (facts.seconds > HOME_VIDEO_RULES.maxSeconds + 0.5) issues.push('long')
  return issues
}

/** Segundos que se guardan: redondeados y dentro de 30..60. */
export function storedSeconds(seconds: number): number {
  return Math.min(HOME_VIDEO_RULES.maxSeconds, Math.max(HOME_VIDEO_RULES.minSeconds, Math.round(seconds)))
}
