# Recovery — continuar una ejecución interrumpida

Actúa como coordinador técnico de recuperación.

## Lee primero

- `CLAUDE.md`
- `docs/STATE.md`
- `docs/architecture.md`
- `docs/SAAS_ROADMAP.md` si existe
- `claude-saas-opus/state/runner-state.json` si existe
- últimos logs de `claude-saas-opus/logs/`
- `git status`
- `git log --oneline -20`

## Objetivo

Determina cuál es la primera fase P00-P17 que NO está realmente terminada/validada y continúa únicamente desde ese punto.

No te bases solo en el número del state del runner. Verifica evidencia en código, docs, tests y logs.

## Reglas

- No repitas trabajo que ya está validado y verde.
- Conserva cambios parciales válidos.
- Si el repo está en estado inconsistente, repara primero la causa.
- Si hay una fase en progreso, termina esa fase antes de cualquier posterior.
- No inventes PASS por presencia de archivos.
- No reescribas migraciones aplicadas.
- No push/PR/deploy.
- Respeta contratos EBIM externos.

## Resultado

Actualiza `docs/STATE.md` con el punto real de recuperación.

La ÚLTIMA línea debe ser:

PHASE_RESULT: PASS

solo si dejaste el repo coherente y determinaste/ejecutaste correctamente la recuperación posible. Si existe un bloqueo real:

PHASE_RESULT: FAIL
