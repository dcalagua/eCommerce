/** Verifica la matriz con un parser CSV de verdad y cuadra el roadmap con ella. */
import { readFileSync } from 'node:fs'

function parseCsv(text, sep = ';') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const rows = parseCsv(readFileSync('docs/RFP_ALICORP_MATRIZ.csv', 'utf8')).filter((r) => r.length > 1)
const body = rows.slice(1)

const malas = body.filter((r) => r.length !== 8)
console.log(`filas: ${body.length}   con campos != 8: ${malas.length}`)
if (malas.length) console.log(malas.slice(0, 3).map((r) => r[0]).join(', '))

const sinEsfuerzo = body.filter((r) => !r[6])
console.log(`sin esfuerzo: ${sinEsfuerzo.length}${sinEsfuerzo.length ? ' -> ' + sinEsfuerzo.map((r) => r[0]).join(', ') : ''}`)

const porFase = {}
const porEstado = {}
const koAbiertos = {}
for (const r of body) {
  porFase[r[7]] = (porFase[r[7]] ?? 0) + 1
  porEstado[r[3]] = (porEstado[r[3]] ?? 0) + 1
  if (r.join(' ').includes('KO') && r[3] !== 'Cumple') {
    koAbiertos[r[7]] = koAbiertos[r[7]] ?? []
    koAbiertos[r[7]].push(r[0])
  }
}

console.log('\nestado:')
for (const [k, v] of Object.entries(porEstado)) console.log(`  ${String(v).padStart(3)}  ${k}`)
console.log('\nfase                total  cumple  KO abiertos')
const orden = ['F0-cimientos', 'F1-interno', 'F2-b2b', 'F3-b2c', 'F4-plataforma', 'F5-diferido']
for (const f of orden) {
  const total = porFase[f] ?? 0
  const cumple = body.filter((r) => r[7] === f && r[3] === 'Cumple').length
  console.log(`${f.padEnd(18)}${String(total).padStart(5)}${String(cumple).padStart(8)}${String((koAbiertos[f] ?? []).length).padStart(13)}`)
}

// El roadmap no puede decir un numero distinto del que dice la matriz.
const doc = readFileSync('docs/RFP_ALICORP_ROADMAP.md', 'utf8')
const totalKo = Object.values(koAbiertos).reduce((a, b) => a + b.length, 0)
const checks = [
  ['total 146', body.length === 146],
  ['cumple en el roadmap', doc.includes(`| **${porEstado.Cumple}** |`)],
  ['KO abiertos en el roadmap', doc.includes(`${totalKo} KO abiertos`) || doc.includes(`| **${totalKo}** |`)],
]
console.log('\ncuadre roadmap <-> matriz:')
for (const [nombre, ok] of checks) console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${nombre}`)
console.log(`\n  (matriz: cumple=${porEstado.Cumple}, KO abiertos=${totalKo})`)
