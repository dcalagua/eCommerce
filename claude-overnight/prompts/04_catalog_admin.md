Lee CLAUDE.md y docs/STATE.md. Ejecuta P04 siguiendo Drive.

Administracion de catalogo:
- productos: listado MUI, busqueda, filtros, crear, editar, publicar/despublicar y eliminacion segura segun estandar
- campos minimos: name, slug, sku, description, category, price, stock_qty, status
- validacion Zod
- create/edit en Drawer lateral si no contradice lineamientos
- feedback, skeleton y empty states
- categorias CRUD minimo

Imagenes con Supabase Storage product-images:
- multiples
- principal
- ordenar/eliminar
- validar mime/tamano
- path tenant/store/product
- nunca service_role en browser

No mezcles Supabase dentro de componentes visuales: services/hooks. Mutaciones respetan Edge Functions/RLS definidos.
Tests criticos + lint + typecheck + build. No deploy. Actualiza STATE.md. Commit: feat: add catalog management
Salida <= 10 lineas.
