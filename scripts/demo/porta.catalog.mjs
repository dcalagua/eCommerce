/**
 * Catálogo de la tienda de demostración «Porta» (tema Retail, B2C).
 *
 * Mochilas, equipaje, bolsos y accesorios de viaje, como una tienda real de
 * esa industria: casi todo se vende por COLOR, y las maletas además por
 * TAMAÑO (cabina, mediana, grande). ~210 variantes vendibles en ~65 productos.
 *
 * Los colores llevan nombres que la vitrina reconoce (`colorSwatch.ts`), así
 * que salen como círculos en la ficha y como bolitas en la tarjeta.
 *
 * Datos de demostración: marcas, precios y stock son verosímiles, no reales.
 */

export const STORE = {
  slug: 'porta',
  name: 'Porta',
  tenantSlug: 'porta',
  tenantName: 'PRO BAGS PERÚ SAC',
  ownerEmail: 'owner@porta.demo',
  // Fijos: correr el script dos veces no crea dos tenants.
  organizationId: '7d1e4b2a-9c35-4f6e-8a17-3b5c9d0e2f41',
  companyId: '2b8f6c19-5e4a-4d73-9b20-8e1f7a6c3d52',
  currency: 'PEN',
  theme: 'retail',
  accent: '#A6192E',
  description:
    'Mochilas, maletas, bolsos y accesorios de viaje diseñados para moverte por la ciudad y por el mundo. Envíos a todo el Perú.',
  heroTitle: 'Viaja ligero, llega lejos',
  heroKicker: 'Nueva colección 2026',
  announcements: ['ENVÍO GRATIS A TODO EL PERÚ DESDE S/199', 'HASTA 6 CUOTAS SIN INTERESES DESDE S/199'],
  supportEmail: 'ventas@porta.demo',
  contactPhone: '+51 970 510 698',
  contactAddress: 'Av. Javier Prado Este 4200, Santiago de Surco, Lima',
  legalName: 'PRO BAGS PERÚ SAC',
  taxId: '20612345671',
  whatsapp: '+51 970 510 698',
  helpNote: 'Ventas Corporativas.',
  hours: 'Lunes a viernes: 9:00 a.m. a 6:00 p.m.\nSábados: 9:00 a.m. a 1:00 p.m.\n(solo días hábiles)',
  social: [
    { network: 'facebook', url: 'https://www.facebook.com/portaperu' },
    { network: 'instagram', url: 'https://www.instagram.com/portaperu' },
    { network: 'youtube', url: 'https://www.youtube.com/@portaperu' },
    { network: 'tiktok', url: 'https://www.tiktok.com/@portaperu' },
  ],
}

export const BRANDS = [
  { code: 'porta', name: 'Porta' },
  { code: 'gunther', name: 'Gunther' },
  { code: 'trekker', name: 'Trekker' },
  { code: 'urban-pro', name: 'Urban Pro' },
  { code: 'kiddo', name: 'Kiddo' },
]

const COLORES = [
  'Negro', 'Azul marino', 'Gris', 'Guinda', 'Beige', 'Verde militar', 'Azul', 'Rojo', 'Rosado',
  'Celeste', 'Camel', 'Plata', 'Grafito', 'Mostaza', 'Lila', 'Turquesa',
]
const TAMANOS = ['Cabina 20"', 'Mediana 24"', 'Grande 28"']

export const ATTRIBUTES = [
  { code: 'color', name: 'Color', values: COLORES },
  { code: 'tamano', name: 'Tamaño', values: TAMANOS },
]

