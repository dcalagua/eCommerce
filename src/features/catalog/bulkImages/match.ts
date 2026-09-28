/**
 * Emparejar fotos con productos por el NOMBRE del archivo.
 *
 * La convención es la que ya usa cualquiera que tiene las fotos en una carpeta:
 * el SKU, y si hay varias, un número detrás.
 *
 *   FMX-0158.jpg        → FMX-0158, foto 1 (la principal)
 *   FMX-0158-2.jpg      → FMX-0158, foto 2
 *   FMX-0158_3.webp     → FMX-0158, foto 3
 *   FMX-0158 (4).png    → FMX-0158, foto 4   (lo que deja el explorador al copiar)
 *
 * Ambigüedad real: un SKU puede acabar en guion y número («FMX-0158» mismo). Por
 * eso primero se busca el nombre ENTERO como SKU y solo si no existe se prueba
 * quitándole el sufijo. Así «FMX-0158» es FMX-0158 y no «FMX-0» foto 158.
 *
 * Sin distinguir mayúsculas: en una carpeta de Windows `fmx-0158.JPG` y
 * `FMX-0158.jpg` son el mismo archivo para quien lo nombró.
 */

/** Hasta 99 fotos por producto: un sufijo de tres cifras ya no es un orden. */
const SUFIJO = /^(.*?)(?:[-_ ](\d{1,2})|\s*\((\d{1,2})\))$/

export interface NameCandidate {
  /** SKU candidato, en mayúsculas y sin espacios alrededor. */
  readonly sku: string
  /** Orden de la foto: 1 cuando no lleva número. */
  readonly order: number
}

/** El nombre sin carpeta ni extensión. */
export function baseName(fileName: string): string {
  const sinCarpeta = fileName.split(/[\\/]/).pop() ?? fileName
  return sinCarpeta.replace(/\.[^.]+$/, '').trim()
}

/**
 * Lecturas posibles de un nombre, de la más literal a la menos.
 *
 * Devuelve una o dos: el nombre entero como SKU (foto 1) y, si acaba en un
 * sufijo de orden, el nombre sin él.
 */
export function nameCandidates(fileName: string): NameCandidate[] {
  const base = baseName(fileName).toUpperCase()
  if (!base) return []
  const lecturas: NameCandidate[] = [{ sku: base, order: 1 }]
  const m = SUFIJO.exec(base)
  const numero = m ? Number(m[2] ?? m[3]) : NaN
  const resto = m?.[1]?.trim()
  if (resto && Number.isFinite(numero) && numero >= 1) lecturas.push({ sku: resto, order: numero })
  return lecturas
}

export interface FileMatch<F> {
  readonly file: F
  /** El producto emparejado, o `null` si ningún SKU coincide. */
  readonly productId: string | null
  readonly sku: string | null
  readonly order: number
}

/**
 * Empareja cada archivo con un producto.
 *
 * `products` es SKU (en mayúsculas) → id. El resultado va ordenado por SKU y por
 * orden de foto, que es el orden en el que se suben —la primera de cada
 * producto acaba siendo la principal—.
 */
export function matchFiles<F extends { name: string }>(
  files: readonly F[],
  products: ReadonlyMap<string, string>,
): FileMatch<F>[] {
  const matches = files.map((file): FileMatch<F> => {
    for (const lectura of nameCandidates(file.name)) {
      const productId = products.get(lectura.sku)
      if (productId) return { file, productId, sku: lectura.sku, order: lectura.order }
    }
    return { file, productId: null, sku: null, order: 1 }
  })
  return matches.sort((a, b) => {
    if (a.sku === b.sku) return a.order - b.order || a.file.name.localeCompare(b.file.name)
    if (a.sku === null) return 1
    if (b.sku === null) return -1
    return a.sku.localeCompare(b.sku)
  })
}

/** Todos los SKU que podrían nombrar estos archivos: lo que hay que consultar. */
export function candidateSkus(files: readonly { name: string }[]): string[] {
  const skus = new Set<string>()
  for (const file of files) for (const lectura of nameCandidates(file.name)) skus.add(lectura.sku)
  return [...skus]
}
