# ADR 016 — Línea base de seguridad y preparación enterprise (P16-SaaS)

- **Estado:** aceptado
- **Fecha:** 2026-08-30
- **Contexto:** cerrar debilidades estructurales antes de considerar la base lista para clientes
  reales. Ámbito: multi-tenant, IAM, web, secretos, datos, cadena de suministro y pagos.
- **Ver también:** [`docs/SECURITY_BASELINE.md`](../SECURITY_BASELINE.md) (el estado con evidencia),
  [ADR 011](011-cms-white-label-search.md) (el contenido del tenant no es HTML),
  [ADR 009](009-payments-provider-contract.md) (PCI por delegación).

---

## 1 · El enlace del tenant se valida contra el navegador, no contra la intuición

**Decisión.** `ebim.is_safe_href` rechaza la barra invertida y los caracteres de control en
cualquier posición, además de la lista blanca de esquemas que ya tenía. La misma regla vive en un
**único** módulo de cliente (`src/domain/href.ts`) del que dependen las tres capas.

**Por qué.** La condición anterior era `like '/%' and not like '//%'` y parecía obviamente correcta.
No lo era. En el analizador de URL de WHATWG, para los esquemas especiales la **barra invertida es
una barra**:

```js
new URL('/\evil.com', 'https://tienda.com').href   // → https://evil.com/
```

`/\evil.com` empieza por `/`, no empieza por `//`, pasaba el CHECK como «ruta interna» y **salía del
dominio**. Cualquiera con permiso de escribir contenido del CMS dejaba publicado en la vitrina un
botón que lleva al comprador a un sitio de terceros con la marca del comercio en la barra. Es un
redirector abierto **almacenado**, y sirve exactamente para phishing.

La lección que se lleva la decisión: **una lista blanca escrita sobre la intuición de cómo se
resuelve una URL no es una lista blanca, es una conjetura.** Por eso el test de regresión no empieza
comprobando el guard: empieza comprobando el **ataque**, con el propio `URL` del navegador. Si algún
día el estándar dejara de tratar la barra invertida como barra, ese test se pondría rojo y el guard
podría relajarse con evidencia en vez de con opinión.

**Consecuencia que había que asumir.** Redefinir una función usada en un CHECK **no revalida las
filas existentes**: un CHECK solo se evalúa al escribir. Sin remediación, una fila envenenada
seguiría publicándose y además sería **imposible de editar**, porque el CHECK saltaría en el UPDATE.
La migración limpia las dos superficies —el par etiqueta/destino de un bloque, y los nodos de texto
enriquecido, a los que se les quita `href` y `linkLabel` juntos para no dejar una etiqueta huérfana
que el validador rechaza.

**Alternativa descartada.** Actualizar `react-router` a la v7, que arregla su mitad
(GHSA-wrjc-x8rr-h8h6). No arregla nada aquí: el fallo no era de la librería. Un `<a href>` normal lo
resolvía igual, porque lo resuelve el navegador. Arreglar la librería y dejar el dato envenenado en
la base habría sido cambiar de sitio el agujero.

---

## 2 · Tres copias de la misma regla eran tres copias del mismo fallo

**Decisión.** La regla de «qué enlace es publicable» vive en `src/domain/href.ts` y las tres capas de
cliente la llaman. La base sigue siendo la autoridad.

**Por qué.** Las tres copias —el CHECK, `src/domain/content.ts` y el borde del storefront— estaban
escritas con la misma condición, palabra por palabra, y **las tres tenían el mismo fallo**. La
duplicación no era el problema en sí; el problema es que se defendía como «defensa en profundidad»
cuando en realidad eran tres capas con el mismo agujero. Tres capas idénticas no son tres capas.

Vive en `domain/` y no en `shared/lib/` porque «qué es un enlace seguro» es conocimiento de dominio,
y porque el test de arquitectura exige que `domain/` no importe de `shared/` — la dirección legítima
es la contraria.

**Lo que se conserva.** La comprobación en el punto donde el valor entra al DOM sigue existiendo, y
ahora sí aporta: es la única de las tres que está en el **sumidero** real.

---

## 3 · La CSP se genera en el build, no se escribe a mano

**Decisión.** Un módulo puro (`src/shared/security/headers.ts`) construye la política; un plugin de
Vite la emite en `dist/_headers` **y** como `<meta http-equiv>` dentro del `index.html`.

**Por qué generarla.** Depende de dos cosas que cambian por despliegue: el origen del proyecto
Supabase —sin él en `connect-src` la aplicación se queda sin backend— y el `sha256` del script
anti-flash del `index.html` —si cambia esa función y el resumen se queda viejo, el usuario ve el
tema equivocado en cada carga—. Escrita a mano en un archivo versionado, sería la de otro
despliegue.

