import { Box } from '@mui/material'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

/** Velocidad de la deriva, en pixeles por segundo. Lenta a proposito: mas
 *  rapido y el nombre no se termina de leer antes de irse. */
const DERIVA_PX_S = 26

/** Cuanto hay que arrastrar para que el gesto deje de contar como clic. */
const UMBRAL_ARRASTRE_PX = 6

/**
 * Fila que gira sola, se para al acercarse y se arrastra con el raton.
 *
 * ## El bucle no tiene costura porque la lista va DOS veces
 *
 * El truco es todo: se pintan los elementos, y detras los mismos otra vez.
 * Cuando el desplazamiento pasa de la mitad se le resta media anchura, que es
 * exactamente el punto donde la segunda copia esta enseñando lo mismo que
 * estaba la primera. El salto existe, pero cae sobre pixeles identicos y no se
 * ve. Sin duplicar no hay bucle posible: al llegar al final solo queda el
 * borde, y volver de un tiron al principio se lee como un fallo.
 *
 * La copia va `aria-hidden`, y por eso `render` recibe `duplicada`: quien la
 * use tiene que sacar sus enlaces del orden de tabulacion. Un lector de
 * pantalla que anunciara diez puertas donde hay cinco estaria describiendo un
 * catalogo que no existe.
 *
 * ## La posicion NO puede vivir en `scrollLeft`
 *
 * A 26 px/s son 0,43 px por fotograma, y el navegador devuelve `scrollLeft`
 * REDONDEADO: se le suma medio pixel, se lee cero, se le vuelve a sumar medio
 * pixel sobre cero. La fila no se mueve ni un pixel nunca, y no hay error que
 * mirar porque la aritmetica es correcta —lo que miente es el sitio donde se
 * guarda el resultado—. Asi que la verdad es `posicion`, en coma flotante, y
 * `scrollLeft` pasa a ser solo su reflejo.
 *
 * ## Por que se para, y no solo al pasar el raton
 *
 * Una fila de ENLACES que se mueve sola es hostil: el destino se escapa bajo el
 * cursor justo cuando se va a pulsar. La pausa al acercarse es lo que la hace
 * usable, y por eso no es un adorno opcional.
 *
 * Se para en tres casos, no en uno: el raton encima, el arrastre en curso y
 * **el foco dentro**. El tercero es el que se olvida siempre: quien recorre la
 * pagina con el tabulador no tiene raton que poner encima, y sin esa pausa el
 * elemento que acaba de enfocar se le va de la pantalla solo.
 *
 * Con `prefers-reduced-motion` no hay deriva en absoluto. La fila sigue
 * desplazandose a mano, que es lo unico que se prometio.
 *
 * ## El arrastre es solo de raton, y a proposito
 *
 * Con el dedo manda el desplazamiento nativo, que ya trae inercia y rebote y lo
 * hace mejor que cualquier cosa que se escriba aqui. Interceptar el toque seria
 * cambiar algo que funciona por algo peor. De ahi el filtro por `pointerType`,
 * y `touchAction: 'pan-x'` para que el gesto vertical siga siendo del
 * navegador.
 *
 * Arrastrar sobre un enlace dispara su clic al soltar, asi que se mide cuanto
 * se ha recorrido: pasado el umbral, el clic se anula en captura —antes de que
 * llegue al enlace—. Sin eso, mover la fila te cambia de pagina.
 */
