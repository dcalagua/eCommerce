-- =============================================================================
-- P09 · Cambio de tasa como operacion atomica
-- 18/18 — `tax_rates_one_open` permite UNA sola tasa abierta por categoria, asi
--         que cambiarla son dos pasos: cerrar la vigente y abrir la nueva. Si el
--         backoffice los hace por separado, un fallo entre medias deja la
--         categoria sin tasa —y `effective_tax_rate` cae al legado sin avisar—.
--
-- `security invoker` a proposito: NO es SECURITY DEFINER. La autorizacion la
-- siguen poniendo las policies de `tax_rates`/`tax_categories` con los claims
-- del JWT, asi que esta funcion no puede escribir nada que su llamante no
-- pudiera escribir directamente. El tenant sale de la categoria, nunca de un
-- parametro.
-- =============================================================================

create or replace function public.set_tax_rate(
  p_tax_category_id uuid,
  p_rate            numeric
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_category public.tax_categories%rowtype;
  v_rate_id  uuid;
begin
  if p_rate is null or p_rate < 0 or p_rate > 1 then
    raise exception 'TASA_INVALIDA: la tasa debe estar entre 0 y 1 (0.13 = 13%%)'
      using errcode = '22023';
  end if;

  -- La RLS de `tax_categories` decide si esta fila es visible: si el llamante
  -- no puede verla, aqui no hay categoria y la operacion termina en error.
  select * into v_category
  from public.tax_categories tc
  where tc.id = p_tax_category_id
  for update;

  if not found then
    raise exception 'CATEGORIA_NO_DISPONIBLE: la categoria fiscal % no existe o no es accesible',
      p_tax_category_id
      using errcode = '22023';
  end if;

  -- Cerrar y abrir en la MISMA transaccion: nunca hay un instante sin tasa
  -- vigente, y el indice parcial garantiza que no queden dos abiertas.
  update public.tax_rates
     set valid_to = now()
   where tax_category_id = v_category.id
     and valid_to is null;

  insert into public.tax_rates (organization_id, company_id, tax_category_id, rate)
  values (v_category.organization_id, v_category.company_id, v_category.id, p_rate)
  returning id into v_rate_id;

  return jsonb_build_object(
    'tax_rate_id',     v_rate_id,
    'tax_category_id', v_category.id,
    -- Texto, no numero JSON: el mismo motivo que en `create_order`.
    'rate',            p_rate::text
  );
end;
$fn$;

revoke execute on function public.set_tax_rate(uuid, numeric) from public, anon;
grant  execute on function public.set_tax_rate(uuid, numeric) to authenticated, service_role;

comment on function public.set_tax_rate(uuid, numeric) is
  'Cierra la tasa vigente de la categoria y abre la nueva en una transaccion. security invoker: la autorizacion la ponen las policies.';
