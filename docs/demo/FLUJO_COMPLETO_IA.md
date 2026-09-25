# Recorrido completo con IA, de la tienda vacía a la venta cobrada y entregada

> Negocio de ejemplo: **Ferretek**, ferretería y equipos de protección personal.
> Vende a constructoras (B2B, con cotización, crédito y aprobación por monto) y al maestro de obra
> que entra a la tienda y paga en el momento (B2C).
>
> Esta guía sirve para dos cosas: montar el negocio desde cero y presentarlo. Cada paso dice **qué
> haces**, **qué deberías ver** y **qué hace la IA ahí**. La IA nunca decide sola: redacta, resume o
> explica, y la decisión y el cálculo siguen siendo del sistema.
>
> Comprobado contra el proyecto de QAS el 2026-09-25: las 38 migraciones están aplicadas, las 18
> funciones de IA están desplegadas y activas, y la clave del proveedor está configurada como secreto
> del servidor.

---

## 0 · Lo que hay que saber antes de empezar

### La IA no viene activa en una tienda nueva

Las cuatro capacidades de IA **no son de base**. Una sociedad recién creada nace sin ninguna, y en el
backoffice no aparece ni un botón. No es un fallo: es el mismo criterio que con el resto de módulos.

| Capacidad | Código para contratar | Qué habilita |
|---|---|---|
| `ai.assist` | `ecommerce.ai.assist` | Asistente de compra de la tienda y medidor de consumo |
| `ai.catalog.copy` | `ecommerce.ai.catalog.copy` | Redactar fichas de producto |
| `ai.insights` | `ecommerce.ai.insights` | Los trece análisis de módulo y el copiloto |
| `ai.content` | `ecommerce.ai.content` | Promociones, contenido de la tienda y respuestas a reseñas |

Tres reglas que explican casi todos los «no me aparece el botón»:

1. **La IA de un módulo exige el módulo.** La IA de crédito no existe sin `credit.management`, la de
   cotizaciones sin `trade.quotes`, la de planificación sin `planning.demand`. Si el módulo no está
   contratado, la respuesta del servidor es `MODULO_NO_CONTRATADO`.
2. **Cada IA exige un rol.** El análisis de crédito y el de operaciones son solo de owner y admin. La
   IA de pedidos la ve hasta un viewer. La de fichas la ve el rol de catálogo.
3. **Sin cuota configurada hay 25 usos en total.** Una sociedad sin fila de cuota queda en plan de
   prueba. Para un recorrido completo eso se agota a la mitad: hay que dejarla en plan activo.

### Dónde vive la IA, módulo por módulo

| Módulo | Dónde aparece | Qué hace |
|---|---|---|
| Inicio | Panel «Resumen inteligente» | Lee las cifras del día y dice qué mirar primero |
| Productos | Botón «Asistente de ficha» dentro del producto | Redacta nombre, descripción, SEO, categoría y atributos |
| Reseñas | Pestaña «Análisis de reseñas con IA» y botón de responder | Agrupa quejas y propone una respuesta pública |
| Promociones | Botón «Redactar con IA» | Redacta el nombre y el texto de la campaña |
| Inventario | Pestaña «Análisis IA» | Explica roturas de stock y desbalances entre almacenes |
| Planificación | Pestaña «Análisis IA» y explicación por sugerido | Justifica cada sugerido de compra |
| Clientes | Pestaña «Resumen IA» y resumen 360 en la ficha | Resume la relación con el cliente |
| Fuerza de ventas | «Asistente de visita» | Prepara la visita del vendedor |
| Cotizaciones | «Borrador de cotización con IA» | Propone líneas; el precio lo recalcula el servidor |
| Pedidos | Pestaña «Asistente IA» y panel dentro del pedido | Busca pedidos por lenguaje natural y señala los que piden atención |
| Pagos | Pestaña «Análisis IA» | Explica qué está sin cobrar y por qué |
| Cobranza | Pestaña «Cobranza con IA» | Prioriza la cobranza por cliente |
| Entregas | Pestaña «Análisis IA» | Explica atascos de despacho |
| Contenido | Botón «Redactar con IA» | Redacta bloques de la portada |
| Operación | Pestaña «Asistente técnico de operaciones» | Traduce errores y logs del sistema |
| Integraciones | Pestaña «Asistente técnico de integraciones» | Explica fallos de integración |
| Todo el backoffice | Botón **EBIM Copilot** en la cabecera | Pregunta transversal sobre catálogo y ventas |
| Tienda pública | Botón «Asistente de compra» | Ayuda al comprador a encontrar producto |

---

## 1 · Crear el negocio

1. **Identificadores.** Genera dos uuid: uno de cuenta (`organization_id`) y uno de sociedad
   (`company_id`). Guárdalos, se usan en el paso siguiente.
