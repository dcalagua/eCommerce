# ADR 015 — SPA con metadatos en cliente y sitemap generado, en vez de migrar de framework

- **Fase**: P15-SaaS
- **Fecha**: 2026-08-30
- **Estado**: aceptada
- **Contexto previo**: [ADR 003](003-pim-variantes-uom-kits.md) (variantes y
  kits: el «desde» de la ficha), [ADR 004](004-pricing-engine.md) (el precio se
  vuelve a resolver al confirmar; lo que se pinta es escaparate),
  [ADR 011](011-cms-white-label-search.md) (contenido administrable, colecciones
  y white-label por tokens: la marca es del tenant),
  [ADR 013](013-analytics-audit-observability.md) (analítica sin PII: el evento
  `search` y su recuento).
- **Encargo**: `claude-saas-opus/prompts/15_storefront_performance_seo.md` —
  «analiza si Vite SPA actual cubre necesidades del producto; crea un ADR
  comparando SPA + prerender vs storefront SSR/SSG separado vs migración de
  framework; **NO migres a Next/Remix u otro framework sin una decisión
  documentada y beneficio medible**».

---

## 0. La pregunta, y por qué no se responde con una preferencia

La vitrina es una SPA de Vite. Un buscador que la visita recibe un `index.html`
vacío y tiene que ejecutar JavaScript para ver un producto. Eso es un hecho de
la arquitectura, no una opinión, y la tentación evidente es migrar a Next o a
Remix «porque el SEO».

El encargo lo prohíbe sin decisión documentada y beneficio medible, y tiene
razón por un motivo que es específico de ESTE producto y no general: **una
aplicación, N tiendas**. Lo que en un sitio único se resuelve con SSG —generar
en el build el HTML de cada producto— aquí no se puede ni empezar: en tiempo de
build no existen las tiendas, no existe el catálogo y no existe el tenant. La
lista de productos a renderizar es una consulta a Postgres con RLS, y la RLS
necesita una petición.

---

## 1. Las tres opciones, comparadas

| | **A · SPA + metadatos en cliente** (elegida) | **B · Storefront SSR/SSG separado** | **C · Migrar a Next/Remix** |
|---|---|---|---|
| **HTML inicial** | vacío; el buscador ejecuta JS | completo | completo |
| **Google** | indexa: renderiza JS desde 2019 | indexa | indexa |
| **Bing / redes sociales** | **no ejecutan JS**: el `og:` que ven es el del `index.html` | correcto | correcto |
| **Multitenant** | resuelto: el tenant sale del slug de la URL contra `public_stores` | hay que resolver el tenant **en el servidor** y llevar el JWT/anon hasta allí | igual, y además el backoffice se queda fuera o se migra también |
| **Coste** | ~700 líneas, cero dependencias nuevas | una aplicación más que desplegar, versionar y vigilar | reescribir router, layouts, providers y 98 archivos de test |
| **Riesgo de aislamiento** | ninguno nuevo: se lee lo mismo que ya lee el comprador anónimo | **alto**: un servidor propio es un sitio nuevo donde equivocarse con `service_role` | alto, y de golpe |
| **Reversible** | sí: los metadatos son un hook | sí | **no** |

### Por qué no B, hoy

B es la respuesta correcta el día que un tenant venda a consumidor final y le
importe compartir fichas en redes sociales. No lo es hoy porque el aislamiento
es el activo que más cuesta recuperar: un renderizador de servidor es un lugar
nuevo donde una consulta puede ejecutarse sin el tenant en el filtro, y este
repo lleva catorce fases construyendo la propiedad contraria —el tenant sale del
JWT o del slug resuelto contra una vista pública, nunca de un parámetro—.
Abrirlo antes de que exista la necesidad es pagar el riesgo por adelantado.

### Por qué no C, nunca por este motivo

Migrar de framework para arreglar el `<head>` es cambiar el edificio para
cambiar una cerradura. El SEO de C se consigue con B sin tocar el backoffice, y
lo que C añade sobre B —convenciones de enrutado— este repo no lo necesita: su
router ya está partido por `lazy` y medido.

### Lo que sí se descartó por medición, no por criterio

**Prerender en el build** (`vite-plugin-prerender` y equivalentes). No se
descarta por gusto: **no puede funcionar aquí**. Prerenderizar exige conocer las
rutas en tiempo de build, y las rutas de esta aplicación son `/s/:slug` y
`/s/:slug/product/:slug` — el conjunto de valores vive en la base de datos de un
proyecto Supabase al que el build no se conecta, y crecería con cada producto
que publique cualquier tenant. Un prerender parcial dejaría media vitrina con
HTML viejo, que es peor que no tener ninguno.

---

## 2. La decisión: A, con tres condiciones que la hacen honesta

### 2.1 Los metadatos se escriben en el cliente, y se LIMPIAN

