import { defineConfig, type Plugin } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * `preconnect` al proyecto Supabase (P15-SaaS).
 *
 * La vitrina no puede pintar catálogo hasta que la PRIMERA consulta vuelve, y
 * esa consulta empieza por abrir la conexión: DNS + TCP + TLS contra un origen
 * distinto al del documento. Adelantar ese apretón de manos mientras el
 * navegador todavía está descargando el JavaScript quita del camino crítico
 * unos 100-300 ms en una conexión móvil, sin descargar ni un byte de más.
 *
 * Se inyecta desde el plugin y no a mano en `index.html` porque la URL es
 * distinta en cada despliegue: escrita a mano acabaría siendo un `preconnect` a
 * un proyecto que no es (peor que ninguno, porque abre una conexión inútil), y
 * `%VITE_SUPABASE_URL%` sin definir dejaría un `href` literal roto en el HTML.
 * Sin variable, no hay etiqueta.
 */
function preconnectSupabase(url: string | undefined): Plugin {
  return {
    name: 'ebim-preconnect-supabase',
    transformIndexHtml() {
      if (!url) return []
      let origin: string
      try {
        origin = new URL(url).origin
      } catch {
        return []
      }
      return [
        { tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: '' }, injectTo: 'head-prepend' },
        { tag: 'link', attrs: { rel: 'dns-prefetch', href: origin }, injectTo: 'head-prepend' },
      ]
    },
  }
}

/**
 * Reparto de dependencias en chunks estables (P15-SaaS).
 *
 * Antes de esta fase todo lo compartido caía en un único `index-*.js` de
 * 970,90 kB (283,38 kB gzip). El problema no era solo el tamaño: era que
 * **cualquier** cambio de una línea de la aplicación cambiaba el hash de ese
 * archivo y el visitante volvía a descargarse React, MUI y `supabase-js`
 * enteros. Separarlos no reduce los bytes de la PRIMERA visita —se descargan
 * igual, pero en paralelo— y sí los de todas las demás.
 *
 * Solo se declaran librerías que ya estaban en el grafo de entrada. Meter aquí
 * una que hoy es perezosa (`zod` lo es: entra por rutas `lazy`) la volvería
 * ansiosa y haría más lenta la vitrina, que es justo lo contrario de la fase.
 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  // `@mui/material` NO se agrupa. Rollup ya lo reparte solo, y de la forma
  // correcta: `TextField`, `Autocomplete`, `Modal`, `Tabs` y `TablePagination`
  // salen en chunks propios porque solo los alcanzan rutas perezosas. Juntarlo
  // todo en un `vendor-mui` mezcla lo ansioso con lo perezoso y arrastra los
  // cinco al primer pintado: medido, +8,5 kB gzip para quien solo abre la
  // vitrina. Lo mismo vale para `zod`, que hoy entra por rutas perezosas.
  if (/[\\/]node_modules[\\/]@emotion[\\/]/.test(id)) return 'vendor-emotion'
  if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase'
  if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return 'vendor-query'
  if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
    return 'vendor-router'
  }
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'

  return undefined
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), preconnectSupabase(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL)],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // El manifiesto es lo que hace medible el presupuesto de rendimiento:
    // `npm run bundle:report` lo lee para calcular los bytes REALES de cada
    // recorrido (entrada + cierre de imports estáticos de su ruta), en vez de
    // mirar el chunk más grande y suponer. Ver `docs/performance-budget.md`.
    manifest: true,
    rollupOptions: {
      output: { manualChunks: (id) => vendorChunk(id) },
    },
    // El aviso por defecto (500 kB) ya no dice nada útil una vez repartido el
    // proveedor: el techo real que vigilamos es el de `docs/performance-budget.md`.
    chunkSizeWarningLimit: 400,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Los flujos completos (login -> alta -> panel) recorren el router real con
    // rutas `React.lazy`. Con la suite entera en paralelo, resolver esos
    // imports en una maquina cargada pasa de los 5 s por defecto y el test
    // fallaria por lento, no por roto. El margen no oculta nada: una asercion
    // que no se cumple sigue fallando igual.
    testTimeout: 30_000,
    // Y el mismo margen para los HOOKS. El `beforeAll` de los bancos de prueba
    // de base aplica las 49 migraciones sobre una Postgres en WASM; con la
    // suite entera en paralelo eso pasa de los 10 s por defecto y el archivo
    // falla antes de ejecutar una sola asercion — un falso negativo que depende
    // del hardware, no del codigo. Subirlo no oculta nada: un hook que de
    // verdad se cuelgue sigue fallando, solo que treinta segundos despues.
    hookTimeout: 30_000,
  },
}))
