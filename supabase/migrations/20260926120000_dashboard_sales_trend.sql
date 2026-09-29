-- =============================================================================
-- Resumen v2 · Tendencia de ventas por periodo
--
-- `dashboard_kpis` cuenta desde el principio de los tiempos, y en P18 se decidió
-- a propósito no darle una serie temporal: los pedidos de entonces caían todos
-- en un día y una línea de un punto era decoración. Hoy la tienda de trabajo
-- tiene pedidos repartidos en semanas, y el Resumen v2 pregunta otra cosa:
-- «¿cómo voy en este periodo y comparado con el anterior?».
--
-- Esta función NO sustituye a `dashboard_kpis` (el estado de la tienda sigue
-- siendo el acumulado); añade el rendimiento de una ventana:
--
--   · `sales` / `previous_sales` — ventas del periodo y del periodo anterior de
--                                  la misma longitud. La variación la calcula
--                                  la pantalla, y solo si hay base (> 0).
--   · `orders` / `avg_ticket`    — pedidos no anulados del periodo y su ticket.
--   · `series`                   — un punto por día (7d, 30d) o por mes (12m),
--                                  CON los ceros: un día sin ventas es un dato.
--   · `best`                     — el mejor día / mes del periodo.
--
-- Mismas reglas que el resto del panel:
--   · `security invoker`: suma bajo la RLS de quien pregunta.
--   · Dinero como texto (decisión P02 #19).
--   · Sin moneda única no hay cifra: si las dos ventanas mezclan monedas,
--     comparar soles con dólares mentiría y la función devuelve null.
--   · Sin pedidos en las dos ventanas, la venta del periodo ES cero: se afirma
--     con la moneda de la tienda (si el usuario la ve), no se inventa.
--
-- Los días se cortan en la zona horaria de quien mira (`p_tz`, validada contra
-- `pg_timezone_names`; si no existe, UTC): el «hoy» de Lima no es el de UTC y
-- una venta de las 21:00 no puede caer en el día siguiente.
-- =============================================================================

create or replace function public.dashboard_sales_trend(
  p_store_id uuid default null,
  p_period   text default '30d',
  p_tz       text default 'UTC'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_tz          text;
  v_unit        text;
  v_len         integer;
  v_today       date;
  v_start       date;
  v_from        timestamptz;
  v_prev_from   timestamptz;
  v_to          timestamptz;
  v_currencies  text[];
  v_currency    text;
  v_sales       numeric(14,2);
  v_prev        numeric(14,2);
  v_orders      bigint;
  v_series      jsonb;
  v_best        jsonb;
begin
  if p_period is null or p_period not in ('7d', '30d', '12m') then
    raise exception 'periodo no valido' using errcode = '22023';
  end if;

  v_tz := case
            when exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then p_tz
            else 'UTC'
          end;
  v_today := (now() at time zone v_tz)::date;

  if p_period = '12m' then
    v_unit      := 'month';
    v_start     := (date_trunc('month', v_today) - interval '11 months')::date;
    v_prev_from := ((v_start - interval '12 months')::timestamp) at time zone v_tz;
  else
    v_unit      := 'day';
    v_len       := case p_period when '7d' then 7 else 30 end;
    v_start     := v_today - (v_len - 1);
    v_prev_from := ((v_start - v_len)::timestamp) at time zone v_tz;
  end if;
  v_from := (v_start::timestamp) at time zone v_tz;
  v_to   := ((v_today + 1)::timestamp) at time zone v_tz;

  -- Una sola pasada sobre las dos ventanas. Anulados fuera, como en las ventas
  -- de `dashboard_kpis`: las dos cifras de la pantalla tienen que cuadrar.
  select coalesce(array_agg(distinct o.currency::text), '{}'::text[]),
         coalesce(sum(o.grand_total) filter (where o.placed_at >= v_from), 0),
         coalesce(sum(o.grand_total) filter (where o.placed_at <  v_from), 0),
         count(*) filter (where o.placed_at >= v_from)
    into v_currencies, v_sales, v_prev, v_orders
  from public.orders o
  where (p_store_id is null or o.store_id = p_store_id)
    and o.status <> 'cancelled'
    and o.placed_at >= v_prev_from
    and o.placed_at <  v_to;

  if array_length(v_currencies, 1) = 1 then
    v_currency := v_currencies[1];
  elsif coalesce(array_length(v_currencies, 1), 0) = 0 and p_store_id is not null then
    -- Ningún pedido en ninguna ventana: cero es la verdad, en la moneda de la
    -- tienda. La lectura pasa por la RLS de `stores`: una tienda ajena no
    -- devuelve fila y la cifra se queda en null.
    select s.currency::text into v_currency from public.stores s where s.id = p_store_id;
  end if;

  if v_currency is null then
    return jsonb_build_object(
      'period', p_period, 'unit', v_unit, 'currency', null,
      'sales', null, 'previous_sales', null, 'orders', v_orders,
      'avg_ticket', null, 'series', '[]'::jsonb, 'best', null
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(b.d, 'YYYY-MM-DD'),
                                               'sales', coalesce(s.total, 0)::numeric(14,2)::text)
                            order by b.d), '[]'::jsonb)
    into v_series
  from generate_series(v_start::timestamp, v_today::timestamp, ('1 ' || v_unit)::interval) as b(d)
  left join (
    select date_trunc(v_unit, o.placed_at at time zone v_tz) as d,
           sum(o.grand_total) as total
    from public.orders o
    where (p_store_id is null or o.store_id = p_store_id)
      and o.status <> 'cancelled'
      and o.placed_at >= v_from
      and o.placed_at <  v_to
    group by 1
  ) s on s.d = b.d;

  -- El mejor punto, solo si vendió algo: «mejor día: 0» no es un récord.
  select jsonb_build_object('date', e->>'date', 'sales', e->>'sales')
    into v_best
  from jsonb_array_elements(v_series) e
  where (e->>'sales')::numeric > 0
  order by (e->>'sales')::numeric desc, e->>'date' desc
  limit 1;

  return jsonb_build_object(
    'period',         p_period,
    'unit',           v_unit,
    'currency',       v_currency,
    'sales',          v_sales::text,
    'previous_sales', v_prev::text,
    'orders',         v_orders,
    'avg_ticket',     case when v_orders > 0 then round(v_sales / v_orders, 2)::text end,
    'series',         v_series,
    'best',           v_best
  );
end;
$fn$;

revoke execute on function public.dashboard_sales_trend(uuid, text, text) from public, anon;
grant  execute on function public.dashboard_sales_trend(uuid, text, text) to authenticated, service_role;

comment on function public.dashboard_sales_trend(uuid, text, text) is
  'Rendimiento de ventas de un periodo (7d, 30d, 12m) contra el anterior, con serie por día o mes, bajo la RLS de quien pregunta.';
