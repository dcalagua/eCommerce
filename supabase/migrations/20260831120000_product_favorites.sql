-- =============================================================================
-- Favoritos del comprador.
--
-- El comprador que guarda una referencia vuelve a por ella: es la lista de la
-- compra de quien reabastece todos los meses, y en B2B —una botica pidiendo lo
-- de siempre— es la funcion que mas se usa despues del buscador.
--
-- ## Quien puede escribir aqui, y por que no hay policy de INSERT
--
-- El comprador NO es miembro del tenant: no lleva `org_id` ni `companies[]` en
-- su JWT, asi que la regla de suite «el tenant sale del token» no se puede
-- aplicar tal cual. Lo que sale de su token es UNA cosa: `ebim.user_id()`, el `sub` de su JWT.
--
-- Por eso la unica puerta de escritura es `public.toggle_product_favorite`, que
-- es DEFINER y deriva el tenant del PRODUCTO, no de lo que diga el cliente. El
-- comprador solo puede nombrar un `product_id`; si ese producto no esta
-- publicado en una tienda activa, la funcion no escribe nada. Un `product_id`
-- de otro tenant es exactamente igual de valido de escribir y exactamente igual
-- de inutil: lo que se guarda es «este uuid le gusta a este uid», y leerlo solo
-- puede el dueno.
--
-- La tabla, en consecuencia, no tiene policy de escritura para nadie. Ni
-- `anon`, ni `authenticated`, ni el backoffice: se escribe por la funcion o no
-- se escribe.
--
-- ## El comprador anonimo no esta aqui
--
-- Sin sesion no hay `auth.uid()`, y la alternativa —un token de portador como
-- el del carrito invitado— seria una tabla que crece con cada visitante que
-- pulsa un corazon por curiosidad. Sus favoritos viven en `localStorage`, que
-- es lo que un anonimo espera: en ese navegador y en ninguno mas. Al iniciar
-- sesion, la vitrina los sube.
-- =============================================================================

create table public.product_favorites (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,
  company_id      uuid        not null,
  store_id        uuid        not null,
  product_id      uuid        not null,
  -- `sub` del JWT del comprador. Lo escribe la funcion desde `auth.uid()`; no
  -- hay forma de declararlo desde el navegador.
  user_id         uuid        not null,
  created_at      timestamptz not null default now(),
  -- Un producto no se puede guardar dos veces: el corazon es un interruptor,
  -- no un contador.
  constraint product_favorites_unique unique (user_id, product_id),
  constraint product_favorites_product_fk foreign key (product_id, store_id)
    references public.products (id, store_id) on delete cascade,
  constraint product_favorites_store_fk foreign key (store_id, organization_id, company_id)
    references public.stores (id, organization_id, company_id) on delete cascade
);

create index product_favorites_user_idx   on public.product_favorites (user_id, store_id);
create index product_favorites_tenant_idx on public.product_favorites (organization_id, company_id);
-- Para el backoffice: «que se guarda y no se compra» ordenado por producto.
create index product_favorites_product_idx on public.product_favorites (product_id);

alter table public.product_favorites enable row level security;
-- FORCE ademas de ENABLE: sin el, el dueno de la tabla se salta sus propias
-- policies, y las migraciones y los procesos de mantenimiento corren como
-- dueno. Es invariante de esquema en este repo, no una preferencia.
alter table public.product_favorites force  row level security;

-- Lectura del comprador: solo lo suyo, y solo lo suyo. No hay `using (true)`
-- por ningun lado.
create policy product_favorites_select_own on public.product_favorites
  for select to authenticated
  using (user_id = ebim.user_id());

-- Lectura del backoffice: el tenant ve lo que se guarda de SU catalogo. Es dato
-- agregable de negocio —que interesa y no se vende— y cae bajo la misma regla
-- de acceso que el resto de sus tablas.
create policy product_favorites_select_member on public.product_favorites
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

-- Privilegio de tabla: SOLO lectura, y solo para `authenticated`. Las policies
-- de arriba deciden QUE filas; esto decide que la escritura no existe ni como
-- posibilidad, ni siquiera para quien tenga una policy que se le olvidara a
-- alguien. `anon` no aparece: sin sesion no hay nada suyo que leer.
grant select on public.product_favorites to authenticated;
grant all    on public.product_favorites to service_role;

