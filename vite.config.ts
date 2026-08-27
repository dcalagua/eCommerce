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
  },
})
