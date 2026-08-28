-- =============================================================================
-- P11-SaaS · 1/5 — CMS: paginas, bloques administrables y contenido enriquecido
--                  SIN ejecucion de codigo del tenant.
--
-- El encargo de la fase se resume en una frase: «el tenant cambia contenido sin
-- deploy y sin ejecutar codigo arbitrario». Las dos mitades tiran en direcciones
-- opuestas —cuanto mas libre es el contenido, mas cerca esta de ser codigo— y
-- todo el modelo de aqui abajo es donde se traza la raya.
--
-- ## Las cuatro decisiones que gobiernan este archivo
--
-- 1. **El bloque tiene TIPO cerrado y columnas tipadas, no `config jsonb`.**
--    Misma decision que P10 tomo con `promotion_scopes` y por el mismo motivo:
--    un `jsonb` con ids dentro no tiene FK, asi que una coleccion que apunta a
--    un producto borrado se queda viva ensenando un hueco —o, peor, ensenando
--    el producto de otro tenant el dia que alguien reutilice un uuid—. El coste
--    asumido y escrito: anadir un tipo de bloque es escribir codigo. Por eso el
--    enum tiene siete valores y no veinte.
--
-- 2. **El contenido enriquecido NO es HTML.** Es un documento portable de
--    cuatro nodos (`paragraph`, `heading`, `list`, `quote`) validado por
--    `ebim.rich_text_is_safe` y pintado por componentes de React que mapean
--    nodo -> componente. No hay `dangerouslySetInnerHTML` en ningun punto del
--    repositorio y un test de arquitectura lo comprueba. Guardar HTML
--    "saneado" habria trasladado la seguridad a una lista de etiquetas que hay
--    que mantener al dia contra cada `mXSS` nuevo; un documento sin etiquetas
--    no tiene esa deuda: no existe la cadena que se escapa mal.
--
-- 3. **`settings` es un vocabulario CERRADO de presentacion.** Doce claves,
--    valores escalares, sin objetos anidados: `ebim.content_settings_are_safe`.
--    Un `jsonb` libre en un bloque publicable acaba siendo el sitio donde
--    alguien mete una URL de script "porque es solo configuracion".
--
-- 4. **`anon` no tiene ni un GRANT sobre estas tres tablas.** El comprador no
--    lee el CMS: recibe el RESULTADO ya resuelto por la funcion definer de
--    `20260828140100`. Es lo mismo que P10 hizo con las campanas, y aqui ademas
--    es lo que hace IMPOSIBLE que un borrador se filtre: no hay policy publica
--    que pueda estar mal escrita, no hay lectura publica en absoluto.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Vocabulario
-- ---------------------------------------------------------------------------

-- `home` es la portada de la vitrina; `landing` una pagina de campana con URL
-- propia; `legal` los textos que toda tienda necesita (devoluciones, privacidad)
-- y que hoy se piden por correo porque no hay donde escribirlos.
create type public.content_page_kind as enum ('home', 'landing', 'legal');

-- Mismo trio que el resto del producto (`draft`/`published`/`archived`). No se
-- reutiliza `product_status` a proposito: compartir un enum entre dos dominios
-- convierte anadir un estado a uno en un cambio del otro.
create type public.content_status as enum ('draft', 'published', 'archived');

create type public.content_block_type as enum (
  'hero',
  'banner',
  'carousel',
  'product_collection',
  'category_collection',
  'rich_text',
  'campaign'
);

create type public.content_item_kind as enum ('product', 'variant', 'category');

-- ---------------------------------------------------------------------------
-- ebim.is_safe_href — que puede llevar un enlace escrito por el tenant.
--
-- Lista BLANCA de esquemas, no lista negra de los peligrosos: `javascript:` es
-- el que todo el mundo recuerda, pero `data:text/html`, `vbscript:` y el
-- protocolo-relativo `//otro-dominio` hacen dano igual. Con lista blanca, el
-- esquema que nadie ha pensado todavia entra en el lado de "no".
-- ---------------------------------------------------------------------------
create or replace function ebim.is_safe_href(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    p_value is null
    or (
      char_length(p_value) between 1 and 2048
      and p_value !~ '[[:space:]]'
      and (
        p_value like 'https://%'
        or (p_value like '/%' and p_value not like '//%')
        or p_value like 'mailto:%'
        or p_value like 'tel:%'
      )
      -- Cinturon ademas del tirante: aunque el prefijo pasara, un esquema
      -- ejecutable en cualquier posicion descalifica el enlace.
      and lower(p_value) !~ 'javascript:|vbscript:|data:'
    ),
    false
  );
