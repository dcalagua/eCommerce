// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_PORQUE,
  datosParaModelo,
  revisarAnalisis,
  type HallazgoParaModelo,
} from '../functions/_shared/aiWatch.ts'

/**
 * El candado del «Ejecutar análisis» del centro de vigilancia.
 *
 * El modelo solo ordena y explica. Lo que este archivo fija:
 *  · el orden es una permutación EXACTA de los avisos que se le dieron;
 *  · ningún dígito escrito por el modelo sobrevive (las cifras son de la base);
 *  · un porqué de un aviso que no existe tumba la respuesta entera;
 *  · lo que ve el modelo no lleva cifras, ni pedidos, ni clientes.
 */

const HALLAZGOS: HallazgoParaModelo[] = [
  { key: 'orders.unpaid', module: 'orders', severity: 'critica' },
  { key: 'inventory.below_reorder', module: 'inventory', severity: 'advertencia' },
]

const ok = {
  headline: 'Primero el cobro parado.',
  order: ['orders.unpaid', 'inventory.below_reorder'],
  reasons: [
    { key: 'orders.unpaid', why: 'Es dinero facturado que no ha entrado.' },
    { key: 'inventory.below_reorder', why: 'Se queda sin existencia esta semana.' },
  ],
}

describe('revisarAnalisis', () => {
  it('acepta un orden que son los MISMOS avisos, sin repetir', () => {
    const revision = revisarAnalisis(ok, HALLAZGOS)
    expect(revision.ok).toBe(true)
    if (revision.ok) {
      expect(revision.value.order).toEqual(['orders.unpaid', 'inventory.below_reorder'])
      expect(revision.value.reasons).toHaveLength(2)
    }
  })

  it('un aviso inventado es una alarma falsa: se rechaza el análisis entero', () => {
    const revision = revisarAnalisis({ ...ok, order: ['orders.unpaid', 'ventas.inventado'] }, HALLAZGOS)
    expect(revision).toEqual({ ok: false, motivo: 'bloqueada' })
  })

  it('omitir un aviso sería esconder un problema: también se rechaza', () => {
    expect(revisarAnalisis({ ...ok, order: ['orders.unpaid'] }, HALLAZGOS)).toEqual({
      ok: false,
      motivo: 'esquema',
    })
  })

  it('repetir una clave para rellenar no cuela', () => {
    expect(revisarAnalisis({ ...ok, order: ['orders.unpaid', 'orders.unpaid'] }, HALLAZGOS)).toEqual({
      ok: false,
      motivo: 'esquema',
    })
  })

  /** Las cifras las calcula la base y ya están en la tarjeta. */
  it('ningún dígito escrito por el modelo sobrevive', () => {
    expect(revisarAnalisis({ ...ok, headline: 'Hay 13 pedidos sin cobrar.' }, HALLAZGOS)).toEqual({
      ok: false,
      motivo: 'bloqueada',
    })
    expect(
      revisarAnalisis(
        { ...ok, reasons: [{ key: 'orders.unpaid', why: 'Llevan 9 días parados.' }] },
        HALLAZGOS,
      ),
    ).toEqual({ ok: false, motivo: 'bloqueada' })
  })

  it('un porqué de un aviso que no existe tumba la respuesta', () => {
    expect(
      revisarAnalisis({ ...ok, reasons: [{ key: 'ventas.inventado', why: 'Porque sí.' }] }, HALLAZGOS),
    ).toEqual({ ok: false, motivo: 'bloqueada' })
  })

  it('sin titular o sin ningún porqué no hay análisis que enseñar', () => {
    expect(revisarAnalisis({ ...ok, headline: '   ' }, HALLAZGOS)).toEqual({ ok: false, motivo: 'vacia' })
    expect(revisarAnalisis({ ...ok, reasons: [] }, HALLAZGOS)).toEqual({ ok: false, motivo: 'vacia' })
  })

  it('un porqué interminable se rechaza en vez de recortarse', () => {
    const largo = 'a'.repeat(MAX_PORQUE + 1)
    expect(
      revisarAnalisis({ ...ok, reasons: [{ key: 'orders.unpaid', why: largo }] }, HALLAZGOS),
    ).toEqual({ ok: false, motivo: 'esquema' })
  })
})

describe('lo que ve el modelo', () => {
  it('solo clave, módulo y severidad: ni cifras ni entidades', () => {
    const datos = datosParaModelo(HALLAZGOS, 'es')
    expect(datos).toContain('orders.unpaid')
    expect(datos).toContain('critica')
    expect(datos).not.toMatch(/EC-\d+/)
    expect(datos).not.toContain('count')
  })
})