export const CATEGORIES = [
  { slug: 'mochilas', name: 'Mochilas', position: 1 },
  { slug: 'mochilas-urbanas', name: 'Mochilas urbanas', parent: 'mochilas', position: 1 },
  { slug: 'mochilas-laptop', name: 'Mochilas para laptop', parent: 'mochilas', position: 2 },
  { slug: 'mochilas-escolares', name: 'Mochilas escolares', parent: 'mochilas', position: 3 },
  { slug: 'equipaje', name: 'Equipaje de viaje', position: 2 },
  { slug: 'maletas', name: 'Maletas', parent: 'equipaje', position: 1 },
  { slug: 'bolsos-de-viaje', name: 'Bolsos de viaje', parent: 'equipaje', position: 2 },
  { slug: 'accesorios-de-viaje', name: 'Accesorios de viaje', parent: 'equipaje', position: 3 },
  { slug: 'deporte', name: 'Deporte', position: 3 },
  { slug: 'maletines-deportivos', name: 'Maletines deportivos', parent: 'deporte', position: 1 },
  { slug: 'mochilas-deportivas', name: 'Mochilas deportivas', parent: 'deporte', position: 2 },
  { slug: 'bolsos', name: 'Bolsos', position: 4 },
  { slug: 'bolsos-de-mano', name: 'Bolsos de mano', parent: 'bolsos', position: 1 },
  { slug: 'bandoleras', name: 'Bandoleras', parent: 'bolsos', position: 2 },
  { slug: 'rinoneras', name: 'Riñoneras', parent: 'bolsos', position: 3 },
  { slug: 'outdoor', name: 'Outdoor', position: 5 },
  { slug: 'mochilas-trekking', name: 'Mochilas de trekking', parent: 'outdoor', position: 1 },
  { slug: 'hidratacion', name: 'Hidratación', parent: 'outdoor', position: 2 },
  { slug: 'accesorios', name: 'Accesorios', position: 6 },
  { slug: 'cartucheras', name: 'Cartucheras', parent: 'accesorios', position: 1 },
  { slug: 'loncheras', name: 'Loncheras', parent: 'accesorios', position: 2 },
  { slug: 'panaleras', name: 'Pañaleras', parent: 'accesorios', position: 3 },
  { slug: 'neceseres', name: 'Neceseres', parent: 'accesorios', position: 4 },
  { slug: 'billeteras', name: 'Billeteras', parent: 'accesorios', position: 5 },
]

const ABREV = {
  Negro: 'NEG', 'Azul marino': 'MAR', Gris: 'GRI', Guinda: 'GUI', Beige: 'BEI', 'Verde militar': 'VML',
  Azul: 'AZU', Rojo: 'ROJ', Rosado: 'ROS', Celeste: 'CEL', Camel: 'CAM', Plata: 'PLA', Grafito: 'GRA',
  Mostaza: 'MOS', Lila: 'LIL', Turquesa: 'TUR',
  'Cabina 20"': '20', 'Mediana 24"': '24', 'Grande 28"': '28',
}

/** Stock determinista por SKU: misma cifra en cada corrida, y algún agotado. */
function stockDe(sku) {
  let h = 0
  for (const c of sku) h = (h * 31 + c.charCodeAt(0)) % 9973
  return h % 17 === 0 ? 0 : 6 + (h % 55)
}

/**
 * Modelos: [código, nombre, categoría, marca, precio, precioAntes|null, colores, descripción, tamaños?]
 * Con `tamaños`, cada color se vende en los tres y el precio sube por tamaño.
 */
