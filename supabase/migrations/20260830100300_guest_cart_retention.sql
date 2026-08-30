-- =============================================================================
-- P16-SaaS · 4/4 — El carrito de invitado deja de ser basura permanente
--
-- HALLAZGO (medido, no supuesto). `public.cart_open(slug, null)` esta concedida
-- a `anon` y, cuando el invitado llega SIN token, no lee: INSERTA. Y nada borra
-- nunca esa fila. Medido sobre Postgres real con 40 llamadas anonimas seguidas:
--
--     carritos tras 40 llamadas ......... 40
--     tras caducar y volver a llamar .... 1 active + 40 abandoned
--
-- `ebim.expire_due_carts` solo cambia el ESTADO. La fila se queda para siempre.
--
-- ## Por que importa, y por que es de esta fase
--
-- Es la misma clase de hallazgo que el techo de `analytics.track` (100200):
-- escritura anonima, sin coste para quien llama y sin recogida. La diferencia
-- es que esta estaba en la ruta mas caliente de la vitrina —`CartProvider`
-- envuelve el layout entero, o sea TODAS las paginas— asi que no hacia falta un
-- atacante: cada visita anonima, y cada rastreador que sigue el sitemap de P15,
-- dejaba una fila. La factura y el indice son del comercio.
--
-- Y contradecia de frente la decision escrita en la cabecera de 100000:
--
--     «El invitado sigue comprando desde localStorage. Nadie crea una fila por
--      visita: un carrito de servidor por cada persona que abre el catalogo
--      seria una tabla de basura con un indice caro y un dato personal mas que
--      custodiar. La fila nace cuando hace falta de verdad.»
--
-- El cliente ya no la llama sin motivo (`CartProvider`, misma fase). Esto es la
-- otra mitad: `cart_open` es una funcion PUBLICA concedida a `anon`, asi que su
-- limite no puede depender de que el unico llamador se porte bien.
--
-- ## Por que RECOGER y no NEGAR
--
-- Un techo por tienda sobre la creacion de carritos —el mecanismo de 100200—
-- seria aqui la decision equivocada, y conviene dejar escrito por que: el
-- contador de 100200 es POR TIENDA porque la base no ve la IP, asi que quien
-- abusa gasta el presupuesto de todos. En la analitica eso solo cuesta medicion
-- y por eso alli se DEGRADA. Aqui el carrito es la puerta de cada venta:
-- negarlo convertiria un ataque contra el ALMACENAMIENTO en un ataque contra
-- las VENTAS, que es estrictamente peor. El limite volumetrico real es por IP y
-- vive en el WAF — declarado como control externo en SECURITY_BASELINE §9.3.
--
-- Lo que si se puede hacer dentro de Postgres es que el dano sea TRANSITORIO en
-- vez de permanente: se recoge lo que no vale nada, y el trafico que crea las
-- filas es el mismo que paga por recogerlas.
--
-- ## Que se borra, exactamente
--
-- Solo el carrito que no le importa a nadie. Las siete condiciones:
--
--   1. `user_id is null`  — de invitado. El de quien tiene sesion viaja con el.
--   2. `status = 'abandoned'` — ya caducado por `expire_due_carts`. Nunca uno
--      activo, y nunca uno 'merged' o 'converted': esos son rastro de algo que
--      paso de verdad.
--   3. `order_id is null` — jamas se convirtio en pedido.
--   4. sin lineas — un carrito abandonado CON lineas es la materia prima de una
--      campana de recuperacion y de la analitica del comercio: eso no es basura
--      y no se toca. El bucle de abuso crea exclusivamente carritos vacios, asi
--      que esta condicion no le deja ni un hueco.
--   5. sin intento de checkout — si llego a la caja hubo intencion, aunque hoy
--      se vea vacio.
--   6. nadie se fusiono hacia el — el rastro de la fusion se mantiene entero.
--   7. quieto desde hace la gracia (1 h por defecto) — sumada a las 2 h de
--      caducidad del invitado, una fila vive al menos 3 h desde su ultimo uso.
--
-- La FK de `cart_items` y la de `checkout_intents` son `on delete cascade` y
-- `carts.merged_into` es `on delete set null`, asi que el borrado no puede
-- dejar nada colgando. Aun asi 5 y 6 estan escritas: no borrar es mejor que
-- borrar y que la cascada lo arregle.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Los dos indices que la recogida necesita para no ser peor que el problema
--
-- El candidato se elige con `carts_store (store_id, status, last_activity_at)`,
-- que ya existe desde 100000. Pero las dos comprobaciones de seguridad —«nadie
-- se fusiono hacia el» y «no llego a la caja»— caen sobre columnas SIN indice:
-- `carts.merged_into` y `checkout_intents.cart_id`. Sin estos dos, cada
-- candidato provoca un recorrido secuencial de `carts`, o sea justo de la tabla
-- que puede haber crecido, y dentro de la llamada de un comprador. La limpieza
-- se habria convertido en el cuello de botella que venia a evitar.
--
-- Parciales los dos: `merged_into` es nulo en la inmensa mayoria de las filas
-- —solo lo lleva el carrito de invitado que se fusiono al iniciar sesion— y un
-- indice sobre nulos es paginas que nadie lee.
-- ---------------------------------------------------------------------------
create index if not exists carts_merged_into
  on public.carts (merged_into) where merged_into is not null;

