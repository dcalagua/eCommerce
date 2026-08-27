# Estado del proyecto — eCommerce by EBIM

GUIDELINES_STATUS: VERIFIED
Fuentes: ver `docs/EBIM_GUIDELINES_TRACE.md` (11 documentos leídos en la raíz de Drive `EBIM-Plataforma`).
Última actualización: 2026-08-27 (P08)

## Fase actual
**P09 — Monedas e impuestos configurables (COMPLETA para el alcance encargado).** Gate: PASS.
`typecheck`, `lint`, `test` (**514 tests / 36 archivos**), `test:db` (243) y `build`, los cinco verdes.

Sacó de código dos decisiones que estaban cableadas y que impedían dar de alta un tenant fuera de Perú:
`stores.currency default 'PEN'` y `store_settings.tax_rate default 0.1800` (IGV). La lista de monedas
vivía además en un `const` de React (`OnboardingPage`), sin **BOB**: ninguna tienda boliviana podía
crearse sin desplegar.

La migración 16 añade `currencies` (catálogo ISO 4217 **global**, con `minor_unit` porque CLP no tiene
decimales), `tenant_currencies` (qué habilita cada sociedad, una sola base por índice parcial),
`tax_categories` y `tax_rates` **con vigencia**: la tasa se versiona, no se sobrescribe, así que un
pedido de hace seis meses se recalcula con la tasa de su fecha. `ebim.effective_tax_rate` resuelve en
cascada producto → tienda → legado → 0; es `SECURITY DEFINER` con autorización explícita dentro (la
tienda debe estar `active`) y devuelve un escalar, nunca filas de tenant, para que la vitrina anónima
pueda pintar el precio con IVA sin SELECT sobre `tax_rates`.

La migración 17 mueve el impuesto de `create_order` **a nivel de línea**, agrupado y redondeado **por
tasa**, que es como se factura cuando hay varios tipos en el mismo carrito. Con una sola tasa el
resultado coincide al céntimo con el anterior. Soporta `tax_inclusive`: cuando los precios ya llevan
impuesto, se extrae en vez de sumarse y el total es exactamente el que vio el comprador. La 18 añade
`set_tax_rate`, que cierra la vigente y abre la nueva en una transacción — **`security invoker` a
propósito**: la autorización la siguen poniendo las policies, así que no puede escribir nada que su
llamante no pudiera escribir directamente.

Backoffice: nueva pestaña **Impuestos** en Configuración (categorías, tasa vigente, marcar por defecto).
El selector de moneda del alta lee el catálogo y ya no trae valor por defecto: la moneda es una decisión
contable y prácticamente inmutable tras el primer pedido, así que se elige.

**Dos invariantes cazaron bugs propios durante la fase:** `tax_rates` sin índice sobre
`(organization_id, company_id)` —un scan por tenant en cada lectura, no solo una regla incumplida— y una
columna `prices_include_tax` que violaba el guard «toda columna con *price* es numeric»; se renombró la
columna a `tax_inclusive` en vez de aflojar el guard.

**Se modificó un test de invariantes** y queda anotado aquí a propósito: `currencies` es un catálogo
global (sin columnas de tenant, PK no uuid), así que rompía dos invariantes de aislamiento. Se añadió
`REFERENCE_CATALOG = ['currencies']`, **nominal y no un patrón**, y se compensó con un test nuevo —«los
catálogos exentos son globales y de solo lectura»— que verifica que cada tabla de esa lista no tiene
columnas de tenant, tiene RLS activada y no tiene ningún GRANT de escritura a `anon`/`authenticated`.
Si alguien mete ahí una tabla de negocio para saltarse el RLS, falla.

**Dependencia reparada:** faltaba `@testing-library/dom` (peer de `@testing-library/react@16`). Con ella
ausente, `typecheck` daba 29 errores y **los 34 archivos de test no arrancaban**, incluidos los de BD.

Nada desplegado, sin push ni PR. Sigue sin project ref. Siguiente: M1 — canales (`channels`,
`channel_id` en `orders`, `product_channels`) sobre catálogo único.

## Fase anterior
**P08 — Quality gate (COMPLETA). Resultado: PASS.** Informe corto en `docs/OVERNIGHT_REPORT.md`.
Los cinco gates verdes sobre un `node_modules` reinstalado desde cero: `npm ci` (exit 0), `npm run lint`
(0 problemas), `npm run typecheck` (`tsc --noEmit`, sin OOM), `npm run test` (**493 tests / 34 archivos**)
y `npm run build`. No se tocó una línea de producto: los 7 tests nuevos son de gate y los tres archivos
modificados son de test.

Lo que el gate **corrigió**, no solo comprobó: el aislamiento del comprador anónimo frente al catálogo
tenía **una** aserción (no puede insertar en `products`) y ahora tiene doce escrituras probadas una por
una —precio, stock, publicar un borrador ajeno, borrar, y lo mismo en `categories`, `stores`,
`store_settings` y `product_images`— más la comprobación de que el catálogo queda intacto tras los doce
intentos y de que tampoco se escribe a través de las vistas públicas. La reproducibilidad de las
migraciones pasa de implícita a probada: un test compara la huella completa del esquema (columnas,
tipos, nulabilidad, defaults, RLS, policies, `security definer`) entre dos bases vírgenes. Y el
diccionario ES/EN gana paridad probada: `translate` cae al español cuando falta una clave en inglés, así
que una traducción olvidada no rompía nada y llegaba a pantalla sin ruido.

**Hallazgo abierto:** el commit `23e7d7b` (P04) modificó dos migraciones ya commiteadas. No hay daño —no
existe project ref, así que ninguna migración se ha aplicado nunca y la carpeta actual arranca limpia—,
pero la inmutabilidad se vuelve vinculante desde el primer `supabase db push`. Anotado en riesgos.
Nada desplegado, sin push ni PR. Siguiente: P09, que depende del **project ref** (aplicar migraciones,
`db:types`, desplegar las 4 Edge Functions) — hasta entonces todo lo demás está bloqueado o es backlog.

## Dos fases atrás
**P07 — Pedidos y configuración de la tienda (COMPLETA para el alcance encargado).** El backoffice ya
gestiona lo que la vitrina genera. `/app/orders`: listado con buscador general (número, cliente o correo),
tabs de estado, filtro de fecha por rangos cerrados y Exportar CSV de lo que se está viendo; el detalle se
abre en un panel lateral con cliente, entrega (`shipping_address`), líneas del pedido, importes e
**historial**. El cambio de estado pasa **siempre** por la Edge Function `update-order-status` —la capa de
datos de pedidos no tiene ni un `update`, y hay un test que lo comprueba sobre el propio código—. Los
estados siguen siendo los del enum `public.order_status` de P02 (`pending/paid/fulfilled/cancelled/refunded`),
no los sugeridos en el encargo: la definición EBIM ya existía, con su máquina de estados en trigger
(decisión 51).

La migración 14 añade `order_status_events`, una **bitácora append-only** que escribe un trigger
`SECURITY DEFINER` en la misma transacción que el UPDATE: no hay GRANT ni policy de INSERT/UPDATE/DELETE
para `anon` ni `authenticated`, así que un cambio de estado sin evento (o un evento inventado) son estados
imposibles, no cosas que vigilar. El actor sale del JWT; en el alta del comprador anónimo queda NULL y la
pantalla lo lee como «desde la vitrina».

`/app/settings`: nombre comercial, descripción, contacto (correo, teléfono, dirección), color primario,
logo y banner. Los assets suben al bucket privado `store-assets` en
`{organization_id}/{store_id}/branding/…` y lo que se guarda es la **ruta**, no una URL firmada —que
caducaría en una hora—. La migración 15 añade el CHECK `ebim.is_store_asset_ref`: `logo_url`/`banner_url`
solo admiten `https://` externo (el logo-auto del contrato §4.3) o una ruta del **propio** tenant. La
vitrina firma esa ruta con el cliente anónimo y refleja los cambios sin tocar una línea de la vitrina.
Nada desplegado: sigue sin project ref. Siguiente: P08 (quality gate).

## Tres fases atrás
**P06 — Carrito y checkout (COMPLETA para el alcance encargado).** Flujo entero del comprador anónimo:
producto → carrito → checkout → pedido. El carrito vive en `localStorage` **por tienda**
(`ebim.ecommerce.cart.v1:<store_id>`), suma/resta/quita, calcula el subtotal en céntimos y **no puede
mezclar tiendas**: la clave lleva el `store_id`, el carrito lo repite dentro, un carrito guardado bajo la
clave de otra tienda se descarta y añadir un producto ajeno lanza `CartStoreMismatchError`. Panel lateral
(`CartDrawer`) que se abre al agregar, contador en la cabecera y página `/cart` con las mismas líneas.
Checkout mínimo (nombre, correo, teléfono, dirección + referencia opcional), **sin pasarela de pago**.
Confirmación en `/s/:storeSlug/order/:orderNumber` con los importes que devolvió el SERVIDOR.
Migración 12 (`checkout`) añade `create_order_for_slug`: **la tienda la resuelve la base a partir del slug**
(solo `status = 'active'`) y delega en `create_order`, que sigue leyendo precios de la BD, validando
publicación/stock/moneda, recalculando subtotal + impuesto + total, generando `order_number` e insertando
pedido y líneas en la misma transacción. El cuerpo que sale del navegador lleva `store_slug`, `items` y
contacto; `store_id` ya **no** se acepta (`rejectUnknownFields` lo tumba) y ningún precio viaja. Estado
inicial `pending` (estándar EBIM, migración 04). Nada desplegado: sigue sin project ref. Siguiente: P07.

