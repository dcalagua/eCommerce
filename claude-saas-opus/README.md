# Claude SaaS Opus Pack — eCommerce by EBIM

Paquete de ejecución supervisada para evolucionar el repositorio existente `eCommerce by EBIM` hacia una base SaaS eCommerce robusta, modular, escalable y vendible a múltiples clientes.

## Qué incluye

- 18 prompts de implementación, ordenados por dependencia.
- Supervisor técnico con diagnóstico de causa raíz y reparación automática.
- Reintentos de la misma fase después de una reparación.
- Reintentos simples para errores transitorios de Claude Code/red/429/overload.
- Gates independientes ejecutados por el runner (`typecheck`, `lint`, tests, DB tests y build según fase).
- Recovery para continuar una ejecución interrumpida sin repetir trabajo ya validado.
- Scripts PowerShell para Windows y un runner Bash equivalente.
- Logs separados por fase, intento y supervisor.
- Estado de runner en `state/runner-state.json`.

## Filosofía

Este pack NO crea otro proyecto desde cero y NO debe reemplazar el core que ya funciona.

El objetivo es evolucionar el producto con este principio:

`CORE COMMERCE + ADD-ONS + ADAPTERS + CONFIGURATION`

No se permiten forks por cliente ni condicionales del tipo `if cliente === ...`.

La personalización debe resolverse mediante configuración, feature flags, entitlements, políticas, workflows, adaptadores, branding y reglas de negocio.

## Modelo

Por defecto todas las fases y el supervisor usan:

```text
opus
```

Puedes cambiarlo con `-Model`, pero el pack fue escrito y dimensionado para Opus.

## Requisitos Windows

- Windows PowerShell 5.1 o PowerShell 7.
- Claude Code autenticado.
- Node.js y npm.
- Git.
- El ZIP debe descomprimirse dentro de la raíz del repositorio, de forma que exista:
  `./claude-saas-opus/README.md`.

Si `CLAUDE.md` exige leer lineamientos externos del HUB EBIM, monta la ruta antes de ejecutar. El runner acepta `-GuidelinesPath`.

## Inicio recomendado

Desde la raíz del repo:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\claude-saas-opus\scripts\preflight.ps1 -RepoPath .
.\claude-saas-opus\scripts\run-all.ps1 -RepoPath . -Model opus -MaxRetries 3
```

También puedes usar:

```text
claude-saas-opus\scripts\start-opus.cmd
```

## Reanudar desde una fase

Ejemplo, desde P05:

```powershell
.\claude-saas-opus\scripts\run-all.ps1 -RepoPath . -StartAt 05
```

Para ejecutar una sola fase:

```powershell
.\claude-saas-opus\scripts\run-one.ps1 -RepoPath . -Phase 05
```

## Recovery

Si la ejecución fue interrumpida:

```powershell
.\claude-saas-opus\scripts\run-all.ps1 -RepoPath . -RecoveryOnly
```

Recovery analiza `docs/STATE.md`, Git, los logs y `state/runner-state.json` antes de decidir dónde continuar.

## Cómo funcionan los reintentos

1. Claude ejecuta una fase con Opus.
2. La última línea debe ser `PHASE_RESULT: PASS` o `PHASE_RESULT: FAIL`.
3. El runner ejecuta además el gate configurado para esa fase.
4. Si falla por una causa de código, tests, arquitectura o cumplimiento, se invoca `SUPERVISOR.md`.
5. El supervisor diagnostica y repara la causa raíz.
6. Si declara `SUPERVISOR_RESULT: REPAIRED`, el runner vuelve a ejecutar la MISMA fase.
7. El ciclo se repite hasta `-MaxRetries`.
8. Errores transitorios de red/429/overload se reintentan sin gastar un ciclo de reparación.

Con `-MaxRetries 3`, una fase puede tener hasta 1 intento inicial + 3 ciclos de reparación/reintento.

## Seguridad de ejecución

El runner está preparado para ejecución unattended y puede usar `bypassPermissions` si tu versión de Claude Code lo soporta.

Eso significa que Claude puede editar y ejecutar comandos sin confirmación. Por ello:

- usa únicamente una rama de desarrollo;
- conserva backups del repo;
- no ejecutes el pack sobre infraestructura productiva;
- los prompts prohíben push, PR y deploy remoto;
- los prompts prohíben reset/destrucción de bases remotas;
- no se permite debilitar RLS, borrar tests ni incluir secretos para obtener verde.

## Gates

El archivo `config/phases.json` define los checks de cada fase. El runner ejecuta solo scripts que existan en `package.json`.

Gates usados:

- `typecheck`
- `lint`
- `test`
- `test:db`
- `build`

El gate final usa todos.

## Prompts

- P00 Auditoría y baseline verificable
- P01 Arquitectura modular y contratos de dominio
- P02 Control Plane, módulos, entitlements y feature flags
- P03 PIM, variantes, atributos, UoM y bundles
- P04 Pricing Engine y listas de precios
- P05 Clientes, segmentos y cuentas B2B
- P06 Inventario multi-almacén y reservas
- P07 Carrito persistente y Checkout Pipeline
- P08 OMS, fulfillment state y snapshots
- P09 Payments abstraction y conciliación base
- P10 Promotions Engine, cupones y gift cards
- P11 CMS, white-label, búsqueda y contenido
- P12 Fulfillment, logística y devoluciones
- P13 Analytics, auditoría y observabilidad
- P14 API empresarial, webhooks e Integration Monitor
- P15 Storefront performance, accesibilidad y SEO
- P16 Seguridad SaaS y readiness enterprise
- P17 Quality Gate y release baseline

## Alicorp / clientes enterprise

El pack prepara el producto para clientes como Alicorp, pero NO codifica reglas específicas de Alicorp en el core. SAP, pagos, logística, mensajería y SSO deben implementarse como adapters/providers configurables.

Las particularidades de un cliente se construyen encima de este baseline como configuración y add-ons.


## Windows / PowerShell 5.1

Esta version del pack incluye compatibilidad explicita con Windows PowerShell 5.1 al cargar `config/phases.json`.
El preflight debe mostrar `Fases configuradas: 18`. Si muestra otro valor, verifica que `config/phases.json` no haya sido modificado y vuelve a extraer el pack.


## Windows PowerShell 5.1 / NativeCommandError (v3)

Esta version corrige un problema de PowerShell 5.1 donde `node`, `vitest`, `npm` o `claude` pueden escribir mensajes a STDERR y PowerShell los convierte en `NativeCommandError` cuando `$ErrorActionPreference = "Stop"`, incluso si el proceso finaliza con codigo 0.

El runner ahora:

- permite STDERR de procesos nativos sin abortar la ejecucion;
- usa `$LASTEXITCODE` como fuente de verdad para decidir PASS/FAIL;
- conserva stdout/stderr en los logs;
- deja que el supervisor actue solo ante fallos reales del gate;
- tiene `GuidelinesPath` vacio por defecto. Pasalo explicitamente si necesitas lineamientos externos.

Ejemplo recomendado en Windows:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\claude-saas-opus\scripts\preflight.ps1 -RepoPath .
.\claude-saas-opus\scripts\run-all.ps1 -RepoPath . -Model opus -MaxRetries 3
```
