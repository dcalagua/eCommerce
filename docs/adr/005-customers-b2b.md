# ADR 005 — Clientes, cuentas B2B y el vínculo que decide el servidor

- **Estado:** aceptada
- **Fecha:** 2026-08-27
- **Fase:** P05-SaaS (productización)
- **Contexto previo:** [`ADR 001`](001-domain-boundaries.md) §1 (la frontera `customers` estaba
  declarada y vacía), [`ADR 002`](002-capabilities-entitlements.md) §2 (`customers.b2b` era
  `declared`), [`ADR 004`](004-pricing-engine.md) §8 (`customer_segments` nació en P04 y
  `price_list_assignments.customer_id` quedó **sin FK** como deuda declarada)
- **Contrato EBIM:** §0.2 (personalización = configuración), §2 (la identidad la emite el hub), §3
  (jerarquía `organization` → `company` → datos), §4.2 (eliminar muestra el uso real), §8 (tabs
  centrados, un buscador general), §13 (`@ebim.pe` no es actor de negocio de un tenant)

---

## Contexto

Hasta P04, «el cliente» de eCommerce eran tres columnas desnormalizadas dentro del pedido
(`orders.customer_email`, `customer_name`, `customer_phone`) y un uuid **sin tabla**
(`price_list_assignments.customer_id`). Eso alcanza para una tienda que le vende una vez a un
desconocido y no alcanza para nada más: no hay dónde guardar la segunda dirección de entrega, ni el
contacto de compras, ni el código con el que ese mismo cliente existe en el ERP, ni a qué segmento
pertenece para que el motor de precios lo encuentre.

Y hay una segunda pregunta, que es la que separa una tienda de un canal B2B: **quién, de esa
empresa, puede comprar, hasta cuánto y a qué sucursal**.

## Decisión

### 1. Usuario autenticado ≠ cliente, y el modelo lo hace imposible de confundir

Son dos ejes distintos:

| | Quién es | Quién lo emite | Dónde vive |
|---|---|---|---|
| **Usuario** | quien inicia sesión | el hub (contrato §2) | el JWT |
| **Cliente** | la contraparte comercial | esta app | `customers` |

`customers` **no tiene `user_id`**, y hay un test de esquema que falla si aparece. Con esa columna,
el modelo diría que un cliente ES una persona con sesión, y a partir de ahí el segundo comprador de
la misma empresa no cabe: o se duplica la ficha, o se elige a uno.

El vínculo entre personas y cuentas es una **relación** (`business_account_users`), porque una
columna solo sabe expresar «uno». La mayoría de los clientes de una tienda nunca tendrá un usuario, y
eso también tiene que ser representable.

### 2. El alcance es la SOCIEDAD, no la tienda

`customers` no lleva `store_id`, igual que `customer_segments`, las marcas y las unidades de medida.
Un cliente de la sociedad lo es de todas sus tiendas: darle `store_id` obligaría a duplicar la ficha
—y con ella el documento fiscal, las direcciones y el código del ERP— cada vez que la sociedad abre
un canal nuevo, y desde ese momento habría dos verdades sobre el mismo cliente. El pedido sí es de
una tienda; el cliente que lo hace, no.

### 3. La ficha es BASELINE; lo que se vende es la cuenta B2B

`customers` entra en `app_capabilities` como capacidad baseline —la primera que se añade después de
P02— y `customers.b2b` pasa de `declared` a `implemented`.

Cobrar aparte por poder anotar el correo del comprador no sería un módulo, sería un peaje: dejaría a
un tenant sin plan sin poder atender una devolución. Lo que sí es un módulo es el **portal**: varios
usuarios, sucursales, roles y límites de autorización.

La consecuencia práctica: la ruta `/app/customers` se gatea con `customers` (que todo tenant activo
tiene) y **la pestaña de cuentas B2B** con `customers.b2b`, dentro de la misma pantalla. Las policies
lo aplican igual: escribir un cliente pide rol; escribir una cuenta pide rol **y** capacidad.

### 4. `business_accounts` es una activación, no una tabla espejo

La cuenta B2B es 1:1 con el cliente empresa, así que «podrían ser columnas de `customers`». No lo
son, por dos razones que se notan el primer día:

- **Ciclo de vida distinto.** Casi ningún cliente tiene portal. Meter `requires_approval`,
  `approval_threshold` y `purchase_order_required` en `customers` haría que cada comprador de
  mostrador arrastrara tres columnas que no significan nada para él.
