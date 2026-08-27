# RFP Alicorp — Roadmap por fases

> **Confidencial (NDA).** Documento de trabajo interno.
> Fuente única de los datos: [`RFP_ALICORP_MATRIZ.csv`](RFP_ALICORP_MATRIZ.csv), columna `Fase`.
> Los 146 requisitos salen del pliego (§4, §7, §7.8 y Anexo A).

El pliego pide explícitamente un roadmap por fases y dice que **se valorará positivamente**
(§3.2), dejando al proveedor elegir el orden de canales «desde la perspectiva de riesgo,
complejidad y generación de valor temprano». Este documento es esa propuesta.

---

## Reparto

| Fase | Requisitos | Cumple hoy | Pendientes | KO abiertos |
|---|---|---|---|---|
| **F0 · Cimientos** | 63 | 15 | 48 | 6 |
| **F1 · Canal Interno** | 6 | 0 | 6 | 1 |
| **F2 · Canal B2B** | 16 | 0 | 16 | 0 |
| **F3 · Canal B2C** | 19 | 0 | 19 | 0 |
| **F4 · Plataforma corporativa** *(en paralelo)* | 39 | 0 | 39 | 13 |
| **F5 · Diferido por el pliego** | 3 | — | — | 0 |
| **Total** | **146** | **15** | **128** | **20** |

F4 no es una fase secuencial: arranca con F0 y corre en paralelo a los tres canales. La lleva
un perfil de infraestructura y seguridad, no el equipo de producto, y su hito es habilitar
producción — no una funcionalidad.

---

## El orden de canales: Interno → B2B → B2C

Va al revés del instinto, y es deliberado.

**Interno primero.** 633 usuarios, 300 pedidos/mes, audiencia cautiva y tolerante. El pliego
difiere el descuento por planilla a Fase 2, así que ni siquiera necesita pasarela. Pero ejercita
**de verdad** las siete integraciones SAP críticas: maestro de clientes, precios, materiales,
ATP, creación de pedido y facturación. Riesgo reputacional casi nulo, aprendizaje de integración
máximo. Si el contrato canónico está mal planteado, se descubre aquí y no delante de 15.000
tiendas de barrio.

**B2B después.** 163 clientes el año 1 según las tablas de §5.5 — no los 25.000 de §5.2, que es
una de las consultas abiertas. Valida estado de cuenta, aprobaciones y precios negociados sobre
un volumen manejable.

**B2C al final.** Es el masivo, el público y el que se lleva las promociones, las pasarelas y los
picos de campaña. Salir aquí el último significa hacerlo con las integraciones ya rodadas en
producción durante meses.

Esto encaja además con cómo paga el pliego: *«el pago de esta fase estará asociado al
cumplimiento de hitos y entregables, y no a plazos calendario fijos»* (§2.1). Tres go-lives con
su hypercare = tres bloques de facturación defendibles.

---

## F0 · Cimientos

**Objetivo:** que exista un canal funcionando extremo a extremo contra SAP. Nada de esto es
visible para un comprador; todo lo es para el riesgo del proyecto.

- **Framework de integraciones** — contrato canónico (`Customer`, `Product`, `PriceList`,
  `StockLevel`, `Order`, `Invoice`, `Payment`) con outbox/inbox, reintentos, circuit-breaker,
  idempotencia y trazabilidad de mensajes. SAP es **un adaptador**, no el modelo.
- **Simulador de las 7 BAPIs críticas** (SD-01, SD-03, SD-04, SD-07, MM-01, MM-03, FI-02). Es la
  inversión de mayor retorno del proyecto: sin él, cada indisponibilidad de la CIA para al equipo
  entero, y durante la fase de propuesta no hay CIA en absoluto.
- **Identidad** — Entra ID SSO (AI038), política de contraseñas (AC0001), MFA (AC0021), RBAC por
  canal (AC0002). Cuatro requisitos, un solo paquete.
- **Listas de precios y unidades de medida** — desbloquean B2B e Interno a la vez.
- **Maestro de clientes** con jerarquía de códigos anidados.
- **Ambientes DEV/QA/PRD** y documentación de arquitectura.

**Salida de fase:** un pedido creado en la plataforma aparece en SAP y vuelve con su número, en
un entorno de QA, con el simulador y con la CIA real.

**Ya cumplido (15):** catálogo único, cálculo de dinero en servidor, bitácora de auditoría
(AD003), aislamiento por rol (AD005), sin SQL directo a producción (AD004), responsive y WCAG AA
(§7.7), TLS 1.3 (AC0014) y personalización por configuración (AA0004).

---

## F1 · Canal Interno — piloto

**Objetivo:** primer go-live real. Validar las integraciones con usuarios de verdad y riesgo
acotado.

