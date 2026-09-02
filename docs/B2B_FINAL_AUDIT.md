# Auditoría final del recorrido B2B

> Fase 16. Cierra las quince fases funcionales. Complementa
> [`B2B_GAP_ANALYSIS.md`](./B2B_GAP_ANALYSIS.md) y
> [`B2B_TARGET_ARCHITECTURE.md`](./B2B_TARGET_ARCHITECTURE.md).
> Rama `feat/b2b-upgrade` · 2026-09-02.

## 0 · Los cuatro gates

| Gate | Resultado |
|---|---|
| `npx tsc --noEmit` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS — 144 ficheros, 2842 pruebas, 0 fallos** |
| `npm run build` | **PASS** |

Línea base antes del recorrido: 2735 pruebas. **+107 pruebas nuevas**, todas
contra Postgres real con PGlite.

## 1 · Qué quedó implementado

**13 migraciones · 11 ficheros de prueba · 35 tablas nuevas** (113 → 148).

| Fase | Estado | Qué entró |
|---|---|---|
| 01 · Maestro comercial | **Completa** | Giro, valor A/B/C, frecuencia y geoposición **como columnas de `customers`**, no un maestro paralelo |
| 02 · Fuerza de ventas | **Completa** | `sales_reps` con jerarquía sin ciclos, cartera con un solo titular, rol `sales_rep` |
| 03 · Territorios y rutas | **Completa** | Territorio **comercial** (distinto de `delivery_zones`), cobertura y ruta con orden único |
| 04 · Crédito y cobranza | **Completa** | Documento por cobrar, recibos, aplicación N:M y antigüedad en cinco tramos |
| 05 · Pedido B2B avanzado | **Completa** | Plantillas y programación. **No** se reescribió el motor de aprobación |
| 06 · Cotizaciones | **Completa** | Documento con vigencia y estado que solo avanza; líneas con la forma de `order_items` |
| 07 · Facturación | **Completa** | Comprobante con impuesto por línea copiado del pedido, bitácora e inmutabilidad |
| 08 · Surtidos | **Completa** | Lista blanca/negra con precedencia `customer > segment > territory > channel > store` |
| 09 · Promociones trade | **Completa** | Presupuesto con consumo por trigger. **Cero valores de enum nuevos** (§2) |
| 10-11 · Reparto y POD | **Completas** | Hoja de ruta, vehículos y evidencia append-only |
| 12-13 · Visitas y comisiones | **Completas** | Agenda separada del hecho; liquidación pagada inmutable |
| 14-15 · Sugerido y forecast | **Completas** | Sugerencia con motivo obligatorio; previsión con modelo y fecha |

**Diez capacidades nuevas**, todas `implemented`: `sales.force`,
`sales.territory`, `sales.performance`, `credit.management`, `invoicing`,
`trade.quotes`, `trade.assortments`, `fulfillment.routing`, `planning.demand`,
y `orders.advanced` que dejó de estar `declared`.

**Cuatro fronteras nuevas** (`sales`, `credit`, `trade`, `planning`) frente a
las quince fases: agruparlas evitó quince carpetas de tres archivos.

## 2 · Lo que el plan pedía y NO se construyó

Esto es lo más valioso de la auditoría, porque es donde se evitó duplicar.

| Lo que el plan proponía | Por qué no se hizo |
|---|---|
| Enum `combo` y `free_goods` en `promotion_kind` | Ya existían como `bundle` y `x_for_y`. Dos valores por mecánica obligan a mantener dos ramas de `evaluate_promotions` sincronizadas |
| Un motor de aprobación para P05 | `purchase_approval` y `order_approval_decide` ya existen. Lo que falta es la **bandeja**, y eso es pantalla |
| `order_batches` para importación | `order_external_refs` con `ref_type='import_batch'` ya lo cubre, y `checkout_intents` ya da idempotencia por fila |
| Un maestro de clientes comerciales | `customers` ya tenía razón social, documento fiscal, contactos y segmento |
| Reutilizar `delivery_zones` como territorio | **Se rechazó a propósito**: ataría la cartera de un vendedor al recorrido de un camión |

## 3 · Los fallos que encontraron las pruebas

Ninguno lo encontré leyendo. Los once ficheros de prueba pagaron su coste:

1. **`unique` con NULL no restringe nada.** En `quote_items`, el caso normal
   —producto simple, sin variante ni unidad— se podía repetir sin límite porque
   SQL trata dos NULL como distintos. `nulls not distinct` lo arregló.
2. **Y en `invoices`, lo contrario.** Ahí `nulls not distinct` hacía chocar dos
   comprobantes esperando número de la autoridad. Pasó a índice parcial. **La
   misma herramienta, dos problemas opuestos**: depende de si el NULL significa
   «no aplica» o «todavía no se sabe».
3. **Una policy `for all` sin rol no autoriza.** `quote_items` dejaba escribir a
   cualquier miembro del tenant, un `viewer` incluido. Lo marcó
   `security-baseline` — es el hallazgo esupplier-030.