- **Se contrata aparte.** Con todo en una tabla, la policy tendría que exigir la capacidad para
  escribir el teléfono de un comprador anónimo, o no exigirla para nada.

Lo que sí se impide es el estado absurdo: `business_accounts` referencia `(customer_id,
customer_kind)` contra `customers (id, kind)` con `on update cascade`, así que **una cuenta
corporativa sobre una persona física es imposible**, y un cliente con cuenta ya no se puede convertir
en persona. Es la misma técnica del PIM: columna denormalizada + CHECK + FK a una clave de apoyo del
padre.

### 5. Los roles B2B son un enum; lo configurable son los importes

Cuatro roles fijos —`admin`, `approver`, `buyer`, `viewer`— y no una tabla de roles con permisos por
fila:

- un permiso que es un dato ya no se puede leer dentro de una policy sin una consulta más por cada
  comprobación, y «quién puede aprobar» pasa a ser el resultado de un JOIN;
- un «comprador» al que se le puede marcar `puede_aprobar` **destruye la separación de funciones**
  para la que existen las reglas de aprobación. Si el rol es configurable, el control es decorativo.

Lo que sí es configurable, y es lo que cada empresa necesita de verdad, son los **importes**:
`business_account_users.spending_limit` por persona y `approval_rules.min_amount` por cuenta. Es la
misma decisión que P04 tomó con la precedencia de precios: el orden no se configura, los números sí.

La matriz de la UI (`BUSINESS_ROLE_PERMISSIONS`) fija además que **el aprobador no compra**: si
comprara y aprobara lo suyo, el control no existiría.

### 6. El acceso a una cuenta lo decide el servidor, y la firma lo demuestra

`public.my_business_accounts()` **no acepta ningún argumento**. No es una comodidad: es la regla 8 de
la fase escrita en la firma de la función. Sin parámetro de cuenta no existe la clase de error que
consiste en creerse el que manda el navegador.

Los usuarios B2B **no tienen ni una policy** sobre las tablas del backoffice: no son miembros del
tenant, así que `ebim.can_access` les devuelve `false` y PostgREST no les entrega una sola fila. Su
única puerta es esa función `SECURITY DEFINER`, que deriva todo de `ebim.user_id()`. Darles policies
habría significado exponer las tablas del backoffice a un público externo para ahorrarse una función.

### 7. La aprobación es una decisión pura, y una sola

`public.purchase_approval(cuenta, importe)` responde si hace falta aprobación y **por qué**, con tres
motivos evaluados de más específico a más general: límite personal → regla de la cuenta → umbral de
la cuenta. Entre reglas gana la de **mayor umbral alcanzado**, igual que una escala de precio, y dos
reglas con el mismo umbral las rechaza un índice único: el ganador dependería del orden de las filas.

No crea solicitudes, no notifica y no cambia estados: la fase pide fundamento, no workflow. Y el
comprobador del backoffice llama a **esa misma función**, no a una copia en JavaScript — la misma
decisión que el simulador de precios de P04, y por la misma razón: se abre precisamente cuando
alguien duda.

### 8. La dirección: dos banderas de uso, un índice parcial por defecto y un ESTADO de verificación

- **El uso son dos banderas, no un enum.** La misma dirección suele servir para entregar y para
  facturar; con un enum habría que duplicar la fila, y el día que cambie la calle habrá que acordarse
  de cambiarla dos veces. Un CHECK exige al menos un uso.
- **El predeterminado es un índice parcial único** por cliente y por uso: no puede haber dos
  direcciones de envío por defecto, ni una por defecto de un uso que la dirección no tiene.
- **La verificación es un estado de cuatro valores**, no un booleano. Una integración que valida
  direcciones distingue «todavía no se preguntó» de «se preguntó y dijo que no», y con un booleano
  las dos serían `false` — que es como se reintenta eternamente una dirección ya rechazada. Para un
  ERP que solo entrega en destinos autorizados, `verified` **es** autorizado. `verified_at` lo estampa
  un trigger: una fecha de verificación escrita por el cliente es una fecha inventada.

### 9. Los identificadores externos son un atributo, nunca una clave

El código del ERP no es único entre sistemas, cambia cuando el cliente migra de versión y no existe
para el que se dio de alta ayer en la tienda. Una PK con esas tres propiedades no es una PK.

