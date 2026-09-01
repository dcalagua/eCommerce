import type { PublicCategory } from './types'

/**
 * El árbol de categorías en la VITRINA.
 *
 * El servidor ya devuelve los productos de una categoría y de todo lo que
 * cuelga de ella (P18, fase 2). Lo que no puede resolver por su cuenta es la
 * presentación: qué se enseña en la barra, con qué cifra al lado y por dónde se
 * ha llegado. Eso se arma aquí, sobre las categorías que la vitrina ya tiene
 * cargadas — decenas de filas, una pasada por array, ninguna consulta más.
 *
 * `public_categories` solo trae categorías alcanzables (activas y con todos sus
 * ancestros activos), así que aquí no hay que volver a filtrar por visibilidad:
 * lo que llega, se enseña.
 */

/**
 * Cuenta lo PROPIO más lo de la descendencia.
 *
 * Las facetas de la búsqueda cuentan por la categoría exacta del producto,
 * porque es lo único que el producto declara. Con árbol eso deja a las madres a
 * cero: «Nutrición» tiene 81 productos repartidos entre sus hijas y ninguno
 * suyo. Un cero al lado de una puerta que sí lleva a algún sitio es peor que no
 * poner cifra: dice «vacío» de una categoría llena.
 *
 * Devuelve `null` para una categoría de la que no se sabe nada —el mapa de
 * entrada usa `null` cuando hay un filtro puesto y el resto de cifras no son de
 * fiar—, y ese `null` se propaga: si no se sabe lo de la hija, tampoco se sabe
 * lo de la madre.
 */
export function rollUpCategoryCounts(
  categories: PublicCategory[],
  counts: Map<string, number | null>,
): Map<string, number | null> {
  const bySlug = new Map(categories.map((category) => [category.slug, category]))
  const childrenOf = new Map<string, PublicCategory[]>()
  for (const category of categories) {
    if (!category.parent_id) continue
    const parent = categories.find((c) => c.category_id === category.parent_id)
    if (!parent) continue
    childrenOf.set(parent.slug, [...(childrenOf.get(parent.slug) ?? []), category])
  }

  const resolved = new Map<string, number | null>()
  const visiting = new Set<string>()

  function total(slug: string): number | null {
    if (resolved.has(slug)) return resolved.get(slug) ?? null
    // Un ciclo no deberia existir —la base lo rechaza— pero esta funcion corre
    // sobre datos que llegan por red: colgarse el navegador no es una opcion.
    if (visiting.has(slug)) return null
    visiting.add(slug)

    const own = counts.get(slug)
    let sum: number | null = own === undefined ? 0 : own
    for (const child of childrenOf.get(slug) ?? []) {
      const childTotal = total(child.slug)
      if (childTotal === null || sum === null) sum = null
      else sum += childTotal
    }

    visiting.delete(slug)
    resolved.set(slug, sum)
    return sum
  }

  for (const slug of bySlug.keys()) total(slug)
  return resolved
}

/**
 * El camino hasta una categoría, de la raíz a ella misma.
 *
 * Es lo que hace legible una vitrina con árbol: sin migas, quien abre
 * «Desodorantes» desde un buscador no sabe que está dentro de «Cuidado
 * personal» ni cómo subir un nivel.
 */
export function categoryTrail(
  categories: PublicCategory[],
  slug: string | null,
): PublicCategory[] {
  if (!slug) return []
  const byId = new Map(categories.map((category) => [category.category_id, category]))
  let current = categories.find((category) => category.slug === slug) ?? null

  const trail: PublicCategory[] = []
  while (current) {
    trail.unshift(current)
    // Tope defensivo por lo mismo que arriba, y porque el arbol admite tres.
    if (trail.length > 4) break
    current = current.parent_id ? (byId.get(current.parent_id) ?? null) : null
  }
  return trail
}

/**
 * Qué categorías enseñar en la barra, según dónde esté el comprador.
 *
 * En la portada, las RAÍCES: son las puertas. Dentro de una, sus hijas, que es
 * el siguiente paso natural. Y dentro de una hoja, sus hermanas, para poder
 * saltar de lado sin volver atrás — que es lo que uno hace de verdad cuando la
 * categoría en la que entró no era la que buscaba.
 *
 * Si el comercio no ha hecho jerarquía, todas son raíces y esto devuelve la
 * lista de siempre: la función no exige un árbol para funcionar.
 */
export function categoryBarItems(
  categories: PublicCategory[],
  selectedSlug: string | null,
): PublicCategory[] {
  const roots = categories.filter((category) => category.parent_id === null)
  const selected = selectedSlug
    ? (categories.find((category) => category.slug === selectedSlug) ?? null)
    : null

  if (!selected) return roots

  const children = categories.filter((category) => category.parent_id === selected.category_id)
  if (children.length > 0) return children

  const siblings = categories.filter((category) => category.parent_id === selected.parent_id)
  return siblings.length > 0 ? siblings : roots
}
