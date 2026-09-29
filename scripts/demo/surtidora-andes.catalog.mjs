/**
 * Catálogo de la tienda de demostración «Surtidora Andes» (distribuidora de
 * insumos para hoteles, restaurantes y oficinas, que también vende al público).
 *
 * Está pensado para que UNA tienda enseñe todo lo que soporta la plataforma:
 *
 *   · producto simple, con y sin oferta (precio anterior);
 *   · variantes con uno y con dos ejes (talla · aroma · color · molienda × peso);
 *   · venta por presentación: unidad / paquete / caja, con su factor;
 *   · kits (producto `bundle`) con stock derivado de sus componentes;
 *   · escalas de precio por cantidad en la lista pública;
 *   · listas por segmento (hoteles, restaurantes) y por cliente;
 *   · los cinco tipos de promoción, una con cupón y otra con reloj.
 *
 * Los precios están en soles y siguen el rango real del rubro. Nada de
 * «Producto 47»: en una demo el catálogo se LEE.
 *
 * `photo` es el encargo de la foto (se genera una por producto, sobre fondo
 * claro, como las de Alma Andina).
 */

export const STORE = {
  slug: 'surtidoraandes',
  name: 'Surtidora Andes',
  tenantSlug: 'surtidora-andes',
  tenantName: 'Surtidora Andes S.A.C.',
  ownerEmail: 'owner@surtidoraandes.demo',
  buyerEmail: 'compras@hotelmiraflores.demo',
  // Fijos para que el script sea idempotente: correrlo dos veces no crea dos tenants.
  organizationId: '5a9e1d3c-7b42-4e8f-9c61-2f0a8b3d4e51',
  companyId: '8c3f2a71-4d6e-4b19-a5f2-6e7d9c0b1a24',
  currency: 'PEN',
  theme: 'universal',
  description:
    'Insumos de limpieza, cafetería, papel e higiene y amenities para hoteles, restaurantes y oficinas. Vendemos al público y a empresas con precio de convenio.',
}

/** Unidades que hacen falta además de las del paquete de arranque. */
export const UNITS = [
  { code: 'UND', name: 'Unidad', symbol: 'und' },
  { code: 'PAQ', name: 'Paquete', symbol: 'paq' },
  { code: 'CJA', name: 'Caja', symbol: 'cja' },
  { code: 'MGA', name: 'Manga', symbol: 'mga' },
  { code: 'ROL', name: 'Rollo', symbol: 'rol' },
]

export const BRANDS = [
  { code: 'brillex', name: 'Brillex' },
  { code: 'casa-pura', name: 'Casa Pura' },
  { code: 'aroma-andes', name: 'Aroma Andes' },
  { code: 'dulce-valle', name: 'Dulce Valle' },
  { code: 'nube-suave', name: 'Nube Suave' },
  { code: 'kappa-pro', name: 'Kappa Pro' },
  { code: 'cuidamax', name: 'Cuidamax' },
  { code: 'hotelia', name: 'Hotelia' },
  { code: 'ecoverde', name: 'EcoVerde' },
]

/** Atributos: los ejes de variante y sus valores. */
export const ATTRIBUTES = [
  { code: 'talla', name: 'Talla', values: ['S', 'M', 'L', 'XL'] },
  { code: 'aroma', name: 'Aroma', values: ['Lavanda', 'Limón', 'Marino'] },
  { code: 'color', name: 'Color', values: ['Azul', 'Amarillo', 'Verde', 'Rosado', 'Blanco', 'Gris'] },
  { code: 'molienda', name: 'Molienda', values: ['Grano', 'Molido'] },
  { code: 'peso', name: 'Peso', values: ['250 g', '1 kg'] },
]

export const CATEGORIES = [
  { slug: 'limpieza', name: 'Limpieza', position: 1 },
  { slug: 'limpieza-pisos', name: 'Pisos y superficies', parent: 'limpieza', position: 1 },
  { slug: 'limpieza-banos', name: 'Baños y desinfección', parent: 'limpieza', position: 2 },
  { slug: 'limpieza-lavanderia', name: 'Lavandería', parent: 'limpieza', position: 3 },
  { slug: 'limpieza-utiles', name: 'Útiles de limpieza', parent: 'limpieza', position: 4 },
  { slug: 'cafeteria', name: 'Cafetería', position: 2 },
  { slug: 'cafeteria-cafe', name: 'Café e infusiones', parent: 'cafeteria', position: 1 },
  { slug: 'cafeteria-descartables', name: 'Descartables', parent: 'cafeteria', position: 2 },
  { slug: 'cafeteria-endulzantes', name: 'Azúcar y endulzantes', parent: 'cafeteria', position: 3 },
  { slug: 'papel', name: 'Papel e higiene', position: 3 },
  { slug: 'proteccion', name: 'Protección personal', position: 4 },
  { slug: 'amenities', name: 'Amenities de hotel', position: 5 },
  { slug: 'equipos', name: 'Dispensadores y equipos', position: 6 },
  { slug: 'kits', name: 'Kits listos', position: 7 },
]