`customer_external_ids` lleva dos unicidades y las dos hacen falta: un cliente tiene **un** código
por sistema (si no, la sincronización no sabe cuál mandar) y un código de un sistema apunta a **un**
cliente (si no, dos fichas se pelean por el mismo documento entrante). `system_code` va **sin FK** a
`integration_providers` a propósito: un ERP sin conector declarado también tiene códigos de cliente.

### 10. El cliente entra en el motor de precios, y cierra la deuda de P04

Dos cosas:

1. **`price_list_assignments.customer_id` gana su FK**, compuesta con el tenant. Un uuid inventado ya
   no entra, y un cliente de otra sociedad tampoco. Es exactamente lo que el ADR 004 §8 dejó
   asignado a esta fase.
2. **`public.price_quote` deriva el segmento del cliente** cuando no se declara. Antes había que
   teclear los dos y nada garantizaba que coincidieran: se podía simular «el cliente X con el
   segmento del vecino», que es un precio que no le van a cobrar a nadie. El segmento explícito sigue
   mandando cuando se da, para poder responder «¿y si lo pasamos a mayorista?».

### 11. `orders` NO gana `customer_id`, y el enlace por correo se declara como lo que es

El checkout sigue siendo anónimo. Colgarle un `customer_id` al pedido hoy sería una columna que solo
puede rellenar el navegador —y el navegador no declara identidades (regla 6 del contrato de
ejecución)—. Se cierra cuando el comprador tenga sesión.

Mientras tanto, `public.customer_orders(cliente)` enlaza por el **correo** de la ficha o de sus
contactos. Es una heurística, y por eso vive en una función con nombre propio y con su aviso en la
pantalla, en vez de en una FK que aparentaría una certeza que no hay.

## Alternativas descartadas

- **`customers.user_id`.** Se descartó por lo del punto 1: hace irrepresentable el caso normal de una
  empresa —varias personas comprando— y ata la ficha al proveedor de identidad de hoy.
- **Tabla `business_roles` configurable por cuenta.** El requisito de la fase la ofrecía como opción
  («o relación equivalente»). Se descartó por el punto 5: mueve la separación de funciones a datos
  que el propio cliente edita.
- **Un tercer valor `kind = 'private'` para los «perfiles privados».** Un perfil privado es una
  persona sin cuenta B2B, que ya es `person` sin fila en `business_accounts`. El tercer valor
  obligaría a decidir qué pasa cuando una persona contrata el portal, y la respuesta correcta —nada—
  ya la da el enum de dos.
- **Direcciones dentro de la sucursal.** Se descartó: la sucursal referencia una dirección del
  cliente con FK compuesta `(address_id, customer_id)`. Duplicar el domicilio significaría corregirlo
  dos veces.
- **Policies para el usuario B2B sobre las tablas del backoffice.** Habría ahorrado una función y
  abierto ocho tablas internas a un público externo. Se descartó por el punto 6.
- **Evaluar la aprobación en el navegador.** Es la tercera copia de la misma regla, el patrón que P04
  desmontó con el precio.
- **Crédito y condiciones de pago.** Fuera de alcance por la regla 7 de la fase: es lógica de un ERP
  concreto y no de este producto.

## Consecuencias

- **Ocho tablas nuevas** (`customers`, `customer_addresses`, `customer_contacts`,
  `customer_external_ids`, `business_accounts`, `business_locations`, `business_account_users`,
  `approval_rules`), todas con RLS forzada, tenant en columnas exactas y FK tenant-safe.
- **Cinco funciones nuevas**: `my_business_accounts`, `purchase_approval`, `customer_orders`,
  `customer_deletion_usage` y `ebim.customer_segment`; más `price_quote` recreada.
- **`customers.b2b` deja de ser `declared`** y aparece `customers` como baseline: el registro de
  capacidades crece a 17 y el test de paridad contra `src/domain/capabilities.ts` lo comprueba fila a
  fila.
- **La frontera `customers` pasa de `partial` a `implemented`** en `src/domain/boundaries.ts`, con
  código en `features/customers` y en `features/storefront/StoreAccountPage.tsx`.
- **Lo que queda abierto**: el comprador del storefront sigue sin identidad propia (P16), así que el
  área de cuenta enseña contexto y todavía no compra en nombre de la cuenta; el flujo de aprobación
  —estados, bandeja, notificaciones— es de una fase posterior; y `database.types.ts` sigue sin
  regenerar, por la misma razón que en P02–P04.
