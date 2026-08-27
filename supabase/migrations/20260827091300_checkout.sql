-- =============================================================================
-- P06 · Checkout público — la tienda la resuelve el SERVIDOR.
--
-- Hasta P05 el comprador anónimo mandaba el `store_id` que había leído de
-- `public_stores`. Funcionaba, pero dejaba en el cuerpo de la petición un
-- identificador de fila que el cliente elige: cualquiera podía probar uuids
-- ajenos contra `create-order`. A partir de aquí el carrito viaja con el
-- **slug de la URL** —que es público por definición— y es la base la que lo
-- traduce a una tienda ACTIVA. Lo que el cliente declara vuelve a ser solo
-- «qué producto y cuántas unidades».
--
-- Todo el dinero lo sigue calculando `public.create_order`: esta función no
-- duplica ni una línea de esa lógica, solo resuelve la tienda y delega dentro
-- de la MISMA transacción (pedido + líneas + stock + numeración, todo o nada).
-- =============================================================================

create or replace function public.create_order_for_slug(
  p_store_slug       text,
  p_customer_email   text,
  p_items            jsonb,
  p_customer_name    text default null,
  p_customer_phone   text default null,
  p_shipping_address jsonb default '{}'::jsonb,
  p_notes            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_store_id uuid;
  v_slug     text := lower(btrim(coalesce(p_store_slug, '')));
begin
  if v_slug = '' then
    raise exception 'TIENDA_NO_DISPONIBLE: falta la tienda del pedido'
      using errcode = '22023';
  end if;

  -- Misma condición que la vista pública `public_stores`: solo tienda ACTIVA.
  -- Una tienda en borrador o suspendida no vende, aunque su slug se conozca.
  select s.id into v_store_id
  from public.stores s
  where lower(s.slug) = v_slug
    and s.status = 'active';

  if not found then
    raise exception 'TIENDA_NO_DISPONIBLE: la tienda "%" no existe o no esta activa', v_slug
      using errcode = '22023';
  end if;

  return public.create_order(
    v_store_id,
    p_customer_email,
    p_items,
    p_customer_name,
    p_customer_phone,
    p_shipping_address,
    p_notes
  );
end;
$fn$;

-- Solo el servidor. Igual que `create_order`: el llamador legítimo es la Edge
-- Function con `service_role`, nunca el navegador (lección esupplier-030).
revoke execute on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text)
from public, anon, authenticated;

grant execute on function
  public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text)
to service_role;

comment on function public.create_order_for_slug(text, text, jsonb, text, text, jsonb, text) is
  'Checkout publico: resuelve la tienda por slug (solo activa) y delega en create_order. Solo service_role.';
