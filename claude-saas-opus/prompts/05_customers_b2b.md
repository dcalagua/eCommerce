# P05 — Customers, segmentos y foundation B2B

## Objetivo

Separar el concepto de cliente comercial/comprador de la autenticación y preparar cuentas B2B con múltiples usuarios y sucursales.

## Modelo esperado

Evalúa y crea solo lo necesario:

- customers
- customer_addresses
- customer_contacts
- customer_segments
- customer_external_ids
- business_accounts
- business_account_users
- business_locations
- business_roles o relación equivalente
- approval_rules (foundation, no workflow gigante)

## Reglas

1. Auth user != Customer. Un usuario autenticado puede representar una cuenta/cliente, pero no son la misma entidad.
2. Permite clientes B2C, clientes empresa B2B y perfiles privados sin duplicar el core.
3. Permite identificadores externos por provider/ERP sin convertirlos en PK.
4. Direcciones deben poder marcar uso de envío/facturación y, cuando una integración lo requiera, estado verificado/autorizado.
5. Segmentos deben ser configurables y consumibles por pricing/promotions.
6. B2B:
   - múltiples usuarios por empresa
   - sucursales/centros de entrega
   - roles comprador/aprobador/admin/observador o equivalentes configurables
   - límites de autorización base preparados para reglas por monto
7. No implementes todavía crédito SAP ni lógica de un ERP concreto.
8. Acceso a una business account requiere vínculo servidor, no ID declarada por browser.
9. Backoffice incluye búsqueda, detalle, contactos, direcciones, segmento y cuentas relacionadas.
10. Storefront/account area debe poder listar las direcciones y contexto de cuenta del usuario cuando aplique.
11. Tests de tenant isolation, user-account membership, direcciones y roles.

## Definition of Done

PASS si customer/account es un dominio reutilizable, B2B multiusuario está modelado y no depende de un proveedor de identidad o ERP específico.
