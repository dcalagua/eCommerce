# Presupuesto de rendimiento del storefront

- **Desde**: P15-SaaS (2026-08-30)
- **Decisión de fondo**: [ADR 015](adr/015-storefront-performance-seo.md)
- **Se mide con**: `npm run build && npm run bundle:report`

---

## 1. Por qué se mide por RECORRIDO y no por chunk

El aviso de Vite («some chunks are larger than 500 kB») mide el archivo más
grande. Nadie descarga el archivo más grande: se descarga el **cierre de imports
estáticos** de la entrada más el de la ruta que se abrió. Con el proveedor
repartido en cinco chunks, mirar el mayor pasó a no decir nada — el número puede
bajar mientras el recorrido empeora, porque un chunk se partió en dos que se
descargan igual.

`scripts/bundle-report.mjs` lee `dist/.vite/manifest.json` —por eso
`build.manifest` está activo— y calcula, para cada recorrido vigilado, la suma
gzip de todos los archivos que el navegador necesita **antes del primer
pintado**. Los imports dinámicos no cuentan: no se descargan hasta que se usan.

El script **sale con código 1** si algún recorrido se pasa. Se puede enchufar a
un gate sin escribir nada más.

---

## 2. Los techos vigentes

| Recorrido | Techo (kB gzip) | Medido en P15 |
|---|---|---|
| vitrina · portada | 400 | 334,6 |
| vitrina · ficha de producto | 400 | 309,1 |
| vitrina · checkout | 430 | 330,3 |
| backoffice · panel | 430 | 298,1 |

Punto de partida, para que el número signifique algo: en P14 (`8d5547d`) el
chunk de entrada era de **970,90 kB / 283,38 kB gzip** y lo descargaba todo el
mundo, entrase donde entrase. Hoy la entrada compartida son **251,8 kB gzip** y
lo demás depende de a dónde se entra.

### De dónde salen los techos

No son aspiracionales ni redondos por gusto: son **el número medido más un
margen del ~20 %**. Un techo que ya se incumple el día que se escribe no frena
nada, y uno pegado al valor actual convierte cualquier funcionalidad legítima en
una alarma. El margen es el sitio donde caben tres o cuatro pantallas más antes
de tener que volver a mirar el reparto.

La vitrina tiene el techo más bajo a propósito: **el comprador anónimo llega por
móvil y no tiene nada en caché**. El backoffice lo abre alguien que vuelve todos
los días, con el proveedor ya descargado.

### Qué hacer cuando un recorrido se pasa

En este orden, que va de lo más barato a lo más caro:

1. **¿Entró algo al chunk de entrada que debería ser perezoso?** Es la causa más
   frecuente y la más fácil de introducir sin querer: basta un `import` estático
   desde un módulo que sí está en el camino crítico. Ejemplo vivo:
   `messages.all.ts` importa los dos diccionarios y hay un test que comprueba
   que **solo los tests lo importan**.
2. **¿Hay una dependencia nueva que solo usa una pantalla?** Debe entrar por la
   ruta `lazy` que la usa, no por `manualChunks`. Declarar en `vendorChunk` una
   librería hoy perezosa la vuelve ansiosa: es lo contrario de lo que se quiere.
3. **¿La pantalla puede partirse?** Un panel con cuatro pestañas no necesita las
   cuatro para pintar la primera.
4. **Subir el techo** — y solo entonces, escribiendo aquí por qué. Un techo que
   se sube sin explicación es un techo que no existe.

---

## 3. Lo que este presupuesto NO mide

- **Web Vitals** (LCP, INP, CLS). Son de campo: exigen un navegador real contra
  un despliegue real con tráfico. Este repo no despliega (contrato §11). Lo que
  P15 sí hizo es quitar de en medio las causas conocidas —hero sin `lazy` y con
  `fetchPriority="high"`, `aspectRatio` declarado en las imágenes que empujan
  texto, `preconnect` al proyecto Supabase— y dejarlas documentadas en el ADR
  015 §3.
- **Puntuaciones de Lighthouse.** No se declaran sin medición, por encargo
  explícito de la fase.
- **El tiempo de las consultas.** Es de la base y de la RLS, no del bundle.
- **La red del visitante.** Un techo en bytes es lo que este repo controla; los
  milisegundos que eso cuesta dependen de dónde esté quien mira.

---

## 4. Cómo añadir un recorrido

En `scripts/bundle-report.mjs`, una entrada más en `JOURNEYS`: `entry` es
siempre `index.html`, `routes` son las claves del manifiesto —las rutas de los
módulos tal y como las escribe Vite— y `budgetKb` el techo. Si un módulo cambia
de sitio, el script falla diciendo qué clave no conoce, en vez de calcular de
menos y dar un verde falso.