/**
 * Productos. Campos:
 *   sku, name, cat, brand, price, compare (precio anterior), stock, desc, photo
 *   variants: [{ sku, name, price?, stock, axes: { eje: valor } }]
 *   uoms:     [{ code, factor, price }]   — presentaciones además de la unidad
 *   tiers:    [[desdeCantidad, precio], ...] — escalas de la lista pública
 */
export const PRODUCTS = [
  // ── Limpieza · pisos y superficies ──────────────────────────────────────
  { sku: 'SA-LIM-001', name: 'Limpiador multiusos Brillex 5 L', cat: 'limpieza-pisos', brand: 'brillex', price: 42.9, compare: 52.9, stock: 140,
    desc: 'Limpiador concentrado para pisos, mesas y superficies lavables. Rinde hasta 50 L diluido. Bidón de 5 litros con tapa de seguridad.',
    tiers: [[6, 39.9], [24, 36.5]],
    photo: 'a 5 liter white plastic jug of multipurpose floor cleaner with a blue label, product photo on light background' },
  { sku: 'SA-LIM-002', name: 'Desinfectante de ambientes Brillex 3.8 L', cat: 'limpieza-pisos', brand: 'brillex', price: 24.9, stock: 0,
    desc: 'Desinfectante y aromatizante para pisos y ambientes. Elimina el 99.9 % de gérmenes. Galón de 3.8 litros.',
    variants: [
      { sku: 'SA-LIM-002-LAV', name: 'Lavanda', stock: 60, axes: { aroma: 'Lavanda' } },
      { sku: 'SA-LIM-002-LIM', name: 'Limón', stock: 45, axes: { aroma: 'Limón' } },
      { sku: 'SA-LIM-002-MAR', name: 'Marino', stock: 0, axes: { aroma: 'Marino' } },
    ],
    photo: 'a 1 gallon translucent jug of purple lavender floor disinfectant, product photo on light background' },
  { sku: 'SA-LIM-003', name: 'Limpiavidrios con gatillo Casa Pura 1 L', cat: 'limpieza-pisos', brand: 'casa-pura', price: 9.9, stock: 220,
    desc: 'Limpiavidrios sin rayas para ventanas, espejos y vitrinas. Botella de 1 litro con pulverizador.',
    uoms: [{ code: 'CJA', factor: 12, price: 108 }],
    photo: 'a 1 liter spray bottle of blue glass cleaner with trigger sprayer, product photo on light background' },
  { sku: 'SA-LIM-004', name: 'Cera autobrillante Brillex 3.8 L', cat: 'limpieza-pisos', brand: 'brillex', price: 34.5, stock: 80,
    desc: 'Cera líquida autobrillante para pisos de vinil, cerámica y mayólica. Secado rápido, no necesita lustrar.',
    photo: 'a 1 gallon jug of liquid floor wax with a red label, product photo on light background' },

  // ── Limpieza · baños y desinfección ─────────────────────────────────────
  { sku: 'SA-LIM-010', name: 'Lejía concentrada Casa Pura 4 L', cat: 'limpieza-banos', brand: 'casa-pura', price: 12.5, stock: 300,
    desc: 'Hipoclorito de sodio al 5 %. Desinfecta baños, cocinas y ropa blanca. Bidón de 4 litros.',
    uoms: [{ code: 'CJA', factor: 4, price: 46 }],
    tiers: [[12, 11.4], [48, 10.6]],
    photo: 'a 4 liter white plastic bottle of bleach with green label, product photo on light background' },
  { sku: 'SA-LIM-011', name: 'Jabón líquido para manos Casa Pura 3.8 L', cat: 'limpieza-banos', brand: 'casa-pura', price: 19.9, compare: 23.9, stock: 160,
    desc: 'Jabón líquido neutro con glicerina para dispensadores de baño. Galón de 3.8 litros.',
    uoms: [{ code: 'CJA', factor: 4, price: 74 }],
    tiers: [[8, 18.5], [32, 17.2]],
    photo: 'a 1 gallon jug of pink liquid hand soap, product photo on light background' },
  { sku: 'SA-LIM-012', name: 'Quitasarro para baños Brillex 1 L', cat: 'limpieza-banos', brand: 'brillex', price: 14.9, stock: 90,
    desc: 'Elimina sarro y manchas de óxido de inodoros, lavatorios y griferías. Con tapa de seguridad para niños.',
    photo: 'a 1 liter bottle of toilet descaler with angled nozzle, product photo on light background' },
  { sku: 'SA-LIM-013', name: 'Ambientador en aerosol Aroma Andes 360 ml', cat: 'limpieza-banos', brand: 'aroma-andes', price: 8.9, stock: 0,
    desc: 'Ambientador en aerosol de larga duración para baños, recepciones y habitaciones.',
    variants: [
      { sku: 'SA-LIM-013-LAV', name: 'Lavanda', stock: 120, axes: { aroma: 'Lavanda' } },
      { sku: 'SA-LIM-013-LIM', name: 'Limón', stock: 95, axes: { aroma: 'Limón' } },
      { sku: 'SA-LIM-013-MAR', name: 'Marino', stock: 70, axes: { aroma: 'Marino' } },
    ],
    photo: 'an aerosol air freshener spray can with lavender flowers on the label, product photo on light background' },
  { sku: 'SA-LIM-014', name: 'Pastillas para tanque de inodoro EcoVerde x 4', cat: 'limpieza-banos', brand: 'ecoverde', price: 11.5, stock: 130,
    desc: 'Pastillas azules para el tanque del inodoro. Limpian y aromatizan en cada descarga. Paquete de 4.',
    photo: 'a pack of four blue toilet tank tablets in blister packaging, product photo on light background' },

  // ── Limpieza · lavandería ───────────────────────────────────────────────
  { sku: 'SA-LIM-020', name: 'Detergente en polvo industrial Brillex 15 kg', cat: 'limpieza-lavanderia', brand: 'brillex', price: 119, stock: 40,
    desc: 'Detergente en polvo para lavanderías de hotel y lavadoras industriales. Saco de 15 kg.',
    tiers: [[5, 112], [20, 105]],
    photo: 'a large 15 kg sack of industrial laundry detergent powder, product photo on light background' },
  { sku: 'SA-LIM-021', name: 'Suavizante de ropa Nube Suave 3.8 L', cat: 'limpieza-lavanderia', brand: 'nube-suave', price: 21.9, stock: 110,
    desc: 'Suavizante concentrado para ropa de cama y toallas. Deja la ropa suave y perfumada.',
    photo: 'a 1 gallon jug of light blue fabric softener, product photo on light background' },
  { sku: 'SA-LIM-022', name: 'Quitamanchas oxígeno activo Brillex 900 g', cat: 'limpieza-lavanderia', brand: 'brillex', price: 18.5, stock: 75,
    desc: 'Quitamanchas en polvo con oxígeno activo para ropa blanca y de color. Pote de 900 g.',
    photo: 'a plastic tub of oxygen stain remover powder with a scoop, product photo on light background' },

  // ── Limpieza · útiles ───────────────────────────────────────────────────
  { sku: 'SA-LIM-030', name: 'Paño de microfibra 40 x 40 cm', cat: 'limpieza-utiles', brand: 'kappa-pro', price: 4.5, stock: 0,
    desc: 'Paño de microfibra lavable hasta 300 veces. Usa un color por zona para no cruzar suciedad.',
    variants: [
      { sku: 'SA-LIM-030-AZU', name: 'Azul', stock: 400, axes: { color: 'Azul' } },
      { sku: 'SA-LIM-030-AMA', name: 'Amarillo', stock: 380, axes: { color: 'Amarillo' } },
      { sku: 'SA-LIM-030-VER', name: 'Verde', stock: 350, axes: { color: 'Verde' } },
      { sku: 'SA-LIM-030-ROS', name: 'Rosado', stock: 300, axes: { color: 'Rosado' } },
    ],
    photo: 'a stack of folded microfiber cleaning cloths in blue, yellow, green and pink, product photo on light background' },
  { sku: 'SA-LIM-031', name: 'Esponja doble uso Kappa Pro', cat: 'limpieza-utiles', brand: 'kappa-pro', price: 1.2, stock: 1200,
    desc: 'Esponja con fibra verde abrasiva para ollas y lado suave para vajilla.',
    uoms: [{ code: 'PAQ', factor: 10, price: 10.5 }, { code: 'CJA', factor: 120, price: 115 }],
    photo: 'a yellow and green kitchen scrub sponge, product photo on light background' },
  { sku: 'SA-LIM-032', name: 'Trapeador de algodón con mango Kappa Pro', cat: 'limpieza-utiles', brand: 'kappa-pro', price: 22.9, stock: 60,
    desc: 'Trapeador de algodón absorbente con mango de aluminio de 1.3 m.',
    photo: 'a cotton string mop with aluminum handle, product photo on light background' },
  { sku: 'SA-LIM-033', name: 'Bolsas para basura 140 L negras x 10', cat: 'limpieza-utiles', brand: 'ecoverde', price: 9.9, stock: 500,
    desc: 'Bolsas de alta resistencia para contenedores de 140 L. Paquete de 10.',
    uoms: [{ code: 'CJA', factor: 10, price: 92 }],
    tiers: [[10, 9.2], [40, 8.5]],
    photo: 'a roll of black heavy duty garbage bags, product photo on light background' },
  { sku: 'SA-LIM-034', name: 'Escoba de cerdas suaves Kappa Pro', cat: 'limpieza-utiles', brand: 'kappa-pro', price: 12.9, stock: 85,
    desc: 'Escoba de interiores con cerdas abiertas y mango roscado de 1.2 m.',
    photo: 'an indoor broom with soft blue bristles and long handle, product photo on light background' },

  // ── Cafetería · café e infusiones ───────────────────────────────────────
  { sku: 'SA-CAF-001', name: 'Café de altura Aroma Andes', cat: 'cafeteria-cafe', brand: 'aroma-andes', price: 18.9, stock: 0,
    desc: 'Café arábica de Chanchamayo, tostado medio. Notas a chocolate y frutos secos. Elige grano o molido y el tamaño.',
    variants: [
      { sku: 'SA-CAF-001-G250', name: 'Grano 250 g', price: 18.9, stock: 80, axes: { molienda: 'Grano', peso: '250 g' } },
      { sku: 'SA-CAF-001-M250', name: 'Molido 250 g', price: 18.9, stock: 95, axes: { molienda: 'Molido', peso: '250 g' } },
      { sku: 'SA-CAF-001-G1K', name: 'Grano 1 kg', price: 64.9, stock: 40, axes: { molienda: 'Grano', peso: '1 kg' } },
      { sku: 'SA-CAF-001-M1K', name: 'Molido 1 kg', price: 64.9, stock: 35, axes: { molienda: 'Molido', peso: '1 kg' } },
    ],
    photo: 'a kraft paper coffee bag with a mountain logo and coffee beans around it, product photo on light background' },
  { sku: 'SA-CAF-002', name: 'Café descafeinado soluble Aroma Andes 200 g', cat: 'cafeteria-cafe', brand: 'aroma-andes', price: 24.5, stock: 70,
    desc: 'Café soluble descafeinado en frasco de vidrio de 200 g.',
    photo: 'a glass jar of instant decaf coffee with a brown lid, product photo on light background' },
  { sku: 'SA-CAF-003', name: 'Té filtrante Dulce Valle caja x 100', cat: 'cafeteria-cafe', brand: 'dulce-valle', price: 11.9, stock: 150,
    desc: 'Té negro en bolsitas filtrantes con sobre individual. Caja de 100.',
    photo: 'a box of 100 black tea bags with individual envelopes, product photo on light background' },
  { sku: 'SA-CAF-004', name: 'Infusiones surtidas Dulce Valle caja x 100', cat: 'cafeteria-cafe', brand: 'dulce-valle', price: 13.9, compare: 16.9, stock: 120,
    desc: 'Anís, manzanilla, hierba luisa y menta en bolsitas filtrantes. Caja de 100.',
    photo: 'a box of assorted herbal tea bags chamomile and mint, product photo on light background' },
  { sku: 'SA-CAF-005', name: 'Crema no láctea en sobres x 100', cat: 'cafeteria-cafe', brand: 'dulce-valle', price: 15.5, stock: 90,
    desc: 'Sustituto de crema para café en sobres individuales de 3 g.',
    photo: 'a box of individual non dairy coffee creamer sachets, product photo on light background' },

  // ── Cafetería · descartables ────────────────────────────────────────────
  { sku: 'SA-CAF-010', name: 'Vaso de papel para bebida caliente 8 oz', cat: 'cafeteria-descartables', brand: 'ecoverde', price: 0.25, stock: 20000,
    desc: 'Vaso de cartón con barrera interna para café y té. Se vende por manga de 50 o por caja de 1000.',
    uoms: [{ code: 'MGA', factor: 50, price: 11.9 }, { code: 'CJA', factor: 1000, price: 210 }],
    tiers: [[500, 0.22], [2000, 0.2]],
    photo: 'a stack of white paper coffee cups 8 oz, product photo on light background' },
  { sku: 'SA-CAF-011', name: 'Vaso de papel para bebida caliente 12 oz', cat: 'cafeteria-descartables', brand: 'ecoverde', price: 0.32, stock: 15000,
    desc: 'Vaso de cartón de 12 onzas para café para llevar.',
    uoms: [{ code: 'MGA', factor: 50, price: 15.2 }, { code: 'CJA', factor: 1000, price: 280 }],
    photo: 'a tall white paper coffee cup 12 oz with a brown sleeve, product photo on light background' },
  { sku: 'SA-CAF-012', name: 'Tapa para vaso 8 oz', cat: 'cafeteria-descartables', brand: 'ecoverde', price: 0.12, stock: 18000,
    desc: 'Tapa con orificio para sorber, compatible con el vaso de 8 oz.',
    uoms: [{ code: 'MGA', factor: 100, price: 11 }],
    photo: 'a stack of white plastic coffee cup lids, product photo on light background' },
  { sku: 'SA-CAF-013', name: 'Removedor de madera 14 cm', cat: 'cafeteria-descartables', brand: 'ecoverde', price: 0.03, stock: 50000,
    desc: 'Removedor de madera de abedul, biodegradable. Se vende por paquete de 1000.',
    uoms: [{ code: 'PAQ', factor: 1000, price: 24 }],
    photo: 'a bundle of wooden coffee stirrers, product photo on light background' },
  { sku: 'SA-CAF-014', name: 'Agua mineral sin gas 625 ml', cat: 'cafeteria-descartables', brand: 'dulce-valle', price: 1.5, stock: 2400,
    desc: 'Agua mineral de manantial en botella de 625 ml. También por paquete de 15.',
    uoms: [{ code: 'PAQ', factor: 15, price: 19.9 }],
    photo: 'a pack of plastic mineral water bottles 625 ml, product photo on light background' },

  // ── Cafetería · endulzantes ─────────────────────────────────────────────
  { sku: 'SA-CAF-020', name: 'Azúcar rubia en sobres 5 g', cat: 'cafeteria-endulzantes', brand: 'dulce-valle', price: 0.04, stock: 60000,
    desc: 'Sobres individuales de azúcar rubia para cafeterías y habitaciones. Caja de 800 sobres.',
    uoms: [{ code: 'CJA', factor: 800, price: 29.9 }],
    photo: 'a pile of small brown sugar sachets, product photo on light background' },
  { sku: 'SA-CAF-021', name: 'Endulzante de stevia en sobres x 100', cat: 'cafeteria-endulzantes', brand: 'dulce-valle', price: 12.9, stock: 140,
    desc: 'Endulzante a base de stevia, cero calorías. Caja de 100 sobres.',
    photo: 'a green box of stevia sweetener sachets, product photo on light background' },

  // ── Papel e higiene ─────────────────────────────────────────────────────
  { sku: 'SA-PAP-001', name: 'Papel higiénico doble hoja Nube Suave', cat: 'papel', brand: 'nube-suave', price: 1.6, stock: 9600,
    desc: 'Rollo de 30 m, doble hoja. Se vende por rollo, por paquete de 4 o por caja de 48.',
    uoms: [{ code: 'PAQ', factor: 4, price: 5.9 }, { code: 'CJA', factor: 48, price: 64 }],
    tiers: [[96, 1.45], [480, 1.3]],
    photo: 'a pack of four white soft toilet paper rolls, product photo on light background' },
  { sku: 'SA-PAP-002', name: 'Papel higiénico jumbo 500 m Nube Suave', cat: 'papel', brand: 'nube-suave', price: 18.9, compare: 21.9, stock: 600,
    desc: 'Rollo jumbo de 500 m hoja simple para dispensador. Caja de 6 rollos.',
    uoms: [{ code: 'CJA', factor: 6, price: 105 }],
    tiers: [[12, 17.9], [60, 16.5]],
    photo: 'a large jumbo toilet paper roll for dispensers, product photo on light background' },
  { sku: 'SA-PAP-003', name: 'Papel toalla interfoliado x 200 hojas', cat: 'papel', brand: 'nube-suave', price: 4.9, stock: 1800,
    desc: 'Toalla de papel doblada en Z para dispensador. Paquete de 200 hojas; caja de 20 paquetes.',
    uoms: [{ code: 'CJA', factor: 20, price: 89 }],
    photo: 'a stack of white z-fold paper hand towels, product photo on light background' },
  { sku: 'SA-PAP-004', name: 'Papel toalla en rollo 200 m', cat: 'papel', brand: 'nube-suave', price: 12.5, stock: 700,
    desc: 'Rollo de papel toalla de 200 m para dispensador de centro.',
    uoms: [{ code: 'CJA', factor: 6, price: 69 }],
    photo: 'a large roll of white paper towel for center pull dispenser, product photo on light background' },
  { sku: 'SA-PAP-005', name: 'Servilletas de mesa 30 x 30 x 100', cat: 'papel', brand: 'nube-suave', price: 3.9, stock: 1500,
    desc: 'Servilleta de papel blanco, hoja simple. Paquete de 100; caja de 24 paquetes.',
    uoms: [{ code: 'CJA', factor: 24, price: 84 }],
    photo: 'a stack of white paper napkins, product photo on light background' },
  { sku: 'SA-PAP-006', name: 'Pañuelos faciales Nube Suave caja x 100', cat: 'papel', brand: 'nube-suave', price: 4.5, stock: 400,
    desc: 'Pañuelos faciales doble hoja en caja dispensadora para habitaciones.',
    photo: 'a white box of facial tissues with one tissue pulled out, product photo on light background' },

  // ── Protección personal ─────────────────────────────────────────────────
  { sku: 'SA-PRO-001', name: 'Guantes de nitrilo sin polvo caja x 100', cat: 'proteccion', brand: 'cuidamax', price: 24.9, compare: 29.9, stock: 0,
    desc: 'Guantes descartables de nitrilo azul, sin polvo ni látex. Caja de 100 unidades.',
    variants: [
      { sku: 'SA-PRO-001-S', name: 'Talla S', stock: 60, axes: { talla: 'S' } },
      { sku: 'SA-PRO-001-M', name: 'Talla M', stock: 140, axes: { talla: 'M' } },
      { sku: 'SA-PRO-001-L', name: 'Talla L', stock: 110, axes: { talla: 'L' } },
      { sku: 'SA-PRO-001-XL', name: 'Talla XL', stock: 0, axes: { talla: 'XL' } },
    ],
    photo: 'a box of blue nitrile disposable gloves with one glove on top, product photo on light background' },
  { sku: 'SA-PRO-002', name: 'Guantes de limpieza reutilizables Cuidamax', cat: 'proteccion', brand: 'cuidamax', price: 5.9, stock: 0,
    desc: 'Guantes de látex con forro de algodón para limpieza pesada.',
    variants: [
      { sku: 'SA-PRO-002-M', name: 'Talla M', stock: 200, axes: { talla: 'M' } },
      { sku: 'SA-PRO-002-L', name: 'Talla L', stock: 180, axes: { talla: 'L' } },
    ],
    photo: 'a pair of yellow household rubber cleaning gloves, product photo on light background' },
  { sku: 'SA-PRO-003', name: 'Mascarilla descartable tres pliegues caja x 50', cat: 'proteccion', brand: 'cuidamax', price: 9.9, stock: 380,
    desc: 'Mascarilla de tres capas con elástico. Caja de 50.',
    uoms: [{ code: 'CJA', factor: 20, price: 179 }],
    photo: 'a box of light blue disposable face masks, product photo on light background' },
  { sku: 'SA-PRO-004', name: 'Gorro descartable plisado x 100', cat: 'proteccion', brand: 'cuidamax', price: 11.9, stock: 260,
    desc: 'Gorro tipo oruga de polipropileno para cocina y limpieza. Paquete de 100.',
    photo: 'a pack of white disposable bouffant hair caps, product photo on light background' },
  { sku: 'SA-PRO-005', name: 'Mandil impermeable Kappa Pro', cat: 'proteccion', brand: 'kappa-pro', price: 16.9, stock: 0,
    desc: 'Mandil de PVC lavable para cocina y lavandería.',
    variants: [
      { sku: 'SA-PRO-005-BLA', name: 'Blanco', stock: 50, axes: { color: 'Blanco' } },
      { sku: 'SA-PRO-005-AZU', name: 'Azul', stock: 45, axes: { color: 'Azul' } },
    ],
    photo: 'a white waterproof PVC kitchen apron, product photo on light background' },

  // ── Amenities de hotel ──────────────────────────────────────────────────
  { sku: 'SA-AME-001', name: 'Jabón de tocador Hotelia 20 g', cat: 'amenities', brand: 'hotelia', price: 0.45, stock: 12000,
    desc: 'Jabón de glicerina con empaque individual para habitaciones. Caja de 500.',
    uoms: [{ code: 'CJA', factor: 500, price: 199 }],
    tiers: [[1000, 0.41], [5000, 0.37]],
    photo: 'small wrapped hotel soap bars with an elegant label, product photo on light background' },
  { sku: 'SA-AME-002', name: 'Shampoo Hotelia 30 ml', cat: 'amenities', brand: 'hotelia', price: 0.6, stock: 10000,
    desc: 'Shampoo en frasco de 30 ml con tapa flip. Caja de 400.',
    uoms: [{ code: 'CJA', factor: 400, price: 212 }],
    photo: 'small 30 ml hotel shampoo bottles with white caps, product photo on light background' },
  { sku: 'SA-AME-003', name: 'Acondicionador Hotelia 30 ml', cat: 'amenities', brand: 'hotelia', price: 0.6, stock: 9000,
    desc: 'Acondicionador en frasco de 30 ml. Caja de 400.',
    uoms: [{ code: 'CJA', factor: 400, price: 212 }],
    photo: 'small 30 ml hotel conditioner bottles, product photo on light background' },
  { sku: 'SA-AME-004', name: 'Gel de ducha Hotelia 30 ml', cat: 'amenities', brand: 'hotelia', price: 0.6, stock: 8000,
    desc: 'Gel de ducha aroma a hierba luisa en frasco de 30 ml. Caja de 400.',
    uoms: [{ code: 'CJA', factor: 400, price: 212 }],
    photo: 'small 30 ml hotel shower gel bottles with green label, product photo on light background' },
  { sku: 'SA-AME-005', name: 'Gorro de ducha en sobre Hotelia', cat: 'amenities', brand: 'hotelia', price: 0.3, stock: 9000,
    desc: 'Gorro de ducha de polietileno en sobre individual.',
    uoms: [{ code: 'CJA', factor: 500, price: 130 }],
    photo: 'individually packaged hotel shower caps in white envelopes, product photo on light background' },
  { sku: 'SA-AME-006', name: 'Kit dental Hotelia', cat: 'amenities', brand: 'hotelia', price: 1.9, stock: 3000,
    desc: 'Cepillo de dientes y pasta de 5 g en caja individual.',
    uoms: [{ code: 'CJA', factor: 200, price: 340 }],
    photo: 'a hotel dental kit with toothbrush and small toothpaste in a paper box, product photo on light background' },
  { sku: 'SA-AME-007', name: 'Pantuflas de hotel Hotelia', cat: 'amenities', brand: 'hotelia', price: 4.9, compare: 5.9, stock: 0,
    desc: 'Pantuflas de toalla con suela antideslizante, empaque individual.',
    variants: [
      { sku: 'SA-AME-007-M', name: 'Talla M', stock: 500, axes: { talla: 'M' } },
      { sku: 'SA-AME-007-L', name: 'Talla L', stock: 450, axes: { talla: 'L' } },
    ],
    photo: 'a pair of white terry cloth hotel slippers, product photo on light background' },
  { sku: 'SA-AME-008', name: 'Toalla de mano 50 x 90 cm Hotelia', cat: 'amenities', brand: 'hotelia', price: 14.9, stock: 0,
    desc: 'Toalla 100 % algodón de 500 g/m², apta para lavandería industrial.',
    variants: [
      { sku: 'SA-AME-008-BLA', name: 'Blanco', stock: 300, axes: { color: 'Blanco' } },
      { sku: 'SA-AME-008-GRI', name: 'Gris', stock: 120, axes: { color: 'Gris' } },
    ],
    photo: 'neatly folded white cotton hand towels stacked, product photo on light background' },

  // ── Dispensadores y equipos ─────────────────────────────────────────────
  { sku: 'SA-EQU-001', name: 'Dispensador de papel higiénico jumbo', cat: 'equipos', brand: 'kappa-pro', price: 49.9, stock: 45,
    desc: 'Dispensador de plástico ABS con llave para rollo jumbo de hasta 500 m.',
    photo: 'a white plastic wall mounted jumbo toilet paper dispenser, product photo on light background' },
  { sku: 'SA-EQU-002', name: 'Dispensador de jabón líquido 1 L', cat: 'equipos', brand: 'kappa-pro', price: 39.9, compare: 46.9, stock: 60,
    desc: 'Dispensador de pared con visor y pulsador, recargable.',
    photo: 'a white wall mounted liquid soap dispenser with push button, product photo on light background' },
  { sku: 'SA-EQU-003', name: 'Dispensador de papel toalla interfoliado', cat: 'equipos', brand: 'kappa-pro', price: 44.9, stock: 38,
    desc: 'Dispensador de pared para papel toalla doblado en Z.',
    photo: 'a white wall mounted paper towel dispenser, product photo on light background' },
  { sku: 'SA-EQU-004', name: 'Carro de limpieza con balde escurridor', cat: 'equipos', brand: 'kappa-pro', price: 389, stock: 8,
    desc: 'Carro de limpieza con balde doble de 25 L, escurridor y bolsa para residuos.',
    photo: 'a yellow janitorial cleaning cart with mop bucket and wringer, product photo on light background' },
  { sku: 'SA-EQU-005', name: 'Letrero piso mojado', cat: 'equipos', brand: 'kappa-pro', price: 29.9, stock: 70,
    desc: 'Señal plegable amarilla «Cuidado piso mojado», bilingüe.',
    photo: 'a yellow folding caution wet floor sign, product photo on light background' },
  { sku: 'SA-EQU-006', name: 'Contenedor de basura con pedal 30 L', cat: 'equipos', brand: 'ecoverde', price: 59.9, stock: 30,
    desc: 'Tacho de plástico con pedal y tapa hermética, 30 litros.',
    photo: 'a gray plastic pedal trash bin 30 liters, product photo on light background' },
]

