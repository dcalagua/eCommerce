# Contrato de ejecución común

Este contrato se adjunta automáticamente a cada fase.

Reglas obligatorias:

1. Trabaja únicamente en la fase solicitada.
2. Lee `CLAUDE.md`, `docs/STATE.md` y `docs/architecture.md` antes de modificar código.
3. Si `CLAUDE.md` declara fuentes externas obligatorias, léelas antes de tocar el área afectada.
4. Conserva lo que ya funciona. No rehagas módulos sin necesidad demostrable.
5. No implementes lógica específica por nombre de cliente dentro del core.
6. No introduzcas `organization_id`, `company_id`, `store_id` ni `channel_id` confiando en valores declarados por el browser cuando deban derivarse de sesión/contexto servidor.
7. No uses `service_role` en frontend.
8. Toda nueva tabla de negocio debe nacer con RLS, índices, FKs tenant-safe y tests de aislamiento cuando corresponda.
9. Migraciones ya aplicadas son inmutables; las correcciones posteriores se realizan con una nueva migración.
10. No borres, ignores, deshabilites o debilites tests para conseguir verde.
11. No hagas push, PR, deploy remoto ni reset/destrucción de bases remotas.
12. No expongas secretos en código, logs o configuración versionada.
13. No hagas refactors no relacionados con el objetivo de la fase.
14. Si encuentras una contradicción con un contrato del HUB EBIM, detente en ese punto, documenta el bloqueo y no inventes una solución incompatible.
15. Cada fase debe dejar documentación mínima de las decisiones importantes en `docs/STATE.md` y, si aplica, en un ADR bajo `docs/adr/`.
16. Antes de declarar PASS ejecuta los checks relevantes de la fase y corrige los fallos que estén dentro del alcance.
17. Si un check falla por una dependencia externa o decisión humana que no puedes resolver, declara FAIL y explica el bloqueo de forma breve.
18. Haz commit local convencional solo cuando la fase esté realmente verde y exista un cambio material. Nunca push.

Resultado:

La ÚLTIMA línea de tu respuesta debe ser exactamente una de estas:

PHASE_RESULT: PASS
PHASE_RESULT: FAIL