$fn$;

revoke execute on function ebim.is_safe_href(text) from public;
grant execute on function ebim.is_safe_href(text) to anon, authenticated, service_role;

comment on function ebim.is_safe_href(text) is
  'Enlace admisible en contenido del tenant: https, ruta interna, mailto o tel. Lista blanca, nunca lista negra.';

-- ---------------------------------------------------------------------------
-- ebim.rich_text_node_is_safe / ebim.rich_text_is_safe
--
-- El documento es un ARRAY de nodos planos. Sin anidamiento: un arbol admite
-- profundidad arbitraria y la profundidad arbitraria es, en la practica, un
-- lenguaje. Cuatro tipos, seis claves posibles, y CUALQUIER clave de mas
-- invalida el nodo entero — asi un `onclick` no "se ignora al pintar", no entra.
--
-- Ojo con el `coalesce` final: un CHECK que recibe NULL PASA. Sin envolver el
-- resultado, un documento con una forma que la expresion no sabe evaluar seria
-- exactamente el que se cuela.
-- ---------------------------------------------------------------------------
create or replace function ebim.rich_text_node_is_safe(p_node jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    jsonb_typeof(p_node) = 'object'
    and jsonb_typeof(p_node -> 'type') = 'string'
    and (p_node ->> 'type') in ('paragraph', 'heading', 'list', 'quote')
    -- Vocabulario cerrado de claves. Una clave desconocida no se ignora: rompe.
    and not exists (
      select 1
      from jsonb_object_keys(p_node) as k(key)
      where k.key not in ('type', 'text', 'level', 'items', 'href', 'linkLabel')
    )
    -- Las listas llevan `items`; el resto lleva `text`.
    and case (p_node ->> 'type')
      when 'list' then
        jsonb_typeof(p_node -> 'items') = 'array'
        and jsonb_array_length(p_node -> 'items') between 1 and 20
        and not exists (
          select 1
          from jsonb_array_elements(p_node -> 'items') as it(value)
          where jsonb_typeof(it.value) <> 'string'
             or char_length(it.value #>> '{}') not between 1 and 300
             or (it.value #>> '{}') ~ '<[a-zA-Z/!]'
        )
        and not p_node ? 'text'
      else
        jsonb_typeof(p_node -> 'text') = 'string'
        and char_length(p_node ->> 'text') between 1 and 2000
        -- Nada que se parezca a una etiqueta, ni siquiera como texto. El
        -- renderizador no interpreta HTML, pero un texto con `<script` dentro
        -- es el que acaba pegado en un correo o en un export que si lo hace.
        and (p_node ->> 'text') !~ '<[a-zA-Z/!]'
        and not p_node ? 'items'
    end
    -- El titular solo tiene dos niveles: el `h1` de la pagina es el titulo, y
    -- dejar que un bloque escriba otro rompe el arbol de encabezados (WCAG).
    and ((p_node ->> 'type') <> 'heading' or (p_node ->> 'level') in ('2', '3'))
    and ((p_node ->> 'type') = 'heading' or not p_node ? 'level')
    and (not p_node ? 'href' or (
      jsonb_typeof(p_node -> 'href') = 'string'
      and ebim.is_safe_href(p_node ->> 'href')
    ))
    and (not p_node ? 'linkLabel' or (
      jsonb_typeof(p_node -> 'linkLabel') = 'string'
      and char_length(p_node ->> 'linkLabel') between 1 and 120
      and (p_node ->> 'linkLabel') !~ '<[a-zA-Z/!]'
    ))
    -- Una etiqueta de enlace sin enlace es un texto que parece pulsable.
    and (not p_node ? 'linkLabel' or p_node ? 'href'),
    false
  );
$fn$;

revoke execute on function ebim.rich_text_node_is_safe(jsonb) from public;
grant execute on function ebim.rich_text_node_is_safe(jsonb) to anon, authenticated, service_role;

create or replace function ebim.rich_text_is_safe(p_doc jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    p_doc is null
    or (
      jsonb_typeof(p_doc) = 'array'
      and jsonb_array_length(p_doc) between 1 and 60
      -- Tope duro de tamano. Sin el, el limite lo pone el TOAST (1 GB) y una
      -- pagina puede tumbar la vitrina de la tienda sin que nadie lo note.
      and char_length(p_doc::text) <= 24000
      and not exists (
        select 1
        from jsonb_array_elements(p_doc) as node(value)
        where not ebim.rich_text_node_is_safe(node.value)
      )
    ),
    false
  );
$fn$;

revoke execute on function ebim.rich_text_is_safe(jsonb) from public;
grant execute on function ebim.rich_text_is_safe(jsonb) to anon, authenticated, service_role;

comment on function ebim.rich_text_is_safe(jsonb) is
  'Documento enriquecido admisible: array plano de nodos paragraph/heading/list/quote con vocabulario cerrado de claves. No es HTML: no hay etiqueta que escapar.';

-- ---------------------------------------------------------------------------
-- ebim.content_settings_are_safe — los mandos de presentacion del bloque.
--
-- Doce claves, valores escalares y nada anidado. `settings` existe para que
-- "dos columnas o tres" no sea un tipo de bloque nuevo; en el momento en que
-- admita objetos, sera el sitio donde alguien meta una URL de script.
-- ---------------------------------------------------------------------------
create or replace function ebim.content_settings_are_safe(p_settings jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    jsonb_typeof(p_settings) = 'object'
    and (select count(*) from jsonb_object_keys(p_settings)) <= 12
    and not exists (
      select 1
      from jsonb_each(p_settings) as e(key, value)
      where e.key not in (
              'layout', 'columns', 'autoplay', 'interval_ms', 'align', 'tone',
              'show_price', 'show_cta', 'aspect', 'background', 'compact', 'reverse'
            )
         or jsonb_typeof(e.value) not in ('string', 'number', 'boolean')
         or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 60)
    ),
    false
  );
$fn$;

revoke execute on function ebim.content_settings_are_safe(jsonb) from public;
grant execute on function ebim.content_settings_are_safe(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- content_pages — la pagina.
--
-- `priority` + vigencia + canal dan un orden TOTAL para la resolucion, igual
-- que la precedencia del motor de precios de P04: canal especifico gana a canal
-- nulo, luego `priority desc`, luego `publish_from` mas reciente, luego `id`.
-- Sin ese ultimo desempate, dos portadas empatadas darian una vitrina distinta
-- segun el plan de ejecucion de Postgres — y nadie sabria por que.
-- ---------------------------------------------------------------------------
create table public.content_pages (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  slug            text        not null,
  title           text        not null,
  kind            public.content_page_kind not null default 'landing',
  status          public.content_status    not null default 'draft',
  -- Canal COMERCIAL. Nulo = vale para todos; una fila con canal gana a la que
  -- no lo lleva. Es la misma regla de especificidad de `price_list_assignments`.
  channel_id      uuid,
  priority        integer     not null default 0,
  publish_from    timestamptz not null default now(),
  publish_to      timestamptz,
  show_in_nav     boolean     not null default false,
  nav_position    integer     not null default 0,
  seo_title       text,
  seo_description text,
  og_image_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint content_pages_slug_fmt  check (slug ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  constraint content_pages_title_len check (char_length(btrim(title)) between 1 and 160),
  constraint content_pages_seo_title_len
    check (seo_title is null or char_length(btrim(seo_title)) between 1 and 160),
  constraint content_pages_seo_desc_len
    check (seo_description is null or char_length(btrim(seo_description)) between 1 and 320),
  constraint content_pages_og_len
    check (og_image_url is null or char_length(og_image_url) between 4 and 1024),
  -- Misma regla que el logo y el banner (`20260827091500`): o https externo, o
  -- una ruta del bucket privado bajo el prefijo del PROPIO tenant.
  constraint content_pages_og_ref
    check (ebim.is_store_asset_ref(og_image_url, organization_id, store_id)),
  constraint content_pages_window check (publish_to is null or publish_to > publish_from),
  constraint content_pages_priority_range check (priority between -100 and 100),

  constraint content_pages_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint content_pages_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete cascade,

  constraint content_pages_slug_unique unique (store_id, slug),
  -- Claves de apoyo para que los hijos amarren tenant y tienda por FK.
  constraint content_pages_store_key  unique (id, store_id),
  constraint content_pages_tenant_key unique (id, organization_id, company_id)
);

create index content_pages_tenant_idx on public.content_pages (organization_id, company_id);
create index content_pages_live_idx
  on public.content_pages (store_id, kind, priority desc, publish_from desc)
  where status = 'published';
create index content_pages_nav_idx
  on public.content_pages (store_id, nav_position)
  where show_in_nav;

create trigger content_pages_set_updated_at
  before update on public.content_pages
  for each row execute function ebim.set_updated_at();

comment on table public.content_pages is
  'Pagina administrable de la vitrina. La portada es kind=home; la resolucion tiene orden TOTAL (canal, priority, publish_from, id).';
comment on column public.content_pages.channel_id is
  'Canal comercial al que aplica. Nulo = todos. Una pagina CON canal gana a una sin canal (especificidad, igual que P04).';

-- ---------------------------------------------------------------------------
-- content_blocks — el bloque.
--
-- Vigencia, canal y segmento PROPIOS ademas de los de la pagina: una portada
-- vive un ano y el banner de rebajas dura dos semanas. Si la vigencia solo
-- viviera en la pagina, cambiar el banner obligaria a duplicar la portada.
-- ---------------------------------------------------------------------------
create table public.content_blocks (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  page_id         uuid        not null,
  block_type      public.content_block_type not null,
  position        integer     not null default 0,

  title           text,
  subtitle        text,
  -- Contenido enriquecido. NO es HTML: ver `ebim.rich_text_is_safe`.
  body            jsonb,

  media_url       text,
  media_alt       text,

  cta_label       text,
  cta_href        text,

  -- Solo para `campaign`: el bloque APUNTA a la campana y la campana no sabe
  -- que existe el bloque. Una sola direccion, `on delete set null`: borrar una
  -- promocion no puede borrar el contenido que la anunciaba.
  promotion_id    uuid,
  -- Solo para `category_collection` / `carousel` por categoria.
  category_id     uuid,
  item_limit      integer     not null default 8,

  is_active       boolean     not null default true,
  publish_from    timestamptz not null default now(),
  publish_to      timestamptz,
  channel_id      uuid,
  segment_id      uuid,
  settings        jsonb       not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint content_blocks_title_len
    check (title is null or char_length(btrim(title)) between 1 and 160),
  constraint content_blocks_subtitle_len
    check (subtitle is null or char_length(btrim(subtitle)) between 1 and 320),
  constraint content_blocks_media_len
    check (media_url is null or char_length(media_url) between 4 and 1024),
  constraint content_blocks_media_ref
    check (ebim.is_store_asset_ref(media_url, organization_id, store_id)),
  constraint content_blocks_media_alt_len
    check (media_alt is null or char_length(btrim(media_alt)) between 1 and 200),
  constraint content_blocks_cta_label_len
    check (cta_label is null or char_length(btrim(cta_label)) between 1 and 60),
  constraint content_blocks_cta_href_safe check (ebim.is_safe_href(cta_href)),
  -- Un boton sin destino es un boton roto, y un destino sin boton no se pulsa.
  constraint content_blocks_cta_pair
    check ((cta_label is null) = (cta_href is null)),
  constraint content_blocks_body_safe
    check (body is null or ebim.rich_text_is_safe(body)),
  constraint content_blocks_settings_safe
    check (ebim.content_settings_are_safe(settings)),
  constraint content_blocks_window
    check (publish_to is null or publish_to > publish_from),
  constraint content_blocks_item_limit
    check (item_limit between 1 and 48),
  constraint content_blocks_position_range
    check (position between 0 and 999),

  -- FORMA POR TIPO. Es lo que hace imposible el bloque "hero" sin nada que
  -- ensenar y la "coleccion" que no dice de que. Sin esto, la vitrina tendria
  -- que decidir en tiempo de pintado si un bloque se ensena o no, y ese es
  -- exactamente el tipo de decision que acaba dando dos respuestas distintas.
  constraint content_blocks_shape check (
    case block_type
      when 'hero'   then title is not null or media_url is not null
      when 'banner' then title is not null or media_url is not null
      when 'rich_text' then body is not null
      when 'campaign'  then title is not null
      when 'category_collection' then true
      when 'carousel'            then true
      when 'product_collection'  then true
    end
  ),
  -- Lo que un tipo NO puede llevar. `promotion_id` fuera de `campaign` seria un
  -- vinculo que nadie lee; `body` fuera de los que lo pintan seria contenido
  -- invisible que sigue costando validacion y espacio.
  constraint content_blocks_promotion_only_campaign
    check (block_type = 'campaign' or promotion_id is null),
  constraint content_blocks_category_only_collection
    check (block_type in ('category_collection', 'carousel', 'product_collection')
           or category_id is null),
  constraint content_blocks_body_only_text
    check (block_type in ('rich_text', 'hero', 'banner') or body is null),

  constraint content_blocks_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade,
  constraint content_blocks_page_fk foreign key (page_id, store_id)
    references public.content_pages (id, store_id) on delete cascade,
  constraint content_blocks_channel_fk foreign key (channel_id, store_id)
    references public.channels (id, store_id) on delete cascade,
  constraint content_blocks_segment_fk foreign key (segment_id, organization_id, company_id)
    references public.customer_segments (id, organization_id, company_id) on delete cascade,
  constraint content_blocks_category_fk foreign key (category_id, store_id)
    references public.categories (id, store_id) on delete set null,
  constraint content_blocks_promotion_fk foreign key (promotion_id, store_id)
    references public.promotions (id, store_id) on delete set null,

  -- Claves de apoyo: `(id, block_type)` es la que permite que el CHECK de los
  -- items mire el tipo del bloque padre (la tecnica del PIM de P03).
  constraint content_blocks_type_key  unique (id, block_type),
  constraint content_blocks_store_key unique (id, store_id)
);

create index content_blocks_tenant_idx on public.content_blocks (organization_id, company_id);
create index content_blocks_page_idx   on public.content_blocks (page_id, position);
create index content_blocks_live_idx
  on public.content_blocks (page_id, position)
  where is_active;

create trigger content_blocks_set_updated_at
  before update on public.content_blocks
  for each row execute function ebim.set_updated_at();

comment on table public.content_blocks is
  'Bloque administrable con tipo cerrado, columnas tipadas, vigencia/canal/segmento propios y contenido enriquecido que NO es HTML.';
comment on column public.content_blocks.settings is
  'Mandos de PRESENTACION con vocabulario cerrado (ebim.content_settings_are_safe). Nunca codigo, nunca objetos anidados.';
comment on column public.content_blocks.promotion_id is
  'Solo en campaign. El bloque apunta a la campana; la campana no sabe del bloque. on delete set null: borrar la promo no borra el contenido.';

-- ---------------------------------------------------------------------------
-- content_block_items — lo que la coleccion ENSENA, con FK de verdad.
--
-- `block_type` va denormalizado con `on update cascade` contra
-- `content_blocks (id, block_type)`: es lo que permite que un CHECK mire el
-- tipo del padre. Es la misma tecnica con la que P03 impide una variante bajo
-- un producto simple y P10 un alcance de combo sin cantidad.
-- ---------------------------------------------------------------------------
create table public.content_block_items (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  block_id        uuid        not null,
  block_type      public.content_block_type not null,
  item_kind       public.content_item_kind  not null,
  product_id      uuid,
  variant_id      uuid,
  category_id     uuid,
  position        integer     not null default 0,
  created_at      timestamptz not null default now(),

  constraint content_block_items_target check (
       (item_kind = 'product'  and product_id is not null and variant_id is null
                               and category_id is null)
    -- La variante exige tambien su producto: es lo que permite la FK compuesta
    -- que impide apuntar a la variante de OTRO producto.
    or (item_kind = 'variant'  and product_id is not null and variant_id is not null
                               and category_id is null)
    or (item_kind = 'category' and category_id is not null and product_id is null
                               and variant_id is null)
  ),
  -- Solo los tipos que ensenan una lista tienen items. Un `hero` con items
  -- seria contenido que nadie pinta y que aun asi hay que mantener.
  constraint content_block_items_block_kind
    check (block_type in ('product_collection', 'category_collection', 'carousel')),
  -- Y la categoria solo cuelga del bloque de categorias; el producto, de los
  -- otros dos. Mezclarlos daria una coleccion que no se sabe como se pinta.
  constraint content_block_items_kind_matches_block check (
    (block_type = 'category_collection' and item_kind = 'category')
    or (block_type in ('product_collection', 'carousel') and item_kind in ('product', 'variant'))
  ),
  constraint content_block_items_position_range check (position between 0 and 999),

  constraint content_block_items_block_fk foreign key (block_id, block_type)
    references public.content_blocks (id, block_type) on update cascade on delete cascade,
  constraint content_block_items_store_fk foreign key (block_id, store_id)
    references public.content_blocks (id, store_id) on delete cascade,
  constraint content_block_items_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint content_block_items_variant_fk foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade,
  constraint content_block_items_category_fk foreign key (category_id, store_id)
    references public.categories (id, store_id) on delete cascade
);

create index content_block_items_tenant_idx
  on public.content_block_items (organization_id, company_id);
create index content_block_items_block_idx
  on public.content_block_items (block_id, position);

-- Sin duplicados dentro de una coleccion: el mismo producto dos veces es un
-- error de edicion que solo se descubre mirando la vitrina.
create unique index content_block_items_product_unique
  on public.content_block_items (block_id, product_id)
  where item_kind = 'product';
create unique index content_block_items_variant_unique
  on public.content_block_items (block_id, variant_id)
  where item_kind = 'variant';
create unique index content_block_items_category_unique
  on public.content_block_items (block_id, category_id)
  where item_kind = 'category';

comment on table public.content_block_items is
  'Lo que una coleccion ensena, con FK compuestas tenant-safe. El item NO es un id dentro de un jsonb: un producto borrado se lleva su fila por delante.';

-- =============================================================================
-- RLS · default deny en las tres tablas.
--
-- **Escritura: rol Y capacidad.** `owner`/`admin` y `content.cms` contratada.
-- Publicar contenido en la vitrina es hablar en nombre del comercio; `catalog`
-- mantiene la ficha del producto, no la portada.
--
-- **Lectura: solo `can_access`, sin capacidad.** Igual que P04 con las listas y
-- P10 con las campanas: si un tenant deja de pagar el modulo, su contenido deja
-- de RESOLVERSE en la vitrina (lo comprueba la funcion de `140100`) pero se
-- sigue VIENDO en el backoffice. Esconderlo convertiria una baja comercial en
-- una perdida de datos aparente.
--
-- **`anon` no tiene ni un GRANT.** La vitrina no lee estas tablas: recibe el
-- resultado de `public.store_page_for_slug`, que es definer y solo devuelve lo
-- publicado y vigente. Es lo que hace imposible que un borrador se filtre por
-- una policy publica mal escrita: no hay policy publica.
-- =============================================================================
alter table public.content_pages       enable row level security;
alter table public.content_pages       force  row level security;
alter table public.content_blocks      enable row level security;
alter table public.content_blocks      force  row level security;
alter table public.content_block_items enable row level security;
alter table public.content_block_items force  row level security;

revoke all on public.content_pages       from public, anon, authenticated;
revoke all on public.content_blocks      from public, anon, authenticated;
revoke all on public.content_block_items from public, anon, authenticated;

grant select, insert, update, delete on public.content_pages       to authenticated;
grant select, insert, update, delete on public.content_blocks      to authenticated;
grant select, insert, update, delete on public.content_block_items to authenticated;

grant all on public.content_pages, public.content_blocks, public.content_block_items
  to service_role;

-- --- content_pages ---------------------------------------------------------
create policy content_pages_select_member on public.content_pages
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy content_pages_insert_admin on public.content_pages
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy content_pages_update_admin on public.content_pages
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy content_pages_delete_admin on public.content_pages
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

-- --- content_blocks --------------------------------------------------------
create policy content_blocks_select_member on public.content_blocks
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy content_blocks_insert_admin on public.content_blocks
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy content_blocks_update_admin on public.content_blocks
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy content_blocks_delete_admin on public.content_blocks
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

-- --- content_block_items ---------------------------------------------------
create policy content_block_items_select_member on public.content_block_items
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy content_block_items_insert_admin on public.content_block_items
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy content_block_items_update_admin on public.content_block_items
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy content_block_items_delete_admin on public.content_block_items
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );
