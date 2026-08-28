# ADR 003 — PIM: variantes, atributos, unidades de venta y kits

- **Estado:** aceptada
- **Fecha:** 2026-08-27
- **Fase:** P03-SaaS (productización)
- **Contexto previo:** [`ADR 001`](001-domain-boundaries.md) §1 (frontera `catalog`),
  [`ADR 002`](002-capabilities-entitlements.md) §2 (`catalog.advanced` era `declared`),
  [`SAAS_ROADMAP.md`](../SAAS_ROADMAP.md) §2
- **Contrato EBIM:** §0.2 (personalización = configuración, nunca fork de schema), §3 (jerarquía
  `organization` → `company` → datos), §4.2 (eliminación segura con conteo de uso real), §8
  (tabs centrados, un buscador general)

---

## Contexto

El catálogo que dejó P02 resuelve bien un producto **simple**: un SKU, un precio, una cantidad. Lo
que no sabe expresar es lo que cualquier catálogo real necesita a partir de unos cientos de
referencias:

- la misma camiseta en cuatro tallas y tres colores, cada combinación con su existencia;
- el mismo jabón vendido por unidad y por caja de doce, con precio de caja que no es doce veces el
  de la unidad;
- un «pack de bienvenida» que se vende como un producto y descuenta tres productos distintos;
- y atributos que sirvan para **filtrar**, no solo para leerse en la ficha.

`catalog.advanced` existía desde P02 como capacidad `declared`: había gating y no había módulo. Esta
fase es la primera validación real de aquel diseño — y la primera vez que una capacidad vendible
pasa de `declared` a tener superficie.

## Decisión

### 1. El producto sigue siendo el maestro único; el tipo es una columna

`products.kind` (`simple` | `variant` | `bundle`) dice qué es un producto desde el punto de vista de
la venta. **No hay tabla `bundles`.**

Un kit es un producto vendible con su SKU, su precio, sus imágenes y su publicación. Darle tabla
propia habría duplicado la identidad del producto —dos sitios donde vive un SKU, dos publicaciones
que sincronizar, dos vistas públicas— y eso es exactamente lo que la regla «producto maestro único;
el canal no duplica el SKU» prohíbe. Lo que sí es nuevo es `bundle_items`: la **receta**.

La misma lógica para las variantes: el maestro es el producto y `product_variants` son sus filas
vendibles. El maestro **no se vende**; `create_order` lo rechaza con `VARIANTE_REQUERIDA`.

### 2. Vocabulario a nivel de SOCIEDAD; lo que cuelga del producto, a nivel de TIENDA

| Tabla | Alcance | Por qué |
|---|---|---|
| `brands`, `product_families`, `attributes`, `attribute_values`, `units_of_measure` | sociedad | Se reusan en todas sus tiendas. Duplicarlos por tienda obliga a mantener «Talla M» en N sitios y a que un día el logo de una marca cambie en una tienda y no en la otra. |
| `product_variants`, `variant_attribute_values`, `product_attribute_values`, `product_uoms`, `bundle_items`, `product_relations` | tienda | Cuelgan del producto, y el producto es de una tienda. |

Es la regla 8 de la fase: `store_id` **solo** si la entidad pertenece de verdad a una tienda. Las
once tablas llevan `organization_id` + `company_id`, y las de tienda amarran su tenant al de la
tienda por FK compuesta, igual que hacía P02 con `categories` y `products`.

### 3. Los atributos son relacionales; `custom_fields` no desaparece pero no crece

`custom_fields` (JSONB) sigue existiendo para extensiones **no críticas** del tenant. Lo que se saca
de ahí —y lo que nunca debió entrar— es todo lo que tiene que filtrar, agrupar o definir variantes:

- `attributes` declara qué se puede decir de un producto y de qué tipo;
- `attribute_values` es el dominio cerrado de los atributos de lista;
- `product_attribute_values` es la ficha técnica, con **una columna por tipo** y un CHECK que exige
  exactamente una rellena;
- `variant_attribute_values` es la combinación que ES cada variante.

Un `jsonb` con `"color": "rojo"` en un sitio y `"Rojo"` en otro no filtra: agrupa mal, no tiene
índice útil y nadie se entera hasta que el catálogo tiene tres mil SKUs. Los índices
`product_attribute_values_filter` y `..._number` son la mitad del argumento; la otra mitad es que un
valor tiene FK a su atributo y no puede inventarse.

Lo que **no** se hizo: convertir el modelo entero a EAV. El precio, la existencia, el SKU, el estado
y la publicación siguen siendo columnas de `products`. Un EAV total habría hecho ilegible la consulta
del listado y habría tirado los CHECK de dinero que P02 puso.

### 4. Cuatro reglas del modelo se impiden en la base, no en la pantalla

Ninguna es un trigger cuando puede ser declarativa. Las cuatro usan la misma técnica —una columna
**denormalizada** con CHECK, amarrada por FK a una clave de apoyo del padre, con `on update
cascade`— que consigue algo que un CHECK normal no puede: mirar una fila de otra tabla.

