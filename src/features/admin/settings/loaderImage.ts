/**
 * Requisitos de la imagen del indicador de carga (2026-10-02).
 *
 * No vale cualquier imagen: el indicador se pinta a 34–48 px, gira o late, y
 * lo hace sobre el fondo de la página en claro y en oscuro. Lo que se exige y
 * por qué:
 *
 *  - **PNG o WebP** — los dos guardan transparencia. JPG no puede, y SVG queda
 *    fuera porque un SVG servido desde el bucket puede llevar script (la base
 *    lo rechaza también: `store_settings_loader_url_check`).
 *  - **Fondo transparente** — un cuadrado blanco girando sobre el modo oscuro
 *    es lo primero que se ve, y se ve mal. Se mira el BORDE de la imagen: si
 *    más de una décima parte de él es opaco, el fondo no es transparente.
 *  - **Cuadrada** (tolerancia 2 %) — gira sobre su centro; una apaisada gira
 *    descentrada y «baila».
 *  - **De 96 a 1024 px de lado** — menos se ve borrosa en pantallas densas;
 *    más es peso para nada.
 *  - **200 KB como mucho** — es lo primero que se descarga en cada espera.
 *
 * `evaluateLoaderImage` es la regla pura (la que se prueba); `inspectLoaderFile`
 * es la parte que necesita el navegador para leer las medidas y los píxeles.
 */
export const LOADER_RULES = {
  types: ['image/png', 'image/webp'] as const,
  maxBytes: 200 * 1024,
  minSide: 96,
  maxSide: 1024,
  squareTolerance: 0.02,
  /** Fracción del borde que puede ser opaca sin dejar de ser «fondo transparente». */
  maxOpaqueBorder: 0.1,
}

export type LoaderIssue = 'type' | 'weight' | 'square' | 'small' | 'large' | 'background'

export interface LoaderImageFacts {
  readonly type: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  /** Alfa (0–255) de los píxeles del borde; vacío si no se pudo leer. */
  readonly borderAlphas: readonly number[]
}

export function evaluateLoaderImage(facts: LoaderImageFacts): LoaderIssue[] {
  const issues: LoaderIssue[] = []
  if (!(LOADER_RULES.types as readonly string[]).includes(facts.type)) issues.push('type')
  if (facts.bytes > LOADER_RULES.maxBytes) issues.push('weight')
  const lado = Math.max(facts.width, facts.height)
  if (lado > 0) {
    if (Math.abs(facts.width - facts.height) / lado > LOADER_RULES.squareTolerance) issues.push('square')
    if (Math.min(facts.width, facts.height) < LOADER_RULES.minSide) issues.push('small')
    if (lado > LOADER_RULES.maxSide) issues.push('large')
  }
  if (facts.borderAlphas.length > 0) {
    const opacos = facts.borderAlphas.filter((alpha) => alpha > 24).length
    if (opacos / facts.borderAlphas.length > LOADER_RULES.maxOpaqueBorder) issues.push('background')
  }
  return issues
}

/** Lee medidas y borde de un archivo en el navegador y aplica la regla. */
export async function inspectLoaderFile(file: File): Promise<LoaderIssue[]> {
  const base = { type: file.type, bytes: file.size }
  if (!(LOADER_RULES.types as readonly string[]).includes(file.type)) {
    return evaluateLoaderImage({ ...base, width: 0, height: 0, borderAlphas: [] })
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return ['type']
  }
  const { width, height } = bitmap
  const borderAlphas: number[] = []
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0)
      const { data } = ctx.getImageData(0, 0, width, height)
      const alfa = (x: number, y: number) => data[(y * width + x) * 4 + 3] ?? 255
      const paso = Math.max(1, Math.floor(Math.max(width, height) / 64))
      for (let x = 0; x < width; x += paso) borderAlphas.push(alfa(x, 0), alfa(x, height - 1))
      for (let y = 0; y < height; y += paso) borderAlphas.push(alfa(0, y), alfa(width - 1, y))
    }
  } finally {
    bitmap.close()
  }
  return evaluateLoaderImage({ ...base, width, height, borderAlphas })
}