## Decisiones tomadas
1. eCommerce entra a la suite EBIM como app propia: **proyecto Supabase propio**, identidad/addons en el hub.
2. Identidad: Third-Party Auth contra el JWKS del hub (Modo A) con `/sso` handoff (Modo B) como plan B.
3. Aislamiento por **RLS default deny** con `organization_id` + `company_id` (uuid del hub) en toda tabla.
4. **Storefront público y backoffice separados lógicamente** dentro del mismo repo/app (`src/storefront` vs
   `src/admin`), rutas y guards distintos, design system compartido.
5. Storefront resuelve tenant por dominio/slug contra vista pública de solo lectura; nunca por dato declarado por el cliente.
6. Imágenes en **Supabase Storage** con path por tenant y policies por tenant. **Ajustado en P02** al layout
   `{organization_id}/{store_id}/...`: la tienda pertenece a una sociedad, así que particionar por tienda es
   más fino que por `company_id` y no pierde aislamiento. Un CHECK en `product_images` obliga al prefijo.
7. Stack: React + TypeScript + Vite + MUI, i18n ES/EN, theming por tokens (color 100% del tenant).
8. Addons, sociedades y config efectiva se leen del hub vía Edge Function proxy `platform-context`.
9. Git: rama de trabajo `dev`, commits locales convencionales; sin push/PR/deploy sin orden del operador.
10. Verificación por fase: typecheck + build + lint + Vitest (+ Playwright cuando haya flujo E2E) + tests de aislamiento tenant.
11. **Tokens de marca replicados 1:1** del handoff de design system de eExpense/eSupplier
    (`coordinacion/respondidos/2026-06-28-esupplier-014`) y el isotipo `EbimMark` del asset de suite
    (`2026-06-28-eexpense-015`). No se inventó branding: modo (`data-theme`) y acento (`data-accent`)
    ortogonales, densidad por `data-density`, favicon compartido.
12. **Rutas base fijadas por el operador (P01):** backoffice en `/app/*` y storefront en `/s/:storeSlug/*`
    (sustituye el borrador `/admin` + `/` de `architecture.md`).
13. Sin i18next: diccionario ES/EN tipado propio en `src/shared/i18n` (claves validadas por `MessageKey`).
14. **P02 — nomenclatura de tenant.** El encargo pedía `tenant_id`; el contrato §3 exige `organization_id`
    + `company_id` con «nombres exactos, sin variantes» y manda sobre el encargo. Se implementa con esos
    nombres: `organization_id` **es** el tenant_id del encargo, y `stores` añade la dimensión `store_id`
    propia de eCommerce. La tabla `tenants` existe igual (espejo local, PK = `organization_id` del hub),
    patrón que el contrato §3.2 reconoce explícitamente para apps con tabla de tenants propia.
    Un test de esquema falla si aparece una columna `tenant_id`/`org_id` en cualquier tabla.
15. **P02 — roles de app**: `owner/admin/catalog/orders/viewer` (enum `public.app_role`). Son dimensión
    propia de eCommerce, no roles del hub — mismo patrón que `work_profile` de eSupplier (contrato §2.5).
16. **P02 — RLS = claims + membresía.** El predicado `ebim.can_access` exige `org_id`/`companies[]` del JWT
    **y** membresía activa en `tenant_members` con tenant activo. Un JWT con el `org_id` de otro tenant no
    ve nada. El rol se comprueba con `ebim.has_role` en cada policy de escritura.
17. **P02 — lo público es `to anon` y punto.** Las policies públicas no se dan a `authenticated` (dejaría a
    un usuario del tenant A leer columnas internas del catálogo de B). El storefront usa un cliente
    Supabase **anónimo** dedicado (`getStorefrontClient`), aunque el visitante tenga sesión de backoffice.
18. **P02 — buckets privados con lectura por policy.** `product-images` y `store-assets` con `public=false`:
    `anon` lee un objeto solo si su producto está publicado / su tienda activa. Un bucket público daría
    lectura a cualquier ruta del bucket, incluidos los borradores.
19. **P02 — el dinero sale como string.** `numeric` en la base y `::text` en el JSON de `create_order`:
    un número JSON se convertiría en float en el primer `JSON.parse` del navegador.
20. **P02 — alta de tenant y alta de pedido son operaciones de servidor.** Únicos dos usos de `service_role`,
    siempre delegando en una función SECURITY DEFINER de la base con `EXECUTE` revocado a `anon`/`authenticated`.
21. **P03 — `bootstrap-tenant` tiene dos credenciales, no dos funciones.** El operador sigue entrando con la
    clave de aprovisionamiento (y ahí los uuid vienen en el cuerpo, porque el tenant aún no existe); el
    usuario que crea su propio espacio entra con su JWT del hub y el tenant sale de los claims. Un
    `organization_id` en el cuerpo de ese segundo camino se rechaza con 400, no se ignora.
22. **P03 — el token del alta se verifica de verdad.** El camino de alta de sí mismo termina llamando a
    `service_role`, que salta RLS: leer los claims sin comprobar la firma dejaría crear un espacio a nombre
    de cualquiera. `_runtime/verify.ts` valida el token contra el servidor de auth (que en Modo A lo valida
    contra el JWKS del hub) y exige que el `sub` verificado coincida con el del payload.
23. **P03 — sin `org_id` en el token NO es un usuario nuevo.** Es un token que no sirve para esta app, así
    que el estado es `unauthorized` (con cerrar sesión como salida) y no `onboarding`. Mandarlo al alta le
    haría crear un espacio que su hub no reconoce.
24. **P03 — la sociedad activa no se persiste en el navegador.** Es parte de la jerarquía del token
    (contrato §3); guardarla en `localStorage` la haría sobrevivir a un cambio de permisos en el hub. El
    selector vive en memoria y solo ofrece sociedades con membresía devuelta por RLS.
25. **P03 — sin switcher de tenant.** El contrato §2.2 modela un usuario = un `org_id`, y `gmao-038`
    (multi-tenant por persona) sigue **pendiente de decisión del operador**. eCommerce implementa el
    selector de **sociedad** que el contrato sí prevé, y muestra el nombre del espacio en el sidebar —que es
    lo que GMAO recomendó mientras tanto—, pero no inventa un cambio de cuenta.
26. **P03 — los KPIs se calculan en la base con `SECURITY INVOKER`.** `public.dashboard_kpis` cuenta bajo la
    RLS del que pregunta. Un panel que agrega es el sitio más fácil para filtrar datos entre tenants sin que
    se note (nadie ve filas ajenas, solo un total más alto), y una función DEFINER aquí sería justo eso.
27. **P03 — el panel no inventa cifras.** Si los pedidos visibles mezclan monedas, o no hay ninguno, la base
    devuelve `sales`/`currency` en null y la pantalla muestra un guion. Un cero en un panel se lee como dato.
28. **P03 — el espacio y su primera tienda comparten slug.** Son tablas con unicidad propia, y pedirle dos
    direcciones a quien está dando de alta su negocio es pedirle que decida algo que todavía no sabe.
29. **P04 — el panel lateral no contradice los lineamientos.** La regla de tabs centrados es para pantallas
    largas y densas; el alta de producto son ocho campos. Lo que sí se respeta del mismo bloque es la barra
    de Guardar persistente, aquí `sticky` al pie del drawer. El listado sigue detrás, así que la búsqueda y
    la pestaña de estado están donde estaban al cerrar.
30. **P04 — «eliminación segura» es el estándar §4.2 del contrato, no una invención.** Dice literalmente:
    «desactivar conserva los datos; eliminar muestra el conteo de uso real antes de borrar». Se implementa
    igual para producto (archivar / conteo de líneas de pedido e imágenes) y para categoría (desactivar /
    conteo de productos e hijas). El conteo sale de una función `SECURITY INVOKER`, así que son las cifras
    del tenant que pregunta y no un texto genérico de «esto podría afectar a otros registros».
31. **P04 — la columna se llama `stock`, no `stock_qty`.** El encargo pedía `stock_qty`; la columna existe
    desde P02 y la conocen las policies, `create_order` y los tests de aislamiento. Renombrarla sería tocar
    seis archivos para no ganar nada. Mismo criterio que la decisión 14 con `tenant_id`.
32. **P04 — imagen principal y orden se resuelven en la base.** `product_images` tiene un índice único
    parcial que prohíbe dos principales por producto: «quitar la anterior» y «poner la nueva» desde el
    navegador se comen un 409 a mitad de camino. `set_primary_product_image` y `reorder_product_images` lo
    hacen en una operación, son `SECURITY INVOKER` y **fallan a propósito** cuando la RLS deja el UPDATE en
    cero filas — un guardado que no guardó nada es peor que un error.
33. **P04 — la ruta de imagen añade el producto: `{organization_id}/{store_id}/{product_id}/{uuid}.{ext}`.**
    Los dos primeros segmentos son los que exige el CHECK de P02 y los que leen las funciones de Storage
    para autorizar; el tercero es lo que pedía el encargo. El nombre es un uuid nuevo y **la extensión sale
    del MIME, no del nombre del archivo**: un `.jpg` que en realidad es HTML no se convierte en imagen por
    llamarse así.
34. **P04 — el precio sale de la base como texto (`price::text` en el `select`).** Es la decisión 19
    aplicada al catálogo: un `numeric` en JSON se vuelve float en el primer `JSON.parse`. El formulario lo
    manda como string decimal a la Edge Function, que ya lo validaba así.