| Regla | Cómo | Qué error evita |
|---|---|---|
| Una variante solo cuelga de un producto `kind = 'variant'`, y ese producto no se puede degradar mientras tenga variantes | `product_variants.product_kind` + FK a `products (id, kind)` | «El producto dice que es simple y tiene cuatro variantes»: `create_order` vendería el maestro y descontaría una existencia que nadie lleva |
| Un valor solo cuelga de un atributo de tipo lista, y un atributo con valores en uso no se puede convertir en texto libre | `attribute_values.attribute_data_type` + FK a `attributes (id, data_type)` | Valores huérfanos de un dominio que ya no existe |
| Solo un atributo declarado **eje** define variantes | `variant_attribute_values.is_axis` + FK a `attributes (id, is_variant_axis)` | «Material» partiendo el catálogo en filas cuando es descriptivo |
| No hay kits dentro de kits, ni se puede convertir en kit un producto que ya es componente | `bundle_items.component_kind <> 'bundle'` + FK a `products (id, kind)` | El cálculo de existencia por componentes deja de ser finito |

Y una quinta, esta sí con trigger porque ningún índice puede expresarla:
`ebim.assert_sku_unique_in_store` mantiene **un solo espacio de nombres de SKU por tienda** entre
`products` y `product_variants`. Un producto simple y una variante con el mismo SKU es una
ambigüedad que termina en el almacén, no en la pantalla: el picking no sabe cuál coger.

### 5. La unidad de venta la valida el servidor; el factor jamás llega del cliente

`product_uoms.factor` (`numeric(18,6)`) dice cuántas unidades **base** entrega una unidad de esa
UoM. `create_order` resuelve la unidad contra `product_uoms` —que exista para ESE producto, que sea
vendible, que su unidad esté activa— y calcula el precio como `product_uoms.price` si lo hay o
`precio base × factor` si no.

`uom_id`, `uom_factor`, `factor` y `base_quantity` entran en la lista negra del payload, en el borde
y en la base. Es la misma clase de decisión que el precio: aceptar un factor del cliente sería
dejar que el comprador decida cuánto se le descuenta del almacén.

**Una conversión que no da un número entero de unidades base se rechaza**
(`CANTIDAD_INVALIDA`) en vez de redondear. `products.stock` es entero; aproximar sería regalar o
cobrar de más media unidad en cada pedido.

### 6. El kit descuenta componentes, nunca su propia existencia

`create_order` recorre `bundle_items` con las filas bloqueadas (`for update`), convierte la cantidad
del componente a unidades base y descuenta de `products.stock` o de `product_variants.stock` según
el componente sea simple o una variante concreta. Si algo no alcanza, no queda ni pedido, ni línea,
ni existencia movida — es la misma transacción de siempre.

La existencia futura del kit es, por tanto, **derivada**: no se guarda. El backoffice enseña
«kits que se pueden armar ahora» calculado en pantalla, y la vitrina pregunta
`ebim.bundle_is_available`.

### 7. La disponibilidad pública se calcula POR TIPO

`products.in_stock` (columna generada `stock > 0`) deja de ser la verdad para dos de los tres tipos.
`public_products.in_stock` pasa a ser:

- **simple** → `products.in_stock`, exactamente como antes;
- **variant** → ¿alguna variante activa con existencia?
- **bundle** → `ebim.bundle_is_available(product_id)`.

Si se hubiera dejado la columna generada, el filtro «solo disponibles» de la vitrina escondería
camisetas que hay en almacén y anunciaría packs que no se pueden armar.

`ebim.bundle_is_available` es la **única** pieza `SECURITY DEFINER` que añade esta fase, y su motivo
es concreto: los componentes de un pack normalmente no están publicados por su cuenta, así que una
vista `security_invoker` los vería como «sin componentes visibles» y todos los kits saldrían no
disponibles. Lleva su autorización **dentro** (regla del repo, lección esupplier-030): solo responde
por un kit ya público, y para cualquier otro uuid devuelve `false` sin mirar nada.

### 8. `products.price` y `products.stock` NO se retiran

La regla 13 de la fase pide documentar su migración sin eliminarlos prematuramente. No se eliminan,
y no es por prudencia genérica: **hay cinco consumidores vivos**.

| Consumidor | Qué usa | Estado tras P03 |
|---|---|---|
| `create_order` | `price` y `stock` del producto simple | Sigue siendo la autoridad. Para `variant` usa la variante; para `bundle`, los componentes |
| `public_products` | `price` en la tarjeta y en la ficha | Sigue. Se añade `price_from` para el «desde» del maestro de variantes |
| `dashboard_kpis` | agregados de catálogo | Sin cambios |
| `products.in_stock` (generada) + `products_available_idx` | filtro de disponibilidad del simple | Sigue, y sigue siendo correcta para el simple |
| Herencia de precio de la variante | `coalesce(variant.price, product.price)` | El precio del maestro pasa a ser **el precio base que heredan las variantes sin precio propio** |

El **cambio de significado** por tipo queda escrito en `comment on column` dentro de la propia base,
que es donde lo va a leer quien consulte el esquema:

