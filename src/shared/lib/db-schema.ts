/**
 * Vocabulario de PERSISTENCIA: cómo se llaman las cosas en Postgres.
 *
 * Está aquí y no en `src/domain` a propósito. Un nombre de tabla no es un
 * concepto de negocio, es un detalle de la implementación que hoy es Supabase;
 * el dominio habla de «producto», no de `public.products`. La prueba de
 * arquitectura verifica que nada bajo `src/domain` importa este archivo.
 *
 * Por qué existe: antes de P01 las mismas constantes estaban escritas dos veces
 * —`STORES_TABLE` en `features/tenant` y en `features/admin/settings`,
 * `PRODUCT_IMAGES_BUCKET` y `STORE_ASSETS_BUCKET` en catálogo y en storefront—.
 * Dos copias de un nombre no se separan el día que se escriben, se separan el
 * día que una de las dos cambia. Cada feature reexporta lo suyo, así que ningún
 * llamante tuvo que cambiar de import.
 *
 * Además es el **consumidor de `database.types.ts`** (R11). Cada constante lleva
 * `satisfies` contra el esquema generado, así que un nombre de tabla, vista o
 * función que deje de existir en la base **deja de compilar**. Hasta P01 el
 * archivo generado estaba commiteado en 0 bytes y no lo importaba nadie, o sea
 * que la convención «tipos generados, no escritos a mano» no se cumplía y
 * tampoco había forma de notarlo. El generador se arregló en
 * `scripts/gen-db-types.mjs`; esto es lo que le da un consumidor.
 *
 * Los buckets de Storage y los nombres de Edge Function NO se pueden tipar así:
 * no están en el esquema `public`. Se quedan como literales.
 */
import type { Database } from './database.types'

type Schema = Database['public']
type TableName = keyof Schema['Tables']
type ViewName = keyof Schema['Views']
type FunctionName = keyof Schema['Functions']

// --- Tablas ----------------------------------------------------------------
export const TENANTS_TABLE = 'tenants' satisfies TableName
export const TENANT_MEMBERS_TABLE = 'tenant_members' satisfies TableName
export const STORES_TABLE = 'stores' satisfies TableName
export const STORE_SETTINGS_TABLE = 'store_settings' satisfies TableName
export const PRODUCTS_TABLE = 'products' satisfies TableName
export const CATEGORIES_TABLE = 'categories' satisfies TableName
export const PRODUCT_IMAGES_TABLE = 'product_images' satisfies TableName
export const ORDERS_TABLE = 'orders' satisfies TableName
export const ORDER_ITEMS_TABLE = 'order_items' satisfies TableName
export const ORDER_EVENTS_TABLE = 'order_status_events' satisfies TableName
export const CURRENCIES_TABLE = 'currencies' satisfies TableName
export const TAX_CATEGORIES_TABLE = 'tax_categories' satisfies TableName

// --- Capacidades y entitlements (P02-SaaS, migración 160000) ---------------
// SIN `satisfies`: `database.types.ts` se genera contra el proyecto Supabase
// ENLAZADO y la migración 160000 todavía no está aplicada allí (esta fase no
// despliega, contrato de ejecución §11). Poner el `satisfies` ahora sería
// romper el typecheck; escribir los tipos a mano sería romper la convención
// que R11 acaba de cerrar. La red de seguridad mientras tanto es
// `supabase/tests/capabilities.test.ts`, que comprueba estos mismos nombres
// contra el esquema real construido desde las migraciones — una verificación
// MÁS fuerte que el `satisfies`, porque no depende de que alguien regenere.
// Al aplicar la migración: `npm run db:types` y añadir el `satisfies`.
export const APP_CAPABILITIES_TABLE = 'app_capabilities'
export const TENANT_PLATFORM_CONTEXT_TABLE = 'tenant_platform_context'
export const TENANT_ENTITLEMENTS_TABLE = 'tenant_entitlements'
export const TENANT_FEATURE_FLAGS_TABLE = 'tenant_feature_flags'

// --- PIM (P03-SaaS, migraciones 170000-170300) ------------------------------
// Sin `satisfies` por la misma razón que las cuatro de arriba: `database.types.ts`
// se genera contra el proyecto ENLAZADO y estas migraciones todavía no están
// aplicadas allí. La red mientras tanto es `supabase/tests/pim-catalog.test.ts`,
// que comprueba estos mismos nombres contra el esquema construido desde las
// migraciones. Al aplicar: `npm run db:types` y añadir el `satisfies`.
export const BRANDS_TABLE = 'brands'
export const PRODUCT_FAMILIES_TABLE = 'product_families'
export const ATTRIBUTES_TABLE = 'attributes'
export const ATTRIBUTE_VALUES_TABLE = 'attribute_values'
export const UNITS_OF_MEASURE_TABLE = 'units_of_measure'
export const PRODUCT_VARIANTS_TABLE = 'product_variants'
export const VARIANT_ATTRIBUTE_VALUES_TABLE = 'variant_attribute_values'
export const PRODUCT_ATTRIBUTE_VALUES_TABLE = 'product_attribute_values'
export const PRODUCT_UOMS_TABLE = 'product_uoms'
export const BUNDLE_ITEMS_TABLE = 'bundle_items'
export const PRODUCT_RELATIONS_TABLE = 'product_relations'

