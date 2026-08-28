/**
 * Sugerencia de slug a partir de un nombre. Solo sugiere: el usuario manda.
 *
 * Mismo formato que el CHECK de la base y que `requireSlug` del borde
 * (minúsculas, guiones, 3-62). Estaba en `features/onboarding/bootstrapTenant`
 * y lo importaban los cajones de producto y de categoría del catálogo: una
 * feature de alta de tenant no es el sitio de una utilidad de texto, y ese
 * import cruzado ataba catálogo a aprovisionamiento sin ninguna razón de
 * dominio.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 62)
    .replace(/-+$/g, '')
}