**Por qué las dos formas.** La cabecera es la buena: es la única que aplica `frame-ancestors` y la
única que cubre respuestas que no son el documento. Pero un `_headers` **depende del hosting**: si
mañana el despliegue se mueve a un bucket que no lo lee, la aplicación se queda sin CSP y nadie se
entera. Con la etiqueta dentro del artefacto, `script-src` viaja con él.

**Dónde va la etiqueta, y por qué ahí.** Justo detrás de `<meta charset>` y delante del primer
script. Son dos reglas que se pisan: la declaración de codificación tiene que caber en los primeros
1024 bytes del documento —si no, el navegador adivina el juego de caracteres, que es su propio
problema de seguridad— y una CSP en etiqueta solo cubre lo que viene **después** de ella. Ese hueco
es el único que cumple las dos.

**Lo que no se puede cerrar, y se declara en vez de disimular.** `style-src` lleva
`'unsafe-inline'`: Emotion inyecta reglas en `<style>` en tiempo de ejecución y sin eso la aplicación
se queda sin ni un estilo. Las salidas reales son un *nonce* por respuesta —exige un servidor que
renderice el HTML; esto es una SPA de ficheros estáticos— o cambiar de motor de estilos. Se deja
como PARCIAL con su condición de salida escrita, y un test comprueba que `style-src` es la **única**
directiva con un `unsafe` dentro. El riesgo abierto es CSS, no ejecución.

**`default-src 'none'`, no `'self'`.** Con `'self'`, cualquier tipo de recurso que se olvide de
declarar queda permitido, y la lista de tipos crece con cada versión del estándar. Con `'none'`, lo
que no está escrito no carga — y eso se nota en un test, no en producción.

**Sin `VITE_SUPABASE_URL` no se emite nada.** Publicar una política que deja la aplicación sin
backend es peor que no publicarla. Mismo criterio que el `preconnect` de P15: sin variable, no hay
etiqueta.

---

## 4 · Los techos de tasa DEGRADAN; no niegan

**Decisión.** `track_events_for_slug` descarta (`recorded: 0`) y `promotion_quote_for_slug` cotiza
sin cupones. Ninguna lanza.

**Por qué.** El contador es **por tienda**, y no puede ser de otra forma: Postgres no recibe la IP, y
el identificador de sesión lo elige el cliente —un atacante lo cambia en cada petición y un contador
por sesión no cuenta nada—. Un contador compartido tiene un coste evidente: quien abusa gasta el
presupuesto de los demás.

Si esas dos superficies lanzaran, un bucle contra una tienda dejaría a sus compradores sin cotización
—es decir, sin poder comprar—. **Un límite que tumba el checkout de una tienda entera porque alguien
lanzó un bucle es peor que el abuso que evita.** Degradar mantiene la propiedad que interesa (el
oráculo se apaga, la escritura se corta) sin la que no interesa (la venta se pierde).

**El de cupones cuenta FALLOS, no usos.** Solo gastan contador los códigos que **no existen**. Una
campaña con diez mil canjes legítimos no toca el contador; un enumerador lo agota en segundos. Sin
esa distinción, una promoción exitosa apagaría sus propios cupones.

**Y `0` desactiva el techo sin dejar rastro.** Con el límite apagado, `public_rate_record` no escribe
—si escribiera, apagar el límite dejaría una fila de contador por llamada, que es exactamente la
amplificación de escritura que el límite venía a impedir, pero en la tabla del propio límite.

**Las dieciséis funciones anónimas restantes se dejan sin techo a propósito.** `order_by_token` y
`returns_by_token` van con 256 bits y `gift_card_balance_for_slug` con 96: adivinarlos no es un
ataque, es una imposibilidad aritmética. Ponerles un contador compartido no añadiría seguridad y sí
una forma nueva de dejar sin servicio a un comprador legítimo. **Añadir un control que tiene coste
real contra una amenaza que ya es imposible es mala ingeniería, no rigor.**

---

## 5 · Las claves ajenas anclan el tenant por construcción

**Decisión.** Las nueve FK que apuntaban a una tabla con tenant sin llevar ninguna columna de alcance
pasan a ser compuestas con `(organization_id, company_id)`.

**Por qué, si ninguna era explotable.** Ninguna de esas nueve tablas hijas tiene GRANT de escritura
para `anon` ni `authenticated`: solo las escriben funciones `SECURITY DEFINER` que derivan el tenant
de la fila del padre. Es decir, hoy el aislamiento se sostiene **por revisión de código**. La FK
compuesta lo sostiene **por construcción**: el día que una de esas funciones se edite mal, la base
rechaza la fila en vez de aceptarla en silencio.

`MATCH SIMPLE` —el de por defecto— es justo lo que se necesita en las tres columnas opcionales
(`merged_into`, `replay_of`, `payment_id`): con la referencia a `NULL` la restricción no se evalúa,
que es el caso que debe seguir permitido.

