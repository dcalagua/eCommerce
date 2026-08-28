-- =============================================================================
-- P12-SaaS · 1/7 — La OFERTA de entrega: zonas, metodos, tarifas, ventanas y
--                  puntos de recojo
--
-- ## Que problema resuelve esta migracion
--
-- Hasta P11 `orders.shipping_total` existia y valia SIEMPRE cero, y el gancho
-- `alwaysDeliverable` del pipeline (P07) devolvia «entregable» para cualquier
-- direccion del mundo. Las dos cosas eran la verdad —no habia dominio
-- logistico— y las dos dejan de serlo aqui.
--
-- La decision que gobierna la fase entera cabe en una frase, y es la hermana de
-- la que goberno P09:
--
--   **El dominio de pedidos no puede enterarse de que existe un transportista.**
--
-- Por eso `orders` no gana ni una columna de logistica: ni `carrier`, ni
-- `tracking_number`, ni `delivery_method_id`. Un envio apunta al pedido; el
-- pedido no apunta al envio. Lo unico que el pedido gana en esta fase es el
-- IMPORTE del envio, que ya tenia columna desde P02 y que es dinero del pedido
-- —no del operador— igual que el impuesto lo es aunque lo cobre el estado.
--
-- ## Cinco piezas, y por que cinco
--
--   delivery_zones     DONDE se entrega. Cobertura por pais, region y prefijo
--                      de codigo postal. Es lo unico que sabe decir «ahi no
--                      llegamos» sin nombrar a ningun operador.
--   delivery_methods   COMO llega. Envio, recojo en tienda, reparto propio o
--                      entrega digital: cuatro ESTRATEGIAS del mismo checkout,
--                      no cuatro checkouts (regla 7 de la fase).
--   delivery_rates     CUANTO cuesta. Un renglon por zona y tramo, con base,
--                      por linea, por peso y umbral de gratuidad. La tarifa es
--                      un DATO del comercio: no hay ni un importe en el codigo.
--   pickup_points      DONDE se recoge. Tienda fisica, oficina o punto de un
--                      tercero. Puede colgar de un almacen, y entonces el
--                      abastecimiento sale de ahi.
--   delivery_windows   CUANDO. Franjas por dia de la semana, con aforo y hora
--                      de corte.
--
-- ## Lo que NO esta aqui
--
-- El transportista. `delivery_methods.provider_code` apunta al catalogo GLOBAL
-- `integration_providers` de familia `logistics`, que es una fila y no un
-- `enum`: dar de alta un operador no es desplegar la aplicacion. Y un metodo de
-- recojo NO puede tener proveedor —lo impide un CHECK—, porque nadie transporta
-- lo que el comprador va a buscar.
--
-- ## Reuso deliberado: las guardas de P09
--
-- `ebim.jsonb_is_card_safe` (migracion 120000) valida tambien la configuracion
-- publica de un metodo de entrega. No es que aqui se espere un numero de
-- tarjeta: es que la funcion prohibe a la vez datos de tarjeta Y credenciales
-- (`api_key`, `client_secret`, `token`...), y una integracion de transporte es
-- exactamente donde alguien pegaria la clave del operador «solo para probar».
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El vocabulario. Enums y no texto libre, misma razon que P08 y P09: un
-- valor que se puede escribir mal es un valor que alguien escribira mal, y
-- entonces el filtro del listado deja de encontrar entregas que si existen.
-- ---------------------------------------------------------------------------

-- La ESTRATEGIA de entrega. Es lo que hace que «recojo en oficina» no sea un
-- checkout aparte sino una opcion mas del mismo: las cuatro comparten
-- cotizacion, ventana y cola de preparacion, y solo se diferencian en si hace
-- falta direccion y en si hay alguien que transporte.
create type public.delivery_strategy as enum (
  'ship',           -- lo lleva un transportista a una direccion
  'pickup',         -- lo recoge el comprador en un punto
  'local_delivery', -- reparto propio del comercio
  'digital'         -- no se mueve nada: licencia, cupon, descarga
);