comment on table public.product_favorites is
  'Favoritos del comprador con sesion. Se escribe SOLO por toggle_product_favorite (DEFINER): el tenant sale del producto, nunca del cliente.';
comment on column public.product_favorites.user_id is
  'sub del JWT del comprador. Lo pone la funcion desde ebim.user_id().';

-- ---------------------------------------------------------------------------
-- toggle_product_favorite — la unica puerta de escritura.
--
-- Devuelve el estado NUEVO (`true` = guardado), que es lo que la vitrina pinta.
-- Idempotente por definicion: pulsar dos veces deja lo mismo que no pulsar.
-- ---------------------------------------------------------------------------
create or replace function public.toggle_product_favorite(p_product_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- `ebim.user_id()` es el `sub` del JWT, el mismo helper que usa el resto del
  -- esquema. `auth.uid()` haria lo mismo, pero atarse al helper propio deja la
  -- funcion probable en el banco de pruebas y consistente con las demas.
  v_user    uuid := ebim.user_id();
  v_product record;
  v_deleted int;
begin
  if v_user is null then
    raise exception 'SESION_REQUERIDA: hay que iniciar sesion para guardar favoritos'
      using errcode = '28000';
  end if;

  -- El producto tiene que estar PUBLICADO en una tienda ACTIVA. Es la misma
  -- frontera que ve el comprador en la vitrina: si no lo puede ver, no lo puede
  -- guardar, y de paso el tenant sale de aqui y no del cliente.
  select p.id, p.store_id, p.organization_id, p.company_id
    into v_product
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.id = p_product_id
    and p.status = 'published'
    and p.published_at is not null
    and p.published_at <= now()
    and s.status = 'active';

  if not found then
    raise exception 'PRODUCTO_NO_ENCONTRADO: no hay ningun producto publicado con ese id'
      using errcode = '22023';
  end if;

  delete from public.product_favorites f
   where f.user_id = v_user and f.product_id = p_product_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    return false;
  end if;

  insert into public.product_favorites
    (organization_id, company_id, store_id, product_id, user_id)
  values
    (v_product.organization_id, v_product.company_id, v_product.store_id, p_product_id, v_user);

  return true;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- my_product_favorites — los ids que el comprador tiene guardados en UNA tienda.
--
-- Solo ids: la ficha de cada producto ya la sirve `public_products`, con su
-- precio resuelto y su disponibilidad. Duplicar aqui esos campos seria una
-- segunda fuente de la misma verdad, y acabarian discrepando.
--
-- Es DEFINER por simetria con el toggle —una sola puerta, una sola regla— y
-- porque asi la vitrina no necesita saber si la policy de lectura existe.
-- ---------------------------------------------------------------------------
create or replace function public.my_product_favorites(p_store_id uuid)
returns table (product_id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  select f.product_id
  from public.product_favorites f
  join public.products p on p.id = f.product_id
  where f.user_id = ebim.user_id()
    and f.store_id = p_store_id
    -- Lo despublicado desaparece de la lista sin borrarse: el dia que el
    -- comercio lo vuelva a publicar, sigue guardado.
    and p.status = 'published'
    and p.published_at is not null
    and p.published_at <= now();
$fn$;

revoke execute on function public.toggle_product_favorite(uuid) from public;
revoke execute on function public.my_product_favorites(uuid)   from public;
-- `anon` no: sin sesion no hay favoritos que guardar ni que leer, y dejarle la
-- llamada solo le daria un error a cambio de una peticion.
grant execute on function public.toggle_product_favorite(uuid) to authenticated;
grant execute on function public.my_product_favorites(uuid)    to authenticated;

comment on function public.toggle_product_favorite(uuid) is
  'Interruptor del favorito. DEFINER con autorizacion dentro: exige sesion y producto publicado de tienda activa; el tenant sale del producto.';
comment on function public.my_product_favorites(uuid) is
  'Ids favoritos del comprador en una tienda. Solo los suyos y solo lo que sigue publicado.';