- Portal exclusivo con credenciales corporativas y validación de colaborador activo contra SAP HR.
- Catálogo restringido por oficina y precio preferencial frente a precio de referencia.
- Límites por colaborador, SKU, unidad, sede y periodo, más antifraude.
- Pagos electrónicos estándar (el descuento por planilla está diferido por el pliego).
- Reportería para RRHH y Comercial.

**Base ya existente:** la visibilidad restringida por canal funciona y está probada —
`product_channels` con lista cerrada, y la creación de pedido rechaza un producto fuera de canal.
El precio de referencia sale gratis contrastando el precio de catálogo con la lista del canal.

**Salida de fase:** go-live + hypercare del canal interno.

---

## F2 · Canal B2B

- Cuentas de empresa con múltiples usuarios y roles (comprador, aprobador, administrador,
  observador) y flujos de aprobación por monto o jerarquía.
- Catálogo y precios por cliente, descuentos por volumen, unidades del canal.
- Pedido masivo, carga CSV/Excel, plantillas recurrentes, pedidos programados, cotizaciones.
- Estado de cuenta contra SAP y bloqueo por mora (FI-01).
- Facturación electrónica vía GusuSoft (FI-02, FI-03).
- Dashboard del cliente.

**Salida de fase:** go-live + hypercare B2B.

---

## F3 · Canal B2C

- Pasarelas locales: Banco Bisa, BCP, Libélula, QR y transferencia con conciliación (FI-04).
- Motor de promociones, cupones, gift cards y campañas con landings.
- Buscador con autocompletado y tolerancia tipográfica, filtros avanzados, navegación por marca y
  familia.
- Logística: coste de envío, ventanas de entrega, asignación entre los 12 centros, entrega express.
- Recomendaciones, carrusel de banners, analítica de conversión y abandono.

**Salida de fase:** go-live + hypercare B2C, y con él el fin de la fase de implementación según
§2.1.

---

## F4 · Plataforma corporativa *(en paralelo desde F0)*

**Concentra 13 de los 20 criterios KO abiertos.** No es opcional ni es «para el final»: sin esto
no hay producción, y en la propuesta hay que declararlo con plan y fechas.

- **Superficie de integración:** OAuth 2.0 en todas las APIs expuestas (AT0004), broker
  Kafka/RabbitMQ/PubSub y orquestadores (AT0016), endpoints SFTP (AT0017), carga al data lake
  (AD002).
- **Infraestructura:** alta disponibilidad con RTO/RPO (AA0016), autoescalado (AI005), SLA de
  infraestructura (AI010), región y DR (AI011/AI012).
- **Seguridad:** WAF (AC0020), anti-DDoS (AC0031), PAM (AC0025), integración con SIEM (AC0008),
  pentesting y SAST/DAST (AC0003/AC0013), política de respaldo con pruebas de restauración
  (AC0009).
- **Operación:** observabilidad, logs con retención, definición y medición de SLAs (AA0026).

---

## F5 · Diferido por el propio pliego

SD-02 (crédito en línea), SD-10 (notas de crédito), MM-06 (push de stock) y el descuento por
planilla. El pliego los excluye de Fase 1 por no existir BAPI y admite una estimación referencial
**opcional y separada** (§3.1.4).

---

## Los 20 KO abiertos, y por dónde empezar

| Fase | KO abiertos |
|---|---|
| F0 | `4.1.4-e` · `AA0001` · `AI038` · `AC0001` · `AC0002` · `AC0011` |
| F1 | `4.4.1` |
| F4 | `4.1.3-g` · `4.1.3-h` · `4.1.3-i` · `4.1.5-b` · `4.1.7-d` · `AA0016` · `AA0026` · `AT0004` · `AT0016` · `AT0017` · `AD002` · `AI005` · `AI010` |

**Lo más rentable antes del 08/09:**

1. **Spike de Entra ID (1 día).** Cierra `AI038` y arrastra `AC0001`, `AC0021`, `AC0002` y `4.4.1`.
   Cuatro KO de F0 de un golpe (`AI038`, `AC0001`, `AC0002`, y `4.4.1` de F1), con un día de trabajo. Y sobre todo: te dice si prometerlo o
   negociarlo, antes de firmarlo.
2. **`AC0011` — borrado seguro.** Es un procedimiento documentado, no código. Un KO que se cierra
   escribiendo.
3. **`AA0001`** — diagramas de arquitectura. Es KO y se cierra documentando, no programando.
4. **La respuesta a la consulta A.1** (¿Azure obligatorio?). Buena parte de los 13 KO de F4 dependen de
   ella. Sin esa respuesta, F4 no se puede dimensionar ni presupuestar.

---

## Advertencia sobre este documento

Los estados de cumplimiento de las 15 filas en «Cumple» están respaldados por código y tests. El
resto —la asignación de fases, los tamaños S/M/L/XL y las dependencias— es criterio profesional,
no medición. Antes de que nada de esto se convierta en compromiso contractual con fechas, tiene
que pasar por el equipo que vaya a ejecutarlo.
