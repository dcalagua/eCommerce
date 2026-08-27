# RFP Alicorp — Consultas a enviar

> **Confidencial (NDA).** Documento de trabajo interno. No sale del repo.

**Enviar a:** `dpintobl@alicorp.com.bo` y `RBasswernerP@alicorp.com.bo`
**Asunto:** `LICITACIÓN_ECOMMERCE_MVP — Consultas de proveedor`
**Plazo:** ventana de consultas **24/08 – 28/08/2026**. Respuestas hasta el 31/08.
**Propuesta:** 08/09/2026 23:59.

---

## Texto listo para copiar

Estimados Delia, Roberto:

En el marco del proceso **LICITACIÓN_ECOMMERCE_MVP**, y tras el análisis del pliego y su Anexo A,
remitimos las siguientes consultas. Las agrupamos por impacto, señalando cuáles condicionan el
dimensionamiento económico de la propuesta.

### A. Consultas que condicionan la arquitectura y el precio

**A.1 · Modelo de despliegue.** El apartado 7.8.4 (AI011/AI012) indica despliegue preferente en Azure,
región East US 2 con Central US para disaster recovery, y AI044 exige que los servicios web se publiquen
exclusivamente a través del Application Gateway TI de Alicorp.

¿Es admisible un **servicio gestionado (SaaS) operado por el proveedor** fuera de la suscripción Azure de
Alicorp, siempre que cumpla los SLA, la integración SSO con Entra ID (AI038) y los controles de
ciberseguridad del dominio AC? ¿O el despliegue **dentro del tenant Azure de Alicorp es mandatorio** y
criterio de descarte?

*Esta respuesta condiciona la arquitectura, el modelo de licenciamiento y el TCO a 5 años.*

**A.2 · Data lake corporativo.** AD002 exige extracción incremental, delta, streaming y full hacia el data
lake corporativo **en GCP**, mientras que el resto de la infraestructura (6.5, AI011) es **Azure**.
¿Se confirma que el destino analítico es GCP? ¿Existe un componente intermedio de Alicorp (CIA u otro) que
deba usarse como puente, o la plataforma debe integrar directamente contra GCP?

**A.3 · Alcance de SFTP y mensajería.** AT0016 y AT0017 son criterios KO y exigen exponer endpoints SFTP y
compatibilidad con Kafka / RabbitMQ / Google Pub/Sub, además de orquestadores (Airflow, MOVEit, Control-M).
¿Estos canales se consideran **requeridos desde la Fase 1**, o basta con acreditar la capacidad y habilitarlos
cuando exista un caso de uso? Solicitamos, de ser posible, el listado de flujos concretos previstos.

### B. Consultas sobre volumetría y dimensionamiento

**B.1 · Contradicción en número de clientes.** El apartado 5.2 indica *«Clientes B2C activos (proyectados a
12 meses): 25000»* y *«Clientes B2B activos: 25000»*. Sin embargo, las tablas de proyección del apartado 5.5
muestran para el Año 1 un total de **2.707 clientes B2C** y **163 clientes B2B**, alcanzando 14.429 y 703
respectivamente en el Año 5.

Son cifras separadas por casi dos órdenes de magnitud. ¿Cuál debe tomarse como base de dimensionamiento?

**B.2 · Multiplicador de pico.** Aparecen tres valores distintos para el mismo concepto:
- 5.3 — *«Multiplicador esperado en picos de campaña (vs. día normal): 30%»*
- 7.2 — *«Capacidad de absorber picos de hasta 2 veces el tráfico normal en campañas»*
- AA0011 — *«capacidad de escalar hasta 4 veces la capacidad base ante picos o eventos especiales»*

¿Cuál es el objetivo contractual de dimensionamiento?

**B.3 · Pedidos mensuales.** En 5.3 las viñetas *«Pedidos mensuales esperados B2C (año 1)»* y *«B2B (año 1)»*
figuran sin valor, seguidas de tablas de transacciones (totales 5.551 y 278). ¿Confirman que esas tablas son
la cifra de pedidos mensuales del Año 1?

### C. Consultas sobre niveles de servicio y cumplimiento

**C.1 · Disponibilidad comprometida.** El apartado 7.1 exige **99,5 % mensual** (deseable 99,9 %) para B2C y
B2B; AI010 establece que los componentes de infraestructura productivos deben tener **SLA no menor al
99,0 %** y lo marca como KO. ¿Cuál es el compromiso contractual que se evaluará y penalizará?

**C.2 · Facturación electrónica.** El integrador aparece como **«GusuSoft»** en los apartados 6.2, 3.1.5 y
Anexo A, y como **«GuruSoft»** en el apartado 3.1.4. Solicitamos confirmar la denominación y, de ser posible,
la documentación de integración vigente.

### D. Consultas de forma sobre el pliego

**D.1 · Referencias cruzadas.** El apartado 8.1, punto 4, remite a *«los requerimientos de la sección 6»*,
pero los requerimientos funcionales están en la **sección 4** (la 6 es el stack tecnológico). Asimismo, la
declaración de cumplimiento de lineamientos remite a la *«sección 9.8»*, siendo la correcta la **7.8**.
Rogamos confirmar para responder sobre el apartado correcto.

**D.2 · Anexo de scoring.** El apartado 2.5 y el 8.1 establecen que el archivo
**`Anexo_Modelo_Scoring_Ecommerce.xlsx`** (hoja Proveedor) es parte integral de la propuesta técnica y que su
omisión es causal de descalificación. **No lo hemos recibido junto al pliego.** Solicitamos su envío a la
mayor brevedad, dado que condiciona la elaboración de la respuesta punto por punto.

Quedamos atentos. Un saludo cordial,

---

## Notas internas (no enviar)

- **A.1 es la pregunta crítica.** Si el despliegue en el Azure de Alicorp resulta mandatorio, el producto
  actual (Supabase gestionado) no encaja tal cual: habría que ofrecer una variante desplegable en su tenant.
  Afecta a arquitectura, licenciamiento y TCO. Ver `docs/STATE.md`.
- **D.2 es lo más urgente en términos prácticos.** Sin el Excel no se puede construir la respuesta puntuable
  ni estimar esfuerzo requisito a requisito.
- Lineamientos marcados KO en el pliego que hoy **no** cubre el producto: AI038 (SSO Entra ID), AT0004 (OAuth
  2.0 en todas las APIs expuestas), AT0016/AT0017 (mensajería y SFTP), AD002 (data lake), AC0001 (política de
  contraseñas configurable), AC0011 (borrado seguro). Cada uno necesita respuesta explícita de cumple /
  cumple parcialmente con plan / no cumple.
