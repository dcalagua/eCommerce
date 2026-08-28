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
 *
 * ## `SearchPort`: deliberadamente NO se crea todavía
 *
 * La búsqueda de hoy es un `ilike` de PostgREST en dos sitios
 * (`features/catalog/api/products.ts` y `features/storefront/api.ts`), sobre
 * dos vistas distintas y devolviendo dos tipos distintos. Un puerto que los
 * unificara tendría que inventar un modelo de resultado que ninguna de las dos
 * pantallas necesita, y seguiría teniendo una sola implementación real: sería
 * exactamente la abstracción sin frontera que este proyecto se prohíbe.
 *
 * Lo que sí había era duplicación de verdad: la construcción del filtro. Está
 * unificada en `shared/lib/search.ts` (`buildTextSearchFilter`), que es la
 * costura por la que entrará el puerto cuando exista el segundo implementador.
 *
 * **Disparador para crearlo:** el día que aparezca un índice o motor de
 * búsqueda propio (P11 / P15) o un `catalog.search` en
 * `integration_providers`. Antes no.
 */
export * from './operations'
export * from './pricing'
export * from './inventory'
export * from './payment'
export * from './fulfillment'
export * from './notification'
export * from './erp'
export * from './invoicing'
