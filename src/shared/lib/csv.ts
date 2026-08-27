/**
 * Exportación a CSV compartida por los listados del backoffice.
 *
 * Estaba en `features/catalog/exportCsv.ts` y sube a `shared` en P07: el
 * listado de pedidos exporta igual que el de productos, y el escapado —que es
 * lo que evita la inyección de fórmulas— no puede tener dos versiones
 * (precedente P05 #45).
 */

/**
 * Escapa un campo CSV.
 *
 * Además de las comillas y los separadores, se neutraliza el arranque por
 * `= + - @` (y tabulador): Excel interpreta esas celdas como fórmula, y un
 * nombre escrito por un tercero —el de un comprador, por ejemplo— no debería
 * ejecutarse al abrir el archivo. Es el clásico "CSV injection".
 */
export function escapeCsvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}

/** Arma la tabla completa: cabecera + filas, ya escapadas. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(row.map(escapeCsvField).join(','))
  return lines.join('\r\n')
}

/** Descarga en el navegador. El BOM es lo que hace que Excel lea el UTF-8. */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([`\u{FEFF}${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
