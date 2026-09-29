/**
 * Las fuentes WEB de la vitrina, auto-alojadas con `@fontsource`.
 *
 * Un solo sitio para las cuatro, y lo importan la vitrina y la muestra de marca
 * del backoffice: si la muestra no las cargara, enseñaría otra fuente que la
 * tienda. Solo se declaran las `@font-face` del subconjunto latino; el
 * navegador baja un archivo únicamente cuando algo se pinta con esa familia,
 * así que una tienda en Universal no descarga ni un byte de Fraunces.
 *
 * Añadir una aquí exige sumarla a `BRAND_FONTS` y al CHECK
 * `store_settings_font` de la base: las tres listas van juntas.
 */
import '@fontsource/plus-jakarta-sans/latin-400.css'
import '@fontsource/plus-jakarta-sans/latin-500.css'
import '@fontsource/plus-jakarta-sans/latin-700.css'
import '@fontsource/plus-jakarta-sans/latin-800.css'
import '@fontsource/archivo/latin-400.css'
import '@fontsource/archivo/latin-600.css'
import '@fontsource/archivo/latin-800.css'
import '@fontsource/fraunces/latin-400.css'
import '@fontsource/fraunces/latin-600.css'
import '@fontsource/fraunces/latin-700.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-700.css'
import '@fontsource/jost/latin-400.css'
import '@fontsource/jost/latin-500.css'
import '@fontsource/jost/latin-600.css'
import '@fontsource/jost/latin-700.css'
