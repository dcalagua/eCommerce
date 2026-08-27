Lee CLAUDE.md y docs/STATE.md. Exige GUIDELINES_STATUS: VERIFIED. Si falta, detente. Ejecuta P01.

Inicializa el frontend siguiendo primero los lineamientos EBIM. Si no fijan tooling concreto usa React + TypeScript + Vite + MUI + React Router + TanStack Query + React Hook Form + Zod + ESLint + Vitest.

Estructura por features:
src/app
src/features/auth
src/features/tenant
src/features/admin
src/features/catalog
src/features/orders
src/features/storefront
src/shared
src/theme

Crea theme/tokens, routing, ErrorBoundary, loading/error/empty states, AdminLayout, StorefrontLayout, .env.example y cliente Supabase sin secretos.

Rutas base:
/ /login /app /app/products /app/orders /app/settings
/s/:storeSlug /s/:storeSlug/product/:productSlug /s/:storeSlug/cart /s/:storeSlug/checkout

No inventes branding si Drive lo define. No deploy remoto. Ejecuta lint, typecheck, tests y build; corrige errores. Actualiza STATE.md. Commit: feat: create frontend foundation
Salida <= 10 lineas.