4. **Dinero con dos formas.** `customer_aging` y `promotion_budget_remaining`
   devolvían `'0'` sin saldo y `'0.00'` con él. El cliente formatea mal justo en
   el caso que importa.
5. **Un CHECK que impedía su propio cierre.** `ends_on >= next_run_on` rechazaba
   la operación que marca una programación como terminada.
6. **Una capacidad baseline en una policy.** Exigir `customers` —siempre
   concedida— es una comprobación que siempre da verdadero y que alguien un día
   lee como si decidiera algo.
7. **Una FK compuesta sin clave que la sostenga**, y **`recorded_at` donde el
   invariante exige `created_at`**.

## 4 · Aislamiento multi-tenant

- **148 de 148 tablas con RLS activada y forzada.** Ninguna excepción.
- Las tres sin `organization_id` —`app_capabilities`, `currencies`,
  `integration_providers`— son catálogos globales preexistentes, no datos de
  tenant.
- Todas las tablas nuevas usan **FK compuestas con tenant**: una FK simple sobre
  el uuid deja colgar una fila de un padre de otra empresa, y hay una prueba que
  lo demuestra sobre `sales_reps.manager_id`.
- El rol `sales_rep` **no** ve la base de clientes: la RLS lo acota contra
  `sales_rep_customers`. Probado.

## 5 · Deuda técnica real

| # | Deuda | Nivel |
|---|---|---|
| D1 | **No hay pantallas.** Las quince fases son esquema, reglas y pruebas. Ninguna carpeta de `src/features/{sales,credit,trade,planning}` tiene componentes: solo existen para satisfacer el registro de fronteras | **P1** |
| D2 | **El bloqueo por mora no está enganchado.** `business_accounts.credit_status` existe y nadie lo lee. Va como gancho del pipeline de checkout, nunca como un `if` en `create_order` | **P1** |
| D3 | **La emisión del comprobante no está cableada al outbox.** La tabla y sus reglas están; falta el productor que encola `invoice.issue` | **P1** |
| D4 | **El sugerido es deliberadamente simple** (`historic_v1`: lo que compró en N días). Es honesto y defendible delante del cliente, pero no considera estacionalidad ni stock | **P2** |
| D5 | **`order_schedule_advance` no tiene quien lo llame.** Falta el planificador que recorra `next_run_on <= current_date` | **P2** |
| D6 | **Los códigos `ecommerce.*` son provisionales** hasta que el operador dé de alta el catálogo de addons en el hub | **P2** |

## 6 · Riesgos

**P0 — ninguno.** Nada de lo añadido es prerrequisito de vender: sin ninguna de
las diez capacidades, la tienda funciona exactamente como antes. Es la regla de
degradación del repositorio y se respetó en las quince fases.

**P1**
- D1: sin pantallas, esto es una plataforma que solo se puede operar por SQL.
- D2 y D3: dos reglas de negocio escritas que todavía no actúan. El riesgo no es
  que fallen, es que alguien las **crea** activas.

**P2**
- El `sales_rep` es un `app_role` nuevo. Cualquier `switch` exhaustivo sobre
  roles en código futuro tiene que contemplarlo; los dos existentes
  (`roles.ts` en cliente y borde) están sincronizados y con test de paridad.

## 7 · Checklist de despliegue

- [ ] Aplicar las 13 migraciones **en orden**. `20260902100000` (el valor de
      enum) va sola y antes que `20260902100100`: Postgres no deja usar un valor
      de enum en la misma transacción que lo crea.
- [ ] `npm run db:types` después de aplicar; hay tests de paridad esquema↔TS.
- [ ] Dar de alta los diez `entitlement_code` en el hub, o el gating queda en
      «no contratado» y las funciones nuevas no se ven.
- [ ] No hace falta tocar nada del checkout, el catálogo ni el storefront: no se
      modificó ninguna tabla del núcleo salvo columnas **aditivas** en
      `customers` y `business_accounts`.

## 8 · Rollout recomendado

Por capacidad, y en el orden en que se desbloquean:

1. **`sales.force`** — sin vendedores, cinco de las capacidades siguientes no
   tienen a quién atribuir nada.
2. **`credit.management`** — lo que más pide un distribuidor, y con el estado de
   cuenta ya existente detrás.
3. **`trade.quotes`** y **`trade.assortments`** — cerradas, sin dependencias.
4. **`sales.territory`** → **`fulfillment.routing`** — la cadena de territorio,
   ruta y entrega.
5. **`orders.advanced`**, **`sales.performance`**.
6. **`invoicing`** — solo cuando el proveedor fiscal del país esté decidido.
7. **`planning.demand`** — al final: con poca historia, el forecast no predice,
   adivina.

Cada una se enciende por tenant desde el hub. Ninguna arrastra a otra en la
base: si `sales.force` está apagada, las tablas siguen ahí y vacías, y la tienda
vende igual.