const MODELOS = [
  // Mochilas urbanas
  ['MU01', 'Mochila urbana Metro 20 L', 'mochilas-urbanas', 'porta', 149.9, 189.9, ['Negro', 'Azul marino', 'Gris', 'Guinda'], 'Mochila de diario con bolsillo antirrobo en la espalda, compartimento acolchado y tela repelente al agua. 20 litros.'],
  ['MU02', 'Mochila urbana Roll Top 24 L', 'mochilas-urbanas', 'urban-pro', 189.9, null, ['Negro', 'Verde militar', 'Mostaza'], 'Cierre enrollable que crece hasta 24 litros, correas acolchadas y base reforzada.'],
  ['MU03', 'Mochila urbana Minimal 18 L', 'mochilas-urbanas', 'porta', 129.9, null, ['Negro', 'Beige', 'Rosado'], 'Silueta limpia, bolsillo frontal oculto y espalda transpirable. Ideal para el día a día.'],
  ['MU04', 'Mochila urbana Commuter 22 L', 'mochilas-urbanas', 'urban-pro', 169.9, 219.9, ['Negro', 'Grafito', 'Azul'], 'Con puerto USB, bolsillo para botella y apertura tipo maleta.'],
  ['MU05', 'Mochila urbana Daypack 16 L', 'mochilas-urbanas', 'porta', 99.9, null, ['Negro', 'Celeste', 'Lila', 'Turquesa'], 'Ligera y plegable, para llevar lo justo. Tela ripstop.'],
  ['MU06', 'Mochila urbana Canvas 20 L', 'mochilas-urbanas', 'porta', 159.9, null, ['Camel', 'Verde militar', 'Negro'], 'Lona encerada con detalles en cuero sintético. Clásica y resistente.'],
  ['MU07', 'Mochila urbana Antirrobo 21 L', 'mochilas-urbanas', 'urban-pro', 199.9, 239.9, ['Negro', 'Gris', 'Azul marino'], 'Cierres ocultos, tela anticorte y puerto USB externo.'],
  // Mochilas laptop
  ['ML01', 'Mochila para laptop Executive 15.6"', 'mochilas-laptop', 'porta', 229.9, 279.9, ['Negro', 'Gris', 'Azul marino'], 'Compartimento acolchado para laptop de 15,6", organizador interno y correa para trolley.'],
  ['ML02', 'Mochila para laptop Slim 14"', 'mochilas-laptop', 'urban-pro', 179.9, null, ['Negro', 'Grafito'], 'Perfil delgado para laptop de 14", espalda acolchada y bolsillo RFID.'],
  ['ML03', 'Mochila para laptop Tech 17"', 'mochilas-laptop', 'urban-pro', 259.9, null, ['Negro', 'Azul marino', 'Gris'], 'Para laptops de hasta 17", con bolsillo para cargador y cables.'],
  ['ML04', 'Mochila para laptop Office 15"', 'mochilas-laptop', 'porta', 199.9, 249.9, ['Negro', 'Guinda', 'Beige'], 'Diseño sobrio para la oficina, con asa superior reforzada.'],
  ['ML05', 'Mochila para laptop Expandible 16"', 'mochilas-laptop', 'gunther', 289.9, null, ['Negro', 'Grafito', 'Plata'], 'Se expande 5 litros con un cierre perimetral. Tela balística.'],
  // Mochilas escolares
  ['ME01', 'Mochila escolar Primaria 18 L', 'mochilas-escolares', 'kiddo', 119.9, 149.9, ['Azul', 'Rosado', 'Turquesa', 'Lila'], 'Espalda ergonómica, bandas reflectivas y fondo impermeable.'],
  ['ME02', 'Mochila escolar Secundaria 25 L', 'mochilas-escolares', 'porta', 149.9, null, ['Negro', 'Azul marino', 'Gris', 'Guinda'], 'Dos compartimentos grandes y bolsillo para laptop de 15".'],
  ['ME03', 'Mochila escolar con ruedas', 'mochilas-escolares', 'kiddo', 179.9, 219.9, ['Azul', 'Rojo', 'Rosado'], 'Ruedas silenciosas y mango retráctil de aluminio. También se lleva a la espalda.'],
  ['ME04', 'Mochila escolar Inicial 10 L', 'mochilas-escolares', 'kiddo', 89.9, null, ['Celeste', 'Rosado', 'Mostaza'], 'Tamaño para los más pequeños, con nombre bordable y cierre fácil.'],
  // Maletas (color × tamaño)
  ['MA01', 'Maleta rígida Gramado', 'maletas', 'gunther', 349.9, 449.9, ['Azul marino', 'Negro', 'Plata'], 'Carcasa de policarbonato, cuatro ruedas dobles 360° y candado TSA integrado.', true],
  ['MA02', 'Maleta rígida Andes', 'maletas', 'porta', 299.9, null, ['Negro', 'Guinda', 'Grafito'], 'ABS ligero con interior forrado, correas de compresión y cierre de doble cursor.', true],
  ['MA03', 'Maleta blanda Viajera', 'maletas', 'porta', 279.9, 339.9, ['Negro', 'Azul marino'], 'Poliéster de alta densidad, bolsillos frontales y expansión del 20 %.', true],
  ['MA04', 'Maleta rígida Aero', 'maletas', 'gunther', 399.9, null, ['Plata', 'Celeste', 'Rosado'], 'Polipropileno ultraligero y resistente a impactos. Asa telescópica de tres alturas.', true],
  ['MA05', 'Maleta rígida Urban', 'maletas', 'porta', 329.9, 389.9, ['Negro', 'Verde militar'], 'Acabado texturizado antirayas y ruedas silenciosas.', true],
  ['MA06', 'Maleta rígida Kids', 'maletas', 'kiddo', 249.9, 299.9, ['Celeste', 'Rosado'], 'Para los pequeños viajeros: ligera, colorida y con candado de combinación.', true],
  // Bolsos de viaje
  ['BV01', 'Bolso de viaje Weekender 40 L', 'bolsos-de-viaje', 'porta', 199.9, 249.9, ['Negro', 'Camel', 'Azul marino'], 'Para escapadas de fin de semana: compartimento para zapatos y correa acolchada.'],
  ['BV02', 'Bolso de viaje con ruedas 60 L', 'bolsos-de-viaje', 'gunther', 289.9, null, ['Negro', 'Grafito'], 'Gran capacidad con ruedas y mango retráctil. Plegable.'],
  ['BV03', 'Bolso de viaje plegable 30 L', 'bolsos-de-viaje', 'porta', 89.9, null, ['Negro', 'Azul', 'Rojo'], 'Se pliega en su propio bolsillo. Perfecto como bolso extra.'],
  // Deporte
  ['MD01', 'Maletín deportivo Training 35 L', 'maletines-deportivos', 'trekker', 139.9, 169.9, ['Negro', 'Azul', 'Rojo'], 'Bolsillo ventilado para zapatillas y compartimento húmedo.'],
  ['MD02', 'Maletín deportivo Gym 25 L', 'maletines-deportivos', 'trekker', 109.9, null, ['Negro', 'Gris', 'Rosado'], 'Compacto, con bolsillo lateral para botella y asas acolchadas.'],
  ['MD03', 'Maletín deportivo Team 60 L', 'maletines-deportivos', 'trekker', 189.9, null, ['Negro', 'Azul marino'], 'Para equipos: gran capacidad, base rígida y correa de hombro.'],
  ['DP01', 'Mochila deportiva Run 12 L', 'mochilas-deportivas', 'trekker', 119.9, 149.9, ['Negro', 'Turquesa', 'Rojo'], 'Ajuste al cuerpo, reflectivos y bolsillo para el celular en el pecho.'],
  ['DP02', 'Mochila deportiva Bike 18 L', 'mochilas-deportivas', 'trekker', 159.9, null, ['Negro', 'Grafito', 'Mostaza'], 'Porta casco y cubierta para lluvia incluida.'],
  ['DP03', 'Mochila deportiva Gym 20 L', 'mochilas-deportivas', 'trekker', 129.9, null, ['Negro', 'Lila', 'Gris'], 'Compartimento separado para zapatillas y espalda ventilada.'],
  // Bolsos
  ['BM01', 'Bolso de mano Tote Ciudad', 'bolsos-de-mano', 'porta', 149.9, 189.9, ['Negro', 'Camel', 'Beige', 'Guinda'], 'Tote amplio con cierre, bolsillo para laptop de 13" y forro estampado.'],
  ['BM02', 'Bolso de mano Shopper', 'bolsos-de-mano', 'porta', 119.9, null, ['Negro', 'Beige', 'Verde militar'], 'Lona gruesa con asas de cuero sintético. Para todo el día.'],
  ['BM03', 'Bolso de mano Mini', 'bolsos-de-mano', 'porta', 99.9, null, ['Negro', 'Rosado', 'Celeste'], 'Pequeño y estructurado, con correa larga desmontable.'],
  ['BM04', 'Bolso de mano Tote Verano', 'bolsos-de-mano', 'porta', 89.9, null, ['Beige', 'Celeste', 'Rosado'], 'Tote ligero de algodón con bolsillo interior con cierre.'],
  ['BA01', 'Bandolera Urbana', 'bandoleras', 'urban-pro', 89.9, 109.9, ['Negro', 'Gris', 'Azul marino'], 'Para el celular, la billetera y las llaves, con bolsillo antirrobo.'],
  ['BA02', 'Bandolera Tablet 11"', 'bandoleras', 'urban-pro', 119.9, null, ['Negro', 'Grafito'], 'Compartimento acolchado para tablet de hasta 11".'],
  ['BA03', 'Bandolera Mensajero', 'bandoleras', 'porta', 139.9, null, ['Camel', 'Negro', 'Verde militar'], 'Estilo mensajero con solapa magnética.'],
  ['RI01', 'Riñonera Sport', 'rinoneras', 'trekker', 59.9, 79.9, ['Negro', 'Turquesa', 'Rojo', 'Mostaza'], 'Ajustable y resistente al agua, con bolsillo trasero oculto.'],
  ['RI02', 'Riñonera Urbana', 'rinoneras', 'urban-pro', 69.9, null, ['Negro', 'Beige', 'Grafito'], 'Se lleva a la cintura o cruzada. Dos compartimentos.'],
  // Outdoor
  ['OT01', 'Mochila de trekking Cumbre 45 L', 'mochilas-trekking', 'trekker', 349.9, 429.9, ['Verde militar', 'Negro', 'Azul'], 'Espalda regulable, cinturón lumbar acolchado y cubierta para lluvia.'],
  ['OT02', 'Mochila de trekking Sendero 30 L', 'mochilas-trekking', 'trekker', 259.9, null, ['Negro', 'Grafito', 'Rojo'], 'Para rutas de un día: bolsillos laterales y anclajes para bastones.'],
  ['OT03', 'Mochila de trekking Expedición 65 L', 'mochilas-trekking', 'trekker', 449.9, null, ['Verde militar', 'Negro'], 'Estructura interna de aluminio y acceso frontal al compartimento principal.'],
  ['HI01', 'Mochila de hidratación Trail 5 L', 'hidratacion', 'trekker', 149.9, 179.9, ['Negro', 'Turquesa', 'Mostaza'], 'Bolsa de agua de 2 L incluida y tubo con válvula de mordida.'],
  ['HI02', 'Mochila de hidratación Bike 10 L', 'hidratacion', 'trekker', 179.9, null, ['Negro', 'Rojo'], 'Bolsa de 3 L, bolsillo para herramientas y reflectivos.'],
  // Accesorios
  ['CA01', 'Cartuchera doble cierre', 'cartucheras', 'kiddo', 34.9, 44.9, ['Azul', 'Rosado', 'Negro', 'Lila'], 'Dos compartimentos para lápices, colores y reglas.'],
  ['CA02', 'Cartuchera organizadora', 'cartucheras', 'porta', 44.9, null, ['Negro', 'Gris', 'Celeste'], 'Se abre como libro, con elásticos para cada útil.'],
  ['CA03', 'Cartuchera simple', 'cartucheras', 'kiddo', 24.9, null, ['Rojo', 'Azul', 'Mostaza'], 'Práctica y lavable.'],
  ['LO01', 'Lonchera térmica Escolar', 'loncheras', 'kiddo', 59.9, 74.9, ['Azul', 'Rosado', 'Turquesa'], 'Aislante térmico que conserva el frío o el calor por horas.'],
  ['LO02', 'Lonchera térmica Oficina', 'loncheras', 'porta', 79.9, null, ['Negro', 'Gris', 'Beige'], 'Con dos niveles y bolsillo para cubiertos.'],
  ['PA01', 'Pañalera mochila Mamá', 'panaleras', 'porta', 189.9, 229.9, ['Negro', 'Gris', 'Beige', 'Rosado'], 'Cambiador incluido, bolsillos térmicos para biberones y correas para coche.'],
  ['PA02', 'Pañalera bolso Clásica', 'panaleras', 'porta', 159.9, null, ['Negro', 'Azul marino'], 'Bolso amplio con organizador interno y cambiador.'],
  ['NE01', 'Neceser de viaje colgante', 'neceseres', 'porta', 59.9, null, ['Negro', 'Gris', 'Azul marino'], 'Con gancho para colgar y bolsillos transparentes.'],
  ['NE02', 'Neceser transparente cabina', 'neceseres', 'porta', 29.9, null, ['Negro', 'Celeste'], 'Cumple con la norma de líquidos en cabina.'],
  ['BI01', 'Billetera RFID Slim', 'billeteras', 'urban-pro', 69.9, 89.9, ['Negro', 'Camel', 'Azul marino'], 'Protección RFID, ocho ranuras para tarjetas y billetera delgada.'],
  ['BI02', 'Billetera de viaje pasaporte', 'billeteras', 'porta', 59.9, null, ['Negro', 'Guinda', 'Camel'], 'Para pasaporte, boletos y tarjetas. Protección RFID.'],
]

