/**
 * Dinero en el dominio.
 *
 * Un importe es SIEMPRE un decimal como texto, nunca un `number`. La razón es
 * la misma que llevó a hacer `price::text` en todos los `select` desde P02
 * (decisión #19): un `numeric` de Postgres se convierte en float en el primer
 * `JSON.parse` del navegador y a partir de ahí los céntimos dejan de cuadrar.
 * El tipo lo hace explícito para que nadie tenga que acordarse.
 *
 * El códec que valida y normaliza en la frontera vive aparte, en
 * `shared/lib/money.ts` (`moneyText`, un esquema Zod): eso es infraestructura
 * de borde. Aquí solo está la forma.
 */

/** Decimal como texto: `"1234.50"`. Sin separador de miles y sin símbolo. */
export type MoneyAmount = string

/** ISO 4217, tres letras mayúsculas. */
export type CurrencyCode = string

export interface Money {
  readonly amount: MoneyAmount
  readonly currency: CurrencyCode
}

/**
 * Cantidad de una línea. Entero: las unidades de medida fraccionadas (kg, m)
 * son trabajo de P03 y llegarán con su propia UoM, no ensanchando este tipo
 * en silencio.
 */
export type Quantity = number