- `kind = 'simple'` — `price` y `stock` son del producto. Sin cambios.
- `kind = 'variant'` — `price` es el precio base heredable; **`stock` no significa nada** y la UI lo
  bloquea, porque un número que no decide nada lo lee el almacén como verdad.
- `kind = 'bundle'` — `price` es el precio del kit; `stock` no se usa.

Retirar `stock` de `products` exige antes P06 (inventario por almacén), que es quien se lleva la
existencia entera a su propia tabla. Hacerlo aquí habría reescrito `create_order`, la vista pública,
los KPI y el índice parcial en la misma fase que introduce el PIM.

### 9. Superficie de backoffice: una ruta gateada y un cajón por pestañas

- **`/app/pim`** — «Catálogo avanzado»: marcas, familias, atributos y unidades, en tabs centrados
  con deep-link `#hash` (§8). Una ruta y no cuatro entradas de menú porque las cuatro se configuran
  juntas, al dar de alta el catálogo. Gateada por `catalog.advanced`.
- **Cajón de producto** — pasa de ocho campos en columna a pestañas: General · Imágenes ·
  Variantes/Componentes · Unidades · Ficha técnica · Relacionados. Variantes y Componentes son
  excluyentes y dependen de `kind`. Sin `catalog.advanced` el cajón vuelve a tener dos pestañas y
  el catálogo simple se comporta como antes del PIM.
- **Listado paginado en el servidor** (`range` + `count: 'exact'`, 25 por página). Un listado que
  traía la tabla entera es correcto con cincuenta productos e insostenible con los miles que el PIM
  hace normales.

La barra de Guardar del cajón guarda **solo la pestaña General**. Las demás escriben su propia fila
al confirmar cada acción: una variante y un producto son dos filas distintas, y guardarlas juntas
obligaría a inventar una transacción en el cliente.

## Alternativas descartadas

- **Tabla `bundles` propia.** Habría duplicado la identidad del producto (SKU, precio, publicación,
  imágenes) y roto la regla del maestro único.
- **Un canal = una tienda.** Ya descartada en P10 histórico por triplicar los SKUs; el PIM la
  hubiera hecho aún más cara. El canal sigue siendo una dimensión sobre el catálogo.
- **Atributos en `custom_fields`.** Barato hoy, sin índice ni dominio cerrado. El día que hay que
  filtrar por color hay que migrar tres mil filas de texto libre.
- **EAV total.** Habría tirado los CHECK de dinero y hecho ilegible el listado.
- **`order_items.quantity` a `numeric`.** Habría permitido vender 0,250 kg, y habría cambiado el
  contrato del pedido —`line_total` generada, `order_by_token`, exportaciones— en la fase del PIM.
  La conversión sí es exacta: `base_quantity` es `numeric(18,6)` GENERATED. Vender fracciones de la
  unidad de venta queda para la fase que toque inventario y precio por peso.
- **Triggers en vez de FK denormalizadas.** Un trigger se puede desactivar y no aparece en el plan
  del esquema; la FK sí. Se pagó el precio de cinco columnas denormalizadas, todas comentadas.
- **Publicar la composición del kit en la vitrina.** Se escribió y se retiró: los componentes no
  están publicados, así que una vista `security_invoker` los habría dejado fuera y el pack se
  anunciaría vacío. Hacerlo bien exige otra función DEFINER con su autorización, y eso es superficie
  de vitrina (P11), no PIM.

## Lo que queda abierto

1. **Filtro por atributo en la vitrina.** El modelo está indexado para ello, pero la faceta es UI de
   escaparate y va con P11. Hoy los atributos no salen a `anon`.
2. **Venta en fracciones de unidad.** Ver arriba: exige tocar el contrato del pedido.
3. **UoM por variante.** Hoy las unidades cuelgan del producto —las tallas de una camiseta se
   despachan en la misma caja—. Si hace falta, es una columna `variant_id` nullable en
   `product_uoms`, no otra tabla.
4. **`database.types.ts` sin regenerar.** Las once tablas y la vista nueva van sin `satisfies` en
   `shared/lib/db-schema.ts` por la misma razón que las cuatro de P02: la migración no está aplicada
   en el proyecto enlazado y esta fase no despliega. La red mientras tanto es
   `supabase/tests/pim-catalog.test.ts`, que comprueba esos nombres contra el esquema construido
   desde las migraciones.
5. **R2 (canales sin superficie de backoffice)** sigue abierto. `SAAS_ROADMAP` lo asignaba a
   «P02/P03» y P02 lo pasó entero aquí. No se cierra: un canal no es vocabulario de catálogo sino
   una dimensión de venta —con precios, catálogo restringido y reglas de sesión propias—, y su
   pantalla pertenece a la fase de precios por canal (P04). Lo que P03 sí garantiza es la regla que
   el canal necesitaba: el catálogo sigue siendo único y **el canal no duplica ni un SKU**;
   `product_channels` referencia `products`, y las variantes heredan el canal de su maestro.
