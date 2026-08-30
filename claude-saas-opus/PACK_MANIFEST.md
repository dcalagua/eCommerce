# Pack manifest

Versión: 1.0.0  
Fecha: 2026-08-27  
Modelo objetivo: Claude Opus  
Repositorio objetivo: base existente eCommerce by EBIM

## Contenido validado

- 18 fases de desarrollo.
- 1 supervisor correctivo.
- 1 recovery prompt.
- 1 execution contract compartido.
- Runner PowerShell con supervisor y reintentos.
- Runner Bash con supervisor y reintentos.
- Preflight PowerShell/Bash.
- Ejecución de una sola fase en PowerShell.
- Stop helper para Windows.
- Launcher `.cmd` para Opus.
- Gates independientes por fase definidos en JSON.
- Logs y estado persistente del runner.

## Política de reintentos

- Errores transitorios: hasta 3 reintentos por defecto con backoff.
- Errores de implementación/gate: supervisor + reejecución de la misma fase.
- Reparaciones máximas por fase: 3 por defecto.
- Si el supervisor declara BLOCKED, la ejecución se detiene para evitar modificaciones especulativas.


## v3 hotfix
- Corrige NativeCommandError de PowerShell 5.1 al ejecutar npm/vitest/claude.
- Evalua procesos nativos por exit code real.
- GuidelinesPath pasa a ser opcional por defecto.
