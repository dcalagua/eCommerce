# ADR 011 — CMS, white-label por tokens y búsqueda del catálogo (P11-SaaS)

Fecha: 2026-08-28 · Estado: aceptado · Fase: P11-SaaS

## Contexto

El criterio de aceptación de la fase es una frase con dos mitades que tiran en
direcciones opuestas:

> «PASS si el tenant puede cambiar contenido/branding y mejorar discovery sin
> deploy y sin ejecutar código arbitrario.»

Cuanto más libre es el contenido, más se parece a código. Cuanto más cerrado,
menos sirve para que un comercio cambie su portada sin llamar a nadie. Este ADR
escribe dónde se traza la raya, y por qué esa raya y no otra.

Punto de partida (P10-SaaS): la vitrina pintaba un hero de `store_settings`, un
catálogo entero descargado al navegador y filtrado con un `ilike`, y un único
interruptor de marca blanca. El dominio `content` estaba declarado `partial` y
`content.cms` era una capacidad `declared` sin nada detrás.

---

## Decisión 1 — El contenido enriquecido **no es HTML**

Hay dos formas de cumplir «rich content sanitizado» y solo una envejece bien:

| Camino | Qué hay que mantener | Cómo se rompe |
|---|---|---|
| Guardar HTML y sanearlo | una lista de etiquetas y atributos, al día contra cada `mXSS` nuevo | una ruta de renderizado que se salte el saneador: un correo, un export, un `dangerouslySetInnerHTML` puesto con prisa |
| **No guardar HTML** | un vocabulario de cuatro nodos | no hay cadena que escapar mal porque no hay cadena que interpretar |

Se elige el segundo. El documento es un **array plano** de `paragraph`,
`heading`, `list` y `quote`, con seis claves posibles y **ninguna más**: una
clave desconocida no se ignora al leer, invalida el nodo entero. Lo impone
`ebim.rich_text_is_safe` como CHECK —así que tampoco entra por PostgREST con un
token robado ni por un script del operador— y lo replica `richTextNodeSchema`
con `.strict()` en el cliente, para que el editor lo diga antes de Guardar.

**Sin anidamiento.** Un árbol admite profundidad arbitraria, y la profundidad
arbitraria es en la práctica un lenguaje: con su coste de validación, de
renderizado y de auditoría.

**Lo que cuesta:** un editor visual completo (tablas, imágenes en línea, colores)
no cabe. El editor es texto con cuatro marcas mínimas. **Lo que se gana:**
«¿puede el tenant ejecutar código?» tiene una respuesta demostrable en vez de
una lista de mitigaciones, y hay un test de arquitectura que la mantiene cierta:
`dangerouslySetInnerHTML` no aparece en ningún archivo de `src/`.

### El enlace: lista BLANCA

`javascript:` es el que todo el mundo recuerda; `data:text/html`, `vbscript:` y
el protocolo-relativo `//otro-dominio` hacen daño igual. Con lista blanca
—`https:`, ruta interna, `mailto:`, `tel:`— el esquema que nadie ha pensado
todavía cae en el lado de «no». Se comprueba en tres capas, y no es exceso: el
CHECK de la base, el esquema al leer la respuesta y el propio componente, porque
ese es el punto donde un valor del tenant entra al DOM.

---

## Decisión 2 — El bloque tiene tipo cerrado y columnas tipadas

Misma decisión que P10 tomó con `promotion_scopes`, y por el mismo motivo: un
`config jsonb` con ids dentro no tiene FK, así que una colección que apunta a un
producto borrado se queda viva enseñando un hueco. Con `content_block_items` y
FK compuestas tenant-safe, borrar el producto se lleva su fila por delante — hay
un test que lo comprueba.

El coste asumido y escrito: **añadir un tipo de bloque es escribir código**. Por
eso el enum tiene siete valores y no veinte.

`settings` existe para que «dos columnas o tres» no sea un tipo nuevo, y por eso
tiene **vocabulario cerrado**: doce claves, valores escalares, nada anidado. En
el momento en que admitiera un objeto, sería el sitio donde alguien mete una URL
de script «porque es solo configuración».

### La técnica del PIM, otra vez

`content_block_items.block_type` va denormalizado con `on update cascade` contra
`content_blocks (id, block_type)`. Es lo que permite que un CHECK mire el tipo
del padre: un item bajo un `hero` no entra, y cambiar el tipo de un bloque que
ya tiene items lo rechaza la cascada. La misma técnica con la que P03 impide una
variante bajo un producto simple y P10 un alcance de combo sin cantidad.

---

## Decisión 3 — La resolución vive en la base, con orden TOTAL

Una tienda puede tener tres portadas a la vez —la de siempre, la de rebajas que
arranca el viernes y la del canal mayorista— y solo una es la buena para este
visitante en este instante. Esa decisión vive en `ebim.content_pick_page`, y
vive ahí por dos motivos que no son de comodidad:

1. **El borrador no puede salir.** Si la vitrina leyera las tablas y filtrara en
   el navegador, el borrador de la campaña de Navidad viajaría por la red en
   noviembre. `anon` **no tiene ni un GRANT** sobre las tres tablas del CMS: no
   hay policy pública que pueda estar mal escrita, no hay lectura pública.
2. **La vista previa no puede mentir.** El editor llama a `content_preview` y la
   vitrina a `store_page_for_slug`; las dos llaman a la MISMA
   `ebim.resolve_content`. Una vista previa calculada aparte se separa un día y
   ese día no avisa: alguien publica confiando en lo que vio.

El orden es **total**, con la técnica de la precedencia de P04:

```
canal específico > canal nulo  →  priority desc  →  publish_from desc  →  id
```

El último desempate no es decorativo: sin él, dos páginas empatadas darían una
portada distinta según el plan de ejecución, y el comercio no tendría forma de
explicar por qué su tienda cambia sola.

**Degradación, no fallo.** Sin `content.cms` la respuesta trae `cms: false` y
cero bloques; no lanza. La vitrina cae a lo que pintaba antes de esta fase, que
es lo que P04 hizo con el motor de precios y P06 con el inventario.

---

## Decisión 4 — White-label por tokens, y la raya del addon premium

El encargo pide «extiende el branding mediante tokens» y «no dupliques
componentes por tenant». Son la misma decisión vista por los dos lados: si la
personalización es un token, el componente es uno; en cuanto una tienda necesita
«su» tarjeta, hay dos tarjetas y a la tercera hay cinco.

Se añaden a `store_settings`: `font_family`, `ui_radius`, `ui_density`,
`business_display_name`, `email_from_name`, `email_reply_to` y el metadato del
dominio propio. Y se cierra de paso una deuda de P07: `favicon_url` era la única
referencia de asset de branding **sin CHECK**.

### La tipografía es un TOKEN de una lista cerrada, nunca una URL

Cinco valores, y las cinco pilas se resuelven sin una petición de red nueva:
`dm-sans` ya viene cargada y las otras cuatro son del sistema. Dejar que el
tenant escriba una `@font-face` con su URL sería cargar un recurso remoto
elegido por el cliente en el dominio de la vitrina: no es JavaScript, pero es la
misma clase de agujero. «No permitir JavaScript arbitrario» no se cumple
permitiendo CSS arbitrario.

### Dónde está la raya de lo premium

`content.white_label` gatea las cuatro cosas que hacen que la tienda —y su
correo— dejen de parecer de la suite: `white_label`, `font_family`, la identidad
de correo y el dominio propio. **No** gatea el acento, el logo, el favicon, el
radio ni la densidad: eso es tematización, el lockup «by EBIM» sigue puesto, y
cobrar por elegir esquinas redondeadas sería vender una casilla en vez de una
capacidad.

### Retirar el addon apaga su efecto — por TODOS los caminos

P02-SaaS resolvió esto dentro de `sync_platform_context`, que es **un** camino.
P11 lo pone en un trigger sobre `tenant_entitlements`, que cubre la
sincronización del hub, una corrección manual del operador y cualquier camino
futuro. Lo premium vuelve a nulo; lo que no lo es sobrevive, porque dar de baja
un módulo no puede parecer una pérdida de configuración.

### La densidad de la tienda es un DEFAULT, no una imposición

Si el visitante ya eligió densidad en su dispositivo, la suya manda. La tienda
decide cómo se ve para quien llega sin preferencia; pisar una preferencia que a
menudo es de accesibilidad sería convertirla en una decisión del comercio.

---

## Decisión 5 — La búsqueda vive en Postgres, detrás de un puerto

### Por qué no un motor externo, hoy

Un índice externo es un segundo almacén que hay que sincronizar, y un segundo
almacén **sin RLS**: el aislamiento entre tenants pasaría a depender de que cada
consulta se acuerde de filtrar por `organization_id`, que es exactamente el
modelo que el contrato §0 prohíbe. Con FTS + `pg_trgm` la búsqueda ocurre dentro
de la base que ya tiene las policies.

El día que el volumen lo pida, cambiar de motor es escribir otro adaptador del
`SearchPort` — no reabrir el dominio. Eso es lo que el encargo pide con «deja el
contrato preparado para Meilisearch/OpenSearch/Algolia».

### Las cinco propiedades del motor

1. **El índice es una columna GENERADA.** `products.search_vector` no puede
   discrepar de `name`/`slug`/`description` porque no se escribe: se deriva. Un
   trigger tendría un estado «índice desincronizado» que solo se descubre
   buscando algo y no encontrándolo.
2. **Los acentos se normalizan en el dato y en la consulta, con la misma
   función.** `unaccent` no vale: es `STABLE` y una columna generada exige
   `IMMUTABLE`. `ebim.search_normalize` es una tabla de traducción fija.
