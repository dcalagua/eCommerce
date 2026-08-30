# P16 — Seguridad SaaS y readiness enterprise

## Objetivo

Cerrar debilidades estructurales antes de considerar la base lista para clientes reales/enterprise.

## Áreas

### Multi-tenant

- RLS default deny/forced según estándar
- FK tenant-safe
- tests tenant A/B para tablas nuevas
- ninguna selección de tenant confiada al browser
- policies públicas con mínimo privilegio

### Auth/IAM

- session handling
- RBAC servidor
- MFA/SSO como capacidades integrables cuando el contrato de identidad lo permita
- privileged/admin paths claramente separados
- support access auditado

### Web/App

- CSP y headers seguros compatibles con la app
- protección CSRF cuando aplique al mecanismo de sesión
- XSS/sanitización
- secure cookies cuando existan cookies
- rate limits en superficies públicas sensibles
- bot/abuse protections preparadas

### Secrets

- no secretos en frontend
- no secretos versionados
- `secret_ref`/vault donde corresponda
- redaction de logs

### Datos

- clasificación mínima de PII
- retención/borrado seguro documentado
- backups y restore procedure documentados
- DB no expuesta directamente

### Supply chain

- dependencias auditadas
- SAST/DAST hooks o documentación CI-ready
- no ejecutar upgrades mayores automáticos sin revisar breaking changes

### Pagos

- PCI scope minimizado por tokenización/delegación
- no PAN/CVV

## Trabajo

1. Crea `docs/SECURITY_BASELINE.md` con estado PASS/PARTIAL/GAP respaldado por evidencia.
2. Corrige gaps de código razonables dentro del repo.
3. Para controles de infraestructura externos, crea requisitos y procedimiento verificable, no mocks que pretendan cubrirlos.
4. Añade tests/regresiones para vulnerabilidades corregidas.
5. Ejecuta búsqueda explícita de secretos y uso de service role en frontend.
6. Revisa permisos del Integration Monitor, pagos, webhooks y audit.

## Definition of Done

PASS si no quedan vulnerabilidades críticas conocidas dentro del alcance del repo y los controles externos pendientes están declarados honestamente con responsables/dependencias.