**La regla se comprueba sobre TODAS las FK, no sobre una lista.** Una FK hacia una tabla con tenant
vale si arrastra una columna de alcance, **o** si su tabla hija tiene otra FK que sí la arrastra —son
las FK de guarda, que comprueban un discriminador (`product_kind`, `is_axis`) sobre una fila ya
anclada—. Lo que la regla prohíbe es una tabla cuya **única** relación con el padre no lleve el
tenant. Preferida a una lista de nombres exentos: una lista es una puerta trasera con forma de
documentación.

---

## 6 · El escáner de secretos busca credenciales, no palabras

**Decisión.** `npm run scan:secrets` es un gate (sale con 1). En el bundle no busca la palabra
`service_role`: busca `sb_secret_` **con cuerpo de clave** y JWT que al **decodificarlos** declaren
`role: service_role`.

**Por qué.** Buscar la palabra da tres falsos positivos garantizados: el guard `assertNoServiceKey`
viaja en el bundle porque *es* el guard, y `supabase-js` lleva los prefijos dentro para poder
validarlos. **Un gate que empieza con tres falsos positivos se desactiva en la primera semana**, y
entonces el proyecto tiene un archivo de seguridad que nadie ejecuta — que es peor que no tenerlo,
porque figura en el inventario.

Decodificar en vez de adivinar por la forma tiene además una consecuencia correcta: una clave legacy
**anon** en el bundle es legítima y no puede hacer fallar el gate; una legacy de servicio, sí.

**El hallazgo no imprime el valor.** Un escáner que enseña el secreto en el log de CI acaba de
publicarlo otra vez.

**Y el escáner se prueba por el lado que casi nunca se prueba: que ENCUENTRA.** Un gate que solo se
verifica en verde no está verificado — lo único que demuestra es que hoy no encuentra nada, que es
exactamente lo que haría uno roto. Ese test ya sirvió: destapó que la expresión regular del detector
de JWT tenía un carácter de retroceso literal en vez de `\b` y no encontraba absolutamente nada.

---

## 7 · No se ejecuta el salto mayor de `react-router`

**Decisión.** Se queda en la v6 con los dos avisos analizados uno a uno y la mitigación puesta.

**Por qué.** El aviso de hidratación SSR **no aplica**: esto es una SPA con `createBrowserRouter`, y
no hay `createStaticHandler`, `StaticRouterProvider`, `renderToString` ni `@remix-run/server-runtime`
en el árbol; el código vulnerable no se ejecuta nunca. El de redirección abierta **sí aplicaba**, y
está mitigado en la capa correcta (§1): ningún destino llega a `<Link to>` ni a `<Navigate to>` sin
pasar por `isInternalPath`, y la base ya no admite guardar la cadena.

El arreglo del segundo aviso es `react-router-dom@7`, un cambio mayor con rupturas de API. Meter un
refactor del enrutador dentro de una fase de seguridad es cambiar el riesgo conocido por uno
desconocido. Queda como trabajo propio, y con la mitigación puesta deja de ser urgente.

**Lo que no se hace: declarar `npm audit` limpio.** Los dos avisos siguen ahí y siguen contados.

---

## 8 · Lo que NO se hizo, y por qué

- **Cabeceras verificadas en un despliegue real.** Esta fase no despliega (contrato §11). El
  procedimiento con `curl` está escrito en `SECURITY_BASELINE.md` §9.2 para que alguien lo ejecute y
  firme. Declarar PASS por haber generado el archivo sería declarar PASS por intención.
- **Prueba de restauración de copias.** Es lo único que convierte «hay backups» en «hay
  recuperación», y exige ejecutarla contra el proveedor. Procedimiento de seis pasos en §9.5,
  incluido el que casi nunca se comprueba: que la base restaurada conserve `FORCE ROW LEVEL
  SECURITY` — una restauración que lo pierda es una fuga entre tenants disfrazada de recuperación
  exitosa.
- **MFA/SSO.** Bloqueado por contrato: `ecommerce` no está dado de alta en el hub. Cambiar el
  mecanismo de identidad es breaking y va al buzón antes de codificar.
- **CI.** No hay `.github/` en este repositorio. Los gates existen y son ejecutables; quién los
  ejecuta en cada cambio es del operador. La canalización mínima está escrita en §9.8.
- **Purga de `audit_log` y `analytics_events`.** Son append-only por diseño (P13) y no tienen purga.
  La retención de una bitácora y el borrado a petición del titular son una decisión de política de
  datos con implicación legal, no un `delete` que se escribe en una fase técnica.
- **Límite por IP y WAF.** Postgres no ve la IP. El techo por tienda no lo sustituye y no se
  presenta como si lo hiciera.