/**
 * Kits (productos `bundle`). El stock se deriva de sus componentes: un kit
 * existe mientras exista cada una de sus piezas.
 */
export const BUNDLES = [
  { sku: 'SA-KIT-001', name: 'Kit limpieza de habitación', cat: 'kits', brand: 'brillex', price: 59.9, compare: 68.4,
    desc: 'Lo que usa una camarera en un turno: desinfectante, limpiavidrios, 4 paños de microfibra y una caja de guantes de nitrilo M.',
    components: [['SA-LIM-002-LAV', 1], ['SA-LIM-003', 1], ['SA-LIM-030-AZU', 2], ['SA-LIM-030-AMA', 2], ['SA-PRO-001-M', 1]],
    photo: 'a housekeeping cleaning kit with spray bottles, microfiber cloths and gloves in a caddy, product photo on light background' },
  { sku: 'SA-KIT-002', name: 'Kit amenities x 50 habitaciones', cat: 'kits', brand: 'hotelia', price: 139, compare: 157.5,
    desc: 'Para 50 habitaciones: jabón, shampoo, acondicionador, gel de ducha y gorro de ducha, 50 de cada uno.',
    components: [['SA-AME-001', 50], ['SA-AME-002', 50], ['SA-AME-003', 50], ['SA-AME-004', 50], ['SA-AME-005', 50]],
    photo: 'a set of hotel amenities with small bottles, soap and shower cap arranged together, product photo on light background' },
  { sku: 'SA-KIT-003', name: 'Kit cafetería para oficina', cat: 'kits', brand: 'aroma-andes', price: 99, compare: 112,
    desc: 'Café molido 1 kg, 200 vasos de 8 oz con tapa, 800 sobres de azúcar y 1000 removedores.',
    components: [['SA-CAF-001-M1K', 1], ['SA-CAF-010', 200], ['SA-CAF-012', 200], ['SA-CAF-020', 800], ['SA-CAF-013', 1000]],
    photo: 'an office coffee station kit with coffee bag, paper cups, sugar sachets and stirrers, product photo on light background' },
  { sku: 'SA-KIT-004', name: 'Kit baño listo', cat: 'kits', brand: 'nube-suave', price: 34.9,
    desc: 'Un paquete de papel higiénico, jabón líquido de manos y un ambientador de lavanda.',
    components: [['SA-PAP-001', 4], ['SA-LIM-011', 1], ['SA-LIM-013-LAV', 1]],
    photo: 'a bathroom supplies kit with toilet paper rolls, hand soap and air freshener, product photo on light background' },
]