-- De DONDE sale la mercancia cuando hay varios almacenes. Es una regla
-- configurable del metodo y no una constante del producto (regla 4 de la fase).
create type public.sourcing_strategy as enum (
  -- El orden que la tienda declaro en `store_warehouses` (P06). Sirve para el
  -- comercio que quiere agotar primero un almacen concreto.
  'store_priority',
  -- El primer almacen, en ese mismo orden, que puede servir el pedido ENTERO.
  -- Evita partir un pedido en dos envios cuando hay uno que lo tiene todo.
  'single_warehouse_atp'
);

-- ---------------------------------------------------------------------------
-- 1 bis · La guarda de las listas de texto.
--
-- Vive en `ebim` y es IMMUTABLE porque la evalua un CHECK, que no admite otra
-- cosa —ni subconsultas, y por eso esto es una funcion y no un `not exists`
-- escrito dentro de la restriccion—. No consulta ninguna tabla: es pura sobre
-- el valor que se intenta escribir.
--
-- Lo que impide, y no es teorico: un array con una cadena VACIA dentro encaja
-- con cualquier prefijo postal y no lo parece al mirarlo. Una zona asi cobra
-- tarifa local a todo el pais y nadie sabe por que.
-- ---------------------------------------------------------------------------
create or replace function ebim.clean_text_array(
  p_values    text[],
  p_max_items integer,
  p_max_len   integer
)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_values is null
      or (coalesce(array_length(p_values, 1), 0) <= p_max_items
          and not exists (
            select 1 from unnest(p_values) as v(item)
            where v.item is null
               or btrim(v.item) = ''
               or char_length(v.item) > p_max_len));
$fn$;

revoke execute on function ebim.clean_text_array(text[], integer, integer) from public;
grant execute on function ebim.clean_text_array(text[], integer, integer)
  to anon, authenticated, service_role;

comment on function ebim.clean_text_array(text[], integer, integer) is
  'Guarda de listas de texto para CHECKs: sin nulos, sin cadenas vacias y con tope de elementos y de longitud.';

-- ---------------------------------------------------------------------------
-- 1 ter · El PESO, que es un atributo de logistica y hasta hoy no existia.
--
-- Sin peso no hay tarifa por kilo, y una tarifa por kilo es la mitad de las
-- tarifas reales de esta region. Va en el catalogo y no en el metodo de entrega
-- porque es una propiedad de LO QUE SE VENDE: el mismo producto pesa lo mismo
-- lo lleve quien lo lleve.
--
-- Nullable a proposito: `null` NO es cero. Un catalogo que todavia no declara
-- pesos no puede cotizar por kilo, y tratarlo como cero cobraria envio gratis
-- de un palet. La cotizacion distingue los dos casos (migracion 150200).
--
-- En variante ademas del producto porque dos tallas de la misma prenda no pesan
-- igual, y con una sola columna habria que elegir entre mentir en una o
-- duplicar el producto.
-- ---------------------------------------------------------------------------
alter table public.products
  add column shipping_weight numeric(12,3),
  add constraint products_shipping_weight_positive
    check (shipping_weight is null or shipping_weight >= 0);

alter table public.product_variants
  add column shipping_weight numeric(12,3),
  add constraint product_variants_shipping_weight_positive
    check (shipping_weight is null or shipping_weight >= 0);

comment on column public.products.shipping_weight is
  'Peso logistico en la unidad del comercio. NULL no es cero: es "no declarado", y entonces no se puede cotizar por peso.';
comment on column public.product_variants.shipping_weight is
  'Peso de ESTA variante. Manda sobre el del producto; NULL hereda el del producto.';