/** Productos simples (sin variantes): accesorios de viaje. */
const SIMPLES = [
  ['AV01', 'Candado TSA de combinación', 'accesorios-de-viaje', 'gunther', 39.9, 49.9, 'Candado aprobado por la TSA, combinación de tres dígitos.'],
  ['AV02', 'Almohada de viaje viscoelástica', 'accesorios-de-viaje', 'porta', 69.9, null, 'Memory foam con funda lavable y bolsa de transporte.'],
  ['AV03', 'Balanza digital para equipaje', 'accesorios-de-viaje', 'gunther', 49.9, null, 'Pesa hasta 50 kg con precisión de 10 g.'],
  ['AV04', 'Set de etiquetas para equipaje x2', 'accesorios-de-viaje', 'porta', 24.9, null, 'Etiquetas de silicona con tarjeta de datos oculta.'],
  ['AV05', 'Organizadores de equipaje x4', 'accesorios-de-viaje', 'porta', 89.9, 109.9, 'Cubos de compresión en cuatro tamaños.'],
  ['AV06', 'Adaptador universal de enchufe', 'accesorios-de-viaje', 'gunther', 59.9, null, 'Para más de 150 países, con dos puertos USB.'],
]

const PLUS_TAMANO = { 'Cabina 20"': 0, 'Mediana 24"': 100, 'Grande 28"': 200 }
const r2 = (n) => Math.round(n * 100) / 100

