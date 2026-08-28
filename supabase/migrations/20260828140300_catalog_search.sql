-- =============================================================================
-- P11-SaaS · 4/5 — Busqueda del catalogo: FTS + trigramas, facetas y sinonimos.
--
-- El encargo pone dos condiciones que, juntas, descartan casi todo lo demas:
-- «evita cargar el catalogo completo al browser para buscar» y «deja el
-- contrato preparado para otro motor sin que el dominio dependa de el».
--
-- ## Por que Postgres y no un motor aparte, HOY
--
-- Un indice externo es un segundo almacen que hay que sincronizar, y un segundo
-- almacen sin RLS: el aislamiento entre tenants pasaria a depender de que cada
-- consulta acuerde filtrar por `organization_id` — exactamente el modelo que el
-- contrato §0 prohibe. Con FTS + `pg_trgm` la busqueda ocurre DENTRO de la base
-- que ya tiene las policies, y el dia que el volumen lo pida, cambiar de motor
-- es escribir otro adaptador del `SearchPort` — no reabrir el dominio.
--
-- ## Las cinco decisiones que gobiernan este archivo
--
-- 1. **El indice es una columna GENERADA.** `products.search_vector` no puede
--    discrepar de `name`/`slug`/`description` porque no se escribe: se deriva.
--    Un trigger que lo mantuviera tendria un estado "indice desincronizado" que
--    solo se descubre buscando algo y no encontrandolo.
-- 2. **Los acentos se normalizan en el DATO y en la CONSULTA, con la misma
--    funcion.** `unaccent` no vale: es STABLE (depende del diccionario) y una
--    columna generada exige IMMUTABLE. `ebim.search_normalize` es una tabla de
--    traduccion fija, immutable por construccion.
-- 3. **Los trigramas son el PLAN B, no el plan A.** Primero FTS con prefijo
--    (rapido, indexado, con lematizacion); si eso no devuelve nada, similitud
--    por trigramas para la errata. Al reves —trigramas siempre— seria pagar un
--    recorrido caro en el 95 % de las busquedas que no llevan erratas.
-- 4. **Los sinonimos son DATOS del tenant.** «zapatilla = zapatilla deportiva =
--    tenis» cambia por pais y por sector; que fuera codigo significaria que
--    mejorar el discovery de un comercio es un despliegue, que es justo lo que
--    esta fase tiene que hacer imposible.
-- 5. **Las facetas salen del SERVIDOR.** Contar marcas y categorias en el
--    navegador exige traerse el catalogo entero, que es la linea que el encargo
--    prohibe cruzar por escrito.
-- =============================================================================

-- `pg_trgm` vive en el esquema `extensions`, que es donde lo pone Supabase. Las
-- funciones de este archivo llevan `search_path = ''` y por eso lo llaman
-- cualificado (`extensions.similarity`): un `search_path` que incluyera el
-- esquema de extensiones seria una via para que otro objeto del mismo nombre se
-- colara delante.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- En un proyecto Supabase el esquema `extensions` ya existe y sus objetos son
-- ejecutables por los roles de la API. Aqui se replica ese permiso para que la
-- base de pruebas se comporte igual que la real: sin esto, un fallo de permisos
-- aparecería solo en un entorno y no en el otro, que es la peor forma de
-- descubrirlo.
grant usage on schema extensions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ebim.search_normalize — la MISMA normalizacion para el dato y la consulta.
--
-- `translate` antes de `lower`: con la colacion C, `lower('Á')` no baja a 'á',
-- asi que el mapa cubre las dos cajas y el `lower` remata el ASCII. Al reves
-- —lower primero— la mayuscula acentuada se quedaria sin normalizar y "CAMISA"
-- y "camisa" dejarian de ser la misma palabra en cuanto llevara tilde.
-- ---------------------------------------------------------------------------
create or replace function ebim.search_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select btrim(regexp_replace(
    lower(translate(
      coalesce(p_text, ''),
      'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
      'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC'
    )),
    '[^a-z0-9]+', ' ', 'g'
  ));
$fn$;

