/**
 * Qué color le toca a cada puerta.
 *
 * La portada tiene dos filas de puertas —categorías y marcas— y en una fila de
 * doce cajas grises ninguna se distingue de la de al lado: no hay dónde volver
 * la vista para «la que miré antes». El color es lo que da sitio propio.
 *
 * Dos decisiones que importan más que la paleta:
 *
 *  · **se asigna por el NOMBRE**, no al azar ni por la posición. La misma
 *    categoría cae siempre en el mismo tinte aunque entren otras nuevas o
 *    cambie el orden; un color que baila en cada recarga no orienta, marea;
 *  · **son tokens de la piel de la vitrina**, no colores escritos aquí. Lo que
 *    esta función devuelve son nombres de variables CSS, así que el tema claro,
 *    el oscuro y cualquier ajuste posterior se deciden en un solo sitio
 *    (`storefront.css`).
 *
 * El acento del comercio no entra en esto: sigue siendo el color de las
 * ACCIONES —botones, precios, estados—, que es donde su marca tiene que
 * mandar. Aquí se está resolviendo orientación, no identidad.
 */
export const TINTES = 6

export interface Tint {
  readonly bg: string
  readonly line: string
  readonly fg: string
}

/**
 * Hash estable de una cadena (djb2 recortado).
 *
 * No hace falta que sea criptográfico ni que reparta perfecto: hace falta que
 * dé SIEMPRE lo mismo para el mismo nombre, en cualquier navegador y entre
 * recargas. `hashCode` de Java sirve igual; este es el mismo espíritu.
 */
function hash(value: string): number {
  let acumulado = 5381
  for (let i = 0; i < value.length; i += 1) {
    acumulado = ((acumulado << 5) + acumulado + value.charCodeAt(i)) | 0
  }
  return Math.abs(acumulado)
}

export function tintFor(name: string): Tint {
  const indice = (hash(name.trim().toLowerCase()) % TINTES) + 1
  return {
    bg: `var(--sf-tint-${indice}-bg)`,
    line: `var(--sf-tint-${indice}-line)`,
    fg: `var(--sf-tint-${indice}-fg)`,
  }
}
