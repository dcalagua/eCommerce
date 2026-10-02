import { isColorAxis } from './colorSwatch'
import type { PublicProductImage, PublicVariant } from './types'

/**
 * Qué fotos enseña la ficha según la variante elegida (2026-10-02).
 *
 * Una foto puede ser de una variante (`variant_id`) o del producto (`null`).
 * La galería sigue al COLOR, no a la variante exacta: elegir otra talla de la
 * mochila negra no cambia las fotos, elegir «Azul» sí. Por eso se agrupan las
 * variantes que comparten valor en el eje de color; sin eje de color, cada
 * variante es su propio grupo.
 *
 *   1. Las fotos del grupo de la elegida, y detrás las del producto.
 *   2. Si ese color no tiene ninguna: las del producto.
 *   3. Si tampoco hay del producto: la principal, sola. Mejor una foto de otro
 *      color que un hueco vacío; enseñar las de todos los colores a la vez es
 *      justo lo que esto viene a quitar.
 *
 * Un producto sin ninguna foto por variante no cambia nada: todas, como antes.
 * Las listas llegan ya ordenadas (principal primero, después por posición) y
 * ese orden se respeta.
 */
export function galleryForVariant<T extends Pick<PublicProductImage, 'variant_id'>>(
  images: readonly T[],
  variants: readonly PublicVariant[],
  selected: PublicVariant | null,
): T[] {
  if (!images.some((image) => image.variant_id)) return [...images]

  const delProducto = images.filter((image) => !image.variant_id)
  const grupo = selected ? variantGroup(variants, selected) : new Set<string>()
  const propias = images.filter((image) => image.variant_id && grupo.has(image.variant_id))

  if (propias.length > 0) return [...propias, ...delProducto]
  if (delProducto.length > 0) return delProducto
  return images.slice(0, 1)
}

/** La clave del grupo de fotos de una variante: su color, o ella misma. */
export function galleryKey(variant: PublicVariant | null): string {
  if (!variant) return ''
  const color = variant.options.find((option) => isColorAxis(option))
  return color ? `${color.code}:${color.value_code}` : variant.variant_id
}

/** Las variantes que comparten fotos con `selected` (ella incluida). */
function variantGroup(variants: readonly PublicVariant[], selected: PublicVariant): Set<string> {
  const clave = galleryKey(selected)
  const grupo = new Set([selected.variant_id])
  for (const variant of variants) if (galleryKey(variant) === clave) grupo.add(variant.variant_id)
  return grupo
}
