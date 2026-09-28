/**
 * Foto de producto «de catálogo»: el producto centrado en un cuadrado blanco.
 *
 * ## Por qué
 *
 * Una vitrina se ve profesional cuando todas las fotos comparten fondo,
 * proporción y aire alrededor. Doscientas fotos de proveedores distintos traen
 * cada una su encuadre: una apaisada con un metro de blanco a la derecha, otra
 * vertical pegada al borde, un PNG recortado sin fondo. En la rejilla eso se lee
 * como descuido aunque cada foto por separado esté bien.
 *
 * Aquí se hace en el navegador, antes de subir, lo que haría un editor:
 *
 *  1. **Recortar el sobrante**: lo que es fondo claro alrededor del producto.
 *  2. **Centrar en un cuadrado blanco** con el mismo margen para todos.
 *  3. **Aplanar la transparencia sobre blanco**: un PNG sin fondo queda igual
 *     que una foto de estudio.
 *
 * ## Lo que NO hace, y lo dice
 *
 * No quita fondos de color ni de ambiente (una mesa, una pared, una mano): eso
 * es segmentación de imagen y necesita un modelo, no un lienzo. Lo que sí hace
 * es **detectarlo** —mira el marco exterior de la foto— para que quien sube
 * decida, en vez de meter en la vitrina una foto que rompe la rejilla.
 *
 * La parte de medir es pura (trabaja sobre los píxeles) y se prueba sin
 * navegador; la de dibujar es una capa fina sobre `canvas`.
 */

/** Píxeles RGBA en fila, como los da `getImageData`. */
export interface Pixels {
  readonly width: number
  readonly height: number
  readonly data: ArrayLike<number>
}

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Un píxel «es fondo» si es transparente o casi blanco.
 *
 * 236 y no 250: el blanco de una foto de estudio casi nunca es 255 puro —la
 * compresión y la luz lo dejan en 240 y pico—, y exigir 250 marcaría como
 * «fondo gris» fotos que cualquiera llamaría blancas.
 */
const CLARO = 236
const TRANSPARENTE = 16

function esFondo(data: ArrayLike<number>, i: number): boolean {
  const alfa = data[i + 3] ?? 255
  if (alfa < TRANSPARENTE) return true
  return (data[i] ?? 0) >= CLARO && (data[i + 1] ?? 0) >= CLARO && (data[i + 2] ?? 0) >= CLARO
}

/**
 * ¿El fondo es blanco (o transparente)? Se mira el MARCO exterior de la foto.
 *
 * El marco es el 4 % de cada lado: ahí está el fondo en cualquier foto de
 * producto bien hecha, y no el producto. Con que un 90 % del marco sea claro se
 * da por bueno —una sombra suave en la base o un borde de la caja que roza el
 * canto no deberían descalificar la foto—.
 */
export function hasLightBackground(pixels: Pixels, minShare = 0.9): boolean {
  const { width, height, data } = pixels
  if (width <= 0 || height <= 0) return false
  const bandaX = Math.max(1, Math.round(width * 0.04))
  const bandaY = Math.max(1, Math.round(height * 0.04))
  let total = 0
  let claros = 0
  for (let y = 0; y < height; y += 1) {
    const enBandaY = y < bandaY || y >= height - bandaY
    for (let x = 0; x < width; x += 1) {
      if (!enBandaY && x >= bandaX && x < width - bandaX) continue
      total += 1
      if (esFondo(data, (y * width + x) * 4)) claros += 1
    }
  }
  return total > 0 && claros / total >= minShare
}

/**
 * El rectángulo que ocupa el producto: todo lo que no es fondo claro.
 *
 * Si la imagen entera es fondo (una foto en blanco, un error), devuelve la
 * imagen completa: recortar a nada sería peor que no recortar.
 */
