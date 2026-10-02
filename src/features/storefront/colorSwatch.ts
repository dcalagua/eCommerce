/**
 * El color de una variante, dicho por su NOMBRE (2026-10-02).
 *
 * El comercio escribe «Negro», «Azul marino» o «Guinda» como valor del eje
 * Color; aquí se traduce a un tono para pintar el círculo. No hay columna de
 * color en la base y no hace falta: el nombre ya lo dice, y pedir un código
 * hexadecimal por valor es cobrarle al comercio nuestro problema.
 *
 * Si un nombre no está en la tabla, no se inventa: el eje sigue con botones de
 * texto (`swatchesFor` devuelve `null` si falta UNO solo, para no mezclar).
 * Los compuestos («Negro/Rojo», «Negro con gris») se pintan en dos mitades.
 */
const TONOS: Readonly<Record<string, string>> = {
  negro: '#111111',
  black: '#111111',
  blanco: '#FFFFFF',
  white: '#FFFFFF',
  'blanco hueso': '#F2EEE3',
  hueso: '#F2EEE3',
  crema: '#F3E9D2',
  beige: '#D9C7A3',
  arena: '#CDB891',
  camel: '#B5834F',
  marron: '#6B4423',
  cafe: '#6B4423',
  chocolate: '#4A2C1A',
  tabaco: '#7A4E2D',
  gris: '#8C8C8C',
  'gris claro': '#C9C9C9',
  'gris oscuro': '#4A4A4A',
  grafito: '#3A3D42',
  plomo: '#5E6266',
  plata: '#C0C4C8',
  plateado: '#C0C4C8',
  dorado: '#C9A24A',
  oro: '#C9A24A',
  azul: '#1F4FA3',
  'azul marino': '#1B2A4A',
  marino: '#1B2A4A',
  navy: '#1B2A4A',
  'azul petroleo': '#1F4E5A',
  petroleo: '#1F4E5A',
  celeste: '#7FB8E6',
  turquesa: '#2BB3B1',
  verde: '#2E7D4F',
  'verde militar': '#4B5320',
  militar: '#4B5320',
  oliva: '#6B7B3A',
  menta: '#9ED9C0',
  rojo: '#C62828',
  guinda: '#6E1E2B',
  vino: '#6E1E2B',
  burdeos: '#6E1E2B',
  rosado: '#E89AB0',
  rosa: '#E89AB0',
  fucsia: '#C2185B',
  morado: '#5E35B1',
  lila: '#B39DDB',
  violeta: '#7E57C2',
  naranja: '#EF6C00',
  amarillo: '#F2C230',
  mostaza: '#C9A227',
  terracota: '#B5532F',
  coral: '#F07A6A',
}

function normaliza(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** ¿El eje es de color? Por el código o el nombre del atributo. */
export function isColorAxis(axis: { code: string; name: string }): boolean {
  return /\b(colou?r|tono)\b/.test(normaliza(`${axis.code} ${axis.name}`))
}

/** El fondo CSS del círculo, o `null` si el nombre no es un color conocido. */
export function swatchOf(label: string): string | null {
  const limpio = normaliza(label)
  if (TONOS[limpio]) return TONOS[limpio]
  const partes = limpio.split(/\s*(?:\/|\+|,| con | y )\s*/).filter(Boolean)
  if (partes.length === 2) {
    const [a, b] = partes.map((p) => TONOS[p] ?? null)
    if (a && b) return `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)`
  }
  return null
}

/** Los fondos de todos los valores, o `null` si alguno no se reconoce. */
export function swatchesFor(labels: readonly string[]): string[] | null {
  const fuera: string[] = []
  for (const label of labels) {
    const tono = swatchOf(label)
    if (!tono) return null
    fuera.push(tono)
  }
  return fuera
}

/** Un tono claro necesita borde para verse sobre una tarjeta blanca. */
export function isLightSwatch(fondo: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(fondo)?.[1]
  if (!hex) return false
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 200
}
