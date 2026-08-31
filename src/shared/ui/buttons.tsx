import { Button, type ButtonProps } from '@mui/material'

/**
 * Jerarquía de botones de la suite. Tres niveles y ni uno más.
 *
 * El repositorio llevaba tres formas de decir lo mismo —`variant="contained"`,
 * `variant="outlined"` y un `<Button>` sin `variant`, que MUI pinta como texto—
 * repartidas sin criterio: la misma acción («Exportar») salía de contorno en
 * Pedidos y como enlace en Analítica. El usuario no lee la prop: lee el peso, y
 * dos pesos distintos para la misma acción le dicen que son acciones distintas.
 *
 * La regla, y es la única:
 *
 *  1. **Primario (`PrimaryButton`, relleno).** La acción que hace avanzar la
 *     pantalla: guardar, crear, confirmar. **Uno por superficie** —pantalla,
 *     panel o diálogo—. Dos rellenos juntos no son dos acciones importantes:
 *     son ninguna, porque el ojo ya no sabe cuál es la que se espera de él.
 *  2. **Secundario (`SecondaryButton`, contorno).** Acciones de apoyo que sí
 *     tienen peso propio: exportar, añadir fila, abrir un panel. Visibles sin
 *     competir con el primario.
 *  3. **Terciario (`GhostButton`, texto).** Cancelar, cerrar y las acciones
 *     dentro de una fila densa. Pesan lo que pesa el texto porque su sitio es
 *     el que ocupa el texto.
 *
 * Son envoltorios finísimos a propósito: aceptan todas las props de `Button`
 * (`size`, `startIcon`, `disabled`, `color="error"`…) y solo fijan `variant`.
 * Así el sitio de llamada sigue siendo MUI y lo que se estandariza es la
 * decisión, no la API. `variant` se puede sobrescribir, pero si hace falta
 * hacerlo es señal de que la acción está en el nivel equivocado.
 *
 * No admiten `component`/`to` a propósito: un botón que navega es un enlace, y
 * para eso está `<Button component={RouterLink}>` con su `variant` explícito.
 */

export type ActionButtonProps = ButtonProps

/** Nivel 1: la acción que hace avanzar la pantalla. Una por superficie. */
export function PrimaryButton(props: ActionButtonProps) {
  return <Button variant="contained" {...props} />
}

/** Nivel 2: acción de apoyo con peso propio (exportar, añadir, abrir panel). */
export function SecondaryButton(props: ActionButtonProps) {
  return <Button variant="outlined" {...props} />
}

/** Nivel 3: cancelar, cerrar y acciones dentro de una fila densa. */
export function GhostButton(props: ActionButtonProps) {
  return <Button variant="text" {...props} />
}
