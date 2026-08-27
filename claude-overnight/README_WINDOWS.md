# EBIM Ecommerce - Claude Overnight Windows (Opus + Supervisor)

Objetivo: arrancar desde un repo vacio el SaaS ecommerce multitenant EBIM, priorizando administracion + storefront, obligando a Claude a respetar los lineamientos del Drive y agregando un supervisor correctivo automatico.

## Lineamientos obligatorios

Ruta usada por defecto:

`H:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma`

El runner:
1. comprueba que la ruta existe y contiene archivos;
2. usa `claude --add-dir` en fases y supervisor;
3. P00 crea `CLAUDE.md`, `docs/STATE.md` y `docs/EBIM_GUIDELINES_TRACE.md`;
4. no permite continuar si `GUIDELINES_STATUS: VERIFIED` no queda registrado;
5. exige `PHASE_RESULT: PASS` ademas de exit code 0.

## Modelo y supervisor

**Opus es el modelo predeterminado.** Tanto las fases como el supervisor usan el modelo indicado por `-Model`; si no especificas nada, usan Opus.

Cuando una fase falla o no declara `PHASE_RESULT: PASS`:
1. se guarda el log;
2. se ejecuta `prompts/SUPERVISOR.md`;
3. el supervisor lee lineamientos EBIM, CLAUDE.md, STATE.md, git diff/status y el log fallido;
4. corrige solo la causa de esa fase;
5. verifica la reparacion;
6. el runner vuelve a ejecutar la MISMA fase.

`-MaxRetries 3` significa hasta 3 ciclos correctivos despues del intento inicial (maximo 4 ejecuciones de la fase). Si el supervisor declara BLOCKED o se agotan los reintentos, la corrida se detiene.

## Requisitos

- Windows PowerShell.
- Google Drive montado como H:.
- Git.
- Node.js + npm.
- Claude Code autenticado.

## Detener una corrida anterior

La opcion mas segura es ir a la consola donde corre y pulsar:

```text
Ctrl + C
```

Si no responde, abre otra PowerShell en el repo y ejecuta:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\claude-overnight\stop-run.ps1
```

El helper busca el `run-all.ps1` y/o procesos Claude asociados al `--add-dir` de EBIM y usa `taskkill /T` para terminar el arbol identificado. No usa `taskkill /IM node.exe`.

Para matar un PID que verificaste manualmente:

```powershell
.\claude-overnight\stop-run.ps1 -ProcessId 12345
```

## Preflight

Desde la raiz del repo:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\claude-overnight\preflight.ps1 -RepoPath .
```

Debe terminar con `PREFLIGHT_OK`.

## Iniciar overnight supervisado con Opus

```powershell
.\claude-overnight\run-all.ps1 -RepoPath .
```

Equivalente explicito:

```powershell
.\claude-overnight\run-all.ps1 -RepoPath . -Model opus -MaxRetries 3
```

## Reanudar desde una fase

Ejemplo desde P05:

```powershell
.\claude-overnight\run-all.ps1 -RepoPath . -StartAt 05
```

Valores: 00 a 08. Si empiezas despues de P00, el runner exige que la evidencia de lineamientos EBIM ya exista y siga en VERIFIED.

## Recuperar una corrida interrumpida

```powershell
.\claude-overnight\run-all.ps1 -RepoPath . -RecoveryOnly
```

Recovery tambien pasa por el supervisor si falla.

## Logs

Se guardan en:

`claude-overnight\logs\`

Formato aproximado:

```text
20260827-030000-P03-attempt-1.log
20260827-030500-P03-supervisor-1.log
20260827-031000-P03-attempt-2.log
```

## Seguridad

El modo unattended usa `--permission-mode bypassPermissions`, por lo que Claude puede editar archivos y ejecutar comandos sin pedir aprobacion. Ejecutalo solo sobre el repo de desarrollo.

Prompts y supervisor prohiben deploy remoto, push, PR, borrado de bases remotas, debilitamiento de RLS, secretos en frontend y modificaciones inseguras de migraciones aplicadas.

El runner evita la suspension de Windows mientras esta activo y restaura el comportamiento normal al terminar.
