-- =============================================================================
-- P18 · Categorias en ARBOL (fase 1: los cimientos).
--
-- `categories.parent_id` existe desde P02 con su clave ajena a la misma tienda,
-- su indice y su `on delete set null` — pero nadie lo escribia: el formulario no
-- tenia el campo y las 37 categorias de la demo eran todas raiz. Antes de dejar
-- que alguien construya una jerarquia hay que poner las dos barandillas que
-- faltan, porque las dos rompen consultas, no datos:
--
--  1. **Ciclos.** El unico guard era `categories_not_self` (A no es su propia
--     madre). `A → B → A` entraba sin protesta, y un ciclo cuelga cualquier
--     recorrido recursivo — incluido el que la vitrina va a usar para resolver
--     "esta categoria y todo lo que cuelga de ella".
--  2. **Profundidad.** Sin tope, un arbol de doce niveles es un menu que nadie
--     navega y una consulta que crece sin motivo. Tres niveles es lo que el
--     comercio usa de verdad: `Salud › Sistema nervioso › Analgesicos`.
--
-- El trigger comprueba las dos cosas a la vez y en el mismo sitio, porque son
-- la misma pregunta hecha desde los dos lados: subir por los ancestros dice si
-- hay ciclo y a que altura queda el nodo; bajar por los descendientes dice
-- cuanto arbol lleva colgando. MOVER una rama es la operacion que puede violar
-- el tope sin que el nodo movido cambie de sitio: por eso no basta con mirar
-- hacia arriba.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.category_depth_above — cuantos niveles hay POR ENCIMA, y hay ciclo?
--
-- Devuelve el numero de ancestros. Levanta si encuentra dos veces el mismo
-- nodo: eso solo pasa con un ciclo ya escrito, y es mejor gritar que colgarse.
-- ---------------------------------------------------------------------------
create or replace function ebim.category_depth_above(p_category_id uuid)
returns integer
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_current uuid := p_category_id;
  v_levels  integer := 0;
begin
  while v_current is not null loop
    select c.parent_id into v_current from public.categories c where c.id = v_current;
    exit when v_current is null;
    v_levels := v_levels + 1;
    -- Cinco vueltas es mas de lo que el tope permite: si seguimos subiendo, lo
    -- que hay arriba es un bucle.
    if v_levels > 5 then
      raise exception 'CATEGORIA_CICLO: la jerarquia de categorias tiene un bucle'
        using errcode = '22023';
    end if;
  end loop;
  return v_levels;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.category_height_below — cuanto arbol cuelga de un nodo.
--
-- 0 = hoja. Se usa al mover una rama: el limite se comprueba contra el nodo mas
-- profundo que viaja con ella, no contra el que se arrastra.
-- ---------------------------------------------------------------------------
create or replace function ebim.category_height_below(p_category_id uuid)
returns integer
language sql
stable
set search_path = ''
as $fn$
  with recursive rama as (
    select c.id, 0 as nivel
      from public.categories c
     where c.id = p_category_id
    union all
    select h.id, r.nivel + 1
      from public.categories h
      join rama r on h.parent_id = r.id
     -- Corta un arbol ya corrupto en vez de girar para siempre.
     where r.nivel < 8
  )
  select coalesce(max(nivel), 0) from rama;
$fn$;

-- ---------------------------------------------------------------------------
-- ebim.category_subtree — la categoria Y todo lo que cuelga de ella.
--
-- Es la pieza de la que depende todo lo demas: sin ella, abrir una categoria
-- madre en la vitrina devuelve cero productos, porque los productos cuelgan de
-- las hijas. La usan la busqueda de catalogo y las reglas que heredan.
--
-- `security definer` porque el llamante legitimo es la vitrina ANONIMA, que no
-- tiene ningun grant sobre `public.categories` — lee por las vistas `public_*`.
-- Lo que revela es un conjunto de uuid de UNA tienda, derivado del id que se le
-- pasa: no expone ni un nombre ni cruza tiendas, porque la clave ajena de
-- `parent_id` ya obliga a que padre e hija compartan `store_id`.
-- ---------------------------------------------------------------------------
create or replace function ebim.category_subtree(p_category_id uuid)
returns table (category_id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  with recursive rama as (
    select c.id, 0 as nivel
      from public.categories c
     where c.id = p_category_id
    union all
    select h.id, r.nivel + 1
      from public.categories h
      join rama r on h.parent_id = r.id
     where r.nivel < 8
  )
  select id from rama;
$fn$;

revoke execute on function ebim.category_subtree(uuid) from public;
grant execute on function ebim.category_subtree(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El guard, en un trigger.
--
-- En trigger y no en CHECK porque un CHECK no puede consultar otras filas: la
-- pregunta "cuantos ancestros tiene mi padre" es, por definicion, sobre filas
-- que no son la que se esta escribiendo.
-- ---------------------------------------------------------------------------
create or replace function ebim.assert_category_tree()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_above  integer;
  v_below  integer;
  v_cursor uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  -- 1 · Ciclo: el nuevo padre no puede estar colgando de MI.
  v_cursor := new.parent_id;
  while v_cursor is not null loop
    if v_cursor = new.id then
      raise exception 'CATEGORIA_CICLO: una categoria no puede colgar de una de sus descendientes'
        using errcode = '22023';
    end if;
    select c.parent_id into v_cursor from public.categories c where c.id = v_cursor;
  end loop;

  -- 2 · Profundidad, contando lo que ya cuelga de esta rama. El tope es de
  --     TRES niveles: raiz, hija y nieta.
  v_above := 1 + ebim.category_depth_above(new.parent_id);
  v_below := case when tg_op = 'UPDATE' then ebim.category_height_below(new.id) else 0 end;

  if v_above + v_below + 1 > 3 then
    raise exception
      'CATEGORIA_PROFUNDIDAD: el arbol de categorias admite tres niveles y esto haria %',
      v_above + v_below + 1
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

drop trigger if exists categories_tree_guard on public.categories;
create trigger categories_tree_guard
  before insert or update of parent_id on public.categories
  for each row execute function ebim.assert_category_tree();

comment on function ebim.assert_category_tree() is
  'Barandillas del arbol de categorias: sin ciclos y con tope de tres niveles, contando lo que ya cuelga al mover una rama.';
comment on function ebim.category_subtree(uuid) is
  'La categoria y todas sus descendientes. Definer: el llamante legitimo es la vitrina anonima, que no lee public.categories.';
