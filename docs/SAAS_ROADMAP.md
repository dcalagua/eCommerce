# SAAS_ROADMAP — P01 a P17

Corte: **2026-08-27**, HEAD `6e66080`. Punto de partida: [`SAAS_BASELINE.md`](SAAS_BASELINE.md).
Clasificación por dominio: [`SAAS_KEEP_REFACTOR_BUILD.md`](SAAS_KEEP_REFACTOR_BUILD.md).

Objetivo del recorrido: llegar a `Core Commerce → Add-ons → Ports → Adapters → Tenant Configuration`
**sin un solo fork de esquema ni de aplicación por cliente**.

> Numeración: P01–P17 son las fases de `claude-saas-opus/config/phases.json`. No confundir con las
> históricas P00–P12 de `docs/STATE.md`, que son trabajo ya ejecutado.

Este documento ordena y encadena. **No pone fechas**: el tamaño de cada fase depende de decisiones que
todavía no están tomadas (identidad, pasarela, alcance B2B) y una fecha inventada aquí se convierte en
compromiso en otro sitio.

---

## 1. La espina dorsal y sus dependencias

```
                                   P00 auditoría (este corte)
                                            │
                                            ▼
                                   P01 fronteras + ports
                                            │
        ┌───────────────┬───────────────────┼───────────────────┬────────────────┐
        ▼               ▼                   ▼                   ▼                ▼
  P02 entitlements  P03 PIM            P05 customers      P15 perf/SEO*   P13 audit_log*
   (control plane)      │                   │              (parcial)        (parcial)
        │               ├──────┬────────────┤
        │               ▼      ▼            │
        │          P04 pricing  P06 inventario
        │               │      │            │
        │               └───┬──┴────────────┘
        │                   ▼
        │             P07 carrito + checkout pipeline
        │                   │
        │                   ▼
        │             P08 OMS (ejes de estado, snapshots)
        │                   │
        │       ┌───────────┼───────────┬──────────────┐
        │       ▼           ▼           ▼              ▼
        │   P09 pagos   P10 promos  P12 fulfillment  P14 API + integraciones
        │       │           │           │              │
        └───────┴─────┬─────┴───────────┴──────────────┘
                      ▼
              P11 CMS/search/white-label   P13 analytics (completo)
                      │                          │
                      └──────────┬───────────────┘
                                 ▼
                          P16 security readiness
                                 ▼
                          P17 quality gate final
```

`*` P15 y P13 empiezan antes de lo que sugiere su número: ver §3.

---

## 2. Dependencias, una por una

