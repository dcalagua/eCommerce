-- =============================================================================
-- P11 · El comprador anonimo puede volver a su pedido
-- 24/24 — La confirmacion se pintaba desde `location.state` del router: al
--         recargar, el comprador se quedaba solo con el numero en la URL y sin
--         forma de ver su pedido. En una tienda con entregas a semanas eso
--         convierte cada consulta en un correo o una llamada.
--
-- Decision: NO se abre `orders` a `anon`. La policy sigue en default deny y la
-- unica puerta es una funcion `SECURITY DEFINER` que exige un token de 256 bits
-- que solo conoce quien hizo la compra. Abrir la tabla con una policy por
-- numero de pedido habria sido mas corto y habria dejado los pedidos de toda la
-- tienda a un bucle de distancia: los numeros son correlativos.
--
-- El token va en TABLA APARTE y no en una columna de `orders`. En Postgres, un
-- `revoke select (columna)` NO anula un `grant select` de tabla entera, asi que
-- una columna "privada" dentro de una tabla concedida es una ilusion; ademas,
-- cualquier columna futura de `orders` obligaria a repasar la lista del grant.
-- Una tabla propia hace el aislamiento estructural en vez de declarativo.
-- =============================================================================

create table public.order_tokens (
  order_id        uuid        primary key
                    references public.orders (id) on delete cascade,
  organization_id uuid        not null,
  company_id      uuid        not null,
  -- 2 uuid v4 sin guiones = 256 bits de entropia, en hexadecimal seguro para
  -- URL. `gen_random_uuid()` es nucleo de Postgres: no depende de pgcrypto ni
  -- de que la extension este habilitada en el proyecto.
  token           text        not null default
                    replace(gen_random_uuid()::text, '-', '') ||
                    replace(gen_random_uuid()::text, '-', ''),
  created_at      timestamptz not null default now(),
  constraint order_tokens_len    check (char_length(token) = 64),
  constraint order_tokens_unique unique (token)
);

create index order_tokens_tenant on public.order_tokens (organization_id, company_id);

-- Los pedidos que ya existen tambien reciben el suyo: si no, la confirmacion de
-- un pedido anterior a esta migracion seguiria sin poder recuperarse.
insert into public.order_tokens (order_id, organization_id, company_id)
select o.id, o.organization_id, o.company_id
from public.orders o
on conflict (order_id) do nothing;

-- ---------------------------------------------------------------------------
-- La unica puerta del comprador anonimo a su pedido.
--
-- Autorizacion explicita dentro (contrato): exige tienda ACTIVA, numero de
-- pedido Y token correcto. Sin los tres no devuelve nada, y no distingue entre
-- "no existe" y "token incorrecto": mensajes distintos permitirian enumerar
-- numeros de pedido, que son correlativos.
-- ---------------------------------------------------------------------------
create or replace function public.order_by_token(
  p_store_slug   text,
  p_order_number text,
  p_token        text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_order public.orders%rowtype;
  v_items jsonb;
begin
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  select o.* into v_order
  from public.orders o
  join public.stores s       on s.id = o.store_id
  join public.order_tokens t on t.order_id = o.id
  where s.slug = lower(btrim(p_store_slug))
    and s.status = 'active'
    and o.order_number = btrim(p_order_number)
    and t.token = p_token;

  if not found then
    raise exception 'PEDIDO_NO_ENCONTRADO: no hay ningun pedido con esos datos'
      using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'sku',        i.sku,
           'name',       i.name,
           'quantity',   i.quantity,
           'unit_price', i.unit_price::text
         ) order by i.name), '[]'::jsonb)
    into v_items
  from public.order_items i
  where i.order_id = v_order.id;

  -- Solo lo que el comprador necesita ver. Ni el token, ni los ids de tenant,
  -- ni el id interno del pedido: nada que sirva para pivotar.
  return jsonb_build_object(
    'order_number',     v_order.order_number,
    'status',           v_order.status,
    'currency',         v_order.currency,
    'placed_at',        v_order.placed_at,
    'customer_name',    v_order.customer_name,
    'subtotal',         v_order.subtotal::text,
    'tax_total',        v_order.tax_total::text,
    'grand_total',      v_order.grand_total::text,
    'shipping_address', v_order.shipping_address,
    'items',            v_items
  );
end;
$fn$;

revoke execute on function public.order_by_token(text, text, text) from public;
grant  execute on function public.order_by_token(text, text, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS — el token es secreto frente al MUNDO, no frente al comercio que lo emitio
-- ---------------------------------------------------------------------------
alter table public.order_tokens enable row level security;
alter table public.order_tokens force  row level security;

revoke all on public.order_tokens from public, anon, authenticated;
grant all    on public.order_tokens to service_role;

-- `anon` no recibe NADA: su unica via es la funcion.
-- El backoffice lee los suyos y solo los suyos. No es una fuga: su personal ya
-- ve el pedido entero, y con el token puede reenviarle al comprador el enlace de
-- seguimiento cuando lo pierda. Sin INSERT ni UPDATE: quien emite el token es
-- `create_order`, y un token que el cliente pueda reescribir no es un secreto.
grant select on public.order_tokens to authenticated;

create policy order_tokens_select_member on public.order_tokens
  for select to authenticated
  using (ebim.can_access(organization_id, company_id));

comment on table public.order_tokens is
  'Secreto de portador del comprador anonimo (256 bits). Tabla aparte y no columna de orders: un revoke por columna no anula el grant de tabla.';
comment on function public.order_by_token(text, text, text) is
  'Unica puerta del comprador anonimo a su pedido. Exige tienda activa + numero + token; no distingue "no existe" de "token incorrecto".';
