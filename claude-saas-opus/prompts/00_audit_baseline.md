# P00 — Auditoría y baseline verificable del SaaS

## Objetivo

Establecer el estado real del repositorio antes de continuar la productización. Esta fase NO debe reescribir funcionalidades existentes.

## Antes de tocar código

Lee como mínimo:

- `CLAUDE.md`
- `docs/STATE.md`
- `docs/architecture.md`
- `docs/EBIM_GUIDELINES_TRACE.md` si existe
- `package.json`
- todas las migraciones de `supabase/migrations`
- estructura de `src/`
- Edge Functions y tests existentes
- framework de integraciones existente
- documentación RFP existente solo como contexto de compatibilidad enterprise, no como lógica hardcodeada.

Si `CLAUDE.md` referencia contratos externos EBIM, valida accesibilidad y lee lo necesario.

## Trabajo

1. Ejecuta baseline:
   - typecheck
   - lint
   - tests
   - tests DB
   - build
   solo usando scripts existentes.
2. Inventaría dominios ya implementados y nivel de madurez: completo / parcial / placeholder / inexistente.
3. Identifica riesgos reales, con archivo o migración que los evidencie.
4. Identifica duplicaciones, dependencias directas de Supabase desde UI, límites del modelo actual y deuda que impacte multi-tenant, escalabilidad o venta multi-cliente.
5. No marques como deuda una decisión deliberada que esté documentada y sea correcta.
6. Crea o actualiza:
   - `docs/SAAS_BASELINE.md`
   - `docs/SAAS_KEEP_REFACTOR_BUILD.md`
   - `docs/SAAS_ROADMAP.md`
7. `SAAS_KEEP_REFACTOR_BUILD.md` debe clasificar cada dominio como KEEP / EXTEND / REFACTOR / BUILD y justificarlo en una frase con evidencia.
8. `SAAS_ROADMAP.md` debe mapear dependencias entre P01-P17 y señalar qué piezas pueden implementarse en paralelo.
9. Registra en `docs/STATE.md` el baseline real y los comandos ejecutados.

## Principios de evaluación

El producto objetivo es un SaaS eCommerce multi-tenant, modular y comercializable a múltiples empresas, con B2C/B2B/portal privado como capacidades configurables.

La arquitectura deseada es:

`Core Commerce -> Add-ons -> Ports -> Adapters -> Tenant Configuration`

No debe existir fork de schema o de aplicación por cliente.

## No hacer

- No crear 30 tablas por anticipación.
- No migrar de stack.
- No cambiar el sistema de identidad por iniciativa propia.
- No implementar módulos funcionales grandes.
- No modificar migraciones aplicadas.

## Definition of Done

PASS solo si:

- baseline técnico ejecutado y documentado;
- arquitectura actual descrita sin inventar;
- matriz KEEP/EXTEND/REFACTOR/BUILD completa;
- roadmap de fases coherente;
- no se introdujeron cambios funcionales innecesarios.