3. **Los trigramas son el PLAN B.** Primero FTS con prefijo —rápido, indexado,
   con lematización—; si eso no devuelve nada, similitud. Al revés sería pagar
   un recorrido caro en el 95 % de las búsquedas sin erratas. Y en el plan B
   **todos** los términos tienen que parecerse: sin esa condición, «bota
   lámpara» devolvería las dos cosas y el Y de la búsqueda se habría convertido
   en un O silencioso.
4. **El `mode` viaja en la respuesta** (`fts` / `fuzzy` / `browse` / `empty`) y
   sale del ORIGEN de las filas, no de que haya filas. Un resultado por parecido
   no es lo mismo que uno exacto, y decirlo es la diferencia entre ayudar y
   fingir.
5. **Las facetas salen del servidor.** Contar marcas y categorías en el
   navegador exige traerse el catálogo entero, que es la línea que el encargo
   prohíbe cruzar por escrito. Por lo mismo, la portada de la vitrina dejó de
   pedir `public_products` sin límite: ahora pide una PÁGINA.

### El puerto, por fin

`ports/index.ts` llevaba desde P01 explicando por qué `SearchPort` **no** se
creaba y dejando escrito el disparador: «el día que aparezca un índice o motor
de búsqueda propio (P11 / P15)». Ese día llegó, y con él las dos
implementaciones que la regla del repositorio exige, que no son dos capas de lo
mismo:

| Implementación | Actor | Qué responde |
|---|---|---|
| `catalog_search_for_slug` | comprador anónimo | solo lo publicado, con precio resuelto y semáforo |
| `catalog_search` | backoffice con sesión | además lo NO publicado |

Es la misma forma que `InventoryPort` tiene desde P06. El primer llamante de la
segunda es el **selector de productos del editor de contenido**, que cierra la
deuda que P10 dejó escrita al no poner buscador en el editor de alcance de
campañas.

### Los sinónimos son DATOS

«Zapatilla = tenis = championes» cambia por país y por sector. Que fuera código
significaría que ayudar a un comercio a vender es una versión nueva de la
aplicación — justo lo que la fase tiene que hacer imposible. `term_normalized`
es GENERADA y el índice único va sobre ella, así que «Zapatilla» y «zapatillas »
son el mismo término porque lo dice el dato (lección de los cupones de P10).

---

## Alternativas descartadas

- **Un editor WYSIWYG con saneado de HTML.** Descartado en la decisión 1: mueve
  la seguridad a una lista que hay que mantener y basta una ruta de renderizado
  para perderla.
- **`rules jsonb` en el bloque.** Descartado en la decisión 2: sin FK, una
  colección sobrevive al producto que enseña.
- **Resolver el contenido en el navegador.** Descartado en la decisión 3: el
  borrador viajaría por la red.
- **Tipografía por URL.** Descartado en la decisión 4: contenido remoto elegido
  por el cliente en el dominio de la vitrina.
- **Meilisearch/Algolia ahora.** Descartado en la decisión 5: un segundo almacén
  sin RLS. El puerto queda escrito para el día que el volumen lo justifique.
- **Un `store_id` en la petición de búsqueda pública.** La tienda sale del slug
  de la URL, resuelto contra tiendas activas. Un parámetro que se puede pasar se
  puede pasar mal.

## Lo que NO se hizo, y cuál es el disparador de cada cosa

- **`content_revisions` (historial de versiones).** Hoy `updated_at` más el
  hecho de que solo `owner`/`admin` escriben responde «¿quién cambió la
  portada?». El disparador es el primer tenant con varios editores y publicación
  delegada, que es una decisión de roles (P16) antes que de contenido.
- **Experimentos A/B.** Repartir visitantes exige una identidad estable del
  visitante anónimo —que choca con que el comprador de esta vitrina es anónimo
  por diseño— y un modelo de medición, que es P13.
- **Traducción del contenido por idioma.** Un bloque con dos textos obliga a
  decidir qué pasa cuando solo uno está escrito, y esa es una decisión de
  producto. El disparador es el primer tenant que venda en dos idiomas a la vez.
- **La comprobación DNS del dominio propio.** El metadato y el token existen;
  comprobar el TXT es trabajo de infraestructura, fuera del alcance de una
  migración. Lo que sí está hecho es que no se pueda saltar: el estado de
  verificación **no tiene GRANT de escritura** para `authenticated`.
- **Firmar las imágenes en la vista previa del editor.** Exigiría montar el
  cliente anónimo de la vitrina dentro del backoffice —otro cliente, otras
  policies— para una previsualización. El editor ve el hueco neutral y la
  pantalla lo dice.
- **Bloque de «envío gratis» o similares atados a fulfillment.** No hay motor de
  entrega hasta P12; sería una casilla que no hace nada.