-- ---------------------------------------------------------------------------
-- 2 · delivery_zones — donde se entrega.
--
-- Tres criterios en cascada y NO uno: pais, region y prefijo de codigo postal.
-- Gana el prefijo mas LARGO, igual que en una tabla de rutas: una zona
-- «Lima metropolitana» con prefijos de cinco digitos tiene que ganarle a una
-- zona «Peru» con el pais a secas, o la tarifa nacional se cobraria dentro de
-- la ciudad.
--
-- `regions` y `postal_prefixes` son arrays y no tablas hijas a proposito: son
-- una LISTA de valores sin identidad propia —nadie va a apuntar a «el prefijo
-- 15001»— y sacarlas a una tabla obligaria a dos consultas y a un join en la
-- ruta caliente de la cotizacion.
-- ---------------------------------------------------------------------------
create table public.delivery_zones (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  name            text        not null,
  -- ISO 3166-1 alpha-2. Obligatorio: una zona sin pais no se puede comparar
  -- con una direccion, y «cualquier pais» es una tienda sin cobertura definida.
  country         char(2)     not null,
  -- Vacio = TODA la region del pais. Se compara en minusculas y sin acentos.
  regions         text[]      not null default '{}',
  -- Vacio = todo el pais/region. Con valores, gana el prefijo mas largo.
  postal_prefixes text[]      not null default '{}',
  -- Desempate cuando dos zonas igual de especificas encajan. Menor gana.
  priority        integer     not null default 100,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint delivery_zones_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint delivery_zones_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint delivery_zones_country_fmt check (country ~ '^[A-Z]{2}$'),
  constraint delivery_zones_priority check (priority between 0 and 9999),
  -- Un array con una cadena vacia dentro encaja con todo y no lo parece. Se
  -- rechaza en la base y no en el formulario: el formulario no es la autoridad.
  constraint delivery_zones_regions_shape check (ebim.clean_text_array(regions, 200, 120)),
  constraint delivery_zones_prefixes_shape
    check (ebim.clean_text_array(postal_prefixes, 500, 12)),
  constraint delivery_zones_code_unique unique (store_id, code),
  constraint delivery_zones_store_key unique (id, store_id),
  constraint delivery_zones_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index delivery_zones_tenant on public.delivery_zones (organization_id, company_id);
create index delivery_zones_store_active
  on public.delivery_zones (store_id, country, priority) where is_active;

create trigger delivery_zones_set_updated_at before update on public.delivery_zones
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3 · delivery_methods — como llega.
--
-- `provider_code` es NULLABLE y lo es a proposito, exactamente por la misma
-- razon que en `payment_methods`: el reparto propio y el recojo en tienda son
-- formas de entrega reales que no tienen operador detras, y en el comercio de
-- esta region se usan mas que el courier.
--
-- La FK compuesta contra `(code, kind)` exige que el proveedor sea de familia
-- `logistics`. Es el mismo truco del PIM y de pagos: columna denormalizada +
-- CHECK + clave de apoyo del padre. Sin ella se podria configurar una pasarela
-- de cobro como transportista y el error saldria en produccion.
-- ---------------------------------------------------------------------------
create table public.delivery_methods (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  -- Codigo del TENANT, no del producto: "express", "recojo-tienda", "moto".
  code            text        not null,
  strategy        public.delivery_strategy not null default 'ship',
  display_name    text        not null,
  description     text,
  -- Operador del catalogo GLOBAL. NULL = lo lleva el comercio o lo recoge el
  -- comprador. Ninguna marca vive en este esquema: esto es una FK a una fila.
  provider_code   text,
  -- Denormalizada para que la FK compuesta pueda exigir familia `logistics`.
  provider_kind   public.integration_kind not null default 'logistics',
  -- De donde sale la mercancia. Regla CONFIGURABLE, no constante del producto.
  sourcing        public.sourcing_strategy not null default 'store_priority',
  -- Plazo comprometido, en dias habiles. Es lo que se le promete al comprador y
  -- lo que congela el pedido; el operador puede tardar otra cosa y entonces la
  -- diferencia es medible, que es justo el punto de guardarlo.
  lead_time_min_days integer  not null default 1,
  lead_time_max_days integer  not null default 3,
  -- ¿Hay que elegir franja? El comercio lo decide por metodo: un courier
  -- nacional no tiene franjas y un reparto propio de la ciudad si.
  requires_window boolean     not null default false,
  is_active       boolean     not null default false,
  position        integer     not null default 100,
  -- Config PUBLICA: lo que la vitrina pinta y lo que el adaptador necesita que
  -- no sea secreto (codigo de servicio, texto de aviso, peso maximo). El CHECK
  -- rechaza credenciales y datos de tarjeta a cualquier profundidad (P09).
  public_config   jsonb       not null default '{}'::jsonb,
  -- Instrucciones para el comprador ("presenta tu DNI en caja").
  instructions    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint delivery_methods_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint delivery_methods_name_len check (char_length(btrim(display_name)) between 1 and 120),
  constraint delivery_methods_desc_len
    check (description is null or char_length(description) <= 1000),
  constraint delivery_methods_instructions_len
    check (instructions is null or char_length(instructions) <= 2000),
  constraint delivery_methods_position check (position between 0 and 9999),
  constraint delivery_methods_provider_kind check (provider_kind = 'logistics'),
  constraint delivery_methods_lead_time check (
    lead_time_min_days between 0 and 365
    and lead_time_max_days between 0 and 365
    and lead_time_max_days >= lead_time_min_days
  ),
  -- Nadie transporta lo que el comprador va a buscar, y nadie transporta una
  -- descarga. Permitir un operador aqui produciria un envio que ningun
  -- transportista puede recoger y que se quedaria en `created` para siempre.
  constraint delivery_methods_provider_shape check (
    provider_code is null or strategy = 'ship'
  ),
  -- Una entrega digital no tiene franja horaria que elegir.
  constraint delivery_methods_window_shape check (
    not requires_window or strategy <> 'digital'
  ),
  constraint delivery_methods_config_safe check (ebim.jsonb_is_card_safe(public_config)),
  constraint delivery_methods_config_shape check (jsonb_typeof(public_config) = 'object'),
  constraint delivery_methods_code_unique unique (store_id, code),
  -- Clave de apoyo para las FK compuestas de los hijos.
  constraint delivery_methods_store_key unique (id, store_id),
  constraint delivery_methods_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint delivery_methods_provider_fk foreign key (provider_code, provider_kind)
    references public.integration_providers (code, kind) on delete restrict
);

create index delivery_methods_tenant on public.delivery_methods (organization_id, company_id);
create index delivery_methods_store_active
  on public.delivery_methods (store_id, position) where is_active;

create trigger delivery_methods_set_updated_at before update on public.delivery_methods
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4 · delivery_rates — cuanto cuesta.
--
-- La tarifa es un DATO del comercio y no una formula en el codigo. Un renglon
-- combina cuatro sumandos que cubren, juntos, casi toda tarifa real:
--
--   base  +  por linea  +  por kilo  +  gratis por encima de X
--
-- `zone_id` NULL significa «cualquier zona cubierta por el metodo». Es lo que
-- permite la tarifa plana nacional sin obligar a declarar una zona por
-- departamento, que es la configuracion que nadie mantiene.
--
-- Los tramos (`min_subtotal`/`max_subtotal`, `min_weight`/`max_weight`) se
-- solapan a proposito: si dos renglones encajan gana el de menor `priority`, y
-- a igualdad, el mas caro NO —el mas ESPECIFICO, es decir el que tiene zona—.
-- Elegir el mas barato invitaria a dejar renglones olvidados que abaratan; la
-- regla explicita es la unica que se puede depurar.
-- ---------------------------------------------------------------------------
create table public.delivery_rates (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,
  company_id         uuid        not null,
  store_id           uuid        not null,
  delivery_method_id uuid        not null,
  -- NULL = vale para toda zona que el metodo cubra.
  zone_id            uuid,
  currency           char(3)     not null,
  base_amount        numeric(14,2) not null default 0,
  per_item_amount    numeric(14,2) not null default 0,
  -- Por unidad de peso del pedido. El peso sale del catalogo, no del navegador.
  per_weight_amount  numeric(14,2) not null default 0,
  -- Umbral de gratuidad. NULL = nunca es gratis por importe.
  free_over_subtotal numeric(14,2),
  -- Tramo por importe del pedido. NULL en cualquiera de los dos = sin limite.
  min_subtotal       numeric(14,2),
  max_subtotal       numeric(14,2),
  -- Tramo por peso. Es lo que hace que un bulto de 40 kg no viaje a tarifa de
  -- sobre: sin `max_weight` no hay forma de decir «esto ya no entra».
  min_weight         numeric(12,3),
  max_weight         numeric(12,3),
  priority           integer     not null default 100,
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint delivery_rates_currency_fmt check (currency ~ '^[A-Z]{3}$'),
  constraint delivery_rates_amounts_non_negative check (
    base_amount >= 0 and per_item_amount >= 0 and per_weight_amount >= 0
    and (free_over_subtotal is null or free_over_subtotal >= 0)
  ),
  constraint delivery_rates_subtotal_band check (
    (min_subtotal is null or min_subtotal >= 0)
    and (max_subtotal is null or max_subtotal >= 0)
    and (min_subtotal is null or max_subtotal is null or max_subtotal >= min_subtotal)
  ),
  constraint delivery_rates_weight_band check (
    (min_weight is null or min_weight >= 0)
    and (max_weight is null or max_weight >= 0)
    and (min_weight is null or max_weight is null or max_weight >= min_weight)
  ),
  constraint delivery_rates_priority check (priority between 0 and 9999),
  constraint delivery_rates_method_fk foreign key (delivery_method_id, store_id)
    references public.delivery_methods (id, store_id) on delete cascade,
  constraint delivery_rates_zone_fk foreign key (zone_id, store_id)
    references public.delivery_zones (id, store_id) on delete cascade,
  constraint delivery_rates_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index delivery_rates_tenant on public.delivery_rates (organization_id, company_id);
create index delivery_rates_method
  on public.delivery_rates (delivery_method_id, priority) where is_active;
create index delivery_rates_zone on public.delivery_rates (zone_id) where zone_id is not null;

create trigger delivery_rates_set_updated_at before update on public.delivery_rates
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5 · pickup_points — donde se recoge.
--
-- `warehouse_id` es el enlace con P06 y es lo que hace que «recojo en tienda»
-- no sea una etiqueta: si el punto cuelga de un almacen, la reserva y la salida
-- de existencia se hacen CONTRA ESE ALMACEN, y no contra el primero de la lista
-- de la tienda. Sin ese enlace, el comprador recogeria en un sitio la mercancia
-- que se descontó de otro.
-- ---------------------------------------------------------------------------
create table public.pickup_points (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  code            text        not null,
  name            text        not null,
  -- Direccion PUBLICA del punto: la ve el comprador antes de comprar.
  address         jsonb       not null default '{}'::jsonb,
  -- Zona a la que pertenece, si el comercio segmenta por cobertura.
  zone_id         uuid,
  -- Almacen del que sale lo que se recoge aqui. NULL = el de siempre.
  warehouse_id    uuid,
  contact_phone   text,
  -- Horario publicable. Texto estructurado, no HTML: lo pinta el design system.
  opening_hours   jsonb       not null default '{}'::jsonb,
  is_active       boolean     not null default false,
  position        integer     not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pickup_points_code_fmt check (code ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  constraint pickup_points_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint pickup_points_phone_len
    check (contact_phone is null or char_length(btrim(contact_phone)) between 6 and 40),
  constraint pickup_points_position check (position between 0 and 9999),
  constraint pickup_points_address_shape check (jsonb_typeof(address) = 'object'),
  constraint pickup_points_hours_shape check (jsonb_typeof(opening_hours) = 'object'),
  constraint pickup_points_code_unique unique (store_id, code),
  constraint pickup_points_store_key unique (id, store_id),
  constraint pickup_points_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint pickup_points_zone_fk foreign key (zone_id, store_id)
    references public.delivery_zones (id, store_id) on delete set null,
  -- El almacen se ata por el TENANT y no por la tienda: un almacen sirve a
  -- varias tiendas de la misma sociedad (P06) y exigir la tienda romperia ese
  -- caso. Lo que no puede pasar es que sea de otra sociedad.
  constraint pickup_points_warehouse_fk foreign key (warehouse_id, organization_id, company_id)
    references public.warehouses (id, organization_id, company_id) on delete set null
);

create index pickup_points_tenant on public.pickup_points (organization_id, company_id);
create index pickup_points_store_active
  on public.pickup_points (store_id, position) where is_active;
create index pickup_points_warehouse
  on public.pickup_points (warehouse_id) where warehouse_id is not null;

create trigger pickup_points_set_updated_at before update on public.pickup_points
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6 · delivery_windows — cuando.
--
-- Una franja pertenece SIEMPRE a un metodo; `pickup_point_id` la estrecha a un
-- punto concreto cuando cada local abre a su hora. `capacity` es el numero de
-- entregas que caben en esa franja y `cutoff_minutes` cuanto antes hay que
-- pedirla: las dos son propiedades de la operacion, no del calendario, y sin
-- ellas una franja es solo texto.
--
-- No hay fecha: la franja es SEMANAL y la fecha concreta la calcula la
-- cotizacion a partir del plazo del metodo. Guardar fechas obligaria a generar
-- filas hasta el infinito o a que la tienda dejara de tener franjas un martes.
-- ---------------------------------------------------------------------------
create table public.delivery_windows (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,
  company_id         uuid        not null,
  store_id           uuid        not null,
  delivery_method_id uuid        not null,
  pickup_point_id    uuid,
  -- 0 = domingo, como `extract(dow)`. Se documenta porque las dos convenciones
  -- existen y elegir mal desplaza toda la semana un dia.
  weekday            smallint    not null,
  starts_at          time        not null,
  ends_at            time        not null,
  -- Entregas que caben. NULL = sin tope declarado.
  capacity           integer,
  -- Minutos de antelacion minima. 0 = se puede pedir hasta que empieza.
  cutoff_minutes     integer     not null default 0,
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint delivery_windows_weekday check (weekday between 0 and 6),
  constraint delivery_windows_range check (ends_at > starts_at),
  constraint delivery_windows_capacity check (capacity is null or capacity between 1 and 100000),
  constraint delivery_windows_cutoff check (cutoff_minutes between 0 and 20160),
  constraint delivery_windows_method_fk foreign key (delivery_method_id, store_id)
    references public.delivery_methods (id, store_id) on delete cascade,
  constraint delivery_windows_point_fk foreign key (pickup_point_id, store_id)
    references public.pickup_points (id, store_id) on delete cascade,
  constraint delivery_windows_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index delivery_windows_tenant on public.delivery_windows (organization_id, company_id);
create index delivery_windows_method
  on public.delivery_windows (delivery_method_id, weekday, starts_at) where is_active;

-- `nulls not distinct`: sin esto, dos franjas identicas «sin punto de recojo»
-- serian filas distintas para el indice y el comercio acabaria con la misma
-- franja duplicada tres veces sin que nada se queje.
create unique index delivery_windows_slot_key on public.delivery_windows
  (delivery_method_id, pickup_point_id, weekday, starts_at) nulls not distinct;

create trigger delivery_windows_set_updated_at before update on public.delivery_windows
  for each row execute function ebim.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7 · RLS. Default deny, `force`, y el comprador solo ve lo publicable.
--
-- Las cinco son CONFIGURACION del comercio, no dinero ni bitacora, asi que el
-- backoffice las escribe directamente con rol `owner`/`admin` — igual que
-- `payment_methods` en P09. Lo que se mueve solo por comando es el DESPACHO,
-- que llega en la migracion siguiente.
-- ---------------------------------------------------------------------------
alter table public.delivery_zones    enable row level security;
alter table public.delivery_zones    force  row level security;
alter table public.delivery_methods  enable row level security;
alter table public.delivery_methods  force  row level security;
alter table public.delivery_rates    enable row level security;
alter table public.delivery_rates    force  row level security;
alter table public.pickup_points     enable row level security;
alter table public.pickup_points     force  row level security;
alter table public.delivery_windows  enable row level security;
alter table public.delivery_windows  force  row level security;

revoke all on public.delivery_zones, public.delivery_methods, public.delivery_rates,
              public.pickup_points, public.delivery_windows
  from public, anon, authenticated;

grant all on public.delivery_zones, public.delivery_methods, public.delivery_rates,
             public.pickup_points, public.delivery_windows
  to service_role;

grant select, insert, update, delete
  on public.delivery_zones, public.delivery_methods, public.delivery_rates,
     public.pickup_points, public.delivery_windows
  to authenticated;

-- El comprador anonimo ve QUE opciones hay y como se llaman. Ni el proveedor,
-- ni la estrategia de abastecimiento, ni la configuracion: eso es informacion
-- del comercio, no de la compra. Las TARIFAS no se conceden a `anon` en
-- absoluto — el precio de su envio se lo dice la cotizacion, ya resuelto para
-- su direccion, y la tabla entera de tarifas es la politica comercial.
grant select (id, store_id, code, strategy, display_name, description, position,
              instructions, lead_time_min_days, lead_time_max_days, requires_window)
  on public.delivery_methods to anon;
grant select (id, store_id, code, name, address, zone_id, contact_phone,
              opening_hours, position)
  on public.pickup_points to anon;
grant select (id, store_id, delivery_method_id, pickup_point_id, weekday,
              starts_at, ends_at, cutoff_minutes)
  on public.delivery_windows to anon;

create policy delivery_zones_select_member on public.delivery_zones
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));
create policy delivery_zones_write_admin on public.delivery_zones
  for all to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy delivery_methods_select_member on public.delivery_methods
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));
create policy delivery_methods_write_admin on public.delivery_methods
  for all to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));
