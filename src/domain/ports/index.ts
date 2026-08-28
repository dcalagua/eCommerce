/**
 * Puertos del dominio.
 *
 * ## Cuándo se crea un puerto en este repositorio
 *
 * La regla, para no acabar con una interfaz por función: **un puerto existe
 * cuando hay una segunda implementación ya declarada**, y «declarada» significa
 * que se puede señalar dónde. Dos fuentes valen:
 *
 *  - una fila de `integration_providers` con la operación en `capabilities`
 *    (migración `20260827150000`), que es un compromiso del producto; o
 *  - dos llamantes concretos hoy en `src/` que hacen lo mismo de dos maneras.
 *
 * Si no se cumple ninguna, no se crea el puerto. Una interfaz con una sola
 * implementación es indirección, no arquitectura.
 *
 * ## Los que existen y por qué
 *
 * | Puerto | Segunda implementación declarada en |
 * |---|---|
 * | `PricingPort` | `price.read` (dos adaptadores de ERP) + listas de P04 |
 * | `InventoryPort` | `stock.read` (dos adaptadores de ERP) + almacenes de P06 |
 * | `PaymentProvider` | tres pasarelas en `integration_providers` |
 * | `FulfillmentProvider` | `shipment.create` / `shipment.track` |
 * | `NotificationProvider` | `message.email` / `sms` / `whatsapp` |
 * | `ErpProvider` | dos generaciones del mismo ERP, mismas operaciones |
 * | `InvoicingProvider` | `invoice.issue` / `invoice.read` |
 * | `SearchPort` | vitrina anónima y backoffice con sesión (P11-SaaS) |
 *
 * ## `SearchPort`: el disparador se cumplió en P11-SaaS
 *
 * Hasta P10 este bloque explicaba por qué el puerto NO existía —una sola
 * implementación real, un `ilike` de PostgREST en dos sitios— y dejaba escrito
 * el disparador: «el día que aparezca un índice o motor de búsqueda propio
 * (P11 / P15)». P11 crea ese índice (`products.search_vector`, trigramas y
 * sinónimos por tienda) y con él aparecen las DOS implementaciones que la regla
 * de arriba exige, que no son dos capas de lo mismo:
 *
 *  - la de la **vitrina** (`catalog_search_for_slug`, comprador anónimo, solo
 *    lo publicado, con precio resuelto y semáforo de disponibilidad), y
 *  - la del **backoffice** (`catalog_search`, con sesión, incluye lo NO
 *    publicado), cuyo primer llamante es el selector de productos del editor de
 *    contenido.
 *
 * Es la misma forma que `InventoryPort` tiene desde P06: dos actores, dos
 * autorizaciones, dos respuestas.
 *
 * `shared/lib/search.ts` (`buildTextSearchFilter`) NO se retira: sigue siendo la
 * construcción del filtro `ilike` de los listados del backoffice —pedidos,
 * clientes, campañas—, que buscan sobre otras tablas y no sobre el catálogo. El
 * puerto es del catálogo; aquello es sintaxis de PostgREST.
 */
export * from './operations'
export * from './pricing'
export * from './inventory'
export * from './payment'
export * from './fulfillment'
export * from './notification'
export * from './erp'
export * from './invoicing'
export * from './search'
