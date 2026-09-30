import { describe, expect, it } from 'vitest'
import { planSupplyToggle, type SupplyLink, type SupplyWarehouse } from './storeSupply'

const NORTE: SupplyWarehouse = { id: 'norte', is_active: true }
const SUR: SupplyWarehouse = { id: 'sur', is_active: true }
const PRUEBA: SupplyWarehouse = { id: 'prueba', is_active: true }
const CERRADO: SupplyWarehouse = { id: 'cerrado', is_active: false }
const TODOS = [NORTE, SUR, PRUEBA, CERRADO]

const link = (warehouse_id: string, is_active = true): SupplyLink => ({
  id: `l-${warehouse_id}`,
  warehouse_id,
  is_active,
})

describe('interruptor «Abastece esta tienda»', () => {
  it('sin almacenes declarados, apagar uno declara LOS DEMÁS activos (no a él)', () => {
    // El fallo de QAS: esto antes vinculaba ALM-PRUEBA y lo dejaba como único.
    expect(planSupplyToggle('prueba', TODOS, [])).toEqual({ kind: 'link', warehouseIds: ['norte', 'sur'] })
  })

  it('sin declarados y con un solo almacén activo, no se puede apagar', () => {
    expect(planSupplyToggle('norte', [NORTE, CERRADO], [])).toEqual({ kind: 'lastOne' })
  })

  it('con varios declarados, apagar uno quita solo su vínculo', () => {
    expect(planSupplyToggle('sur', TODOS, [link('norte'), link('sur')])).toEqual({
      kind: 'unlink',
      linkId: 'l-sur',
    })
  })

  it('el último declarado no se quita: la tienda volvería a servirse de todos a escondidas', () => {
    expect(planSupplyToggle('norte', TODOS, [link('norte')])).toEqual({ kind: 'lastOne' })
  })

  it('encender uno no declarado lo añade', () => {
    expect(planSupplyToggle('prueba', TODOS, [link('norte')])).toEqual({
      kind: 'link',
      warehouseIds: ['prueba'],
    })
  })

  it('un vínculo apagado que quedó de antes se reemplaza por uno vivo', () => {
    expect(planSupplyToggle('sur', TODOS, [link('norte'), link('sur', false)])).toEqual({
      kind: 'relink',
      linkId: 'l-sur',
      warehouseId: 'sur',
    })
  })

  it('sin declarados, los que tienen un vínculo apagado no se re-declaran por la puerta de atrás', () => {
    expect(planSupplyToggle('prueba', TODOS, [link('sur', false)])).toEqual({
      kind: 'link',
      warehouseIds: ['norte'],
    })
  })
})
