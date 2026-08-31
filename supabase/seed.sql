-- =============================================================================
-- Seed de DEMO — solo para el stack LOCAL (`supabase db reset`).
--
-- Sirve para ver la vitrina de `/s/miquimica` con categorías y productos sin
-- tener que dar de alta nada a mano. No es un fixture de producción y no se
-- aplica en remoto: `supabase db reset` es un comando de desarrollo y esta
-- migración no existe (esto no es una migración, es `seed.sql`).
--
-- El tenant de demo es una BOTICA: medicamentos de venta libre, cuidado
-- personal y suplementos. Se eligió un catálogo de farmacia porque ejercita
-- cosas que el de muebles no tocaba —presentaciones como eje de variante, un
-- producto que exige receta, lotes que caducan— y porque los tickets pequeños y
-- las cantidades altas dan otra forma a la analítica.
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
--
-- Sobre los textos de los productos: dicen QUÉ ES y QUÉ TRAE —principio activo,
-- presentación, contenido—, nunca para qué tomarlo ni cuánto. Una ficha de
-- catálogo no es un prospecto, y una demo tampoco es sitio para dar indicación
-- médica. Lo que exige receta lo dice en su propia ficha.
-- =============================================================================

-- Cuenta (organization) del hub. En demo el uuid es fijo para poder repetir.
insert into public.tenants (organization_id, slug, name, admin_email, status)
values (
  'd0000000-0000-4000-8000-000000000001',
  'miquimica',
  'MiQuímica',
  'admin@miquimica.demo',
  'active'
)
on conflict (organization_id) do nothing;

-- Tienda de la sociedad. `status = 'active'` es lo que la hace visible a `anon`.
insert into public.stores (id, organization_id, company_id, slug, name, status, currency)
values (
  'd0000000-0000-4000-8000-0000000000a1',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-0000000000c1',
  'miquimica',
  'MiQuímica',
  'active',
  'PEN'
)
on conflict (id) do nothing;

-- Una segunda tienda EN BORRADOR: existe para comprobar de un vistazo que el
-- storefront devuelve 404 en `/s/botica-cerrada` y no la lista en ningún sitio.
insert into public.stores (id, organization_id, company_id, slug, name, status, currency)
values (
  'd0000000-0000-4000-8000-0000000000a2',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-0000000000c1',
  'botica-cerrada',
  'Botica Cerrada',
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
  '#0E7C66',
  'es',
  'hola@miquimica.demo',
  'Tu botica en línea',
  'Medicamentos, cuidado personal y suplementos con entrega el mismo día en Lima.',
  '+51 999 111 222',
  'Av. Arequipa 1420, Lima'
)
on conflict (store_id) do nothing;

-- Categorías. La última está inactiva a propósito: no debe salir en el menú.
insert into public.categories (id, organization_id, company_id, store_id, slug, name, position, is_active)
values
  ('d0000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'medicamentos', 'Medicamentos', 1, true),
  ('d0000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'cuidado-personal', 'Cuidado personal', 2, true),
  ('d0000000-0000-4000-8000-0000000000b3', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'vitaminas', 'Vitaminas y suplementos', 3, true),
  ('d0000000-0000-4000-8000-0000000000b4', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'descontinuado', 'Descontinuado', 9, false)
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
   'MED-PAR-500', 'paracetamol-500-mg', 'Paracetamol 500 mg',
   'Analgésico y antipirético de venta libre. Caja con 20 tabletas ranuradas en blíster de aluminio. Lee el prospecto antes de usarlo.',
   '8.90', '11.50', 'PEN', 24, 'published', now() - interval '10 days'),

  ('d0000000-0000-4000-8000-0000000000e2', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b1',
   'MED-IBU-400', 'ibuprofeno-400-mg', 'Ibuprofeno 400 mg',
   'Antiinflamatorio de venta libre. Caja con 10 tabletas recubiertas. Lee el prospecto antes de usarlo.',
   '12.50', null, 'PEN', 0, 'published', now() - interval '8 days'),

  ('d0000000-0000-4000-8000-0000000000e3', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b1',
   'MED-LOR-010', 'loratadina-10-mg', 'Loratadina 10 mg',
   'Antihistamínico de venta libre. Caja con 10 tabletas. Lee el prospecto antes de usarlo.',
   '9.90', null, 'PEN', 7, 'published', now() - interval '6 days'),

  -- El único que exige receta: la ficha lo dice y el atributo lo marca. Es lo
  -- que hace visible en la demo un catálogo mixto, que es el caso real de
  -- cualquier botica.
  ('d0000000-0000-4000-8000-0000000000e4', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b1',
   'MED-AMO-500', 'amoxicilina-500-mg', 'Amoxicilina 500 mg',
   'Antibiótico de venta bajo receta médica. Caja con 12 cápsulas. La botica valida la receta antes de despachar el pedido.',
   '24.90', '29.00', 'PEN', 5, 'published', now() - interval '5 days'),

  ('d0000000-0000-4000-8000-0000000000e5', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b2',
   'CPE-SOL-050', 'protector-solar-fps-50', 'Protector solar facial FPS 50',
   'Fluido de textura ligera, sin perfume, apto para piel sensible. Frasco de 60 ml con dosificador.',
   '54.00', null, 'PEN', 12, 'published', now() - interval '4 days'),

  ('d0000000-0000-4000-8000-0000000000e6', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b2',
   'CPE-ALC-070', 'alcohol-en-gel-70', 'Alcohol en gel 70°',
   'Gel antiséptico para manos con 70 % de alcohol y glicerina. Frasco de 500 ml con válvula dosificadora.',
   '14.90', null, 'PEN', 18, 'published', now() - interval '3 days'),

  ('d0000000-0000-4000-8000-0000000000e7', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b3',
   'VIT-VTC-1G0', 'vitamina-c-1-g-efervescente', 'Vitamina C 1 g efervescente',
   'Suplemento alimenticio en tabletas efervescentes sabor naranja. Tubo con 10 tabletas.',
   '19.90', '24.00', 'PEN', 3, 'published', now() - interval '2 days'),

  -- Sin categoría: el catálogo tiene que seguir mostrándolo.
  ('d0000000-0000-4000-8000-0000000000e8', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   null,
   'BOT-MAS-095', 'mascarilla-kn95', 'Mascarilla KN95',
   'Mascarilla de cinco capas con clip nasal ajustable. Caja con 10 unidades empacadas por separado.',
   '19.00', null, 'PEN', 40, 'published', now() - interval '1 day'),

  -- Borrador: NO debe aparecer en la vitrina.
  ('d0000000-0000-4000-8000-0000000000e9', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b3',
   'VIT-OMG-030', 'omega-3-1000-mg', 'Omega 3 1000 mg',
   'Todavía en alta: falta la ficha del proveedor.', '49.90', null, 'PEN', 1, 'draft', null),

  -- Archivado: tampoco.
  ('d0000000-0000-4000-8000-0000000000ea', 'd0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-0000000000b4',
   'MED-JAR-099', 'jarabe-descontinuado', 'Jarabe descontinuado',
   'Fuera de catálogo: el laboratorio dejó de fabricarlo.', '17.90', null, 'PEN', 0, 'archived', now() - interval '400 days')
on conflict (id) do nothing;