export const PRODUCTS = [
  ...MODELOS.map(([code, name, cat, brand, price, compare, colores, desc, tamanos]) => {
    const sku = `PT-${code}`
    const variants = []
    for (const color of colores) {
      if (tamanos) {
        for (const t of TAMANOS) {
          variants.push({
            sku: `${sku}-${ABREV[color]}-${ABREV[t]}`,
            name: `${color} · ${t}`,
            price: r2(price + PLUS_TAMANO[t]),
            stock: stockDe(`${sku}-${color}-${t}`),
            axes: { color, tamano: t },
          })
        }
      } else {
        variants.push({ sku: `${sku}-${ABREV[color]}`, name: color, stock: stockDe(`${sku}-${color}`), axes: { color } })
      }
    }
    return {
      sku,
      name,
      cat,
      brand,
      price,
      ...(compare ? { compare } : {}),
      desc,
      variants,
      photo: `${name}, color ${colores[0].toLowerCase()}, e-commerce product photo on pure white background, front three-quarter view, soft studio light`,
    }
  }),
  ...SIMPLES.map(([code, name, cat, brand, price, compare, desc]) => ({
    sku: `PT-${code}`,
    name,
    cat,
    brand,
    price,
    ...(compare ? { compare } : {}),
    desc,
    stock: stockDe(`PT-${code}`) || 12,
    photo: `${name}, e-commerce product photo on pure white background, soft studio light`,
  })),
]