/** Descuento de cada lista de segmento sobre el precio público. */
export const SEGMENTS = [
  { code: 'hoteles', name: 'Hoteles', discount: 0.08 },
  { code: 'restaurantes', name: 'Restaurantes', discount: 0.05 },
]

/** Clientes empresa. El hotel tiene precio pactado propio y crédito. */
export const ACCOUNTS = [
  { code: 'HMP', name: 'Hotel Miraflores Plaza', legal: 'Inversiones Hoteleras Miraflores S.A.C.', ruc: '20512345671', segment: 'hoteles',
    credit: 20000, terms: 30, poRequired: true,
    agreed: [['SA-PAP-002', 15.9], ['SA-LIM-011', 16.9], ['SA-AME-001', 0.36], ['SA-AME-002', 0.49], ['SA-LIM-010', 10.2], ['SA-CAF-010', 0.19]] },
  { code: 'RLT', name: 'Restaurante La Tinaja', legal: 'La Tinaja Gastronomía E.I.R.L.', ruc: '20587654329', segment: 'restaurantes',
    credit: 5000, terms: 15, poRequired: false, agreed: [] },
]

/**
 * Promociones: una de cada tipo. `endsInDays` pone la fecha de fin (con 5 días
 * sale el reloj en la portada); sin él, no caduca.
 */