2. **Cuenta del dueño.** Crea el acceso de `owner@ferretek.pe` con contraseña. Mientras el hub no esté
   conectado, se crea desde el script de servicio y nace confirmada, así que no se envía correo.
3. **Alta desde la aplicación.** Entra con ese usuario. Al no tener negocio, la aplicación lleva sola a
   `/onboarding`. Rellena nombre **Ferretek**, dirección **`ferretek`** y moneda **PEN**.

Queda creado el negocio, el dueño y la tienda en borrador. El detalle paso a paso, con el SQL exacto,
está en [`ALTA_DE_NEGOCIO_EN_DEV.md`](../integracion-hub/ALTA_DE_NEGOCIO_EN_DEV.md).

**Qué deberías ver:** entras al backoffice y el menú lateral está casi vacío. Es lo correcto: todavía no
hay módulos contratados.

---

## 2 · Contratar los módulos, IA incluida

Una sola llamada activa todo. La lista **reemplaza** lo anterior, así que va completa.

```sql
select public.sync_platform_context(
  'ORGANIZATION-ID'::uuid,
  'COMPANY-ID'::uuid,
  true,
  array[
    -- Catálogo y precios
    'ecommerce.catalog.advanced',
    'ecommerce.pricing.lists',
    'ecommerce.promotions',
    -- Inventario
    'ecommerce.inventory.multiwarehouse',
    'ecommerce.planning.demand',
    -- Clientes y venta B2B
    'ecommerce.customers.b2b',
    'ecommerce.sales.force',
    'ecommerce.trade.quotes',
    'ecommerce.trade.assortments',
    -- Venta, cobro y entrega
    'ecommerce.orders.advanced',
    'ecommerce.payments',
    'ecommerce.credit.management',
    'ecommerce.fulfillment',
    'ecommerce.invoicing',
    -- Tienda y medición
    'ecommerce.content.cms',
    'ecommerce.analytics.advanced',
    -- IA
    'ecommerce.ai.assist',
    'ecommerce.ai.catalog.copy',
    'ecommerce.ai.insights',
    'ecommerce.ai.content'
  ]::text[],
  'provisioning'::public.entitlement_source,
  'demo'
);
```

Y la cuota de IA, que sin esto son 25 usos en total:

```sql
insert into public.ai_quotas (organization_id, company_id, plan, monthly_quota)
values ('ORGANIZATION-ID'::uuid, 'COMPANY-ID'::uuid, 'active', 2000)
on conflict (organization_id, company_id) do update
   set plan = excluded.plan, monthly_quota = excluded.monthly_quota;
```

**Qué deberías ver:** recarga y el menú se llena con los seis grupos (Catálogo, Inventario, Clientes,
Ventas, Tienda, Sistema). En **Sistema → Diagnóstico** aparece la sección de IA con el medidor de
consumo a cero y las cuatro capacidades en verde. En la cabecera aparece el botón **EBIM Copilot**.

> Si algo no sale, Diagnóstico es el sitio donde mirar: dice qué módulo está contratado y cuánta cuota
> de IA queda, sin tener que entrar a la base.

---

## 3 · Montar el vocabulario del catálogo

**Catálogo → Catálogo avanzado.** Es la base de todo lo demás, y el orden importa.

| Pestaña | Qué cargar en Ferretek |
|---|---|
| Marcas | Truper, Stanley, 3M, Ferretek (marca propia) |
| Familias | Herramienta manual, Herramienta eléctrica, Fijación, EPP, Eléctrico |
| Unidades | UND (unidad), CAJA12 (caja de 12), MIL (millar), PAR (par) |
| Atributos | `medida` y `talla` como ejes de variante; `material`, `norma` y `voltaje` como descriptivos |

Los atributos marcados como **eje** son los que generan variantes. Para Ferretek:

- `talla` con valores S, M, L, XL → guantes y chalecos.
- `medida` con valores 1/4", 3/8", 1/2", 3/4" → llaves, brocas, tornillería.

Los descriptivos no generan SKU, pero se rellenan en la ficha técnica del producto y sirven para filtrar:

- `norma` con valores EN 388, ANSI Z87.1, NTP 399.010 → es el dato que una constructora exige.
- `material` con acero al carbono, cromo vanadio, nitrilo, policarbonato.

**Qué deberías ver:** al crear un atributo de tipo lista, los valores se cargan debajo, en «Valores
admitidos», y se guardan al pulsar Añadir, sin esperar al botón de guardar de arriba.

---

## 4 · Cargar productos, con la IA redactando

**Catálogo → Productos.** Tres productos bastan para enseñar los tres comportamientos distintos:

| Producto | Tipo | Por qué |
|---|---|---|
| Guante de nitrilo Ferretek | Variante | Cuatro tallas, cada una con su stock y su precio |
| Juego de llaves mixtas Truper 12 piezas | Simple | Producto normal, se vende por unidad y por caja de 12 |
| Kit de seguridad básico | Kit | Casco, lentes y guantes; su stock sale de sus componentes |

En cada ficha:

1. Escribe solo el nombre y el SKU.
2. Pulsa **Asistente de ficha**. Devuelve un borrador de descripción, título y descripción de buscador,
   categoría sugerida y valores de atributo.
3. **El borrador no se guarda solo.** Se ve, se corrige y se acepta. Es deliberado: la IA redacta, la
   persona publica.
4. En el producto de variantes, pon Tipo **Variante** y guarda; en la pestaña Variantes cruza `talla` y
   genera las cuatro, cada una con SKU, precio y stock.
5. En **Unidades**, añade CAJA12 con factor 12 al juego de llaves. Así la tienda puede vender la caja.
6. En **Ficha técnica**, rellena `norma` y `material`.

**Qué hace la IA:** redacta. Nada más. El precio, el stock y la categoría efectiva los sigue decidiendo
el sistema, y la ficha queda igual que si la hubieras escrito a mano.

**Qué deberías ver:** debajo del borrador aparecen los pulgares de valoración. Ese voto queda en la
traza de Diagnóstico junto al modelo usado y los tokens gastados.

---

## 5 · Precios: uno para el mostrador y otro para la constructora

**Catálogo → Precios.** Cuatro pestañas: Listas, Segmentos, Simulador y Diagnóstico.

1. **Segmentos:** `minorista`, `constructora`, `distribuidor`.
2. **Listas:**

| Lista | Alcance | Prioridad | Desde | Precio |
|---|---|---|---|---|
| Tarifa base | Tienda | 0 | 1 unidad | el de catálogo |
| Tarifa constructora | Segmento constructora | 80 | 1 unidad | 10 % menos |
| Tarifa constructora por volumen | Segmento constructora | 80 | 10 unidades | 18 % menos |
| Tarifa distribuidor | Segmento distribuidor | 90 | 24 unidades | 25 % menos |

3. **Simulador:** antes de seguir, pregunta «¿cuánto le costaría el guante talla L a esta constructora
   comprando 12?». Te dice qué lista ganó, por qué alcance y desde qué escala.

**Por qué importa el orden:** la precedencia es lo único que no se configura. Gana el alcance más
específico (cliente, luego segmento, luego canal, luego tienda) y solo a igualdad decide la prioridad.
La Tarifa base no es decorativa: es el suelo que garantiza que siempre haya un precio.

**Qué deberías ver:** en Diagnóstico, cero conflictos. Si dos listas comparten alcance, prioridad y
vigencia, sale en rojo: ahí el precio lo decidiría un identificador interno, o sea nadie.

---

## 6 · Inventario y planificación

**Inventario → Inventario.** Crea dos almacenes: Lima Centro y Lurín. Reparte stock distinto en cada
uno, y deja un producto en cero en uno de ellos a propósito.

- **IA de inventario** (pestaña Análisis IA): explica dónde falta y dónde sobra, y señala el desbalance
  que acabas de crear.
- **IA de planificación** (Inventario → Planificación): cada sugerido de compra lleva un botón de
  explicación que dice en qué consumo y en qué plazo de reposición se basa. El número lo calcula el
  sistema; la IA solo lo cuenta en palabras.

---

## 7 · Los dos clientes

### El cliente B2B: Constructora Andes SAC

**Clientes → Clientes** y **Cuentas de empresa**:

1. Ficha de cliente con RUC, del segmento `constructora`. Esto es lo que le da la tarifa del paso 5.
2. Cuenta de empresa con **línea de crédito 30 000**, **plazo 30 días** y **umbral de aprobación 5 000**.
3. Dos compradores vinculados: `compras@andes.pe` (comprador) y `gerencia@andes.pe` (aprobador).
4. Una sede de entrega en obra.

### El cliente B2C: el maestro de obra

No se crea desde el backoffice: se registra solo en `/s/ferretek/register`. Queda como consumidor, sin
cuenta de empresa, sin crédito y sin segmento, así que paga la Tarifa base.

**IA de clientes:** en la ficha, «Resumen 360 con IA» resume compras, incidencias y saldo en un párrafo.
Útil antes de una llamada; no cambia ningún dato.

---

## 8 · La tienda de cara al público

**Tienda → Contenido** y **Sistema → Configuración**:

1. Marca y diseño: logo, color de acento y tipografía.
2. Portada: hero, categorías destacadas y una fila de productos. El botón **Redactar con IA** propone
   los textos de cada bloque.
3. Medios de pago: tarjeta, Yape, transferencia y **Crédito empresa**. Este último solo lo verá quien
   tenga línea de crédito.
