# P15 — Storefront: performance, accesibilidad, SEO y calidad de experiencia

## Objetivo

Elevar el storefront existente a una experiencia comercial profesional y medible sin migrar de framework por moda.

## Trabajo

1. Audita el storefront actual con evidencia:
   - tamaño de bundle
   - code splitting
   - waterfalls obvios
   - imágenes
   - queries repetidas
   - loading/error/empty
   - mobile UX
   - accesibilidad
2. Optimiza:
   - lazy loading de rutas/componentes pesados
   - imágenes responsivas y dimensiones correctas
   - caching razonable
   - paginación/infinite loading server-side donde aplique
   - evitar N+1
   - prefetch selectivo
3. SEO:
   - analiza si Vite SPA actual cubre necesidades del producto;
   - crea un ADR comparando SPA + prerender vs storefront SSR/SSG separado vs migración de framework;
   - NO migres a Next/Remix u otro framework sin una decisión documentada y beneficio medible;
   - implementa metadatos, canonical, robots/sitemap o prerender solo si encajan con la decisión adoptada.
4. Accesibilidad:
   - navegación por teclado
   - focus visible
   - labels
   - contraste
   - errores de formulario accesibles
   - `prefers-reduced-motion`
   - landmarks y headings coherentes
5. UX mobile-first:
   - navegación clara
   - buscador usable
   - filtros sin saturación
   - carrito/checkout sin layout shift severo
   - skeletons útiles
6. Mantén theming por tokens y white-label.
7. Agrega pruebas de componentes y E2E de recorridos críticos si la infraestructura ya lo permite.
8. Documenta métricas objetivo razonables y cómo medirlas; no declares Lighthouse 100 sin medición.

## Definition of Done

PASS si el storefront mejora de forma verificable, mantiene compatibilidad multi-tenant y existe una estrategia SEO consciente en vez de una migración arbitraria.