| Fase | Depende de | Por qué esa dependencia es real | Habilita |
|---|---|---|---|
| **P01** Fronteras y ports | P00 | Necesita el inventario de dominios para no refactorizar a ciegas | todo lo demás |
| **P02** Entitlements | P01 · **contrato EBIM accesible** | Las capacidades se resuelven contra la fuente autorizada del hub; duplicar su catálogo sería violar el principio 1 | gating de P03–P14 |
| **P03** PIM | P01 · (blando) P02 | Variantes y atributos son la unidad sobre la que P04 y P06 trabajan; sin ellos el precio y el stock siguen colgando del producto | P04, P06, P11 |
| **P04** Pricing | P03 · P01 (`PricingPort`) · (blando) P05 | El precio se resuelve por variante/UoM y por segmento; el prompt de P04 exige **pricing base antes que promociones** | P07, P10 |
| **P05** Customers/B2B | P01 | Cliente ≠ usuario autenticado: es un dominio propio y no depende del catálogo | P04 (segmentos), P07, P08, P10 |
| **P06** Inventario | P03 · P01 (`InventoryPort`) | ATP y reservas se llevan por variante y almacén | P07, P12 |
| **P07** Carrito + checkout | **P04 · P06 · P05 · P02** | El pipeline es literalmente `resolve prices → reserve inventory → validate account`: es donde convergen los tres | P08, P09, P10 |
| **P08** OMS | P07 | Los ejes `payment_status`/`fulfillment_status` y el snapshot fiscal por línea nacen de lo que el pipeline produce | P09, P12, P13 |
| **P09** Pagos | P07 (hook de pago) · P08 (`payment_status`) · marco de integraciones existente | `PaymentProvider` es la misma forma que el adaptador de integraciones; construirlo aparte sería el sistema paralelo que P14 prohíbe | P12, conciliación |
| **P10** Promociones | P04 · P07 (paso 4 del pipeline) | Regla explícita: pricing base primero, promociones después, con desglose de qué aplicó | P13 (`promotion_used`) |
| **P11** CMS / search / white-label | P03 · (blando) P02 | Las colecciones se definen sobre el catálogo; el CMS se activa por capacidad | P15 |
| **P12** Fulfillment | P08 · P06 (`InventoryPort` para elegir centro) | Un envío es de un pedido y sale de un almacén | P13 |
| **P13** Analytics y auditoría | **parcial desde P01** (`audit_log`) · completo tras P07/P08/P10 | La bitácora transversal es transversal: cuanto antes exista, más historia captura. Los KPIs necesitan los eventos que producen las fases de negocio | P16, P17 |
| **P14** API enterprise e integraciones | P01 · marco existente · **un consumidor real** de P07/P08/P09 | Un contrato canónico sin adaptador que lo ejercite no está validado, solo escrito | P16 |
| **P15** Storefront perf/SEO | **parcial desde ya** (bundle) · completo tras P03/P11 | El `manualChunks` no espera a nadie; el SEO por producto sí necesita el catálogo definitivo | P17 |
| **P16** Security readiness | todas las tablas nuevas · **contrato EBIM accesible** | Tests A/B de aislamiento por tabla nueva; identidad/MFA/SSO dependen del contrato | P17 |
| **P17** Gate final | P00–P16 | Verifica, no construye | release |

---

## 3. Qué puede correr en paralelo

Cinco carriles. Dentro de un carril el orden es obligatorio; entre carriles no.

### Carril A — espina de comercio *(camino crítico)*
`P01 → P03 → {P04, P06} → P07 → P08 → {P09, P10, P12}`
Es el que marca el ritmo. **P04 y P06 son paralelizables entre sí**: pricing no toca inventario y el
punto de encuentro es P07. Igual con **P09, P10 y P12** después de P08: tres consumidores distintos de
la misma orden.

### Carril B — control plane
`P02`, arrancable en cuanto P01 fije los ports. No compite con el carril A por archivos: sus tablas y
su capa `AppCapabilities` son nuevas. **Debe entrar pronto de todos modos**: cada pantalla que P03–P14
construya sin gating es una pantalla que habrá que volver a tocar.

### Carril C — clientes
`P05`, arrancable justo después de P01 y **en paralelo con P03**. Solo converge en P04 (segmentos) y
P07. Es el carril con menos acoplamiento del roadmap.

### Carril D — experiencia
`P11` tras P03, `P15` en dos tramos: el **tramo de rendimiento** (`manualChunks`, lazy loading, imágenes)
no depende de ninguna fase de negocio y puede hacerse hoy; el **tramo de SEO** espera al catálogo y al
CMS, y su ADR (SPA + prerender vs SSR separado) conviene escribirlo temprano porque condiciona P11.

### Carril E — plataforma y operación
- **`audit_log` de P13**: adelantable a la altura de P01/P02. Cuanto antes exista, más cambios registra.
- **`deno check` de P17** y **Playwright**: son gates, no producto; entran en cuanto haya Deno instalado
  y decisión sobre navegadores.
- **P14** en cuanto exista el primer consumidor real del outbox — probablemente el evento
  `order.create` de P07/P08.
- **P16** es continuo en su parte de tests de aislamiento (una tabla nueva = un test A/B, ya es regla del
  contrato de ejecución) y concentrado al final en su parte de cabeceras, CSP y readiness.

### Lo que NO se paraleliza
- **P04 y P10.** El prompt de P04 lo dice explícitamente: pricing base y promociones son capas
  distintas y mezclarlas produce un motor que nadie puede explicar cuando un precio sale mal.