export const PROMOTIONS = [
  { code: 'cabina-30', name: '30 % en maletas', kind: 'percentage', percent: 30,
    desc: 'Rígidas y blandas, en todos los tamaños.', scope: { category: 'maletas' }, endsInDays: 4 },
  { code: 'escolar-20', name: 'Vuelta al cole: 20 % en mochilas escolares', kind: 'percentage', percent: 20,
    desc: 'Mochilas, cartucheras y loncheras para el nuevo año escolar.', scope: { category: 'mochilas-escolares' }, endsInDays: 12 },
  { code: 'cartucheras-2x1', name: 'Cartucheras: lleva 2, paga 1', kind: 'x_for_y', buy: 2, free: 1,
    desc: 'En la cartuchera doble cierre, en todos sus colores.', scope: { product: 'PT-CA01' }, endsInDays: 9 },
  { code: 'desde-299', name: 'S/ 30 de descuento desde S/ 299', kind: 'fixed_amount', amount: 30, minSubtotal: 299,
    desc: 'En toda la tienda, a partir de S/ 299 de compra.', scope: { all: true } },
  { code: 'bienvenida', name: 'Bienvenida: 10 % en tu primera compra', kind: 'percentage', percent: 10, coupon: 'BIENVENIDA',
    desc: 'Usa el cupón BIENVENIDA al pagar.', scope: { all: true }, perCustomer: 1 },
]

