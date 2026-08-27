Lee CLAUDE.md y docs/STATE.md. Ejecuta P08 final. No agregues features nuevas.

Verifica y corrige:
- install limpio si corresponde, lint, typecheck, tests, production build
- migraciones reproducibles e inmutabilidad de aplicadas
- RLS y aislamiento tenant A/B
- publico no modifica catalogo
- service_role ausente del frontend
- storage aislado
- create-order recalcula precios server-side
- Edge Functions no confian en tenant_id del browser
- rutas, responsive, loading/error/empty
- sin secretos, mocks productivos accidentales ni TODO critico

Recorridos minimos:
login -> onboarding -> admin
producto -> imagen -> publicar
storefront -> producto -> carrito -> checkout -> order
admin -> ver orden

No deploy, push ni PR.
Actualiza STATE.md con PASS/FAIL por fase, comandos ejecutados, tests, build, commits, pendientes, riesgos y siguiente fase.
Crea docs/OVERNIGHT_REPORT.md <= 160 lineas.
Commit solo si hay cambios: chore: complete initial ecommerce quality gate
Salida <= 15 lineas.