export function contentBox(pixels: Pixels): Box {
  const { width, height, data } = pixels
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (esFondo(data, (y * width + x) * 4)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width, height }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** Lado máximo del cuadrado final: la ficha permite ampliar, pero no a póster. */
export const PHOTO_MAX_SIDE = 2000
/** Por debajo de esto el producto se verá borroso al ampliar en la ficha. */
export const PHOTO_MIN_CONTENT = 600
/** Aire alrededor del producto, por lado: el 8 % es el de un catálogo de estudio. */
export const PHOTO_MARGIN = 0.08

/**
 * Dónde y a qué tamaño se dibuja el producto dentro del cuadrado.
 *
 * El lado sale del propio producto (no se amplía una foto pequeña hasta 2000:
 * se inventaría detalle y se vería borrosa) con el margen fijo alrededor.
 */
export function squareLayout(content: { width: number; height: number }): {
  side: number
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
} {
  const mayor = Math.max(1, content.width, content.height)
  const util = 1 - PHOTO_MARGIN * 2
  const side = Math.min(PHOTO_MAX_SIDE, Math.max(1, Math.ceil(mayor / util)))
  const escala = Math.min(1, (side * util) / mayor)
  const drawWidth = Math.max(1, Math.round(content.width * escala))
  const drawHeight = Math.max(1, Math.round(content.height * escala))
  return {
    side,
    drawX: Math.round((side - drawWidth) / 2),
    drawY: Math.round((side - drawHeight) / 2),
    drawWidth,
    drawHeight,
  }
}

export type PhotoWarning = 'background' | 'lowResolution'

export interface PreparedPhoto {
  /** El cuadrado blanco listo para subir, o el original si no se pudo dibujar. */
  readonly file: File
  readonly warnings: readonly PhotoWarning[]
  /** ¿Se pudo preparar? Sin lienzo (navegador viejo) sale `false` y el original. */
  readonly prepared: boolean
}

/** Lado al que se reduce la foto SOLO para medirla: rápido y de sobra preciso. */
const LADO_ANALISIS = 400

/**
 * Deja la foto lista: recortada, centrada en blanco y con sus avisos.
 *
 * **Nunca lanza.** Si el navegador no puede dibujar, devuelve el original sin
 * avisos y `prepared: false`: la subida sigue su camino de siempre.
 */
export async function prepareProductPhoto(file: File): Promise<PreparedPhoto> {
  const original: PreparedPhoto = { file, warnings: [], prepared: false }
  try {
    const fuente = await decodificar(file)
    if (!fuente) return original
    const ancho = 'naturalWidth' in fuente ? fuente.naturalWidth : fuente.width
    const alto = 'naturalHeight' in fuente ? fuente.naturalHeight : fuente.height
    if (ancho <= 0 || alto <= 0) return original

    // 1 · Medir sobre una copia pequeña.
    const reduccion = Math.min(1, LADO_ANALISIS / Math.max(ancho, alto))
    const aw = Math.max(1, Math.round(ancho * reduccion))
    const ah = Math.max(1, Math.round(alto * reduccion))
    const medida = document.createElement('canvas')
    medida.width = aw
    medida.height = ah
    const mctx = medida.getContext('2d', { willReadFrequently: true })
    if (!mctx) return original
    mctx.drawImage(fuente, 0, 0, aw, ah)
    const pixels = mctx.getImageData(0, 0, aw, ah)

    const warnings: PhotoWarning[] = []
    if (!hasLightBackground(pixels)) warnings.push('background')

    // Con fondo que no es claro no se recorta: el «contenido» sería la foto
    // entera y el recorte solo movería el encuadre de quien la hizo.
    const caja = warnings.includes('background')
      ? { x: 0, y: 0, width: aw, height: ah }
      : contentBox(pixels)
    // De vuelta a la escala real, con un píxel de holgura por el redondeo.
    const recorte = {
      x: Math.max(0, Math.floor(caja.x / reduccion) - 1),
      y: Math.max(0, Math.floor(caja.y / reduccion) - 1),
      width: 0,
      height: 0,
    }
    recorte.width = Math.min(ancho - recorte.x, Math.ceil(caja.width / reduccion) + 2)
    recorte.height = Math.min(alto - recorte.y, Math.ceil(caja.height / reduccion) + 2)
    if (Math.max(recorte.width, recorte.height) < PHOTO_MIN_CONTENT) warnings.push('lowResolution')

    // 2 · Dibujar en el cuadrado blanco.
    const plan = squareLayout(recorte)
    const lienzo = document.createElement('canvas')
    lienzo.width = plan.side
    lienzo.height = plan.side
    const ctx = lienzo.getContext('2d')
    if (!ctx) return original
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, plan.side, plan.side)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      fuente,
      recorte.x,
      recorte.y,
      recorte.width,
      recorte.height,
      plan.drawX,
      plan.drawY,
      plan.drawWidth,
      plan.drawHeight,
    )
    cerrar(fuente)

    // WebP si el navegador sabe escribirlo; si no, JPEG (ya no hay transparencia).
    const webp = await aBlob(lienzo, 'image/webp')
    const blob = webp?.type === 'image/webp' ? webp : await aBlob(lienzo, 'image/jpeg')
    if (!blob) return { ...original, warnings }
    const extension = blob.type === 'image/webp' ? 'webp' : 'jpg'
    const nombre = `${file.name.replace(/\.[^.]+$/, '') || 'foto'}.${extension}`
    return {
      file: new File([blob], nombre, { type: blob.type, lastModified: file.lastModified }),
      warnings,
      prepared: true,
    }
  } catch {
    return original
  }
}

async function decodificar(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Al respaldo.
    }
  }
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(file)
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const elemento = new Image()
    elemento.onload = () => resolve(elemento)
    elemento.onerror = () => resolve(null)
    elemento.src = url
  })
  URL.revokeObjectURL(url)
  return img
}

function cerrar(fuente: ImageBitmap | HTMLImageElement): void {
  if ('close' in fuente && typeof fuente.close === 'function') fuente.close()
}

/** 0,88: un punto más que la reducción general; es la foto que vende. */
function aBlob(lienzo: HTMLCanvasElement, tipo: string): Promise<Blob | null> {
  if (typeof lienzo.toBlob !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    lienzo.toBlob((blob) => resolve(blob), tipo, 0.88)
  })
}