`src/shared/seo/meta.ts` (puro: decide) + `useDocumentMeta.ts` (efecto: escribe).
Están separados porque lo que puede salir mal —qué se indexa, con qué identidad,
con qué canonical— se comprueba con un test de función, no montando un DOM.

Lo que no es negociable es la limpieza. Una SPA no recarga el documento: una
etiqueta que sobrevive al desmontaje acaba **describiendo la página anterior**, y
el caso concreto es la ficha de un producto agotado declarando
`availability: InStock` porque el JSON-LD de la ficha anterior sigue en el
`<head>`. Todo lo que pone el hook lleva `data-ebim-meta` y se retira entero.
Hay un test que lo comprueba desmontando.

Sin librería: son cinco etiquetas, un `<title>`, un `<link>` y un `<script>`.
`react-helmet-async` cuesta ~7 kB gzip **en el chunk de entrada** —el que
descarga todo el mundo— para resolver una concurrencia que aquí no existe,
porque hay una sola pantalla montada a la vez.

### 2.2 Lo que no existe y lo que es privado, `noindex`

Una SPA responde 200 a todo. Sin esto, un slug de tienda que no resuelve o una
ficha despublicada se indexan como página vacía —el «soft 404» clásico— y lo que
queda en el índice de un buscador es una tienda del cliente enseñando «no
encontramos eso».

Y las cuatro rutas privadas —`/cart`, `/checkout`, `/account`, `/order/`— llevan
`noindex, nofollow`. No es pudor: son estado de una sesión, no contenido, y el
seguimiento además lleva el token del pedido en la cadena de consulta. Las
mismas cuatro llevan `Disallow` en `public/robots.txt` y **no aparecen** en el
sitemap. Tres señales, la misma lista, y un test por cada una: `robots.txt` pide
que no se RASTREE y no impide que se indexe una URL enlazada desde fuera.

### 2.3 El sitemap se GENERA por tienda, y se lee con el cliente anónimo

`supabase/functions/storefront-seo` sirve `/s/:slug/sitemap.xml` y
`/s/:slug/robots.txt`. No hay archivo commiteado porque un archivo estático
estaría viejo el día que un tenant publique un producto, y porque en tiempo de
build no existen las tiendas (§0).

La decisión que importa: **la función no usa `service_role`**. Lee con
`anonClient`, exactamente igual que la vitrina. Así lo máximo que puede llegar a
publicar es lo que ya publica el catálogo — si mañana cambia una policy, cambia
el sitemap con ella. Con `service_role`, un despiste aquí publicaría en un
buscador el catálogo **sin publicar** de un tenant, y eso no se arregla revisando
código: hay que hacerlo imposible. El origen se valida (`https` o local) porque
llega en una cabecera que escribe el cliente, y lo que no es un slug no entra en
el XML.

---

## 3. Rendimiento: lo que se midió y lo que cambió

Todo lo de esta sección sale de `npm run build` y de `npm run bundle:report`. El
techo y el método están en [`docs/performance-budget.md`](../performance-budget.md).

| | P14 (`8d5547d`) | P15 | |
|---|---|---|---|
| chunk de entrada | 970,90 kB (**283,38 kB gzip**) | 360,72 kB (106,77 kB gzip) + proveedor repartido | |
| bytes gzip hasta el primer pintado de la **portada** | ~283 kB + ruta | **334,6 kB** total (251,8 entrada + 82,9 ruta) | techo 400 |
| bytes gzip · **ficha de producto** | — | **309,1 kB** | techo 400 |
| bytes gzip · **checkout** | — | **330,3 kB** | techo 430 |
| bytes gzip · **backoffice** | — | **298,1 kB** | techo 430 |

Cuatro cambios, y el motivo de cada uno:

1. **El diccionario del idioma que no se lee deja de viajar.** Pesaba
   **61,76 kB gzip** del bundle de entrada y la mitad eran un idioma que el
   visitante no va a abrir. Un objeto literal no se tree-shakea por mitades, así
   que se partió: `messages.es.ts` es estático —es el suelo del fallback y sin él
   un fallo de red deja la pantalla con claves crudas— y `messages.en.ts` entra
   por `import()` (114,26 kB / **30,09 kB gzip**, en su propio chunk). Mientras
   llega se traduce en español: un texto en el idioma equivocado se entiende, una
   clave cruda no.

2. **El proveedor se reparte en chunks estables.** No ahorra bytes en la primera
   visita —se descargan igual, en paralelo— y los ahorra en todas las demás: antes
   cualquier cambio de una línea de la aplicación cambiaba el hash del único
   chunk compartido y el visitante volvía a descargarse React, MUI y
   `supabase-js` enteros. `@mui/material` **no** se agrupa a propósito: Rollup ya
   lo reparte, y juntarlo arrastraba `TextField`, `Autocomplete`, `Modal`, `Tabs`
   y `TablePagination` —hoy perezosos— al primer pintado: medido, +8,5 kB gzip
   para quien solo abre la vitrina.

