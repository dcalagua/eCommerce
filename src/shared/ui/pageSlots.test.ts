import { describe, expect, it } from 'vitest'
import { pageSlots } from './pageSlots'

/**
 * La ventana de páginas es aritmética de índices, que es justo donde se cuelan
 * los errores de uno: una página fantasma más allá del final, la última perdida,
 * o un hueco donde no falta nada.
 */
describe('pageSlots', () => {
  it('con pocas páginas las pinta todas: un hueco no ahorra nada', () => {
    expect(pageSlots(0, 1)).toEqual([0])
    expect(pageSlots(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('nunca propone una página fuera de rango', () => {
    for (const total of [1, 5, 8, 20, 137]) {
      for (const current of [0, Math.floor(total / 2), total - 1]) {
        const numbers = pageSlots(current, total).filter((s): s is number => s !== 'gap')
        expect(numbers.every((n) => n >= 0 && n < total)).toBe(true)
      }
    }
  })

  it('siempre deja a un clic la primera y la última', () => {
    for (const current of [0, 5, 10, 19]) {
      const slots = pageSlots(current, 20)
      expect(slots).toContain(0)
      expect(slots).toContain(19)
    }
  })

  it('incluye la página actual y sus vecinas', () => {
    const slots = pageSlots(10, 20)
    expect(slots).toContain(9)
    expect(slots).toContain(10)
    expect(slots).toContain(11)
  })

  it('no pone un hueco donde no falta ninguna página', () => {
    for (const current of [0, 4, 9, 15, 19]) {
      const slots = pageSlots(current, 20)
      slots.forEach((slot, index) => {
        if (slot !== 'gap') return
        const before = slots[index - 1]
        const after = slots[index + 1]
        // Un hueco solo vale si de verdad se salta más de una página.
        expect(typeof before === 'number' && typeof after === 'number' && after - before > 1).toBe(
          true,
        )
      })
    }
  })

  it('las páginas salen ordenadas y sin repetir', () => {
    const numbers = pageSlots(9, 40).filter((s): s is number => s !== 'gap')
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(new Set(numbers).size).toBe(numbers.length)
  })

  it('el ancho no baila al navegar por los extremos', () => {
    // Si el control cambia de tamaño al pasar de página, los botones se mueven
    // bajo el cursor y se acaba pulsando el que no era.
    const anchos = [0, 1, 2, 3, 17, 18, 19].map((p) => pageSlots(p, 20).length)
    expect(new Set(anchos).size).toBe(1)
  })
})
