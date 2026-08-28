import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
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
})