create index if not exists checkout_intents_cart
  on public.checkout_intents (cart_id);

-- ---------------------------------------------------------------------------
-- ebim.sweep_empty_guest_carts — la recogida oportunista.
--
-- Acotada por `p_limit`. El tope no es cosmetico: esto lo ejecuta la llamada de
-- un comprador anonimo, y una limpieza sin techo convertiria la abertura de un
-- carrito en un trabajo de duracion desconocida — es decir, en otra forma de
-- dejar la tienda sin servicio. Con un tope, cada llamada hace un trozo y el
-- estado estacionario se sostiene solo: quien crea filas mas rapido tambien
-- llama mas veces, y cada una de sus llamadas recoge hasta `p_limit`.
--
-- Se llama desde `cart_open` por la misma razon que se llama alli
-- `expire_due_carts` (100100): «este proyecto no tiene un planificador
-- garantizado, y una caducidad que depende de un job que puede no existir no
-- existe».
--
-- El indice `carts_store (store_id, status, last_activity_at desc)` de 100000
-- es exactamente el de esta consulta. No hace falta uno nuevo.
-- ---------------------------------------------------------------------------
create or replace function ebim.sweep_empty_guest_carts(
  p_store_id uuid,
  p_grace    interval default '1 hour',
  p_limit    integer  default 50
)
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  if p_store_id is null then
    return 0;
  end if;

  with candidatos as (
    select c.id
    from public.carts c
    where c.store_id  = p_store_id
      and c.status    = 'abandoned'
      and c.user_id   is null
      and c.order_id  is null
      and c.last_activity_at < now() - coalesce(p_grace, interval '1 hour')
      and not exists (select 1 from public.cart_items i where i.cart_id = c.id)
      and not exists (select 1 from public.checkout_intents ci where ci.cart_id = c.id)
      and not exists (select 1 from public.carts o where o.merged_into = c.id)
    order by c.last_activity_at
    limit greatest(coalesce(p_limit, 50), 0)
    -- `skip locked` porque esto lo ejecutan compradores EN PARALELO. Sin el,
    -- dos visitas simultaneas eligen las mismas filas —mismo orden, mismo
    -- limite—, la segunda se queda esperando a que la primera confirme, y abrir
    -- un carrito pasa a depender de cuanta gente hay abriendo carritos. Saltar
    -- lo que otro ya tiene cogido es ademas lo correcto: esa fila se va igual,
    -- solo que la borra el otro.
    for update skip locked
  )
  delete from public.carts c
   using candidatos k
   where c.id = k.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

comment on function ebim.sweep_empty_guest_carts(uuid, interval, integer) is
  'Recoge los carritos de invitado que quedaron vacios y abandonados: sin dueno, sin lineas, sin pedido, sin intento de checkout y sin fusion. Acotada por limite porque la ejecuta la llamada de un comprador (P16-SaaS).';