export const PROMOTIONS = [
  { code: 'panos-3x2', name: 'Paños de microfibra: lleva 3, paga 2', kind: 'x_for_y', buy: 3, free: 1,
    desc: 'En todos los colores. Mezcla como quieras.', scope: { product: 'SA-LIM-030' }, endsInDays: 5 },
  { code: 'limpieza-15', name: '15 % en limpieza de baños', kind: 'percentage', percent: 15,
    desc: 'Lejía, quitasarro, jabón de manos y más.', scope: { category: 'limpieza-banos' }, endsInDays: 12 },
  { code: 'desde-500', name: 'S/ 40 de descuento desde S/ 500', kind: 'fixed_amount', amount: 40, minSubtotal: 500,
    desc: 'En toda la tienda, a partir de S/ 500 de compra.', scope: { all: true } },
  { code: 'vasos-volumen', name: 'Vasos: más llevas, menos pagas', kind: 'volume_tier',
    desc: '5 % desde 1000 vasos y 10 % desde 5000.', scope: { category: 'cafeteria-descartables' },
    tiers: [[1000, 5], [5000, 10]] },
  { code: 'bienvenida', name: 'Bienvenida: 10 % en tu primera compra', kind: 'percentage', percent: 10, coupon: 'BIENVENIDA',
    desc: 'Usa el cupón BIENVENIDA al pagar.', scope: { all: true }, perCustomer: 1 },
]

/** Almacenes. El de Lima es el principal; Arequipa guarda una parte. */
export const WAREHOUSES = [
  { code: 'ALM-LIMA', name: 'Almacén Lima (Ate)', city: 'Lima', region: 'Lima', isDefault: true, share: 0.75 },
  { code: 'ALM-AQP', name: 'Almacén Arequipa', city: 'Arequipa', region: 'Arequipa', isDefault: false, share: 0.25 },
]