35. **P04 — Supabase vive en `features/catalog/api/`, nunca en un componente.** Las pantallas piden a los
    hooks y los hooks a los servicios. Alta y edición de producto van por la Edge Function `catalog-product`
    (que actúa con el JWT del usuario, sin `service_role`); categorías, imágenes y borrados van directos a
    la tabla bajo las policies que P02 ya definió. Ninguna consulta lleva filtro de tenant: lo pone la RLS.
36. **P04 — primero la fila, después el objeto de Storage.** Al revés, si el DELETE fallara por permisos,
    las fotos ya estarían perdidas y el producto seguiría en el catálogo apuntando a rutas muertas. Lo peor
    que puede pasar en este orden es dejar objetos huérfanos, que no rompen ninguna pantalla.
37. **P04 — mientras el espacio de trabajo se resuelve NO se dice «no tienes tiendas».** Mismo criterio que
    la sesión en P03: no afirmar algo que todavía no se sabe. Las pantallas de catálogo muestran esqueleto
    durante `status === 'loading'`.
38. **P05 — la disponibilidad se publica, el inventario no.** El comprador necesita saber si puede comprar;
    cuántas unidades quedan es dato competitivo del tenant y está fuera del GRANT de `anon`. Se resuelve con
    `products.in_stock`, columna **generada** (`stock > 0`): no se puede escribir a mano, así que no existe
    el estado «dice disponible y el stock es 0», y `anon` recibe el GRANT sobre ella pero nunca sobre `stock`.
39. **P05 — un producto de categoría desactivada sigue a la venta, pero sin anunciar la sección.** La
    categoría entra en `public_products` por LEFT JOIN contra la categoría activa. Con un INNER JOIN, apagar
    una categoría habría hecho desaparecer del catálogo productos que nadie despublicó — un borrado
    accidental disfrazado de cambio de menú.
40. **P05 — los filtros viven en la URL (`?q=&c=&d=&sort=`), no en un `useState` suelto.** Así una búsqueda
    se comparte, el botón de atrás hace lo que se espera y recargar no borra lo que el comprador eligió. El
    término entra con `replace: true` y sale con debounce: una entrada de historial por letra no es historial.
41. **P05 — sin logo, iniciales del tenant; nunca el isotipo EBIM haciendo de su marca.** El fallback tiene
    que ser NEUTRO (encargo). Lo mismo con el banner: sin `banner_url` se pinta el degradado de tokens, que
    ya lleva el acento del tenant, y no una foto de archivo. El lockup «by EBIM» solo aparece en el pie, y
    desaparece si la tienda es white-label.
42. **P05 — la ficha no lleva botón de compra todavía.** El carrito y el pago son P06 y esta fase no toca
    pagos. Un botón que no lleva a ninguna parte es peor que no ponerlo.
43. **P05 — la vitrina usa el cliente ANÓNIMO aunque haya sesión de backoffice abierta.** Las policies
    públicas son `to anon`: con el cliente autenticado el catálogo se vería vacío. Es la decisión de P02
    (`getStorefrontClient`), ahora ejercitada por un test que comprueba que la vitrina solo consulta vistas
    `public_*` y jamás `products` o `stores`.
44. **P05 — el lector de branding del contrato §4.3 deja de estar duplicado en el cliente.** La vista
    `public_store_branding` sigue en la base (es la interfaz homologada que consumen las otras apps de la
    suite), pero el hook `useStoreBranding` se retira: la vitrina resuelve contra `public_stores`, que trae
    eso y además `store_id`, banner y contacto. Dos lectores del mismo dato se desincronizan.
45. **P05 — `moneyText` y `sanitizeSearchTerm` suben a `src/shared/lib`.** Los necesitan por igual el
    backoffice y la vitrina; duplicarlos habría dejado dos reglas de saneado del buscador, que es el campo
    más expuesto de toda la app.

46. **P06 — la tienda del pedido la resuelve el SERVIDOR, no el cuerpo de la petición.** Hasta P05 el
    checkout habría mandado el `store_id` leído de `public_stores`; funcionaba, pero dejaba un
    identificador de fila en manos del cliente. `create_order_for_slug` (migración 12) traduce el **slug
    público** a tienda activa dentro de la misma transacción y delega en `create_order`. La Edge Function
    dejó de admitir `store_id`: si llega, la petición se cae con `CAMPO_NO_PERMITIDO`.
47. **P06 — el precio del carrito es de ESCAPARATE, no de cobro.** El carrito guarda nombre y precio para
    poder pintar la línea, pero al servidor solo viajan `product_id` y `quantity`; el importe lo vuelve a
    leer la base. Un `localStorage` editado cambia lo que el comprador ve en su pantalla y nada de lo que
    paga. Hay test de las dos mitades: el cuerpo de la petición no contiene ni la palabra `price`, y la
    confirmación muestra los números del servidor, no los del carrito.
48. **P06 — un carrito por tienda, y no se mezclan.** La clave de `localStorage` incluye el `store_id` y el
    propio carrito lo repite dentro: un carrito copiado a la clave de otra tienda se descarta al leerlo.
    Los carritos de dos tiendas coexisten sin verse; el `CartProvider` se remonta al cambiar de tienda.
49. **P06 — el carrito se vacía cuando el servidor confirma, no cuando se pulsa el botón.** Si se vaciara
    al enviar, un error de red dejaría al comprador sin carrito y sin pedido. Doble candado contra el doble
    envío: el botón se deshabilita mientras la mutación está en vuelo y el `onSubmit` corta de raíz
    cualquier envío que se cuele igual.
50. **P06 — `shipping_address` no es un vertedero.** Es un `jsonb` y lo primero que hace la Edge Function es
    aceptar exactamente dos claves (`address`, `reference`) y rechazar el resto, en vez de guardar lo que
    llegue. La referencia vacía no se guarda como clave hueca.

51. **P07 — los estados del pedido son los de la base, no los del encargo.** El encargo sugería
    `pending/confirmed/preparing/ready/completed/cancelled` «salvo definición EBIM distinta», y la
    definición EBIM existe desde P02: el enum `public.order_status` con su máquina de estados en trigger
    (`ebim.assert_order_transition`), sus policies, `create_order` y sus tests de aislamiento. Cambiarlo
    sería tocar media base para no ganar nada — mismo criterio que las decisiones 14 (`tenant_id`) y 31
    (`stock_qty`). La máquina vive en tres copias (trigger, borde Deno, navegador) y un test las compara
    entre sí y contra el SQL de la migración 04, para que no se separen solas.
52. **P07 — el historial lo escribe la BASE, no la aplicación.** `order_status_events` la puebla un trigger
    `SECURITY DEFINER` en la MISMA transacción que el UPDATE que ya validaron la RLS y la máquina de
    estados. Si lo escribiera la pantalla, un fallo de red entre el cambio y el registro dejaría un pedido
    movido sin autor, o peor: un historial que cuenta algo distinto de lo que dice la columna `status`.
53. **P07 — «append-only» no es un COMMENT, es la ausencia de GRANT.** La tabla no da INSERT/UPDATE/DELETE
    a `anon` ni a `authenticated` y no tiene policy que los habilite; la única escritura es el trigger.
    Es el mismo patrón que `orders` + `create_order` de P02 y la lección `esupplier-030` (un comentario que
    promete append-only no impide nada). Hay test de las cuatro puertas: insertar, editar, borrar y llamar
    a la función del trigger a mano fallan las cuatro.
54. **P07 — sin JWT no hay autor.** El pedido lo crea un comprador anónimo por `create-order`, así que su
    primer evento va con `actor_id`/`actor_email` en NULL y la pantalla dice «Desde la vitrina». Rellenarlo
    con el `service_role` o con el dueño de la tienda sería atribuir el pedido a quien no lo hizo.
55. **P07 — el cambio de estado NO se hace por PostgREST aunque la policy lo permita.** El GRANT por
    columna de P02 deja a `authenticated` escribir `status` directamente, y no se puede revocar porque la
    propia Edge Function actúa con el JWT del usuario. Así que la regla es de aplicación y se defiende
    donde puede defenderse: `features/orders/api.ts` no contiene ni un `.update(`, y un test lo verifica
    sobre el código fuente (quitando los comentarios, que nombran la llamada prohibida para explicarla).
56. **P07 — el filtro de fecha son PRESETS, no un panel.** La regla de suite §8 es un buscador general +
    tabs de estado y prohíbe los paneles de filtros multi-campo; el encargo pide filtrar por fecha. Un
    `Select` de rangos cerrados (hoy / 7 / 30 / 90 días) cumple las dos cosas con un solo control. El
    rango arranca a medianoche e **incluye hoy**: «últimos 7 días» son hoy y los seis anteriores.
57. **P07 — la descripción de la tienda es `hero_subtitle`; no se añade un `description`.** Es el texto que
    la vitrina ya pinta bajo el nombre desde P05. Dos campos de descripción se desincronizan y alguien
    acaba editando el que no se ve (precedente 44, el lector duplicado de branding).
58. **P07 — el branding guarda la RUTA del objeto, no una URL.** Una URL firmada caduca en una hora y
    dejaría la tienda sin logo al día siguiente; un bucket público daría lectura a cualquier ruta, incluida
    la de un borrador. Se guarda la ruta y firma cada lado bajo su propia policy: el backoffice con la
    sesión del usuario, la vitrina con el cliente anónimo (`ebim_objects_select_public_asset`, solo tienda
    activa). El CHECK `store_settings_logo_ref` valida la ruta contra las columnas de tenant de la PROPIA
    fila —igual que `product_images_path_tenant` de P02—, así que apuntar al bucket de otro tenant no es
    algo que haya que auditar después: no entra.
