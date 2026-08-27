-- =============================================================================
-- Seed de DEMO — solo para el stack LOCAL (`supabase db reset`).
--
-- Sirve para ver la vitrina de `/s/casa-nordica` con categorías y productos sin
-- tener que dar de alta nada a mano. No es un fixture de producción y no se
-- aplica en remoto: `supabase db reset` es un comando de desarrollo y esta
-- migración no existe (esto no es una migración, es `seed.sql`).
--
-- Reglas que sigue igual que el resto del proyecto:
--   · La jerarquía es organization → company → store → catálogo, con los uuid
--     como identidad y `company_code` como simple atributo.
--   · El correo de administrador NO es `@ebim.pe`: el operador de la suite
--     nunca es actor de negocio de un tenant (contrato §13).
--   · No hay claves, tokens ni secretos aquí. Solo datos de catálogo.
--   · Idempotente (`on conflict do nothing`): correrlo dos veces no duplica.
--   · Sin `product_images`: el objeto de Storage no existe en un `db reset`, y
--     una fila apuntando a una ruta vacía daría imágenes rotas en vez del
--     fallback neutral que la vitrina ya sabe pintar.
-- =============================================================================

-- Cuenta (organization) del hub. En demo el uuid es fijo para poder repetir.
insert into public.tenants (organization_id, slug, name, admin_email, status)
values (
  'd0000000-0000-4000-8000-000000000001',
  'casa-nordica',
  'Casa Nórdica',
  'admin@casanordica.demo',
  'active'
)
on conflict (organization_id) do nothing;

-- Tienda de la sociedad. `status = 'active'` es lo que la hace visible a `anon`.
insert into public.stores (id, organization_id, company_id, slug, name, status, currency)
values (
  'd0000000-0000-4000-8000-0000000000a1',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-0000000000c1',
  'casa-nordica',
  'Casa Nórdica',
  'active',
  'PEN'
)
on conflict (id) do nothing;

-- Una segunda tienda EN BORRADOR: existe para comprobar de un vistazo que el
-- storefront devuelve 404 en `/s/taller-cerrado` y no la lista en ningún sitio.
insert into public.stores (id, organization_id, company_id, slug, name, status, currency)
values (
  'd0000000-0000-4000-8000-0000000000a2',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-0000000000c1',
  'taller-cerrado',
  'Taller Cerrado',
  'draft',
  'PEN'
)
on conflict (id) do nothing;

-- Branding del tenant. El acento, el hero y el contacto salen de aquí: la
-- vitrina no cablea ni un color ni un nombre.
insert into public.store_settings (
  store_id, organization_id, company_id,
  accent_color, default_locale, support_email,
  hero_title, hero_subtitle, contact_phone, contact_address
)
values (
  'd0000000-0000-4000-8000-0000000000a1',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-0000000000c1',
  '#056769',
  'es',
  'hola@casanordica.demo',
  'Muebles que duran',
  'Fabricación propia en madera certificada. Envíos a todo el país.',
  '+51 999 111 222',
  'Av. Primavera 120, Lima'
)
on conflict (store_id) do nothing;

-- Categorías. La última está inactiva a propósito: no debe salir en el menú.
insert into public.categories (id, organization_id, company_id, store_id, slug, name, position, is_active)
values
  ('d0000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'sillas', 'Sillas', 1, true),
  ('d0000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'mesas', 'Mesas', 2, true),
  ('d0000000-0000-4000-8000-0000000000b3', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'iluminacion', 'Iluminación', 3, true),
  ('d0000000-0000-4000-8000-0000000000b4', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'descatalogado', 'Descatalogado', 9, false)
on conflict (id) do nothing;

-- Productos. Hay publicados con y sin stock, un borrador y un archivado: es lo
-- mínimo para ver que la vitrina filtra por estado y marca la disponibilidad.
insert into public.products (
  id, organization_id, company_id, store_id, category_id,
  sku, slug, name, description, price, compare_at_price, currency, stock, status, published_at
)
values
  ('d0000000-0000-4000-8000-0000000000e1', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b1',
   'SIL-ROB-01', 'silla-roble-nordica', 'Silla de roble nórdica',
   'Silla de comedor en roble macizo con acabado al aceite. Estructura ensamblada a espiga, sin tornillería a la vista.',
   '389.00', '450.00', 'PEN', 24, 'published', now() - interval '10 days'),

  ('d0000000-0000-4000-8000-0000000000e2', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b1',
   'SIL-TAP-02', 'silla-tapizada-lino', 'Silla tapizada en lino',
   'Asiento tapizado en lino natural sobre base de haya. Funda desmontable y lavable.',
   '429.00', null, 'PEN', 0, 'published', now() - interval '8 days'),

  ('d0000000-0000-4000-8000-0000000000e3', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b1',
   'SIL-PLE-03', 'silla-plegable-abedul', 'Silla plegable de abedul',
   'Plegable, apilable y pensada para espacios chicos. Contrachapado de abedul de nueve capas.',
   '259.00', null, 'PEN', 7, 'published', now() - interval '6 days'),

  ('d0000000-0000-4000-8000-0000000000e4', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b2',
   'MES-COM-01', 'mesa-comedor-extensible', 'Mesa de comedor extensible',
   'De cuatro a ocho comensales con un solo gesto. Tablero de roble y guías metálicas ocultas.',
   '1890.00', '2150.00', 'PEN', 5, 'published', now() - interval '5 days'),

  ('d0000000-0000-4000-8000-0000000000e5', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b2',
   'MES-AUX-02', 'mesa-auxiliar-redonda', 'Mesa auxiliar redonda',
   'Mesa de apoyo de 45 cm con tapa de mármol y patas de fresno.',
   '540.00', null, 'PEN', 12, 'published', now() - interval '4 days'),

  ('d0000000-0000-4000-8000-0000000000e6', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b3',
   'ILU-COL-01', 'lampara-colgante-opalo', 'Lámpara colgante ópalo',
   'Pantalla de vidrio opal soplado y cable textil de dos metros. Casquillo E27.',
   '320.00', null, 'PEN', 18, 'published', now() - interval '3 days'),

  ('d0000000-0000-4000-8000-0000000000e7', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b3',
   'ILU-PIE-02', 'lampara-de-pie-arco', 'Lámpara de pie de arco',
   'Arco de acero con base de mármol y regulador de intensidad en el cable.',
   '760.00', '850.00', 'PEN', 3, 'published', now() - interval '2 days'),

  -- Sin categoría: el catálogo tiene que seguir mostrándolo.
  ('d0000000-0000-4000-8000-0000000000e8', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   null,
   'ACC-COJ-01', 'cojin-lana-gris', 'Cojín de lana gris',
   'Cojín de 45x45 en lana virgen con relleno de plumón reciclado.',
   '95.00', null, 'PEN', 40, 'published', now() - interval '1 day'),

  -- Borrador: NO debe aparecer en la vitrina.
  ('d0000000-0000-4000-8000-0000000000e9', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b2',
   'MES-PRO-09', 'mesa-prototipo', 'Mesa prototipo',
   'Todavía en diseño.', '999.00', null, 'PEN', 1, 'draft', null),

  -- Archivado: tampoco.
  ('d0000000-0000-4000-8000-0000000000ea', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b4',
   'SIL-OLD-99', 'silla-descatalogada', 'Silla descatalogada',
   'Fuera de catálogo.', '199.00', null, 'PEN', 0, 'archived', now() - interval '400 days')
on conflict (id) do nothing;