-- ---------------------------------------------------------------------------
-- public.purge_empty_guest_carts — la version del planificador.
--
-- Misma regla, sin tope y para todas las tiendas. Es la sexta `purge_*` del
-- proyecto y entra en la misma ficha de despliegue que las otras cinco
-- (SECURITY_BASELINE §9.4). La recogida oportunista de arriba existe
-- precisamente para que el dia que ese planificador no este, esto no se
-- convierta en el agujero que era.
-- ---------------------------------------------------------------------------
create or replace function public.purge_empty_guest_carts(
  p_older_than interval default '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  delete from public.carts c
   where c.status   = 'abandoned'
     and c.user_id  is null
     and c.order_id is null
     and c.last_activity_at < now() - p_older_than
     and not exists (select 1 from public.cart_items i where i.cart_id = c.id)
     and not exists (select 1 from public.checkout_intents ci where ci.cart_id = c.id)
     and not exists (select 1 from public.carts o where o.merged_into = c.id);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke execute on function public.purge_empty_guest_carts(interval)
  from public, anon, authenticated;
grant  execute on function public.purge_empty_guest_carts(interval) to service_role;

comment on function public.purge_empty_guest_carts(interval) is
  'Purga programada de carritos de invitado vacios y abandonados. Solo service_role (P16-SaaS).';

revoke execute on function ebim.sweep_empty_guest_carts(uuid, interval, integer)
  from public, anon, authenticated;

-- A `service_role` SI, y por el mismo criterio que `ebim.merge_cart_lines`
-- (100100): es la unica forma de comprar el TOPE POR LLAMADA en un test, que es
-- justo la propiedad que impide que esta limpieza deje sin servicio a la
-- tienda. Y no le concede nada que no tuviera: ya puede llamar a
-- `purge_empty_guest_carts`, que hace lo mismo sin tope y en todas las tiendas.
grant execute on function ebim.sweep_empty_guest_carts(uuid, interval, integer) to service_role;

-- =============================================================================
-- public.cart_open — reemitida entera con la recogida dentro
--
-- `create or replace` completo porque una migracion aplicada es inmutable. Ni
-- una linea de conducta cambia respecto de 100100 salvo la marcada `P16-SaaS`.
-- =============================================================================
create or replace function public.cart_open(
  p_store_slug text,
  p_token      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store   public.stores%rowtype;
  v_channel public.channels%rowtype;
  v_user    uuid := ebim.user_id();
  v_token   text := nullif(btrim(coalesce(p_token, '')), '');
  v_guest   public.carts%rowtype;
  v_cart    public.carts%rowtype;
begin
  v_store   := ebim.active_store_by_slug(p_store_slug);
  v_channel := ebim.public_channel(v_store.id);

  perform ebim.expire_due_carts(v_store.id);
  -- P16-SaaS. Va DESPUES de caducar y ANTES de crear: asi la fila que esta
  -- llamada acaba de dejar madura es candidata en la siguiente, y la que se
  -- cree abajo nunca se recoge a si misma.
  perform ebim.sweep_empty_guest_carts(v_store.id);

  if v_token is not null and char_length(v_token) = 64 then
    select * into v_guest
    from public.carts c
    where c.store_id = v_store.id
      and c.token = v_token
      and c.status = 'active';
    if not found then v_guest := null; end if;
  end if;

  if v_user is null then
    -- Invitado. Un token de un carrito CON dueño no vale: ese carrito exige la
    -- sesion de su dueño y aqui no hay ninguna.
    if v_guest.id is not null and v_guest.user_id is null then
      update public.carts
         set last_activity_at = now()
       where id = v_guest.id;
      return ebim.cart_payload(v_guest.id, true);
    end if;

    insert into public.carts (
      organization_id, company_id, store_id, channel_id, currency, expires_at
    ) values (
      v_store.organization_id, v_store.company_id, v_store.id, v_channel.id,
      v_store.currency, now() + interval '2 hours'
    )
    returning * into v_cart;

    return ebim.cart_payload(v_cart.id, true);
  end if;

  -- Con sesion: su carrito activo de esta tienda y este canal, o uno nuevo.
  select * into v_cart
  from public.carts c
  where c.store_id   = v_store.id
    and c.channel_id = v_channel.id
    and c.user_id    = v_user
    and c.status     = 'active';

  if not found then
    insert into public.carts (
      organization_id, company_id, store_id, channel_id, user_id, currency, expires_at
    ) values (
      v_store.organization_id, v_store.company_id, v_store.id, v_channel.id, v_user,
      v_store.currency, now() + interval '30 days'
    )
    returning * into v_cart;
  end if;

  -- La fusion, si el invitado traia carrito.
  if v_guest.id is not null and v_guest.user_id is null and v_guest.id <> v_cart.id then
    perform ebim.merge_cart_lines(v_guest.id, v_cart.id);
    perform ebim.cart_refresh_prices(v_cart.id);
  end if;

  update public.carts
     set last_activity_at = now()
   where id = v_cart.id;

  return ebim.cart_payload(v_cart.id, true);
end;
$fn$;

comment on function public.cart_open(text, text) is
  'Abre o recupera el carrito de quien llama: con sesion el suyo, sin sesion el del token. Un token de invitado presentado CON sesion fusiona ese carrito en el del usuario. Recoge de paso los carritos de invitado que quedaron vacios (P16-SaaS).';