revoke execute on function ebim.search_normalize(text) from public;
grant execute on function ebim.search_normalize(text) to anon, authenticated, service_role;

comment on function ebim.search_normalize(text) is
  'Normalizacion IMMUTABLE (acentos, caja, puntuacion) usada por la columna generada y por la consulta. unaccent no sirve: es STABLE.';

-- ---------------------------------------------------------------------------
-- El indice: columna generada + GIN, y el trigrama sobre el nombre.
--
-- Pesos: nombre A, slug B, descripcion C. Sin pesos, un producto cuya
-- descripcion menciona "camisa" doce veces ganaria al producto que SE LLAMA
-- camisa, y esa es la unica busqueda que el comprador esperaba que funcionara.
-- ---------------------------------------------------------------------------
alter table public.products
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('spanish'::regconfig, ebim.search_normalize(name)), 'A')
    || setweight(to_tsvector('spanish'::regconfig, ebim.search_normalize(coalesce(slug, ''))), 'B')
    || setweight(to_tsvector('spanish'::regconfig, ebim.search_normalize(coalesce(description, ''))), 'C')
  ) stored;

create index products_search_vector_idx on public.products using gin (search_vector);

-- El indice de trigramas es lo que hace barata la busqueda tolerante a erratas.
-- Va sobre el NOMBRE normalizado y no sobre la descripcion: buscar "camizeta"
-- tiene que encontrar la camiseta, no los ocho productos que la mencionan.
create index products_search_trgm_idx
  on public.products using gin ((ebim.search_normalize(name)) extensions.gin_trgm_ops);

-- `anon` NO recibe GRANT sobre `search_vector`: el vector es el catalogo
-- deshecho en lexemas y con el se reconstruye el texto de productos que ni
-- siquiera estan publicados. La busqueda publica pasa por la funcion definer,
-- que devuelve filas — nunca el indice.
comment on column public.products.search_vector is
  'Indice de texto derivado de nombre/slug/descripcion con pesos A/B/C. GENERADA: no puede desincronizarse porque no se escribe.';

-- ---------------------------------------------------------------------------
-- search_synonyms — el discovery que el comercio ajusta sin desplegar.
--
-- `term_normalized` es GENERADA y el indice unico va sobre ella: «Zapatilla» y
-- «zapatillas » son el mismo termino porque lo dice el DATO, no porque tres
-- sitios se acuerden de normalizar (misma decision que `coupons.code_normalized`
-- en P10).
-- ---------------------------------------------------------------------------
create or replace function ebim.search_expansions_are_safe(p_values text[])
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    p_values is not null
    and not exists (
      select 1
      from unnest(p_values) as e(value)
      where e.value is null
         or char_length(btrim(e.value)) not between 2 and 60
         or ebim.search_normalize(e.value) = ''
    ),
    false
  );
$fn$;

revoke execute on function ebim.search_expansions_are_safe(text[]) from public;
grant execute on function ebim.search_expansions_are_safe(text[])
  to anon, authenticated, service_role;

