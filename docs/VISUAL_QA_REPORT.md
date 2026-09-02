# QA visual y no-regresión (P12)

Cierra la corrida P00–P12 hecha directamente contra `src/`, después de que el
arnés `claude_visual_ecommerce_opus/` marcara las 13 fases en verde sin aplicar
nada. Plan e inventario en [`VISUAL_REDESIGN_PLAN.md`](./VISUAL_REDESIGN_PLAN.md).

## Comandos y resultado

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | limpio |
| `npm run lint` | limpio |
| `npx vitest run` | **2731 pasan · 133 ficheros** |
| `npm run build` | correcto (12,4 s) |

> Una corrida intermedia de `vitest` dio 1 fallo y 50 saltados con el doble de
> duración; al repetirla salió verde entera y con cero saltados. Fue contención
> de recursos por dos procesos de test a la vez, no una regresión. Queda dicho
> porque un informe que solo enseña la corrida buena no es un informe.

## Archivos modificados

**Nuevos**

- `src/features/storefront/components/SectionHeading.tsx` — la cabecera de
  sección, una sola para toda la vitrina.
- `docs/VISUAL_REDESIGN_PLAN.md`, `docs/VISUAL_QA_REPORT.md`.

**Modificados**

- `src/theme/tokens.ts` — añade la escala `TS`. **No toca `T`**: el backoffice
  queda exactamente igual.
- 29 ficheros de `src/features/storefront/**` — sustitución de `T.` por `TS.`.
  Solo tamaños de fuente; ni un cambio de lógica.
- `components/ProductRow.tsx`, `components/BrandRow.tsx`,
  `components/PromoCarousel.tsx`, `components/ContentBlocks.tsx` — adoptan
  `SectionHeading`.
- `components/ContentBlocks.tsx` — la tarjeta de campaña sin enlace centra su
  contenido en vez de reservar el hueco del fondo.
- `StoreCheckoutPage.tsx` — correo y teléfono comparten fila desde `sm`.

## Mejoras aplicadas, por fase

- **P00** Inventario, lista de permitidos/prohibidos y los cinco contratos que
  los tests fijan (un solo `<h1>`, el `h3` de la lámina de promoción, el tinte
  por `color-mix`, `cover`/`contain` de la foto, el carrusel).
- **P01** Escala tipográfica propia de la vitrina. Era el hallazgo de fondo: la
  tienda usaba la escala del backoffice —cuerpo 13 px, etiquetas 11 px— en 87
  sitios. Un catálogo a 13 px se lee como un listado de inventario.
- **P03** Una sola cabecera de sección donde había tres, y el agujero del mural
  de campañas. Además, de esta misma sesión: el carrusel de imágenes con
  disposición mosaico, la imagen sin recortar, el tinte por sección y el hero de
  reserva que ya no aparece cuando el CMS pone cubierta.
- **P07** El emparejado de correo y teléfono en el formulario de compra.
- **P10** Auditoría de responsive y accesibilidad: `:focus-visible`,
  `prefers-reduced-motion` y `overflow-x: clip` ya estaban resueltos en
  `tokens.css` y `storefront.css`. Los anchos fijos que quedan (168 px y 190 px)
  viven dentro de filas de desplazamiento horizontal y no desbordan.

## Fases sin cambios, y por qué

**P02 (header), P04 (tarjetas), P05 (catálogo), P06 (ficha), P08 (favoritos y
cuenta), P09 (pedidos y cupones), P11 (pulido).** La vitrina ya tenía trabajo de
diseño hecho y bueno: `.sf-scope` con su geometría, sombras y tintes de
orientación; la tarjeta de producto con cuatro niveles de jerarquía y el enlace
estirado sobre el nombre; los iconos de cabecera con color por acción. Cambiar
esas zonas habría sido churn con riesgo de regresión sobre una suite verde de
2731 pruebas, no mejora. Lo aplicado es lo que estaba de verdad mal.

**P10 (footer) — no hecho a propósito.** El prompt pide reconstruir el pie, pero
`StorefrontLayout.tsx` lo eliminó deliberadamente y documenta por qué.
Reconstruirlo revierte una decisión de producto; no es un cambio visual neutro.

## Riesgos revisados

- **Lógica intacta.** Ni un endpoint, servicio, modelo, hook de datos, cálculo,
  validación, ruta ni permiso tocado. La sustitución `T.` → `TS.` afecta solo a
  `fontSize`.
- **Un solo `<h1>`.** `SectionHeading` es `h2` por defecto; el test que lo fija
  sigue verde.
- **Contratos de test.** `promos-ui` (el `h3` de la lámina y el primer
  `section`) y `storefront-content` (el `color-mix` del tinte) siguen pasando:
  `SectionHeading` no introduce un `section` propio ni toca `TINTES`.
- **Backoffice.** `T` sin tocar y `tokens.css` sin tocar. La escala nueva solo
  se importa desde `src/features/storefront`.
- **Colores de marca.** Cero literales nuevos. Los `#FFFFFF` que quedan son
  texto sobre foto o sobre velo oscuro, donde el blanco debe seguir siendo
  blanco en los dos temas.

## Pendientes

- El arnés `claude_visual_ecommerce_opus/` sigue sin versionar y **roto**: le
  falta `--permission-mode` y su `project_dir` apunta a sí mismo. Tal como está,
  cualquier corrida futura volverá a dar 13 fases verdes sin hacer nada. O se
  arregla o se borra.
- Nada de esto está commiteado.