59. **P07 — sin SVG en el branding.** Un SVG es un documento que puede llevar `<script>`, y aquí lo sube el
    tenant y lo sirve el dominio de su vitrina. Se aceptan JPG/PNG/WebP/AVIF y la extensión sale del MIME,
    no del nombre del archivo (criterio P04 #33). El cliente además descarta cualquier referencia que no
    sea `https://` o ruta del bucket: un `javascript:` guardado en `logo_url` nunca llega a un `<img src>`.
60. **P07 — el asset sube ANTES de guardar.** Al revés, un fallo al subir dejaría la fila apuntando a un
    objeto que no existe, y eso se ve en la vitrina. En este orden lo peor que queda es un objeto huérfano
    en el bucket si el usuario cancela, que no rompe ninguna pantalla (criterio P04 #36).

## Pendientes / riesgos abiertos
- [ ] Confirmar con el operador el **project ref de Supabase** para eCommerce (aún no existe). Bloquea:
      aplicar las migraciones, `npm run db:types` y el despliegue de las 4 Edge Functions.
- [ ] **(P08) Inmutabilidad de migraciones sin candado automático.** El commit `23e7d7b` (P04) modificó
      dos migraciones ya commiteadas (`090300_catalog`, `090400_orders`) para arreglar tres FK compuestas.
      Sin daño —nada aplicado, la carpeta arranca limpia y hay test de reproducibilidad—, pero desde el
      primer `supabase db push` los archivos quedan congelados y todo cambio va en migración nueva. Un
      guard por checksum tiene sentido a partir de ese momento; antes solo daría ruido.
- [ ] **(P08) Las Edge Functions no se typechequean.** `tsconfig.json` incluye `_shared` (TS plano), pero
      `_runtime/*` y los cuatro `index.ts` usan globales de Deno y quedan fuera de `tsc`. No hay Deno en
      la máquina de la corrida; cerrar esto pide añadir `deno check` al gate.
- [ ] **(P08) Chunk de entrada de 738 kB (219 kB gzip).** `vite build` avisa. Para una app mobile-first
      conviene partir vendors con `manualChunks` (react, MUI, supabase). Es configuración de build, no
      producto, y quedó fuera del alcance del gate.
- [ ] Exponer **solo** el esquema `public` por PostgREST al crear el proyecto (`supabase/config.toml`):
      las funciones de `ebim` son de policy, no de API.
- [ ] Definir los secretos de las Edge Functions (`EBIM_PROVISIONING_KEY` ≥32 chars, `EBIM_ADMIN_ORIGINS`,
      `SUPABASE_SERVICE_ROLE_KEY`). La clave de aprovisionamiento se entrega por un canal que **no** sea el
      buzón de Drive ni el propio Drive (contrato §2.6: ambos los lee cualquiera con acceso a la carpeta).
- [x] ~~`bootstrap-tenant` se autoriza solo con la clave de aprovisionamiento~~ → **cerrado en P03**: admite
      además el JWT del hub con la firma verificada (`_runtime/verify.ts`) para el alta de sí mismo.
- [ ] `platform-context` todavía no alimenta el **nombre de las sociedades**: el selector de sociedad
      muestra el uuid corto + rol. Se cablea cuando exista el project ref y el proxy responda (P04).
- [ ] Persistir la apariencia en `profiles.settings.appearance` (hidratación cross-device al login): hoy
      solo `localStorage`. Requiere tabla de perfil, que no existe en este proyecto todavía.
- [ ] Playwright: **sigue abierto tras P08**. Los cuatro recorridos mínimos (login → alta → panel;
      producto → imagen → publicar; vitrina → carrito → checkout → pedido; admin → ver pedido) corren con
      el **router real y un backend falso**, no en navegador. El gate lo verificó así a propósito —añadir
      Playwright y sus navegadores era instalar dependencia nueva, no verificar— y por tanto siguen sin
      cubrirse los fallos que solo aparecen en un navegador de verdad. Entra con el project ref.
- [ ] **Rate limiting de `create-order`** (checkout anónimo servido con `service_role`): P06 entrega el
      flujo pero NO el límite de tasa. Hoy la única barrera es que el pedido no puede falsificar precios
      ni tenant; nada impide crear muchos pedidos basura. Necesita el project ref para elegir mecanismo
      (límite del gateway de Supabase o tabla de intentos). Pasa a P07/P08.
- [ ] `shipping_total` y `discount_total` **siguen en 0** tras P06: el encargo de la fase era el checkout
      mínimo, y no hay reglas de envío ni de cupones que aplicar. Las columnas existen y el CHECK de
      cuadre del total ya las contempla, así que entran sin migración cuando se definan.
- [ ] **Pagos**: P06 se entrega sin pasarela por encargo explícito. El pedido nace en `pending` y la tienda
      cobra por su canal. La pasarela es un addon del hub (contrato §4.4) y necesita decidir proveedor.
- [ ] **El comprador no puede consultar su pedido después**: `orders` no tiene policy para `anon` (decisión
      de P02), así que la confirmación se muestra con el estado de navegación y, si se recarga, solo queda el
      número de la URL. Un seguimiento real necesita token de pedido o identidad local del comprador.
- [ ] **Correo de confirmación al comprador**: la pantalla dice que se envía, pero no hay envío todavía —
      el buzón por app (contrato §14) no está cableado en eCommerce. Es P07 (notificaciones).
- [ ] **Reserva de stock**: `create_order` descuenta stock al confirmar, no al añadir al carrito. Dos
      compradores pueden llevar la última unidad en su carrito y solo uno se la lleva; el segundo recibe
      `STOCK_INSUFICIENTE` con mensaje claro. Reservar de verdad exige carrito servidor y caducidad.
- [ ] Alta de `ecommerce` en el hub: `apps`, `workspace_apps`, catálogo de addons propios (requiere GMAO, owner del contrato).
- [ ] Crear aviso en `coordinacion\pendientes\` declarando entrada de eCommerce a la suite y sus canales de
      integración (§0.5 del contrato) — no se hizo en esta fase por alcance (solo lectura de Drive).
- [ ] Definir crew de 5 roles (regla gmao-027) para eCommerce antes de coordinar con las otras apps.
- [ ] Decidir momento gatillo de vitrina cruzada (§6.1) hacia eSupplier/eExpense.
- [ ] Replicar assets de identidad de suite (`EbimMark`, `favicon.svg`) desde los activos compartidos.
- [ ] Confirmar si el comprador final del storefront es identidad **local** al proyecto eCommerce
      (patrón §2.5, como los proveedores de eSupplier) — supuesto actual: sí, no va al hub.
- [ ] **Variantes de producto** (talla/color/…): el checklist original de P04 las mencionaba, el encargo de
      la fase no. No existe tabla `product_variants` ni UI. Decidir con el operador si entran antes del
      storefront (P05 las mostraría) o si el modelo se queda en producto simple.
- [ ] **Miniatura en el listado de productos**: hoy las imágenes solo se ven al editar. El bucket es
      privado, así que enseñarlas en la tabla obliga a firmar N URLs por página; se hace cuando el listado
      tenga paginación, que tampoco tiene todavía.
- [x] ~~`categories` admite jerarquía sin límite de profundidad~~ → **acotado en P04**: el CRUD mínimo no
      ofrece selector de padre, así que por UI el árbol no puede crecer más de un nivel. El límite duro en
      la base se pone cuando exista la pantalla de árbol.
- [ ] **Alt text de las imágenes**: la vitrina de P05 ya SIRVE el `alt` (`primary_image_alt` en el catálogo,
      `alt` en la galería) y cae al nombre del producto cuando viene en null. Lo que falta es el campo en el
      backoffice para escribirlo: hoy P04 lo guarda siempre en null, así que en la práctica el alt es el
      nombre del producto. Cierra cuando el panel de imágenes tenga el campo.
- [ ] **SEO del storefront**: P05 entrega la vitrina navegable, pero no `<title>`/`<meta>` por producto,
      Open Graph, `sitemap.xml` ni datos estructurados; con Vite es SPA y el HTML llega vacío para un
      crawler. Es lo que queda del enunciado «SEO básico» de la fase y se aborda con el operador (necesita
      decidir prerender/SSR o meta tags de cliente).
- [ ] **Paginación del catálogo público**: hoy se pide la página entera. Con `max_rows = 1000` en PostgREST
      no revienta, pero una tienda grande manda demasiado al móvil. Entra cuando haya un catálogo real.
- [ ] **Resolución por DOMINIO**: `stores.domain` existe y la vista lo expone, pero la vitrina solo resuelve
      por slug de URL. El camino por dominio necesita el despliegue y el DNS, que dependen del project ref.
- [ ] **Seed de demo sin imágenes**: `supabase/seed.sql` no inserta `product_images` porque el objeto de
      Storage no existe en un `db reset`; la vitrina demo se ve con el marcador neutral. Para una demo con
      fotos hay que subirlas al bucket y registrar las filas.
- [ ] **Mascota de suite `Bebim.jpg` (gmao-032)**: no aplica todavía a eCommerce — no hay asistente, chat ni
      ícono de soporte con IA en ninguna pantalla. Cuando exista, se usa esa imagen desde el primer commit.

## Checklist P00–P08
- [x] **P00 — Lineamientos:** Drive leído, CLAUDE.md + trace + state + architecture creados. VERIFIED.
- [x] **P01 — Frontend foundation:** Vite + React + TS + MUI, tokens de marca, layout storefront/admin,
      i18n, router, scripts `typecheck`/`lint`/`build`/`test`. VERIFIED (36 tests verdes).
- [x] **P02 — Supabase multitenant:** 8 migraciones (`tenants`, `tenant_members`, `stores`,
      `store_settings`, `categories`, `products`, `product_images`, `orders`, `order_items`), RLS default
      deny + forzada, vistas públicas, Storage por tenant, 4 Edge Functions. VERIFIED (115 tests nuevos
      sobre Postgres real). **Tipos generados pendientes**: requieren el project ref (`npm run db:types`).
- [x] **P03 — Auth y admin:** sesión única con recuperación, login/logout/recuperación de clave, guards
      `/app/*` (sesión → tenant), `TenantProvider` sin tenant cableado, alta de espacio de sí mismo con JWT
      verificado, shell MUI responsive (sidebar/drawer, header, breadcrumb, selectores) y panel de KPIs
      reales. VERIFIED (75 tests nuevos).
- [x] **P04 — Catálogo (backoffice):** productos (listado, buscador, tabs de estado, alta/edición en drawer
      con Zod, publicar/despublicar, archivar, eliminación segura), categorías con CRUD mínimo, precios,
      stock e imágenes múltiples en Storage con principal y orden. VERIFIED (93 tests nuevos).
      **Variantes de producto quedan fuera**: no estaban en el encargo de la fase (ver pendientes).
- [x] **P05 — Storefront público:** resolución de tenant por **slug** de URL contra `public_stores`, portada
      con banner configurable + categorías + buscador + filtros simples + orden, rejilla de tarjetas con
      imagen/precio/descuento/disponibilidad, ficha con galería y relacionados simples, cabecera con logo y
      pie con contacto, branding 100% de `store_settings` con fallback neutral, y los seis estados
      (esqueleto, error, vacío, sin resultados, 404 de tienda, 404 de producto). Migración 11 y
      `supabase/seed.sql` de demo. VERIFIED (55 tests nuevos). **Fuera de alcance de esta ejecución:**
      resolución por dominio (necesita DNS/deploy) y **SEO básico** (meta tags/sitemap: requiere decidir
      prerender o SSR) — ambos anotados en pendientes. Sin pagos: carrito/checkout siguen en P06.
- [x] **P06 — Carrito y checkout:** carrito persistente por tienda en `localStorage` (agregar/quitar,
      cantidad, subtotal, Cart Drawer, sin mezclar tiendas), checkout mínimo (nombre, correo, teléfono,
      dirección + referencia opcional), pedido creado **server-side** por `create-order` →
      `create_order_for_slug` (resuelve tienda, valida publicación/cantidades/stock, precios de la BD,
      recalcula totales, `order_number`, pedido + líneas transaccionales, estado `pending`), pantalla de
      confirmación, doble envío bloqueado y errores traducidos. VERIFIED (53 tests nuevos).
      **Fuera de alcance por encargo:** pasarela de pago (addon) y rate limiting — ver pendientes.
- [x] **P07 — Pedidos y configuración:** `/app/orders` (listado, buscador general, tabs de estado, filtro
      de fecha por rangos, Exportar CSV, detalle en drawer con líneas, entrega, importes e historial, cambio
      de estado **solo** por `update-order-status`) y `/app/settings` (nombre comercial, descripción,
      contacto, color primario, logo y banner en `store-assets`, reflejados en la vitrina). Migraciones 14
      (bitácora `order_status_events` append-only por trigger SECURITY DEFINER) y 15 (CHECK de assets de
      branding por tenant). VERIFIED (59 tests nuevos). **Fuera de alcance por encargo:** facturación,
      shipping avanzado, pasarela de pago, suscripciones SaaS y dominios propios. **Notificaciones de
      pedido por correo** (contrato §14) y **custom fields por sociedad** quedan en pendientes: el encargo
      de esta fase no las pedía y §14 exige secretos M365 que carga el operador.
- [x] **P08 — Quality gate: PASS.** `npm ci` + lint + typecheck + 493 tests + build verdes; auditoría de
      RLS/aislamiento A/B, escritura pública del catálogo, Storage, `create-order`, Edge Functions,
      secretos, rutas, estados y a11y. 7 tests de gate añadidos, cero features. **Playwright sigue sin
      instalarse** (los cuatro recorridos corren con el router real y backend falso, no en navegador) y
      **las Edge Functions no se typechequean** (no hay Deno en la máquina): ambos en riesgos.

## PASS/FAIL por fase (cierre del gate P08)
| Fase | Estado | Evidencia |
| --- | --- | --- |
| P00 Lineamientos | PASS | `docs/EBIM_GUIDELINES_TRACE.md`, GUIDELINES_STATUS VERIFIED |
| P01 Frontend foundation | PASS | rutas, tokens, i18n, scripts; `routes.test.tsx`, `appearance.test.ts` |
| P02 Supabase multitenant | PASS | 14 migraciones, RLS forzada; `rls-tenant-isolation` (35), `schema-invariants` (16) |
| P03 Auth y admin | PASS | `auth-flow.test.tsx`, `session.test.ts`, `bootstrap-authorization.test.ts` |
| P04 Catálogo backoffice | PASS | `ProductsPage`, `CategoriesPage`, `ProductImagesPanel`, `catalog-admin.test.ts` |
| P05 Storefront público | PASS | `storefront.test.ts`, `storefront-ui.test.tsx`, `storefront-public.test.ts` |
| P06 Carrito y checkout | PASS | `cart.test.ts`, `checkout-ui.test.tsx` (12), `checkout-order.test.ts` |
| P07 Pedidos y settings | PASS | `OrdersPage.test.tsx`, `orders-admin.test.ts`, `SettingsPage.test.tsx` |
| P08 Quality gate | PASS | esta sección + `docs/OVERNIGHT_REPORT.md` |

## Verificaciones de esta fase (P08 — quality gate)
Node v22.17.0 · npm 10.9.2 · rama `dev` · base `fc382f1`. Sin deploy, sin push, sin PR.

### Comandos ejecutados y resultado
- `npm ci` → **exit 0**. Install limpio desde `package-lock.json`, sin desviaciones del lockfile.
- `npm run lint` (ESLint 9 flat) → **0 problemas**.
- `npm run typecheck` (`tsc --noEmit`) → **verde**, sin OOM (no hizo falta el fallback a `vite build`).
- `npm run test` (Vitest 3) → **493 tests / 34 archivos, todos verdes** (486/33 antes del gate).
- `npm run build` (`vite build`) → **verde en 4.1 s**. Único aviso: chunk de entrada de 738 kB
  (219 kB gzip), que es el aviso estándar de Vite por encima de 500 kB. Ver riesgo 5.
- Escaneo del bundle recién construido para `service_role`, `sb_secret_` y `eyJhbGciOi…`.
- `git log --name-status -- supabase/migrations` para la inmutabilidad de las migraciones.

### Auditorías, una por una
- **Migraciones reproducibles** — PASS. El harness aplica las 14 tal cual, en orden, sobre Postgres real
  (PGlite) en cada archivo de test. **Nuevo test**: dos bases vírgenes tienen que dar la misma huella de
  esquema (columnas, tipos, nulabilidad, defaults, RLS, policies, `security definer`). Una migración que
  dependa del reloj o de `random()` falla ahí y no en el primer `db push` del operador.
- **Inmutabilidad de las aplicadas** — PASS con hallazgo. El commit `23e7d7b` (P04) modificó
  `20260827090300_catalog.sql` y `20260827090400_orders.sql` ya commiteadas, para arreglar tres FK
  compuestas `on delete set null`. Sin daño: **no hay project ref**, ninguna migración se aplicó nunca y
  la carpeta actual arranca limpia desde cero. La regla se vuelve vinculante en el primer `db push`.
- **RLS y aislamiento A/B** — PASS. 35 tests con `SET ROLE` + claims en `request.jwt.claims`: A no ve, no
  inserta declarando el `organization_id` de B, no actualiza (cero filas, no error silencioso) y no borra;
  el JWT sin membresía activa no vale; membresía revocada y tenant suspendido cierran; sociedad fuera de
  `companies[]` no da acceso; nadie escala a `owner` desde la app.
- **El público no modifica el catálogo** — PASS, **cobertura ampliada**. De una aserción a doce escrituras
  probadas (`products` precio/stock/publicar/borrar, `categories`, `stores`, `store_settings`,
  `product_images`) + el catálogo intacto después + no se escribe por las vistas públicas.
- **`service_role` ausente del frontend** — PASS. Las dos apariciones en `dist/` son literales de
  detección (el prefijo que comprueba `@supabase/supabase-js` y la regex del guard `assertNoServiceKey`),
  no credenciales. Cero cadenas con forma de JWT. `.env` git-ignored; solo se versiona `.env.example`.
- **Storage aislado** — PASS. 6 tests de path `{organization_id}/{store_id}/`: A escribe en el suyo y no
  en el de B, no ve objetos de B, `anon` lee la imagen publicada pero no la del borrador ni sube nada, y
  los buckets no son públicos.
- **`create-order` recalcula precios en el servidor** — PASS. `create_order` lee el precio de la fila,
  bloquea con `for update`, descuenta stock y arma subtotal/impuesto/total en la misma transacción; el SQL
  y la Edge Function rechazan explícitamente cualquier clave de precio del cliente.
- **Edge Functions y el tenant del navegador** — PASS. Las cuatro llaman a `assertNoTenantInPayload`
  (400, no «ignorar»). `create-order` resuelve la tienda por slug **en la base**. `bootstrap-tenant` es la
  única excepción legítima y está acotada (clave dedicada en cabecera o JWT con firma verificada).
- **Rutas, responsive y estados** — PASS. `routes.test.tsx` verifica la separación de las tres áreas y los
  guards; las 19 pantallas usan `LoadingState`/`ErrorState`/`EmptyState`/`TableSkeleton`; `errorElement`
  en las tres raíces; los 17 `IconButton` con `aria-label` traducido y las 6 imágenes con `alt`.
- **Sin secretos, mocks productivos ni TODO crítico** — PASS. Cero `any`, `@ts-ignore` y `eslint-disable`.
  Las cinco coincidencias de «TODO» son la palabra española en comentarios. `src/test/supabaseMock.ts` no
  lo importa ningún archivo de producción ni aparece en `dist/`. Ninguna URL de Supabase hardcodeada.

### Recorridos mínimos: los cuatro cubiertos
| Recorrido | Dónde |
| --- | --- |
| login → onboarding → admin | `src/app/auth-flow.test.tsx` (router real, backend falso) |
| producto → imagen → publicar | `ProductsPage.test.tsx` + `ProductImagesPanel.test.tsx` |
| storefront → producto → carrito → checkout → order | `checkout-ui.test.tsx` (12 tests, flujo entero) |
| admin → ver orden | `OrdersPage.test.tsx` (detalle con líneas, entrega e historial) |

### Cambios de esta fase (solo tests)
- `supabase/tests/rls-tenant-isolation.test.ts` — +2 tests (33 → 35).
- `supabase/tests/schema-invariants.test.ts` — +1 test (15 → 16).
- `src/shared/i18n/messages.test.ts` — nuevo, 4 tests de paridad ES/EN.
- `docs/OVERNIGHT_REPORT.md` — nuevo, informe de la corrida.
- Commit: `chore: complete initial ecommerce quality gate` (local, sin push).

### Siguiente fase
**P09 depende del project ref de Supabase** y hasta que exista está bloqueada de raíz: aplicar las 14
migraciones, `npm run db:types` (los tipos de BD siguen sin generar desde P02), desplegar las 4 Edge
Functions con sus secretos y re-verificar el aislamiento contra el proyecto real. Con el ref en mano
entran, en este orden: rate limiting de `create-order`, `deno check` en el gate, Playwright en navegador
y el partido de vendors del bundle.

## Verificaciones de P07
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas**.
- `npm run test` (Vitest 3) → **486 tests / 33 archivos, todos verdes** (427 de P01–P06 + 59 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref; las migraciones 14 y 15 no están
  aplicadas en ningún proyecto real.
- Ajuste de infraestructura de test: `testTimeout` de Vitest a 30 s y `asyncUtilTimeout` de Testing Library
  a 5 s. Con la suite entera en paralelo, el flujo `login → alta → panel` recorre el router real con rutas
  `React.lazy` y pasaba de los 5 s por defecto: fallaba por lento, no por roto. No se relajó ninguna
  aserción ni se saltó ningún test.

### Reparación de la corrida (supervisor, 2026-08-27)
La corrida automatizada de P07 terminó con `Error: Reached max turns (100)`: el agente agotó su
presupuesto de turnos **después** de dejar el trabajo escrito y **antes** del commit y del marcador de
fin de fase. No hubo fallo de código. El supervisor volvió a pasar los cuatro gates sobre el árbol tal
cual (typecheck, lint, 486 tests, build → verdes) y cerró la fase con el commit local
`feat: add order management and store customization`. No se tocó código de producto ni de test.
La carpeta `claude-overnight/` (arnés de la corrida y sus logs) se deja sin versionar.

### Qué cubren los 59 tests nuevos
- `supabase/tests/orders-admin.test.ts` (16, **Postgres real** con PGlite): el alta del pedido deja el
  primer evento sin autor inventado; un cambio de estado del backoffice queda firmado con el `sub` y el
  correo del JWT; una transición imposible no cambia el estado **ni** deja evento; tocar solo la nota no
  inventa un cambio de estado; `authenticated` no puede insertar, editar ni borrar en la bitácora ni
  invocar el trigger a mano; `anon` no la ve; el tenant A no ve la de B; un `viewer` lee pedidos pero su
  UPDATE no mueve nada ni genera evento; y en branding, la base acepta la ruta del propio tenant y una URL
  `https` externa, y **rechaza** la ruta de otro tenant y los esquemas `javascript:`/`http:`/`data:`.
- `src/features/orders/orders.test.ts` (21): las tres copias de la máquina de estados dicen lo mismo (front
  ↔ borde Deno ↔ SQL de la migración 04); el dinero del pedido nunca se queda como float; un
  `shipping_address` con otra forma se lee vacío en vez de romper la pantalla; los rangos de fecha arrancan
  a medianoche e incluyen hoy; el CSV lleva importes en texto plano y neutraliza una fórmula escondida en
  el nombre del comprador; y el escáner de código que verifica que `features/orders/api.ts` no escribe por
  PostgREST y que su cuerpo no lleva tenant ni importes.
- `src/features/orders/OrdersPage.test.tsx` (9): listado con número, cliente, estado, fecha y total; el
  buscador y los tabs filtran de verdad; el filtro de fecha deja fuera lo que cae fuera del rango; el panel
  abre líneas, entrega e historial (incluido «Pedido recibido / Desde la vitrina»); el desplegable solo
  ofrece las transiciones que la base permite; el cambio de estado invoca `update-order-status` con
  `order_id`/`status`/`notes` y **sin** tenant ni importes; y un `viewer` ve el pedido con el botón
  deshabilitado.
- `src/features/admin/SettingsPage.test.tsx` (11): carga los datos reales; guarda el nombre en `stores` y
  el resto en `store_settings`; un campo vacío se guarda como NULL y no como cadena vacía; correo y color
  inválidos se detienen en el cliente; el logo sube a `store-assets` con la ruta
  `{org}/{store}/branding/logo-…` y lo que se persiste es esa ruta; SVG y >2 MB se rechazan; y un `viewer`
  no ve el formulario.
- `src/features/storefront/storefront-ui.test.tsx` (2 nuevos): el logo que subió el tenant se firma y se
  pinta en la vitrina; una referencia que no es `https` ni ruta del bucket se descarta y cae a iniciales.

## Verificaciones de P06
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas**.
- `npm run test` (Vitest 3) → **427 tests / 29 archivos, todos verdes** (374 de P01–P05 + 53 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref; las migraciones 11 y 12 no están
  aplicadas en ningún proyecto real.

### Qué cubren los 53 tests nuevos
- `supabase/tests/checkout-order.test.ts` (22, **Postgres real** con PGlite): el slug resuelve la tienda y
  el pedido queda en el tenant correcto; un slug inventado o una tienda no activa no venden; un producto de
  OTRA tienda no se cuela aunque se conozca su uuid y no mueve su stock; subtotal/impuesto/total
  recalculados con los precios vigentes (349.70 + 18 % = 412.65) y guardados como `numeric`; un precio en el
  payload se RECHAZA; un cambio de precio se refleja en el pedido siguiente; las líneas repetidas se
  agrupan; borrador y stock insuficiente no venden; cantidad ≤ 0, carrito vacío y correo inválido se
  paran; un fallo a media compra no deja pedido, ni líneas, ni stock movido; `order_number` correlativo
  **por tienda**; estado inicial `pending`; dirección y referencia guardadas tal cual; y ni `anon` ni
  `authenticated` pueden invocar la función ni leer `orders`.
- `src/features/storefront/checkout-ui.test.tsx` (12, router real + PostgREST falso): agregar abre el panel,
  la cantidad de la ficha es la que entra, el carrito de otra tienda no se ve, el carrito sobrevive a la
  recarga y se edita; el cuerpo que sale a `create-order` es exactamente `store_slug` + contacto +
  `items` y **no contiene** `price`/`total`/`currency`/`store_id`/`organization_id`; la referencia es
  opcional; un formulario incompleto no envía; un carrito vacío no llega al pago; el doble envío no crea dos
  pedidos; un error del servidor se explica sin vaciar el carrito; y la confirmación muestra los importes
  del servidor y deja el carrito vacío.
- `src/features/storefront/cart.test.ts` (14): sumar la misma línea en vez de duplicarla, fijar cantidad,
  quitar, topes, subtotal en céntimos (0.10 + 0.20 = 0.30, no 0.30000000000000004), carrito vacío a 0.00,
  producto de otra tienda rechazado, una clave de `localStorage` por tienda, carrito ajeno descartado, JSON
  roto y línea manipulada que no se cuelan, y que a servidor solo salen `product_id` y `quantity`.
- `supabase/tests/edge-shared.test.ts` (5 nuevos): `normalizeShippingAddress` acepta dirección + referencia
  opcional, no guarda referencias vacías, exige dirección, rechaza claves que no son de dirección
  (`total`, `organization_id`) y corta los textos desmesurados.

### Un cambio fuera del carrito (y por qué)
- `src/test/supabaseMock.ts`: `functions.invoke` ahora **espera** al handler. Sin eso no se puede dejar una
  llamada en vuelo y el test del doble envío no probaría nada. Los 374 tests anteriores siguen verdes.

## Verificaciones de P05
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas** (0 errores, 0 avisos).
- `npm run test` (Vitest 3) → **374 tests / 26 archivos, todos verdes** (319 de P01–P04 + 55 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` siguen siendo
  la regex del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK. Sin claves de servicio.
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref y la migración 11 no está aplicada.

### Qué cubren los 55 tests nuevos
- `supabase/tests/storefront-public.test.ts` (21, **Postgres real** con PGlite): la tienda inactiva no
  resuelve (404), la categoría desactivada desaparece del menú, borradores/archivados no salen, una
  publicación programada a futuro todavía no se ve, `in_stock` dice si hay pero `stock` sigue denegado a
  `anon`, la columna generada no se puede dejar mintiendo, un producto de categoría apagada sigue a la venta
  sin etiqueta, las vistas no exponen `sku`/tenant/`status`, la galería de un borrador no se sirve, `anon`
  no escribe por ninguna vista y el catálogo de A no se mezcla con el de B.
- `src/features/storefront/storefront-ui.test.tsx` (24, router real + PostgREST falso): resolución por slug,
  404 de tienda, logo vs iniciales neutras, contacto en el pie, tienda sin branding con fallbacks, catálogo
  con precio/descuento/disponibilidad, buscador, sin resultados con salida, filtro de categoría y de
  disponibilidad, deep link con filtros ya puestos, esqueleto, ficha con galería firmada, cambio de foto,
  descripción ausente, relacionados que nunca incluyen el producto abierto, 404 de producto, y que la
  vitrina **solo consulta vistas `public_*`** — nunca `products` ni `stores`.
- `src/features/storefront/storefront.test.ts` (10): el precio se queda en texto, el descuento solo cuenta
  si el precio tachado es mayor, un `accent_color` o un `logo_url` basura se descartan en vez de romper la
  vitrina, las iniciales del fallback, los relacionados simples y el saneado del buscador público.

### Dos cosas que cambiaron fuera del storefront (y por qué)
1. `sanitizeSearchTerm` y `moneyText` se movieron a `src/shared/lib` con reexport desde `features/catalog`:
   los usan las dos áreas y duplicarlos habría dejado dos reglas distintas para el campo más expuesto.
2. El mock de Supabase (`src/test/supabaseMock.ts`) ya implementa `or=` y ordena por tipo, en vez de ser un
   no-op. Los 319 tests anteriores siguen verdes; los que usaban `.or()` simplemente no lo estaban probando.

## Verificaciones de P04
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas** (0 errores, 0 avisos).
- `npm run test` (Vitest 3) → **319 tests / 23 archivos, todos verdes** (226 de P01–P03 + 93 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` siguen
  siendo la regex del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK. Sin claves de
  servicio: el navegador sube a Storage con la clave publicable y la sesión del usuario.
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref.

### Qué se construyó
- **Servicios** (`features/catalog/api/`): `products.ts`, `categories.ts`, `images.ts`, `errors.ts` y
  `client.ts`. Es la única puerta a Supabase del catálogo; ningún componente importa el SDK.
- **Hooks** (`useProducts`, `useCategories`, `useProductImages`): consultas y mutaciones de React Query,
  con invalidación de todo el catálogo *y* de los KPIs del panel, que cuentan las mismas tablas.
- **Productos** (`ProductsPage` + `ProductDrawer`): tabla MUI con SKU, nombre, categoría, precio, stock y
  estado; un buscador general, tabs de estado y Exportar a CSV; menú de fila con editar, publicar,
  despublicar, archivar y eliminar. El alta/edición es un `Drawer` derecho con los ocho campos del encargo,
  validación Zod cuyos mensajes son **claves de i18n** (el mismo esquema sirve en ES y EN) y barra de
  guardar persistente. Un error del servidor **no cierra el panel**: lo que el usuario escribió se queda.
- **Imágenes** (`ProductImagesPanel`): subida múltiple, principal, mover antes/después, quitar, validación
  de MIME y tamaño (5 MB) y miniaturas por **URL firmada** — el bucket es privado (decisión P02 #18).
- **Categorías** (`CategoriesPage` + `CategoryDrawer`): listado, alta, edición, activar/desactivar y
  eliminación segura. Sin selector de padre a propósito (ver pendientes).
- **UI de suite reusable**: `TableSkeleton`/`GridSkeleton`, `FormDrawer`, `ConfirmDeleteDialog` (el estándar
  §4.2 hecho componente) y `FeedbackProvider` + `useFeedback` para los avisos efímeros.
- **Migración 10** `20260827091100_catalog_admin.sql`: trigger de primera imagen principal, ascenso al
  borrar la principal, `set_primary_product_image`, `reorder_product_images`, `product_deletion_usage` y
  `category_deletion_usage`. Todas `SECURITY INVOKER`, `search_path` fijo y `EXECUTE` revocado a `anon`.

### Un defecto de P02 que este trabajo destapó
Las tres claves foráneas compuestas con `on delete set null` (`products.category_id`,
`order_items.product_id` y `categories.parent_id`) ponían a null **toda** la clave, incluido `store_id`,
que es NOT NULL. En la práctica: **borrar una categoría con productos, o un producto con líneas de pedido,
fallaba con un error de constraint** — justo las dos operaciones que P04 estrena. Se corrigió con la lista
de columnas de Postgres 15+ (`on delete set null (category_id)`), editando las migraciones de P02 porque
ninguna está aplicada todavía. Los dos tests que lo destaparon siguen en el banco.

### Tests nuevos (93)
- `supabase/tests/catalog-admin.test.ts` (20) — sobre Postgres real: la primera imagen queda principal;
  cambiar la principal deja exactamente una; volver a marcar la misma no falla; un rol `viewer` recibe
  `SIN_PERMISO` en vez de un no-op silencioso; para el tenant vecino la imagen no existe; `anon` no ejecuta
  ninguna de las cuatro funciones; el reorden se aplica entero y rechaza listas parciales, repetidas o
  vacías; el conteo de uso es el real y el tenant vecino no lo obtiene ni forzando el `org_id` en el JWT;
  borrar la categoría deja los productos sin categoría en vez de borrarlos; borrar la principal asciende la
  siguiente; y borrar el producto se lleva sus imágenes dejando la línea de pedido con su snapshot.
- `src/features/catalog/catalog.test.ts` (38) — funciones puras: el dinero nunca se guarda como `number`;
  el formulario rechaza precio con coma, con moneda pegada o con tres decimales, y stock negativo o
  decimal; el slug usa el mismo formato que la Edge Function; los mensajes son claves de i18n; validación
  de imagen por MIME y tamaño; la ruta empieza por `{org}/{store}/{product}/` y la extensión sale del MIME;
  dos subidas no comparten nombre; `moveImage` nunca pierde elementos; el buscador neutraliza los
  separadores del filtro `or` de PostgREST; los errores de RLS se explican como falta de permiso y lo
  desconocido **no filtra el mensaje de Postgres**; y el CSV neutraliza las celdas que Excel ejecutaría.
- `src/features/catalog/ProductsPage.test.tsx` (18) — contra el árbol real con un backend falso: la tabla,
  el esqueleto mientras se resuelve el espacio, el estado vacío, el gating por rol, un solo buscador, las
  cuatro pestañas; **el alta manda `create` sin ninguno de los nueve campos de tenant** que el contrato
  prohíbe; el slug se sugiere del nombre; un precio inválido se detiene en el cliente; publicar manda solo
  el estado; y el diálogo de borrado enseña el conteo real y ofrece archivar.
- `src/features/catalog/CategoriesPage.test.tsx` (7) — el alta escribe el tenant que el JWT resolvió, un
  slug inválido no llega a escribir nada, desactivar conserva la fila, y el diálogo cuenta productos e hijas.
- `src/features/catalog/ProductImagesPanel.test.tsx` (11) — sin producto guardado no hay dónde subir; el
  objeto y la fila apuntan a la misma ruta bajo `{org}/{store}/{product}/`; varias a la vez se colocan en
  orden; el `accept` declara solo los cuatro formatos y, si un archivo se cuela igual, la validación propia
  lo para antes de tocar Storage; el tamaño se corta en 5 MB; marcar principal deja una sola; reordenar
  manda la lista completa; y quitar borra la fila **y** el objeto de Storage.
- `src/app/routes.test.tsx` — actualizado: el backoffice tiene ahora cinco secciones.

### Nota de coordinación
No se escribió en Drive (la carpeta es de solo lectura para este repo). El aviso de alta de eCommerce en la
suite y la definición de crew siguen pendientes desde P02/P03.

## Verificaciones de P03
- `npm run typecheck` (`tsc --noEmit`) → verde.
- `npm run lint` (ESLint 9 flat config) → verde, **0 problemas** (0 errores, 0 avisos).
- `npm run test` (Vitest 3) → **226 tests / 18 archivos, todos verdes** (151 de P01+P02 + 75 nuevos).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` siguen
  siendo la regex del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK. Sin claves de servicio.
- Sin push, sin PR, **sin deploy remoto**: sigue sin existir project ref.

### Qué se construyó
- **Sesión** (`features/auth`): `SessionProvider` con una única suscripción a Supabase Auth; `getSession()`
  recupera la sesión persistida, y mientras esa lectura está en curso el estado es `loading` y no
  `anonymous` —dar por anónimo a quien sí tiene sesión lo expulsaría al login en cada F5—. La sesión de
  `PASSWORD_RECOVERY` es un estado propio: sirve para poner la clave nueva y no abre el backoffice.
- **Login / recuperación** (`AuthShell`): la anatomía de suite (§4.5, `esupplier-031`) se extrajo a un
  componente y ahora la comparten login, `/recuperar` y `/nueva-clave` — que es justo lo que pide el punto 7
  de la regla. El correo de recuperación responde igual exista o no la cuenta: lo contrario es un
  enumerador de usuarios del cliente.
- **Contexto de tenant** (`features/tenant`): `resolveTenantSelection` es una función pura con las reglas
  de resolución (claims → membresías → sociedad → tienda) y `TenantProvider` solo la alimenta. Ninguna de
  las tres consultas (`tenants`, `tenant_members`, `stores`) lleva filtro de tenant: lo pone la RLS.
- **Alta mínima** (`features/onboarding`): tres campos —nombre del negocio, dirección de la tienda, moneda—
  y ni uno más. Quién eres, a qué cuenta perteneces y con qué correo NO se preguntan: salen del token. El
  correo de administrador que exige `echange-005`/§3.2 es el de la propia sesión.
- **Shell administrativo**: sidebar fijo en escritorio y `Drawer` en móvil, topbar con breadcrumb derivado
  de la navegación, selector de sociedad (solo si hay más de una), selector de tienda (autoselección con
  una sola, preparado para varias), menú de cuenta con rol y cierre de sesión, y el nombre del espacio
  siempre visible en el sidebar.
- **Panel**: `public.dashboard_kpis` (migración 09) devuelve productos, publicados, pedidos y ventas.

### Estados cubiertos, uno por uno
| Estado | Dónde | Qué se ve |
|---|---|---|
| Cargando | sesión, workspace, KPIs | `LoadingState` con `role="status"` |
| Error | workspace, KPIs, sesión | `ErrorState` con reintento y el detalle técnico aparte del mensaje humano |
| Vacío | tenant sin tiendas, panel sin catálogo | `EmptyState` con acción, no un cero suelto |
| Sin permiso | token sin `org_id`, Configuración sin rol | `UnauthorizedState` (nuevo) con salida clara |
| Sin espacio | usuario nuevo | redirección a `/onboarding` |

### Tests nuevos (75)
- `src/features/tenant/workspace.test.ts` (15) — resolución de tenant: sin claims → `unauthorized`; sin
  membresía → `onboarding`; autoselección con una sociedad/tienda; `active_company` del JWT con varias;
  membresía viva para una sociedad que el token ya no otorga; tenant de otra organización; selectores que
  solo admiten lo que la RLS devolvió.
- `supabase/tests/bootstrap-authorization.test.ts` (22) — las dos credenciales del alta: la clave manda
  sobre la sesión, sin credencial es 401, el camino de usuario rechaza `organization_id`/`company_id`/
  `tenant_id`/`org_id`/`owner_user_id`/`admin_email` en el cuerpo, `@ebim.pe` no puede crearse un tenant,
  y una moneda mal escrita falla en vez de degradarse a PEN en silencio.
- `supabase/tests/dashboard-kpis.test.ts` (8) — sobre Postgres real: cada tenant cuenta lo suyo, pedir la
  tienda del otro por id devuelve ceros, un JWT con el `org_id` ajeno no cuenta nada, las ventas excluyen
  anulados, el dinero sale como texto, con monedas mezcladas devuelve null, y `anon` no puede ejecutarla.
- `src/app/auth-flow.test.tsx` (6) — el flujo completo contra el router real: `/app` sin sesión manda al
  login; login → alta → panel; quien ya tiene espacio va directo; ventas en guion cuando no hay cifra;
  token sin jerarquía → `unauthorized`; cerrar sesión vuelve al login.
- `src/shared/lib/roles.test.ts` (6) — la matriz de capacidades del front y la del borde son copias
  separadas (bundle vs Deno) y este test es lo que impide que se separen.
- `src/features/onboarding/bootstrapTenant.test.ts` (8) y `src/features/auth/authApi.test.ts` (7).
- `src/app/routes.test.tsx` (+3) — actualizado: ahora afirma que `/app` y `/onboarding` cuelgan del guard y que
  login, recuperación y storefront quedan fuera.

### Un defecto de P01 que este trabajo destapó
Las pantallas de Productos y Pedidos consultaban columnas que **no existen** en las migraciones de P02:
`products.image_url`, `orders.number`, `orders.total`, `orders.created_at`. Venían de los tipos de dominio
que P01 escribió antes de que existiera el esquema, y nadie lo notó porque sin project ref ninguna consulta
llegó a correr. Como el panel cuenta esas mismas tablas, se corrigieron aquí: los tipos ahora usan
`order_number`, `grand_total`, `placed_at` y `stock`, y las dos pantallas se acotan a la tienda activa.

### Coordinación (buzón leído, sin escribir en Drive)
Se leyó `coordinacion\BANDEJA.md` y los pendientes relevantes. Cómo queda P03 frente a ellos:
- `esupplier-031` (anatomía única de login) — **cumplido y extendido**: la anatomía es ahora un componente
  compartido por las tres pantallas de auth, como pide su punto 7.
- `echange-005` (correo de administrador obligatorio al crear tenant) — **cumplido en la base** desde P02;
  P03 no añade una vía que lo esquive: el alta de sí mismo toma el correo del token y falla sin él.
- `gmao-038` (multi-tenant por persona) — **sin implementar a propósito**, está pendiente de decisión del
  operador. Se adoptó su recomendación provisional: mostrar el nombre del espacio en el que estás.
La carpeta de Drive se mantiene de **solo lectura** (regla del repo), así que sigue pendiente el aviso de
alta de eCommerce en la suite, ya anotado en P02.

## Verificaciones de P02
- `npm run typecheck` (`tsc --noEmit`) → verde. Ahora incluye `supabase/functions/_shared` y `supabase/tests`.
- `npm run lint` (ESLint 9 flat config, `no-explicit-any` en error) → verde, 0 problemas.
- `npm run test` (Vitest 3) → **151 tests / 11 archivos, todos verdes** (36 de P01 + 115 nuevos de P02).
- `npm run build` (`vite build`) → verde. Se mantiene el aviso de chunk >500 kB del vendor MUI (P01).
- Auditoría de secretos sobre `dist/`: las únicas coincidencias de `service_role`/`sb_secret_` son la regex
  del guard `assertNoServiceKey` y el chequeo de prefijo del propio SDK de Supabase. Sin claves de servicio.
- Sin push, sin PR, **sin deploy remoto**: no existe project ref y ninguna migración se ha aplicado.

### Cómo se probó el aislamiento sin proyecto remoto
Las pruebas de RLS corren sobre **Postgres real** con `@electric-sql/pglite` (Postgres 18 en WASM).
`supabase/tests/harness.ts` recrea lo que las migraciones dan por hecho porque Supabase ya lo trae (roles
`anon`/`authenticated`/`service_role`, `auth.jwt()`, esquema `storage`), aplica **las migraciones tal cual**
y consulta con `SET ROLE` + `request.jwt.claims`. No se simula ninguna policy: si una está mal escrita,
el test falla.

- `rls-tenant-isolation.test.ts` (33) — tenant A vs tenant B vs público: lectura, escritura, borrado,
  pedidos, membresías, JWT forjado con el `org_id` ajeno, membresía revocada, tenant suspendido, gating por
  rol, columnas publicables, y aislamiento de Storage por path.
- `server-operations.test.ts` (25) — alta atómica de tenant (incluye `ADMIN_EMAIL_REQUERIDO` y que un slug
  de tienda inválido no deje tenant huérfano), recálculo de totales, stock, moneda, máquina de estados.
- `schema-invariants.test.ts` (15) — RLS activada y forzada en todas, ninguna tabla sin policy, ninguna
  policy para PUBLIC, `organization_id`+`company_id` NOT NULL e indexados, PK uuid, cero columnas
  float/real/money, `search_path` fijo en toda función SECURITY DEFINER, y que `anon`/`authenticated` no
  puedan ejecutar las operaciones de servidor.
- `edge-shared.test.ts` (42) — capa compartida de las Edge Functions: rechazo (no silencio) de un tenant
  declarado en el cuerpo, guard `@ebim.pe`, clave de aprovisionamiento, carrito sin precios, CORS por
  origen, y traducción de errores sin filtrar internos de Postgres.

### Dos fallos reales que encontraron estas pruebas
1. `ebim.safe_uuid` quedaba con `REVOKE ... FROM public` y sin `GRANT`: toda policy que derivaba el tenant
   del JWT fallaba con «permission denied for function safe_uuid». En un proyecto remoto se habría visto
   como un backoffice que no muestra absolutamente nada.
2. La vista `public_products` ordenaba la imagen principal por `created_at`, columna fuera del GRANT por
   columna de `anon`: el catálogo público reventaba con «permission denied for table product_images».

Ambos se corrigieron editando las migraciones **porque ninguna está aplicada todavía**. A partir del primer
`db push`, la regla es la del encargo: migración aplicada es inmutable y toda corrección es una migración nueva.

### Pendientes técnicos que deja P02
- Tipos de BD generados (`npm run db:types`): bloqueado por el project ref. **No se escriben a mano**
  (convención del repo), así que las pantallas siguen con los tipos de dominio de P01 hasta entonces.
- Las Edge Functions no tienen test de integración HTTP (haría falta el runtime de Deno o el stack local);
  lo que sí queda cubierto es toda su lógica de decisión, extraída a propósito a `_shared`.
- `logo_url`/`favicon_url` son URL absolutas (interfaz homologada del contrato §4.3); resolver un objeto
  subido a `store-assets` hasta una URL es trabajo de P04, cuando exista la pantalla de subida.
- El comprador del storefront no puede consultar su propio pedido: eso pide un token de seguimiento (P06),
  no una policy de `anon` sobre `orders`.
- `categories` admite jerarquía (`parent_id` amarrado a la misma tienda) pero no hay límite de profundidad;
  se acota en P04 cuando exista el árbol en pantalla.