create table public.search_synonyms (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  term            text        not null,
  term_normalized text        generated always as (ebim.search_normalize(term)) stored,
  expansions      text[]      not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint search_synonyms_term_len
    check (char_length(btrim(term)) between 2 and 60),
  constraint search_synonyms_expansions_len
    check (array_length(expansions, 1) between 1 and 12),
  -- Cada expansion es una palabra o frase corta, no un patron: aceptar
  -- cualquier texto convertiria la tabla en un sitio donde meter sintaxis de
  -- `tsquery` y, con ella, una consulta que el tenant no deberia poder escribir.
  -- Va en funcion y no en el CHECK directamente porque un CHECK no admite
  -- subconsultas, y comprobar un array elemento a elemento exige una.
  constraint search_synonyms_expansions_shape
    check (ebim.search_expansions_are_safe(expansions)),
  constraint search_synonyms_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index search_synonyms_tenant_idx on public.search_synonyms (organization_id, company_id);
create unique index search_synonyms_term_key
  on public.search_synonyms (store_id, term_normalized);
create index search_synonyms_active_idx
  on public.search_synonyms (store_id, term_normalized) where is_active;

create trigger search_synonyms_set_updated_at
  before update on public.search_synonyms
  for each row execute function ebim.set_updated_at();

comment on table public.search_synonyms is
  'Sinonimos de busqueda por tienda. Mejorar el discovery de un comercio es una fila, no un despliegue.';

alter table public.search_synonyms enable row level security;
alter table public.search_synonyms force  row level security;

revoke all on public.search_synonyms from public, anon, authenticated;
grant select, insert, update, delete on public.search_synonyms to authenticated;
grant all on public.search_synonyms to service_role;

-- Lectura para el miembro, escritura para owner/admin CON la capacidad. `anon`
-- no lee la tabla: los sinonimos los aplica la funcion definer, y la lista de
-- sinonimos de una tienda dice que busca la gente y que no encuentra — eso es
-- informacion comercial del tenant.
create policy search_synonyms_select_member on public.search_synonyms
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

create policy search_synonyms_insert_admin on public.search_synonyms
  for insert to authenticated
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy search_synonyms_update_admin on public.search_synonyms
  for update to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  )
  with check (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

create policy search_synonyms_delete_admin on public.search_synonyms
  for delete to authenticated
  using (
    ebim.has_role(organization_id, company_id, array['owner','admin']::public.app_role[])
    and ebim.has_capability(organization_id, company_id, 'content.cms')
  );

-- ---------------------------------------------------------------------------
-- ebim.search_terms / ebim.search_tsquery — de lo que escribio el comprador a
-- una consulta que Postgres entiende.
--
-- Los tokens salen ya normalizados a `[a-z0-9]`, asi que no hay sintaxis de
-- `tsquery` que inyectar: `&`, `|`, `!`, `(` y `:` no sobreviven a
-- `search_normalize`. El `quote_literal` es el segundo cinturon, no el primero.
-- ---------------------------------------------------------------------------
create or replace function ebim.search_terms(p_query text)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    (select array_agg(t)
       from unnest(string_to_array(ebim.search_normalize(p_query), ' ')) as t
      where t <> ''),
    array[]::text[]
  );
$fn$;

revoke execute on function ebim.search_terms(text) from public;
grant execute on function ebim.search_terms(text) to anon, authenticated, service_role;

create or replace function ebim.search_tsquery(p_store_id uuid, p_query text)
returns tsquery
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_terms  text[] := ebim.search_terms(p_query);
  v_term   text;
  v_group  text;
  v_groups text[] := array[]::text[];
  v_syn    text[];
begin
  if array_length(v_terms, 1) is null then
    return null;
  end if;

  foreach v_term in array v_terms loop
    -- Sinonimos del tenant: el termino se convierte en un GRUPO alternativo
    -- (`a | b | c`), no en un termino mas encadenado con AND. Encadenarlos
    -- haria que pedir "zapatilla" exigiera que el producto dijera tambien
    -- "tenis", que es lo contrario de un sinonimo.
    select s.expansions into v_syn
    from public.search_synonyms s
    where s.store_id = p_store_id
      and s.is_active
      and s.term_normalized = v_term;

    v_group := quote_literal(v_term) || ':*';

    if v_syn is not null then
      v_group := v_group || coalesce((
        select string_agg(' | ' || quote_literal(n) || ':*', '')
        from (
          select distinct ebim.search_normalize(e.value) as n
          from unnest(v_syn) as e(value)
        ) x
        where x.n <> '' and x.n <> v_term
      ), '');
      v_group := '(' || v_group || ')';
    end if;

    v_groups := v_groups || v_group;
  end loop;

  return to_tsquery('spanish'::regconfig, array_to_string(v_groups, ' & '));
exception
  -- Una consulta que el analizador rechace no puede tumbar la vitrina: se
  -- responde "sin resultados de texto" y el camino de trigramas hace el resto.
  when others then
    return null;
end;
$fn$;