export function LoopingRow<T>({
  items,
  keyOf,
  render,
  itemWidth,
  gap = 2,
  ariaLabel,
}: {
  items: readonly T[]
  keyOf: (item: T) => string
  /** `duplicada` marca la copia del bucle: sus enlaces van con `tabIndex={-1}`. */
  render: (item: T, duplicada: boolean) => ReactNode
  /** Ancho fijo de cada hueco. Fijo porque de el depende la mitad exacta. */
  itemWidth: Record<string, number | string> | number | string
  gap?: number
  ariaLabel?: string
}) {
  const pista = useRef<HTMLDivElement | null>(null)
  const posicion = useRef(0)
  const arrastre = useRef({ activo: false, desdeX: 0, desdeScroll: 0, recorrido: 0 })

  const [encima, setEncima] = useState(false)
  const [arrastrando, setArrastrando] = useState(false)
  const [foco, setFoco] = useState(false)

  const quieto = encima || arrastrando || foco

  const aplica = useCallback(() => {
    const nodo = pista.current
    if (!nodo) return
    const mitad = nodo.scrollWidth / 2
    if (mitad > 0) {
      while (posicion.current >= mitad) posicion.current -= mitad
      while (posicion.current < 0) posicion.current += mitad
    }
    nodo.scrollLeft = posicion.current
  }, [])

  // La rueda y el dedo mueven la fila por su cuenta y hay que enterarse. Se
  // distinguen por el tamaño del desajuste: lo que escribimos nosotros vuelve
  // redondeado y difiere en menos de un pixel; lo que mueve una persona salta
  // mucho mas.
  const alDesplazar = useCallback(() => {
    const nodo = pista.current
    if (!nodo) return
    if (Math.abs(nodo.scrollLeft - posicion.current) <= 1.5) return
    posicion.current = nodo.scrollLeft
    const mitad = nodo.scrollWidth / 2
    if (mitad > 0 && posicion.current >= mitad) {
      posicion.current -= mitad
      nodo.scrollLeft = posicion.current
    }
  }, [])

  useEffect(() => {
    if (quieto) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let peticion = 0
    let anterior = performance.now()
    const paso = (ahora: number) => {
      if (pista.current) {
        // Por tiempo, no por fotograma: a 120 Hz el mismo incremento por
        // fotograma correria al doble de velocidad.
        posicion.current += (DERIVA_PX_S * (ahora - anterior)) / 1000
        aplica()
      }
      anterior = ahora
      peticion = requestAnimationFrame(paso)
    }
    peticion = requestAnimationFrame(paso)
    return () => cancelAnimationFrame(peticion)
  }, [quieto, aplica])

  function alBajar(evento: ReactPointerEvent<HTMLDivElement>) {
    const nodo = pista.current
    if (!nodo || evento.pointerType !== 'mouse') return
    arrastre.current = {
      activo: true,
      desdeX: evento.clientX,
      desdeScroll: posicion.current,
      recorrido: 0,
    }
    setArrastrando(true)
    nodo.setPointerCapture(evento.pointerId)
  }

  function alMover(evento: ReactPointerEvent<HTMLDivElement>) {
    const nodo = pista.current
    const estado = arrastre.current
    if (!estado.activo || !nodo) return

    const desplazado = evento.clientX - estado.desdeX
    estado.recorrido = Math.max(estado.recorrido, Math.abs(desplazado))

    const mitad = nodo.scrollWidth / 2
    let siguiente = estado.desdeScroll - desplazado
    // El origen se mueve con el envoltorio: sin esto, al dar la vuelta el
    // contenido pega un tiron de media anchura bajo el raton.
    if (mitad > 0) {
      while (siguiente < 0) {
        siguiente += mitad
        estado.desdeScroll += mitad
      }
      while (siguiente >= mitad) {
        siguiente -= mitad
        estado.desdeScroll -= mitad
      }
    }
    posicion.current = siguiente
    nodo.scrollLeft = siguiente
  }

  function alSoltar(evento: ReactPointerEvent<HTMLDivElement>) {
    const nodo = pista.current
    arrastre.current.activo = false
    setArrastrando(false)
    if (nodo?.hasPointerCapture(evento.pointerId)) nodo.releasePointerCapture(evento.pointerId)
  }

  const huecos = (duplicada: boolean) =>
    items.map((item) => (
      <Box
        key={(duplicada ? 'clon-' : 'real-') + keyOf(item)}
        sx={{ flex: '0 0 auto', width: itemWidth }}
      >
        {render(item, duplicada)}
      </Box>
    ))

  return (
    <Box
      ref={pista}
      role="group"
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      onPointerEnter={() => setEncima(true)}
      onPointerLeave={() => setEncima(false)}
      onFocusCapture={() => setFoco(true)}
      onBlurCapture={() => setFoco(false)}
      onPointerDown={alBajar}
      onPointerMove={alMover}
      onPointerUp={alSoltar}
      onPointerCancel={alSoltar}
      onScroll={alDesplazar}
      onDragStart={(evento) => evento.preventDefault()}
      onClickCapture={(evento) => {
        if (arrastre.current.recorrido > UMBRAL_ARRASTRE_PX) {
          evento.preventDefault()
          evento.stopPropagation()
        }
      }}
      sx={{
        display: 'flex',
        gap,
        overflowX: 'auto',
        // Nada de `smooth`: el salto del bucle tiene que ser instantaneo o se
        // ve viajar de vuelta.
        scrollBehavior: 'auto',
        touchAction: 'pan-x',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
        py: 0.5,
        '@media (hover: hover)': {
          cursor: arrastrando ? 'grabbing' : 'grab',
        },
      }}
    >
      {huecos(false)}
      {/* La copia que hace posible el bucle. Invisible para el lector de
          pantalla: se ve, se pulsa, y no se cuenta. */}
      <Box aria-hidden sx={{ display: 'contents' }}>
        {huecos(true)}
      </Box>
    </Box>
  )
}