3. **«Ver más» pagina de verdad contra el servidor.** Antes subía el `limit` y
   volvía a pedir desde el desplazamiento cero: la segunda página descargaba 48
   productos para enseñar 24 nuevos, la tercera 72 para enseñar 24. Ahora cada
   página pide su tramo con `offset`. Y `fetchPublicProducts` lleva el techo
   SIEMPRE: sin `limit`, PostgREST devuelve lo que la política del proyecto
   permita —una categoría con dos mil referencias se descargaba entera para
   pintar cuatro relacionados—.

4. **Se adelanta lo que está en el camino crítico y se retrasa lo que no.**
   `preconnect` al proyecto Supabase (inyectado desde el plugin, porque la URL
   cambia por despliegue y un `preconnect` a un proyecto que no es abre una
   conexión inútil); el hero con `fetchPriority="high"` y sin `lazy` porque es el
   candidato a LCP; las miniaturas del catálogo perezosas; `aspectRatio`
   declarado en banner y campaña para que el texto no salte media pantalla
   cuando llega la imagen; y prefetch de la ficha **al apuntar o enfocar** una
   tarjeta, no al pintarla — precargar las 24 fichas de la rejilla convierte un
   ahorro en 24 consultas que casi nadie usa.

**Lo que NO se declara**: ninguna puntuación de Lighthouse. No se ha medido en
un navegador real contra un despliegue real, y el encargo pide explícitamente no
declarar 100 sin medición. Lo que sí es medible y está automatizado es el
presupuesto de bytes: `npm run bundle:report` sale con código 1 si un recorrido
se pasa.

---

## 4. Accesibilidad: tres cosas que faltaban

- **Salto al contenido.** Sin él, llegar al catálogo con el teclado obliga a
  pasar por el logo, el menú, la cuenta y el carrito en **cada** página. El
  destino ya existía (`id="contenido"`); faltaba el enlace, y faltaba
  `tabIndex={-1}` en el destino: sin eso el salto mueve el scroll pero **no el
  foco**, y el siguiente Tab vuelve al principio de la cabecera.
- **Un solo `<h1>` por página.** Cuando el hero del CMS sustituye al de
  `store_settings`, es él quien lo lleva: antes la portada se quedaba sin nivel 1
  en cuanto el comercio publicaba una portada, y el documento empezaba por un
  `<h2>`. En `/p/:slug` el `<h1>` sigue siendo el título de la página — un
  segundo `<h1>` no ordena, desordena.
- **`prefers-reduced-motion`, de verdad.** Hasta P14 solo apagaba el isotipo y
  la tarjeta de producto; los ~20 componentes de MUI que animan por defecto
  —Drawer, Dialog, Collapse, Skeleton, Ripple— seguían moviéndose, que es justo
  la lista que marea a quien pide no ver movimiento. Se apagan con `0.01ms` y no
  con `0`: con duración cero muchos navegadores **no disparan**
  `transitionend`/`animationend` y los componentes que esperan ese evento para
  desmontarse se quedan colgados.

Y el buscador de la portada es ahora un landmark `role="search"`: un lector de
pantalla lo lista junto a la cabecera y el pie, en vez de dejarlo a diez saltos
del principio en una tienda con hero y bloques.

---

## 5. Lo que queda pendiente, y de quién depende

1. **Publicar `/s/:slug/sitemap.xml` en el dominio de la tienda.** La función
   existe y está probada; que `https://tienda/s/:slug/sitemap.xml` llegue a ella
   es una regla de reescritura del hosting. **Esta fase no despliega**
   (contrato §11). Es configuración del proyecto, igual que el planificador de
   `integration-worker` desde P14.
2. **Medir en un navegador real.** Web Vitals de campo exigen un despliegue con
   tráfico. Hasta entonces, el número que este repo puede defender es el de
   bytes, y está automatizado.
3. **Revisar la decisión si aparece B2C.** El disparador está escrito: el día que
   un tenant necesite que Bing o una red social vean la ficha sin ejecutar
   JavaScript, la opción B deja de ser prematura. Nada de lo construido aquí
   estorba entonces —`meta.ts` es puro y su salida sirve igual para un `<head>`
   renderizado en servidor—.

---

## 6. Lo que este ADR NO decide

- **No migra a Next ni a Remix.** El encargo lo condiciona a un beneficio
  medible; el beneficio medible es HTML inicial para clientes que no ejecutan JS,
  y hoy no hay ningún tenant B2C que lo necesite. Cuando lo haya, la opción es B,
  no C.
- **No introduce un servidor de renderizado.** Sería un lugar nuevo donde una
  consulta puede perder el filtro de tenant, y el aislamiento no se recupera.
- **No toca el modelo de datos.** P15 no trae ni una migración: es fase de
  entrega, no de dominio.
