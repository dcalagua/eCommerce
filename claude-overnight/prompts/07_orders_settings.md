Lee CLAUDE.md y docs/STATE.md. Ejecuta P07 siguiendo Drive.

Completa MVP admin.

/app/orders:
listado, busqueda, filtros estado/fecha, total, cliente, order_number, detalle en Drawer, items, entrega e historial disponible. Cambios de estado solo mediante update-order-status Edge Function.
Estados sugeridos pending/confirmed/preparing/ready/completed/cancelled salvo definicion EBIM distinta.

/app/settings:
nombre comercial, descripcion, logo, banner, color primario y contacto. Assets en store-assets. El storefront debe reflejar cambios.

NO crear aun: facturacion, shipping avanzado, pasarela, suscripciones SaaS, dominios custom.
Tests + lint + typecheck + build. No deploy. Actualiza STATE.md. Commit: feat: add order management and store customization
Salida <= 10 lineas.
