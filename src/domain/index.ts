/**
 * Dominio de eCommerce: fronteras, contratos y vocabulario canónico.
 *
 * Este directorio es **puro**. No importa React, MUI, TanStack Query,
 * `@supabase/supabase-js` ni nada de `src/features`, `src/shared` o
 * `src/theme`; la única dependencia externa admitida es Zod, y solo para
 * describir formas. `src/architecture.test.ts` lo comprueba archivo por archivo.
 *
 * La regla no es estética. Supabase es la implementación de persistencia de hoy
 * y el ERP del tenant puede ser la de mañana para la mitad de estas preguntas.
 * Un dominio que sabe de `PostgrestError` no se puede reutilizar: se reescribe.
 *
 * Qué vive aquí:
 *  - `boundaries`   — el mapa de dominios, con su estado real y su ruta en `src/`.
 *  - `capabilities` — qué módulos sabe hacer el producto y cómo se resuelve
 *                     cuáles tiene contratados una sociedad.
 *  - `flags`        — interruptores técnicos. Solo restan; nunca conceden.
 *  - `errors`       — `AppError` y su discriminante `kind`.
 *  - `money`        — importe como decimal en texto, nunca `number`.
 *  - `ports`        — los contratos con el mundo exterior y la regla para crearlos.
 *
 * Qué NO vive aquí: nombres de tabla, de vista, de bucket o de función remota.
 * Eso es vocabulario de persistencia y está en `shared/lib/db-schema.ts`.
 */
export * from './boundaries'
export * from './capabilities'
export * from './errors'
export * from './flags'
export * from './money'
export * from './ports'
