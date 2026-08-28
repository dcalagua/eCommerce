/**
 * Observabilidad del borde (P13-SaaS).
 *
 *   correlation  el HILO: leerlo de la peticion o abrirlo, y devolverlo
 *   redact       lo que nunca sale en un log
 *   logger       registro estructurado con sinks y medicion de operaciones
 *   sinks        consola, memoria (tests) e incidente (`ops_events`)
 *
 * Nada de aqui importa el SDK de Supabase ni toca `Deno`: es TypeScript puro,
 * igual que el resto de `_shared`, y por eso el `tsc` y los tests del repo lo
 * compilan y lo prueban sin levantar nada.
 */
export * from './correlation.ts'
export * from './logger.ts'
export * from './redact.ts'
export * from './sinks.ts'