revoke execute on function ebim.search_tsquery(uuid, text) from public, anon, authenticated;
grant execute on function ebim.search_tsquery(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- ebim.search_catalog — el motor. Una sola implementacion de la pregunta.
--
-- Devuelve `jsonb` y no un `setof` a proposito: la respuesta lleva items,
-- total, facetas y el modo de coincidencia (`fts` / `fuzzy` / `browse`) en una
-- sola ida y vuelta. Con `setof` harian falta cuatro consultas y las cuatro
-- podrian ver estados distintos del catalogo.
--
-- `p_filters` es un saco `jsonb` y no doce parametros: anadir una faceta manana
-- no cambia la firma, y una firma que cambia rompe a todos los llamantes a la
-- vez. Lo que SI esta cerrado es lo que se lee de dentro — nada del saco llega
-- crudo a una consulta.
--
-- `p_include_unpublished` es lo que separa a los dos llamantes: la vitrina
-- pregunta por lo publicado, el backoffice por todo. No son dos motores, es un
-- motor con un parametro que solo puede poner quien tiene sesion.
-- ---------------------------------------------------------------------------
create or replace function ebim.search_catalog(
  p_store_id            uuid,
  p_query               text,
  p_filters             jsonb,
  p_sort                text,
  p_limit               integer,
  p_offset              integer,
  p_include_unpublished boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_filters   jsonb   := coalesce(p_filters, '{}'::jsonb);
  v_norm      text    := ebim.search_normalize(p_query);
  v_query     tsquery;
  v_limit     integer := least(greatest(coalesce(p_limit, 24), 1), 60);
  v_offset    integer := greatest(coalesce(p_offset, 0), 0);
  v_sort      text    := coalesce(nullif(btrim(coalesce(p_sort, '')), ''), 'relevance');
  v_category  text    := nullif(btrim(coalesce(v_filters ->> 'category', '')), '');
  v_brands    text[];
  v_avail     text    := coalesce(nullif(btrim(coalesce(v_filters ->> 'availability', '')), ''), 'all');
  v_price_min numeric;
  v_price_max numeric;
  v_attrs     jsonb   := case when jsonb_typeof(v_filters -> 'attributes') = 'object'
                              then v_filters -> 'attributes' else '{}'::jsonb end;
  v_terms     text[] := ebim.search_terms(p_query);
  v_result    jsonb;
begin
  if v_sort not in ('relevance', 'price-asc', 'price-desc', 'name', 'recent') then
    v_sort := 'relevance';
  end if;

  if jsonb_typeof(v_filters -> 'brands') = 'array' then
    select array_agg(lower(btrim(b.value #>> '{}')))
      into v_brands
      from jsonb_array_elements(v_filters -> 'brands') as b(value)
     where jsonb_typeof(b.value) = 'string'
       and btrim(b.value #>> '{}') <> '';
  end if;

  -- Los importes del filtro llegan como TEXTO y se convierten aqui: un numero
  -- de JSON es un double, y un double no es un importe (regla del repositorio
  -- desde P02). Un valor que no sea un numero se ignora en vez de reventar: es
  -- un filtro, no una orden de cobro.
  begin
    v_price_min := nullif(btrim(coalesce(v_filters ->> 'price_min', '')), '')::numeric;
  exception when others then v_price_min := null;
  end;
  begin
    v_price_max := nullif(btrim(coalesce(v_filters ->> 'price_max', '')), '')::numeric;
  exception when others then v_price_max := null;
  end;

  if v_norm <> '' then
    v_query := ebim.search_tsquery(p_store_id, p_query);
  end if;

  -- --- El conjunto candidato, ya filtrado por todo lo que NO es texto -------
  with base as (
    select
      p.id           as product_id,
      p.name,
      p.slug,
      p.brand_id,
      p.category_id,
      p.search_vector,
      p.status,
      p.published_at,
      pp.price,
      pp.compare_at_price,
      pp.currency,
      pp.in_stock,
      pp.kind,
      pp.brand_name,
      pp.category_slug,
      pp.category_name,
      pp.primary_image_path,
      pp.primary_image_alt,
      pp.price_from,
      pp.description
    from public.products p
    -- La vitrina lee de `public_products`, que es la vista que YA sabe que es
    -- publico, con que precio y con que disponibilidad. El backoffice necesita
    -- ademas lo no publicado, y para eso el LEFT JOIN: el borrador aparece sin
    -- precio resuelto, que es la verdad — todavia no tiene precio publico.
    left join public.public_products pp
      on pp.product_id = p.id and pp.store_id = p.store_id
    where p.store_id = p_store_id
      and (p_include_unpublished or pp.product_id is not null)
  ),
  filtered as (
    select b.*
    from base b
    where (v_category is null or b.category_slug = v_category)
      and (v_brands is null or lower(coalesce((
            select br.code from public.brands br where br.id = b.brand_id
          ), '')) = any (v_brands))
      and (v_avail <> 'in-stock' or coalesce(b.in_stock, false))
      and (v_price_min is null or coalesce(b.price, 0) >= v_price_min)
      and (v_price_max is null or coalesce(b.price, 0) <= v_price_max)
      -- Atributos: AND entre atributos, OR entre los valores de cada uno. Es lo
      -- que espera quien filtra ("rojo o azul", pero "y talla M").
      and (
        v_attrs = '{}'::jsonb
        or not exists (
          select 1
          from jsonb_each(v_attrs) as f(code, values)
          where not exists (
            select 1
            from public.product_attribute_values pav
            join public.attributes a on a.id = pav.attribute_id
            join public.attribute_values av on av.id = pav.value_id
            where pav.product_id = b.product_id
              and lower(a.code) = lower(f.code)
              and jsonb_typeof(f.values) = 'array'
              and lower(av.code) in (
                select lower(v.value #>> '{}')
                from jsonb_array_elements(f.values) as v(value)
                where jsonb_typeof(v.value) = 'string'
              )
          )
        )
      )
  ),
  -- --- Coincidencia por TEXTO, en dos pasadas -------------------------------
  fts as (
    select f.*, ts_rank_cd(f.search_vector, v_query) as text_score
    from filtered f
    where v_query is not null and f.search_vector @@ v_query
  ),
  fts_brand as (
    -- La marca y la categoria no caben en el vector del producto (viven en
    -- otras tablas y una columna generada no puede mirarlas). Entran por aqui,
    -- con puntuacion mas baja que el nombre.
    select f.*, 0.05::real as text_score
    from filtered f
    where v_norm <> ''
      and not exists (select 1 from fts x where x.product_id = f.product_id)
      and (
        ebim.search_normalize(coalesce(f.brand_name, '')) like '%' || v_norm || '%'
        or ebim.search_normalize(coalesce(f.category_name, '')) like '%' || v_norm || '%'
      )
  ),
  exact as (
    select * from fts union all select * from fts_brand
  ),
  fuzzy as (
    -- PLAN B: solo si el texto no encontro nada y la palabra da para
    -- comparar. Con menos de cuatro letras la similitud de trigramas es ruido.
    --
    -- **Todos** los terminos tienen que parecerse, no solo uno. Sin esta
    -- condicion, "bota lampara" devolveria las dos cosas: el plan B habria
    -- convertido el Y de la busqueda exacta en un O silencioso, que es
    -- exactamente el resultado que hace que un buscador deje de ser util.
    select f.*,
           extensions.word_similarity(v_norm, ebim.search_normalize(f.name))::real as text_score
    from filtered f
    where v_norm <> ''
      and char_length(v_norm) >= 4
      and not exists (select 1 from exact)
      and not exists (
        select 1
        from unnest(v_terms) as t(term)
        where extensions.word_similarity(t.term, ebim.search_normalize(f.name)) < 0.4
      )
  ),
  matched as (
    -- `origin` dice de que rama salio cada fila. Es lo que permite responder
    -- "esto se encontro por parecido" sin adivinarlo mirando si hubo
    -- resultados: una respuesta con filas no significa que la coincidencia
    -- fuera exacta.
    select e.*, 'fts'::text as origin from exact e
    union all
    select f.*, 'fuzzy'::text from fuzzy f
    union all
    -- Sin termino de busqueda esto no es una busqueda, es un catalogo: entra
    -- todo lo filtrado con puntuacion neutra.
    select f.*, 0::real as text_score, 'browse'::text from filtered f where v_norm = ''
  ),
  ranked as (
    select m.*,
           -- Lo disponible sube. No es una preferencia estetica: un resultado
           -- agotado es un resultado que no se puede comprar, y ordenarlo por
           -- delante de uno que si convierte la busqueda en una decepcion.
           (m.text_score * 4)::numeric + case when coalesce(m.in_stock, false) then 0.25 else 0 end
             as score
    from matched m
  ),
  counted as (
    -- El orden se calcula UNA vez, como columna. Ordenar en el `page` y volver
    -- a ordenar en el `jsonb_agg` no es redundante: es que manda el segundo, y
    -- el resultado saldria ordenado por relevancia dijera lo que dijera
    -- `p_sort`. Con el numero de orden dentro de la fila, paginar y serializar
    -- usan la MISMA decision.
    select r.*,
           count(*) over ()::int as total,
           row_number() over (
             order by
               case when v_sort = 'relevance'  then score end desc nulls last,
               case when v_sort = 'price-asc'  then price end asc  nulls last,
               case when v_sort = 'price-desc' then price end desc nulls last,
               case when v_sort = 'name'       then name  end asc  nulls last,
               case when v_sort = 'recent'     then published_at end desc nulls last,
               name,
               product_id
           )::int as rank
    from ranked r
  ),
  page as (
    select * from counted
    where rank > v_offset and rank <= v_offset + v_limit
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', pg.product_id,
        'slug',       pg.slug,
        'name',       pg.name,
        'description', left(coalesce(pg.description, ''), 240),
        'kind',       pg.kind,
        'brand_name', pg.brand_name,
        'category_slug', pg.category_slug,
        'category_name', pg.category_name,
        'price',      pg.price::text,
        'compare_at_price', pg.compare_at_price::text,
        'price_from', pg.price_from::text,
        'currency',   pg.currency,
        'in_stock',   coalesce(pg.in_stock, false),
        'image_path', pg.primary_image_path,
        'image_alt',  pg.primary_image_alt,
        'published',  (pg.published_at is not null and pg.status = 'published'),
        'score',      round(pg.score, 4)::text
      ) order by pg.rank)
      from page pg
    ), '[]'::jsonb),
    'total', coalesce((select max(total) from counted), 0),
    'mode', case
      when v_norm = ''                                             then 'browse'
      when exists (select 1 from counted where origin = 'fts')      then 'fts'
      when exists (select 1 from counted where origin = 'fuzzy')    then 'fuzzy'
      else 'empty'
    end,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'facets', jsonb_build_object(
      'categories', coalesce((
        select jsonb_agg(x order by x->>'name')
        from (
          select jsonb_build_object(
            'slug', c.category_slug, 'name', c.category_name, 'count', count(*)::int
          ) as x
          from counted c
          where c.category_slug is not null
          group by c.category_slug, c.category_name
        ) cats
      ), '[]'::jsonb),
      'brands', coalesce((
        select jsonb_agg(x order by x->>'name')
        from (
          select jsonb_build_object(
            'code', (select br.code from public.brands br where br.id = c.brand_id),
            'name', c.brand_name,
            'count', count(*)::int
          ) as x
          from counted c
          where c.brand_id is not null
          group by c.brand_id, c.brand_name
        ) br
      ), '[]'::jsonb),
      'attributes', coalesce((
        select jsonb_agg(x order by x->>'code')
        from (
          select jsonb_build_object(
            'code', a.code,
            'name', a.name,
            'values', jsonb_agg(
              jsonb_build_object('code', av.code, 'label', av.label, 'count', cnt)
              order by av.position, av.label
            )
          ) as x
          from (
            select pav.attribute_id, pav.value_id, count(*)::int as cnt
            from counted c
            join public.product_attribute_values pav on pav.product_id = c.product_id
            where pav.value_id is not null
            group by pav.attribute_id, pav.value_id
          ) g
          join public.attributes a on a.id = g.attribute_id
          join public.attribute_values av on av.id = g.value_id
          where a.is_filterable and a.is_active
          group by a.code, a.name
        ) attrs
      ), '[]'::jsonb),
      'price', jsonb_build_object(
        'min', (select min(price)::text from counted),
        'max', (select max(price)::text from counted)
      ),
      'availability', jsonb_build_object(
        'in_stock', (select count(*) filter (where coalesce(in_stock, false))::int from counted),
        'total',    (select count(*)::int from counted)
      )
    )
  )
  into v_result;

  -- El MODO ya viene dentro: explica por que salio lo que salio. Sin el, un
  -- resultado por trigramas parece una busqueda que funciono raro; con el, la
  -- vitrina puede decir "quiza quisiste decir" en vez de fingir que era lo que
  -- se pidio.
  return v_result || jsonb_build_object('query', p_query);
end;
$fn$;

revoke execute on function ebim.search_catalog(uuid, text, jsonb, text, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function ebim.search_catalog(uuid, text, jsonb, text, integer, integer, boolean)
  to service_role;

comment on function ebim.search_catalog(uuid, text, jsonb, text, integer, integer, boolean) is
  'Motor de busqueda del catalogo: FTS con prefijo y sinonimos, trigramas como plan B, facetas server-side y modo explicito (fts/fuzzy/browse/empty).';

-- =============================================================================
-- Las tres puertas. Un motor, tres autorizaciones.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.catalog_search_for_slug — el comprador ANONIMO.
--
-- Tienda por slug (solo activa) y `p_include_unpublished` fijado a `false`
-- DENTRO: no es un parametro que se pueda pasar mal porque no es un parametro.
-- ---------------------------------------------------------------------------
create or replace function public.catalog_search_for_slug(
  p_store_slug text,
  p_query      text default null,
  p_filters    jsonb default '{}'::jsonb,
  p_sort       text default 'relevance',
  p_limit      integer default 24,
  p_offset     integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_slug  text := lower(btrim(coalesce(p_store_slug, '')));
begin
  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return ebim.search_catalog(v_store.id, p_query, p_filters, p_sort, p_limit, p_offset, false);
end;
$fn$;

revoke execute on function public.catalog_search_for_slug(text, text, jsonb, text, integer, integer)
  from public;
grant execute on function public.catalog_search_for_slug(text, text, jsonb, text, integer, integer)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.catalog_suggest_for_slug — el autocompletado.
--
-- Tres origenes en una respuesta (producto, categoria, marca) y un tope duro de
-- diez: el autocompletado se dispara con cada tecla y una consulta que devuelve
-- cien filas por pulsacion es una denegacion de servicio escrita por uno mismo.
-- Devuelve ETIQUETAS, nunca precios ni existencias: es una ayuda a teclear.
-- ---------------------------------------------------------------------------
create or replace function public.catalog_suggest_for_slug(
  p_store_slug text,
  p_query      text,
  p_limit      integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
  v_slug  text := lower(btrim(coalesce(p_store_slug, '')));
  v_norm  text := ebim.search_normalize(p_query);
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 10);
begin
  -- Dos caracteres como minimo, y la regla vive AQUI y no en el navegador: con
  -- uno solo, "sugerir" es devolver el catalogo entero por cada tecla, y esa es
  -- una denegacion de servicio que el cliente no deberia poder provocar.
  if char_length(v_norm) < 2 then
    return '[]'::jsonb;
  end if;

  select * into v_store
  from public.stores s
  where lower(s.slug) = v_slug and s.status = 'active';

  if not found then
    return '[]'::jsonb;
  end if;

  -- Cuatro origenes con rango explicito: primero lo que EMPIEZA por lo tecleado
  -- (que es lo que el comprador esta escribiendo), luego lo que lo contiene,
  -- luego categorias y marcas. El rango es una columna y no un `order by` sobre
  -- el jsonb: ordenar por el texto de un objeto es ordenar por como se
  -- serializo, que no es una regla que nadie pueda explicar.
  return coalesce((
    select jsonb_agg(s.item order by s.rank, s.label)
    from (
      select * from (
        (
          select 1 as rank, pp.name as label,
                 jsonb_build_object('kind', 'product', 'label', pp.name, 'slug', pp.slug) as item
          from public.public_products pp
          where pp.store_id = v_store.id
            and ebim.search_normalize(pp.name) like v_norm || '%'
          order by pp.name
          limit v_limit
        )
        union all
        (
          select 2, pp.name,
                 jsonb_build_object('kind', 'product', 'label', pp.name, 'slug', pp.slug)
          from public.public_products pp
          where pp.store_id = v_store.id
            and ebim.search_normalize(pp.name) like '%' || v_norm || '%'
            and ebim.search_normalize(pp.name) not like v_norm || '%'
          order by pp.name
          limit v_limit
        )
        union all
        (
          select 3, pc.name,
                 jsonb_build_object('kind', 'category', 'label', pc.name, 'slug', pc.slug)
          from public.public_categories pc
          where pc.store_id = v_store.id
            and ebim.search_normalize(pc.name) like '%' || v_norm || '%'
          order by pc.name
          limit 4
        )
        union all
        (
          select 4, b.name,
                 jsonb_build_object('kind', 'brand', 'label', b.name, 'slug', b.code)
          from public.brands b
          where b.organization_id = v_store.organization_id
            and b.company_id = v_store.company_id
            and b.is_active
            and ebim.search_normalize(b.name) like '%' || v_norm || '%'
            and exists (
              select 1 from public.public_products pp
              where pp.store_id = v_store.id and pp.brand_name = b.name
            )
          order by b.name
          limit 4
        )
      ) u
      order by u.rank, u.label
      limit v_limit
    ) s
  ), '[]'::jsonb);
end;
$fn$;

revoke execute on function public.catalog_suggest_for_slug(text, text, integer) from public;
grant execute on function public.catalog_suggest_for_slug(text, text, integer)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.catalog_search — el BACKOFFICE con sesion.
--
-- Segunda implementacion viva del `SearchPort`, y no una copia de la primera:
-- responde otra pregunta (incluye lo NO publicado) para otro actor (con
-- membresia). Es la misma forma que `InventoryPort` tiene desde P06 —
-- backoffice con cifra, vitrina con semaforo— y es lo que hace que el puerto
-- sea una frontera y no una indireccion.
--
-- Su primer llamante es el selector de productos del editor de contenido: hasta
-- hoy, montar una coleccion habria sido pegar uuids a mano (deuda que P10 dejo
-- escrita al no poner buscador en el editor de alcance de campanas).
-- ---------------------------------------------------------------------------
create or replace function public.catalog_search(
  p_store_id uuid,
  p_query    text default null,
  p_filters  jsonb default '{}'::jsonb,
  p_sort     text default 'relevance',
  p_limit    integer default 24,
  p_offset   integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store public.stores%rowtype;
begin
  select * into v_store from public.stores s where s.id = p_store_id;

  if not found then
    raise exception 'TIENDA_NO_ENCONTRADA: la tienda no existe' using errcode = '22023';
  end if;

  if not ebim.can_access(v_store.organization_id, v_store.company_id) then
    raise exception 'SIN_PERMISO: la tienda no pertenece a esta sociedad' using errcode = '42501';
  end if;

  return ebim.search_catalog(v_store.id, p_query, p_filters, p_sort, p_limit, p_offset, true);
end;
$fn$;

revoke execute on function public.catalog_search(uuid, text, jsonb, text, integer, integer)
  from public, anon;
grant execute on function public.catalog_search(uuid, text, jsonb, text, integer, integer)
  to authenticated, service_role;

comment on function public.catalog_search(uuid, text, jsonb, text, integer, integer) is
  'Busqueda del backoffice: incluye lo no publicado y exige membresia. Segunda implementacion del SearchPort, con otro actor y otra respuesta.';
