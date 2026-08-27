import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'

/**
 * Margen de espera de los `findBy*`.
 *
 * El defecto de Testing Library es 1 s, y las pantallas del router real llegan
 * por `React.lazy`: con la suite entera corriendo en paralelo, resolver ese
 * import puede pasar del segundo en una máquina cargada y el test falla por
 * lento, no por roto. Subirlo no oculta ningún fallo —una aserción que no se
 * cumple sigue fallando— pero quita el falso negativo que depende del hardware.
 */
configure({ asyncUtilTimeout: 5000 })