/** Almacenes: el centro de distribución y la tienda insignia. */
export const WAREHOUSES = [
  { code: 'CD-LURIN', name: 'Centro de distribución Lurín', city: 'Lima', region: 'Lima', isDefault: true, share: 0.8 },
  { code: 'TDA-JOCKEY', name: 'Tienda Jockey Plaza', city: 'Lima', region: 'Lima', isDefault: false, share: 0.2 },
]

const p = (text) => ({ type: 'paragraph', text })
const h = (text) => ({ type: 'heading', level: 2, text })
const l = (...items) => ({ type: 'list', items })

/** Páginas del pie: `landing` (Empresa) y `legal` (Legales). */
export const PAGES = [
  { slug: 'sobre-nosotros', title: 'Sobre nosotros', kind: 'landing', body: [
    p('Desde 2008 diseñamos mochilas, maletas y bolsos para quienes se mueven todos los días: al trabajo, a clases o al otro lado del mundo.'),
    h('Lo que nos mueve'),
    l('Diseño propio, pensado para la ciudad y el viaje.', 'Materiales resistentes y garantía real.', 'Atención cercana en tienda y en línea.'),
  ] },
  { slug: 'nuestras-tiendas', title: 'Nuestras tiendas', kind: 'landing', body: [
    p('Visítanos y prueba tu próxima mochila o maleta.'),
    l('Jockey Plaza · Av. Javier Prado Este 4200, Surco · 10:00 a.m. a 10:00 p.m.', 'Real Plaza Salaverry · Av. Salaverry 2370, Jesús María · 10:00 a.m. a 10:00 p.m.', 'Mall Aventura Arequipa · Av. Porongoche 500 · 10:00 a.m. a 9:00 p.m.'),
  ] },
  { slug: 'distribuidor-porta', title: 'Distribuidor Porta', kind: 'landing', body: [
    p('¿Tienes una tienda o un negocio y quieres vender Porta? Te ofrecemos precios por volumen, material de exhibición y capacitación.'),
    p('Escríbenos a ventas@porta.demo con el nombre de tu negocio, tu RUC y la ciudad donde vendes.'),
  ] },
  { slug: 'trabaja-con-nosotros', title: 'Trabaja con nosotros', kind: 'landing', body: [
    p('Buscamos personas que disfruten atender, organizar y viajar. Envíanos tu CV indicando el puesto y la ciudad.'),
    l('Asesores de venta en tienda.', 'Almacén y despacho.', 'Atención al cliente en línea.'),
  ] },
  { slug: 'nuestro-blog', title: 'Nuestro blog', kind: 'landing', body: [
    h('Cómo elegir la maleta de cabina ideal'),
    p('Revisa las medidas de tu aerolínea: la mayoría acepta hasta 55 × 35 × 25 cm. Prefiere cuatro ruedas dobles para moverte en aeropuertos y un candado TSA para viajes a Estados Unidos.'),
    h('Mochila escolar: cuidado con el peso'),
    p('Lo recomendable es que no supere el 10 % del peso del niño. Ajusta las correas para que quede a la altura de la cintura.'),
  ] },
  { slug: 'contactanos', title: 'Contáctanos', kind: 'landing', body: [
    p('WhatsApp: +51 970 510 698 (atención solo por mensajes, no llamadas).'),
    p('Correo: ventas@porta.demo'),
    p('Lunes a viernes de 9:00 a.m. a 6:00 p.m. y sábados de 9:00 a.m. a 1:00 p.m.'),
  ] },
  { slug: 'preguntas-frecuentes', title: 'Preguntas frecuentes', kind: 'legal', body: [
    h('¿Cuánto demora mi pedido?'),
    p('En Lima, de 1 a 3 días hábiles. En provincias, de 3 a 7 días hábiles.'),
    h('¿Puedo pagar en cuotas?'),
    p('Sí, hasta 6 cuotas sin intereses con tarjetas de crédito participantes en compras desde S/ 199.'),
    h('¿Puedo recoger en tienda?'),
    p('Sí, elige «Recojo en tienda» al pagar y te avisaremos cuando esté listo.'),
  ] },
  { slug: 'politicas-de-despacho', title: 'Políticas de despacho', kind: 'legal', body: [
    p('Despachamos a todo el Perú. El envío es gratuito en compras desde S/ 199; por debajo de ese monto, el costo se calcula al pagar según el distrito o la ciudad.'),
    l('Lima Metropolitana: 1 a 3 días hábiles.', 'Provincias: 3 a 7 días hábiles.', 'Los pedidos confirmados después de la 1:00 p.m. se procesan al día hábil siguiente.'),
  ] },
  { slug: 'politicas-de-garantia', title: 'Políticas de garantía', kind: 'legal', body: [
    p('Nuestros productos tienen garantía contra defectos de fabricación: 1 año en mochilas y bolsos, y 3 años en maletas.'),
    p('La garantía no cubre el desgaste normal, el mal uso ni los daños causados por aerolíneas. Para hacerla efectiva, presenta tu comprobante de compra.'),
  ] },
  { slug: 'politicas-de-cambios-y-devoluciones', title: 'Políticas de cambios y devoluciones', kind: 'legal', body: [
    p('Puedes cambiar o devolver tu producto dentro de los 30 días posteriores a la compra, sin uso, con etiquetas y en su empaque original.'),
    l('Los cambios por talla o color son gratuitos.', 'El reembolso se realiza por el mismo medio de pago en un plazo de hasta 15 días hábiles.', 'Los productos en liquidación no tienen cambio, salvo por falla de fábrica.'),
  ] },
  { slug: 'politica-de-privacidad', title: 'Política de privacidad', kind: 'legal', body: [
    p('PRO BAGS PERÚ SAC trata tus datos personales conforme a la Ley N.º 29733, Ley de Protección de Datos Personales, y su reglamento.'),
    p('Usamos tus datos para procesar tus pedidos, atender tus consultas y, si lo aceptas, enviarte novedades. Puedes ejercer tus derechos de acceso, rectificación, cancelación y oposición escribiendo a ventas@porta.demo.'),
  ] },
  { slug: 'politica-de-cookies', title: 'Política de cookies', kind: 'legal', body: [
    p('Usamos cookies propias para que la tienda funcione (carrito y sesión) y para entender cómo se usa. Puedes borrarlas o bloquearlas desde tu navegador.'),
  ] },
  { slug: 'terminos-y-condiciones', title: 'Términos y condiciones', kind: 'legal', body: [
    p('Al comprar en esta tienda aceptas estos términos. Los precios incluyen IGV y están expresados en soles. Las promociones son válidas hasta agotar stock o hasta la fecha indicada.'),
    p('PRO BAGS PERÚ SAC, RUC 20612345671, Av. Javier Prado Este 4200, Santiago de Surco, Lima.'),
  ] },
]
