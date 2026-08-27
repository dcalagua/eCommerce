import { z } from 'zod'

/**
 * Importe tal y como viaja entre la base y la app.
 *
 * Sale de Postgres como TEXTO (`price::text` en el `select`) por la decisión
 * P02 #19: un `numeric` en JSON se convierte en float en el primer
 * `JSON.parse` del navegador y los céntimos dejan de cuadrar. El esquema
 * acepta número por si alguna respuesta llega sin castear, pero normaliza
 * siempre a string decimal: la app nunca guarda un importe como `number`.
 */
export const moneyText = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