4. Entrega: recojo en tienda y reparto, con sus zonas.
5. Publica la tienda: de borrador a activa.

**IA de la tienda:** en `/s/ferretek` aparece el **Asistente de compra**. Es anónimo, responde solo con
productos publicados de esa tienda y tiene freno por tienda y hora para que nadie gaste la cuota
haciéndole preguntas en bucle.

---

## 9 · Promociones

**Catálogo → Promociones.** Crea «Campaña Obra Segura»: 15 % en la familia EPP, con vigencia y tope.

- El botón **Redactar con IA** propone nombre y texto de cara al comprador.
- El alcance se elige con un buscador, no escribiendo identificadores.
- Las promociones se aplican **después** del precio de acuerdo: primero la lista del cliente, luego la
  campaña.

---

## 10 · La venta B2C, de principio a fin

1. El maestro de obra entra a `/s/ferretek`, busca con el asistente y abre un producto.
2. Elige talla con los botones de opción y agrega al carrito. Puede hacerlo desde la vista rápida sin
   salir del catálogo.
3. Va al checkout, elige recojo en tienda y paga con Yape.
4. **Ventas → Pedidos:** el pedido entra como pagado.
5. **Ventas → Entregas:** se prepara y se despacha.

**Qué enseñar aquí:** el precio que vio en la ficha, el del carrito y el que se cobró son el mismo, y
todos salen del servidor. El navegador nunca manda un precio.

---

## 11 · La venta B2B, que es otra historia

1. **Cotización.** Clientes → Cotizaciones. El **Borrador de cotización con IA** propone las líneas a
   partir de lo que pidió el cliente por correo. Al convertirla en pedido, **el servidor vuelve a
   poner el precio**: el borrador no fija importes.
2. **El comprador entra a la tienda** con `compras@andes.pe` y ve la Tarifa constructora, con el
   descuento mayor a partir de diez unidades.
3. **Paga con Crédito empresa**, que solo le aparece a él.
4. **Aprobación.** Si el pedido supera 5 000, queda esperando a `gerencia@andes.pe`. Hasta que no
   apruebe, no avanza.
5. **Ventas → Pedidos:** el pedido tiene cuatro estados independientes (estado, cobro, entrega y
   aprobación). El **Asistente IA** de esta pantalla busca en lenguaje natural («pedidos de Andes sin
   cobrar») y marca los que piden atención.
6. **Ventas → Pagos:** el pedido figura pendiente de cobro. La pestaña Análisis IA explica el cuadro.
7. **Ventas → Entregas:** se prepara y se despacha. Aquí hay un candado que conviene enseñar: si la
   tienda exige cobro antes de despachar, solo se salta cuando el pedido se pagó **con línea de
   crédito**. Que el cliente tenga crédito no basta si pagó con Yape.
8. **Ventas → Cobranza:** aparece la deuda a 30 días. La pestaña **Cobranza con IA** ordena a quién
   llamar primero y por qué.

---

## 12 · Cierre y medición

1. **Tienda → Analítica:** el embudo de la tienda, con las visitas y los carritos.
2. **Inicio:** el panel «Resumen inteligente» ya tiene datos reales que resumir.
3. **Sistema → Operación** y **Sistema → Integraciones:** los asistentes técnicos traducen errores y
   logs. Es la IA que mira al operador, no al comprador.
4. **Sistema → Diagnóstico:** el medidor de IA muestra cuánta cuota se gastó en el recorrido, con la
   traza de cada llamada, el modelo usado y los pulgares que fuiste dejando.
5. **EBIM Copilot**, desde la cabecera: cierra preguntando algo transversal, como qué producto se vendió
   más esta semana.

---

## Qué decir sobre la IA cuando pregunten

- **No decide.** Redacta, resume, explica y busca. El precio, el stock, el crédito y los estados los
  calcula el sistema, con las mismas reglas que sin IA.
- **No ve lo que el usuario no puede ver.** Cada llamada usa la sesión de quien la hace, así que la IA
  lee exactamente lo que esa persona lee, ni una fila más.
- **No se paga sola.** Cada uso descuenta cuota de la sociedad, y el consumo se ve en Diagnóstico.
- **Se puede apagar.** Es un módulo contratable: sin él, el producto funciona igual, solo que sin los
  botones.
- **Los datos del comprador van delimitados.** Lo que escribe una persona entra al modelo marcado como
  dato, no como instrucción.

---

## Pendientes conocidos

- La guía de alta de negocio no incluye los cuatro códigos de IA en su lista de ejemplo. Por eso la
  tienda `biel` se creó sin IA.
- La capacidad `ai.content` figura como **declarada**, no implementada, porque el código comercial lo
  tiene que dar de alta el hub. Activándola por provisión funciona igual.
- No hay pantalla para la cuota de IA: se configura con SQL.
