/**
 * Qué hace el interruptor «Abastece esta tienda» de un almacén.
 *
 * La regla de la base: sin vínculos ACTIVOS la tienda se sirve de todos los
 * almacenes activos; con alguno, solo de los vinculados. La pantalla pinta lo
 * mismo —todos encendidos en el primer caso— y este plan hace que pulsar
 * cambie exactamente lo que se ve y nada más.
 *
 * Es pura para poder probar los cuatro caminos sin montar la pantalla: el
 * fallo que la motivó (QAS, ALM-PRUEBA) estaba justo en el camino que nadie
 * había probado —apagar uno cuando no había ninguno declarado lo convertía en
 * el ÚNICO almacén de la tienda—.
 */
export interface SupplyWarehouse {
  id: string
  is_active: boolean
}

export interface SupplyLink {
  id: string
  warehouse_id: string
  is_active: boolean
}

export type SupplyPlan =
  /** Declarar estos almacenes (en este orden). */
  | { kind: 'link'; warehouseIds: string[] }
  /** Quitar este vínculo. */
  | { kind: 'unlink'; linkId: string }
  /** Reemplazar un vínculo apagado por uno vivo. */
  | { kind: 'relink'; linkId: string; warehouseId: string }
  /** No se hace nada: dejaría la tienda sin almacén (o, peor, con todos a escondidas). */
  | { kind: 'lastOne' }

export function planSupplyToggle(
  warehouseId: string,
  warehouses: readonly SupplyWarehouse[],
  links: readonly SupplyLink[],
): SupplyPlan {
  const activos = new Set(links.filter((l) => l.is_active).map((l) => l.warehouse_id))
  const vinculo = links.find((l) => l.warehouse_id === warehouseId)

  // Se sirve de todos y se APAGA uno: se declaran los demás.
  if (activos.size === 0) {
    const conVinculo = new Set(links.map((l) => l.warehouse_id))
    const resto = warehouses
      .filter((w) => w.id !== warehouseId && w.is_active && !conVinculo.has(w.id))
      .map((w) => w.id)
    return resto.length === 0 ? { kind: 'lastOne' } : { kind: 'link', warehouseIds: resto }
  }

  if (vinculo && activos.has(warehouseId)) {
    return activos.size === 1 ? { kind: 'lastOne' } : { kind: 'unlink', linkId: vinculo.id }
  }

  if (vinculo) return { kind: 'relink', linkId: vinculo.id, warehouseId }
  return { kind: 'link', warehouseIds: [warehouseId] }
}
