# Rediseño visual de la vitrina — plan y guardarraíles (P00)

> Sustituye a la corrida del arnés `claude_visual_ecommerce_opus/`, que marcó las
> 13 fases en verde **sin aplicar una sola línea**: el supervisor lanza
> `claude -p … --model opus` sin `--permission-mode`, así que toda escritura se
> auto-denegaba, y con `"project_dir": "."` el `cwd` era la carpeta del arnés —
> donde no hay `package.json`, de modo que la validación por fase tampoco corrió.
> Detalle en `logs/P12_*.log`. Este documento y el trabajo que describe se
> hicieron directamente contra `src/`.

## 1. Inventario de la vitrina

**Ámbito** (`src/features/storefront/`, 40 ficheros):

| Zona | Ficheros |
|---|---|
| Marco | `StorefrontLayout.tsx`, `storefront.css` |
| Portada | `StoreHomePage.tsx`, `components/StoreHero.tsx`, `components/ContentBlocks.tsx`, `components/SliderBlock.tsx`, `components/PromoCarousel.tsx`, `components/ProductRow.tsx`, `components/BrandRow.tsx`, `components/CategoryBar.tsx`, `components/StoreCategoryNav.tsx` |
| Catálogo | `components/ProductGrid.tsx`, `components/ProductCard.tsx`, `components/StoreFilterPanel.tsx`, `components/StoreSortMenu.tsx`, `components/ScrollRow.tsx` |
| Buscador | `components/StoreSearchField.tsx`, `components/StoreQuickSearch.tsx` |
| Ficha | `StoreProductPage.tsx`, `components/ProductGallery.tsx`, `components/ProductMedia.tsx`, `components/ProductQuickView.tsx`, `components/ImageLightbox.tsx`, `components/QuantityStepper.tsx` |
| Carrito y compra | `StoreCartPage.tsx`, `cart/CartDrawer.tsx`, `cart/CartLineList.tsx`, `StoreCheckoutPage.tsx`, `components/DeliveryPicker.tsx`, `StoreOrderPage.tsx` |
| Cuenta | `StoreAccountPage.tsx`, `StoreFavoritesPage.tsx`, `account/*` (pedidos, estado de cuenta, cupones, chip de estado, cajón de pedido) |
| Contenido | `StoreContentPage.tsx`, `pages.tsx` |

**Sistema visual compartido:** `src/theme/tokens.css` (colores y tokens de
suite), `src/theme/tokens.ts` (escalas `C/S/R/D/T`), y `storefront.css`, que
define el ámbito `.sf-scope` con la geometría propia de la tienda — radios,
sombras, tintes de orientación y el rojo de «guardado».

## 2. Qué se puede tocar y qué no

**Permitido (solo por razones visuales):** todo lo listado arriba, más
`src/theme/tokens.ts` para *añadir* escalas, y `storefront.css`.

**Prohibido, sin excepción:**

- Fuentes de datos y sus hooks (`hooks.ts`, `api.ts`, `content.ts`, `search.ts`,
  `promotions.ts`, `delivery.ts`, `checkout.ts`, `favorites.ts`, `cart/*` en su
  lógica de estado).
- Cualquier `supabase/` — migraciones, funciones, RLS.
- Cálculos de dinero, impuestos, descuentos y validaciones.
- Rutas, guards, permisos y el estado en la URL (`?q &c &d &b &sort &ver &p`).
- Los temporizadores de los carruseles y sus reglas de pausa /
  `prefers-reduced-motion`.
- `src/theme/tokens.css`: cambiarlo afecta también al backoffice.

## 3. Contratos que los tests fijan (comprobar antes de tocar)

- `storefront-a11y-seo.test.tsx:145` y `storefront-content.test.tsx` — la portada
  tiene **exactamente un `<h1>`**. Sale de `StoreHero`, del `hero` del CMS
  (`leadingHeading`) o del `<h1>` oculto cuando la cubierta es un carrusel.
- `promos-ui.test.tsx` — la lámina activa se localiza por `h3` y el hover se
  dispara sobre el primer `section`.
- `storefront-content.test.tsx` — el tinte de sección es
  `color-mix(in srgb, var(--accent) 6%, transparent)`; ningún color literal.
- `ProductMedia.test.tsx` — `cover` en la rejilla, `contain` en la ficha.
- `SliderBlock.test.tsx` — una sola diapositiva en el DOM, `contain`, y el
  destino revalidado con `isSafeHref`.

## 4. Problemas visuales encontrados

| # | Hallazgo | Fase |
|---|---|---|
| 1 | La vitrina usaba la escala tipográfica del **backoffice** (`T.body` 13 px, `T.label` 11 px) en 87 sitios. Es densidad de herramienta de trabajo, no de tienda. | P01 |
| 2 | La portada tenía **tres** tratamientos distintos de cabecera de sección, y los tres podían coincidir en pantalla. | P03 |
| 3 | En el mural de campañas, una tarjeta sin enlace reservaba igualmente el hueco del fondo: texto arriba y un agujero debajo. | P03 |
| 4 | En el checkout, correo y teléfono ocupaban cada uno una línea del ancho de una dirección. | P07 |

## 5. Sistema visual propuesto

- **Escala propia de la vitrina** (`TS` en `tokens.ts`): mismos papeles que `T`,
  un escalón más grandes. Cuerpo 14, etiquetas 12, título de sección 21/24.
  El backoffice sigue con `T`, intacto.
- **Una sola cabecera de sección** (`components/SectionHeading.tsx`): titular,
  subtítulo opcional, versalitas opcionales, acción a la derecha y la regla de
  acento que cierra el bloque.
- Geometría, sombras y tintes: **sin cambios**. `storefront.css` ya resuelve eso
  y su razonamiento sigue siendo válido.

## 6. Checklist de no-regresión

- [ ] `npx tsc --noEmit` limpio
- [ ] `npm run lint` limpio
- [ ] `npx vitest run` — la suite entera verde
- [ ] `npm run build` correcto
- [ ] Un solo `<h1>` en la portada
- [ ] Ni un color de marca escrito a mano (el blanco sobre foto no cuenta)
- [ ] Ningún cambio en `supabase/`, en hooks de datos ni en el estado de la URL