create policy delivery_methods_select_public on public.delivery_methods
  for select to anon
  using (
    is_active
    and exists (
      select 1 from public.stores s
      where s.id = delivery_methods.store_id and s.status = 'active'
    )
  );

create policy delivery_rates_select_member on public.delivery_rates
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));
create policy delivery_rates_write_admin on public.delivery_rates
  for all to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));

create policy pickup_points_select_member on public.pickup_points
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));
create policy pickup_points_write_admin on public.pickup_points
  for all to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));
create policy pickup_points_select_public on public.pickup_points
  for select to anon
  using (
    is_active
    and exists (
      select 1 from public.stores s
      where s.id = pickup_points.store_id and s.status = 'active'
    )
  );

create policy delivery_windows_select_member on public.delivery_windows
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));
create policy delivery_windows_write_admin on public.delivery_windows
  for all to authenticated
  using      (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]))
  with check (ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[]));
create policy delivery_windows_select_public on public.delivery_windows
  for select to anon
  using (
    is_active
    and exists (
      select 1
      from public.delivery_methods m
      join public.stores s on s.id = m.store_id
      where m.id = delivery_windows.delivery_method_id
        and m.is_active
        and s.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- 8 · La vista publica de opciones de entrega.
--
-- `security_invoker`: no amplia ni un permiso, se apoya en las policies `to
-- anon` y en el GRANT por columna de arriba. Existe para que la vitrina pueda
-- PINTAR las opciones antes de tener direccion —cuando todavia no hay precio
-- que calcular— sin abrirle la tabla entera.
-- ---------------------------------------------------------------------------
create view public.public_delivery_methods
with (security_invoker = on) as
select
  m.id       as delivery_method_id,
  m.store_id,
  m.code,
  m.strategy,
  m.display_name,
  m.description,
  m.instructions,
  m.position,
  m.lead_time_min_days,
  m.lead_time_max_days,
  m.requires_window
from public.delivery_methods m;

revoke all on public.public_delivery_methods from public;
grant select on public.public_delivery_methods to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9 · Comentarios: la parte del contrato que se lee desde psql.
-- ---------------------------------------------------------------------------
comment on table public.delivery_zones is
  'Cobertura de entrega por pais, region y prefijo postal. Gana el prefijo mas largo; a igualdad, menor priority.';
comment on table public.delivery_methods is
  'Como llega el pedido. Cuatro estrategias del MISMO checkout: recojo y reparto no son un checkout aparte.';
comment on column public.delivery_methods.provider_code is
  'NULL = sin operador (recojo, reparto propio, digital). Solo la estrategia `ship` admite transportista.';
comment on column public.delivery_methods.sourcing is
  'De que almacen sale la mercancia. Regla configurable del metodo, no una constante del producto.';
comment on table public.delivery_rates is
  'Tarifa como DATO del comercio: base + por linea + por peso + umbral de gratuidad, por zona y tramo. Ni un importe en el codigo.';
comment on table public.pickup_points is
  'Puntos de recojo. Si cuelgan de un almacen, la existencia se reserva y sale de ESE almacen.';
comment on table public.delivery_windows is
  'Franjas SEMANALES con aforo y hora de corte. La fecha concreta la calcula la cotizacion desde el plazo del metodo.';
comment on view public.public_delivery_methods is
  'Opciones de entrega publicables de una tienda activa. Sin operador, sin abastecimiento y sin tarifas.';
