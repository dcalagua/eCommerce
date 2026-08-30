/** Posiciones fijas del control: primera, ultima, la ventana y los huecos. */
const SLOTS = 7


/**
 * Devuelve las páginas a pintar, con huecos donde se saltan tramos.
 *
 * Siempre la primera y la última —son los destinos que más se piden— más una
 * ventana alrededor de la actual. Con siete páginas o menos se pintan todas: un
 * puntito de elipsis para ahorrar dos botones no ahorra nada y quita un destino.
 */
export function pageSlots(current: number, total: number): Array<number | 'gap'> {
  if (total <= SLOTS) return Array.from({ length: total }, (_, i) => i)

  // Siempre SLOTS posiciones, pase lo que pase. Si el control cambia de ancho
  // al navegar, los botones se desplazan bajo el cursor y se acaba pulsando el
  // que no era; es mas importante que el ancho no baile que apurar un hueco.
  const last = total - 1

  // Pegado al principio: se estira la ventana hacia la derecha.
  if (current <= 3) return [0, 1, 2, 3, 4, 'gap', last]

  // Pegado al final: hacia la izquierda.
  if (current >= total - 4) return [0, 'gap', total - 5, total - 4, total - 3, total - 2, last]

  // En medio: la actual con una vecina a cada lado.
  return [0, 'gap', current - 1, current, current + 1, 'gap', last]
}