// --- Motor de precios (P04-SaaS, migraciones 180000-180200) -----------------
// Sin `satisfies` por la misma razón que las del PIM: `database.types.ts` se
// genera contra el proyecto ENLAZADO y estas migraciones todavía no están
// aplicadas allí. La red mientras tanto es `supabase/tests/pricing-engine.test.ts`
// y `pricing-checkout.test.ts`, que comprueban estos nombres contra el esquema
// construido desde las migraciones. Al aplicar: `npm run db:types` y `satisfies`.
export const CUSTOMER_SEGMENTS_TABLE = 'customer_segments'
export const PRICE_LISTS_TABLE = 'price_lists'
export const PRICE_LIST_ITEMS_TABLE = 'price_list_items'
export const PRICE_LIST_ASSIGNMENTS_TABLE = 'price_list_assignments'
export const PRICE_CHANGE_EVENTS_TABLE = 'price_change_events'
export const CHANNELS_TABLE = 'channels'

// --- Vistas del modelo de lectura público ----------------------------------
// `security_invoker` sobre policies `to anon`: filtran filas, y el GRANT por
// columna es lo que evita que `anon` vea `stock` o `config` (P02, §4.3).
export const PUBLIC_STORES_VIEW = 'public_stores' satisfies ViewName
export const PUBLIC_CATEGORIES_VIEW = 'public_categories' satisfies ViewName
export const PUBLIC_PRODUCTS_VIEW = 'public_products' satisfies ViewName
export const PUBLIC_PRODUCT_IMAGES_VIEW = 'public_product_images' satisfies ViewName
// Ídem que las tablas del PIM: sin `satisfies` hasta que se regeneren los tipos.
export const PUBLIC_PRODUCT_VARIANTS_VIEW = 'public_product_variants'

// --- Buckets de Storage ----------------------------------------------------
// Los dos son PRIVADOS: no hay URL pública ni para el dueño. Cada lado firma
// con su propio cliente y bajo su propia policy (decisión P02 #18).
export const PRODUCT_IMAGES_BUCKET = 'product-images'
export const STORE_ASSETS_BUCKET = 'store-assets'

// --- Funciones de la base (RPC) --------------------------------------------
export const DASHBOARD_KPIS_RPC = 'dashboard_kpis' satisfies FunctionName
export const PRODUCT_USAGE_RPC = 'product_deletion_usage' satisfies FunctionName
export const CATEGORY_USAGE_RPC = 'category_deletion_usage' satisfies FunctionName
export const SET_PRIMARY_IMAGE_RPC = 'set_primary_product_image' satisfies FunctionName
export const REORDER_IMAGES_RPC = 'reorder_product_images' satisfies FunctionName
export const SET_TAX_RATE_RPC = 'set_tax_rate' satisfies FunctionName
export const ORDER_BY_TOKEN_RPC = 'order_by_token' satisfies FunctionName
// Ídem que las tablas de 160000: sin `satisfies` hasta que se regeneren.
export const EFFECTIVE_CAPABILITIES_RPC = 'effective_capabilities'
// Motor de precios (P04-SaaS). `price_quote_for_slug` la llama el comprador
// ANÓNIMO desde la vitrina; `price_quote` y `price_list_conflicts` solo el
// backoffice con sesión. Son tres funciones distintas y no una con bandera
// justo por eso: cada una tiene su propia autorización dentro.
export const PRICE_QUOTE_PUBLIC_RPC = 'price_quote_for_slug'
export const PRICE_QUOTE_RPC = 'price_quote'
export const PRICE_LIST_CONFLICTS_RPC = 'price_list_conflicts'

// --- Edge Functions --------------------------------------------------------
export const BOOTSTRAP_FUNCTION = 'bootstrap-tenant'
export const CATALOG_PRODUCT_FUNCTION = 'catalog-product'
export const CREATE_ORDER_FUNCTION = 'create-order'
export const UPDATE_ORDER_STATUS_FUNCTION = 'update-order-status'
export const PLATFORM_CONTEXT_FUNCTION = 'platform-context'
