Lee CLAUDE.md y docs/STATE.md. Exige GUIDELINES_STATUS: VERIFIED. Ejecuta P03.

Construye auth + tenant context + shell administrativo segun EBIM:
- login/logout/recuperacion
- recovery de sesion
- proteccion /app/*
- TenantProvider
- seleccion automatica si solo tiene un tenant
- ningun tenant_id hardcodeado

Si usuario no tiene negocio: onboarding minimo nombre negocio, slug tienda, datos basicos y alta mediante bootstrap-tenant.

Backoffice MUI responsive: sidebar/drawer, header, breadcrumb, selector de tienda preparado para futuro y Dashboard.
Dashboard solo KPIs reales disponibles: productos, publicados, ordenes y ventas si existen datos; no inventar cifras.

Completa loading/error/empty/unauthorized. Valida login -> onboarding -> /app.
Tests + lint + typecheck + build. No deploy. Actualiza STATE.md. Commit: feat: add tenant authentication and admin shell
Salida <= 10 lineas.
