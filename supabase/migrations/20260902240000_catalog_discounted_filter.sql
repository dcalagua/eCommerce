-- =============================================================================
-- P18 · El catalogo sabe filtrar por REBAJADO.
--
-- La portada abre con una oferta concreta —producto, precio antes, precio
-- ahora— y para eso hay que poder PEDIR lo rebajado. Sin este filtro solo
-- quedaban dos caminos, los dos malos: leer `public_products` desde el
-- navegador —que es justo lo que P11 prohibio, y que un test de la vitrina
-- vigila— o traerse una pagina entera y descartar a mano, que con 568
-- productos y 61 rebajados es traer 24 para quedarse con dos.
--
-- Se anade como un filtro mas de `catalog_search_for_slug`, que es la unica
-- puerta del catalogo. Con eso, «Ofertas» deja de ser un ancla en la portada y
-- pasa a ser una vista del catalogo como cualquier otra: se comparte por URL,
-- se pagina y se combina con categoria o marca.
--
-- La definicion de abajo es la vigente en la base con dos anadidos marcados:
-- la variable `v_discount` y su clausula en `filtered`. Nada mas cambia.
-- =============================================================================

CREATE OR REPLACE FUNCTION ebim.search_catalog(p_store_id uuid, p_query text, p_filters jsonb, p_sort text, p_limit integer, p_offset integer, p_include_unpublished boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_filters   jsonb   := coalesce(p_filters, '{}'::jsonb);
  v_norm      text    := ebim.search_normalize(p_query);
  v_query     tsquery;
  v_limit     integer := least(greatest(coalesce(p_limit, 24), 1), 60);
  v_offset    integer := greatest(coalesce(p_offset, 0), 0);
  v_sort      text    := coalesce(nullif(btrim(coalesce(p_sort, '')), ''), 'relevance');
  v_category  text    := nullif(btrim(coalesce(v_filters ->> 'category', '')), '');
  -- P18 · La categoria pedida Y SU DESCENDENCIA. Se resuelve una vez, aqui:
  -- dentro del `where` obligaria a recorrer el arbol por fila.
  --
  -- Si el slug no existe, `array_agg` devuelve NULL y `= any (null)` no deja
  -- pasar ninguna fila — que es exactamente lo que hacia el filtro por slug
  -- cuando no encontraba nada.
  v_category_ids uuid[] := case
    when nullif(btrim(coalesce(v_filters ->> 'category', '')), '') is null then null
    else (
      select array_agg(s.category_id)
      from public.categories c
      cross join lateral ebim.category_subtree(c.id) s
      where c.store_id = p_store_id
        and lower(c.slug) = lower(btrim(v_filters ->> 'category'))
    )
  end;
  v_brands    text[];
  v_avail     text    := coalesce(nullif(btrim(coalesce(v_filters ->> 'availability', '')), ''), 'all');
  -- P18 · «Solo lo rebajado». Un booleano y no una lista: es un si/no, y el
  -- valor que no sea booleano se ignora en vez de reventar, como el resto de
  -- este bloque — es un filtro, no una orden de cobro.
  v_discount  boolean := coalesce((v_filters ->> 'discounted')::boolean, false);
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
    -- P18 · Abrir una categoria enseña lo que cuelga de ella. Antes se
    -- comparaba `category_slug` exacto y una madre con toda su carga en las
    -- hijas —«Nutricion», 81 productos— devolvia CERO.
    where (v_category is null or b.category_id = any (v_category_ids))
      and (v_brands is null or lower(coalesce((
            select br.code from public.brands br where br.id = b.brand_id
          ), '')) = any (v_brands))
      and (v_avail <> 'in-stock' or coalesce(b.in_stock, false))
      -- Rebajado es «hay un antes y es MAYOR»: un `compare_at_price` igual o
      -- menor que el precio no es una oferta, es un dato mal puesto, y
      -- anunciarlo como rebaja seria mentir al comprador.
      and (
        not v_discount
        or (b.compare_at_price is not null and b.compare_at_price > b.price)
      )
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
$function$;


comment on function ebim.search_catalog is
  'Busca en el catalogo publicado. Filtros: categoria, marcas, disponibilidad, precio, atributos y REBAJADO (compare_at_price > price).';