- **P06 y P07.** Reservar stock es la parte del pipeline con más riesgo de concurrencia; hacerlo a la
  vez que se define el pipeline es garantizar que ninguno de los dos queda probado.
- **P08 y P09.** El eje `payment_status` tiene que existir antes de que un pago lo mueva.

---

## 4. De los riesgos del baseline a las fases

| Riesgo | Fase que lo cierra | Nota |
|---|---|---|
| R1 · sin entitlements | **P02** | bloqueante comercial: sin esto no hay venta por módulos |
| R2 · canales sin superficie | **P02 → P03** | el modelo ya es correcto; falta UI y storefront por canal |
| R3 · outbox sin consumidor | **P07/P08 → P14** | el primer adaptador real valida el contrato canónico |
| R4 · checkout no idempotente | **P07** | clave de idempotencia en `create_order`, no en el navegador |
| R5 · sin impuesto por línea | **P08** | prerrequisito de facturación electrónica en P09/P14 |
| R6 · identidad de hub ausente | **P02/P16** | **requiere decisión del operador**; no se resuelve por iniciativa propia |
| R7 · sin `audit_log` | **P13**, adelantable a P01/P02 | lo exige `CLAUDE.md` |
| R8 · Edge Functions sin typecheck | **P17**, adelantable | necesita Deno en la máquina |
| R9 · bundle de 742 kB | **P15**, adelantable | configuración de build, no producto |
| R10 · lineamientos EBIM no montados | **antes de P02** | ver §5 |

---

## 5. Bloqueos que dependen de una persona, no de código

Ninguno impide arrancar P01. Todos tienen que estar resueltos antes de la fase que se indica.

1. **Remontar `H:\…\EBIM-Plataforma\`** — en esta sesión la unidad no existe. **Antes de P02 y P16**: el
   contrato manda sobre el código y sus §2 (claims), §3 (jerarquía) y §5 (Platform Context API) son la
   fuente de los entitlements. También queda sin leer `coordinacion\BANDEJA.md`.
2. **Modo de identidad: A (JWKS del hub) o B (handoff `/sso?token=`)** — y con ello la retirada del
   `demo_access_token_hook`. Cambio breaking según el contrato: propuesta al buzón antes de codificar.
   **Antes de P16**, idealmente ejercitado en P02.
3. **Proveedor de pasarela de pago y sus secretos** — **antes de P09**. Sin decisión, el `PaymentProvider`
   se puede diseñar pero no se puede validar contra nada real.
4. **Proveedor de correo transaccional** — pendiente desde P11 histórico. La pantalla del checkout dice
   que envía un correo y **no lo envía**. Entra con P07 (notificación asíncrona del pipeline).
5. **Alcance B2B real** (aprobaciones, estado de cuenta, crédito) — **antes de P05**, para no modelar de
   más ni de menos.
6. **Alta de `ecommerce` en el hub** (`apps`, `workspace_apps`, addons propios) — requiere a GMAO, dueño
   del contrato. **Antes de P02**.

---

## 6. Reglas que se mantienen en las 17 fases

Vienen del contrato de ejecución y de `CLAUDE.md`; se repiten aquí porque son las que se rompen cuando
hay prisa.

- Toda tabla nueva nace con `organization_id` + `company_id`, RLS forzada default deny, FK tenant-safe,
  índices y **test de aislamiento A/B en la misma fase**.
- Las migraciones aplicadas son inmutables: la corrección viaja en una migración nueva.
- El servidor decide precio, impuesto, stock, tenant y canal. El navegador nunca.
- `service_role` solo en Edge Functions. Nunca en el bundle.
- Sin lógica por nombre ni por UUID de cliente dentro del core. La diferencia entre clientes se expresa
  en configuración, capacidades y adaptadores.
- Ningún test se borra ni se debilita para conseguir verde.
- Cada fase deja su decisión en `docs/STATE.md` y, cuando es estructural, un ADR en `docs/adr/`.
