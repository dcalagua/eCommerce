-- =============================================================================
-- P14-SaaS · 7/7 — El modulo pasa a `implemented`, y el HILO llega a la API
--
-- ## Por que `integrations.enterprise` deja de ser `partial`
--
-- Desde P02 estaba declarada asi con razon: existia el transporte y no existia
-- ninguna superficie. Lo que faltaba no era mas SQL, era que un tercero pudiera
-- USARLO: credenciales con permisos, una API versionada, suscripciones a
-- eventos y una pantalla para operar los fallos. Las cuatro existen desde esta
-- fase, asi que el estado se corrige. `state` dice la verdad sobre el producto
-- HOY y no la intencion: mantenerla `partial` seria tan falso ahora como
-- declararla `implemented` lo era antes.
--
-- ## Y por que el MONITOR no se vende
--
-- El gate de `integrations.enterprise` cubre PUBLICAR —crear credenciales,
-- endpoints y suscripciones—. NO cubre mirar: `integration_monitor`,
-- `webhook_monitor` e `integration_health` estan fuera del addon, igual que
-- `/app/operations` en P13 y por el mismo motivo. Un tenant que no puede ver
-- por que fallan sus integraciones acaba llamando por telefono, y la
-- observabilidad es area de plataforma, no un modulo de comercio.
--
-- ## El hilo, extendido a los dos dominios nuevos
--
-- `trace_by_correlation` (P13) reconstruye un incidente por once tablas. Con
-- esta fase hay dos saltos mas que un incidente real recorre y que se perdian:
-- la ENTREGA de un webhook —«el pedido se creo, ¿su aviso salio?»— y la
-- PETICION de un socio —«ese pedido no lo hizo un comprador, lo empujo el
-- ERP»—. Se anaden dos ramas al `union`; ni una funcion de dominio cambia,
-- que es la propiedad que P13 establecio y que aqui se conserva.
-- =============================================================================

update public.app_capabilities
   set state = 'implemented'
 where code = 'integrations.enterprise';

-- ---------------------------------------------------------------------------
-- El hilo llega a la entrega del webhook y a la peticion del socio
-- ---------------------------------------------------------------------------
create or replace function public.trace_by_correlation(p_correlation_id text)
returns table (
  occurred_at timestamptz,
  domain      text,
  entity_type text,
  entity_id   uuid,
  summary     text,
  status      text,
  severity    text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_id text := nullif(btrim(coalesce(p_correlation_id, '')), '');
begin
  if v_id is null or v_id !~ '^[A-Za-z0-9_.:-]{8,120}$' then
    raise exception 'CORRELACION_INVALIDA: el identificador de hilo no tiene la forma esperada'
      using errcode = '22023';
  end if;

  return query
  select c.created_at, 'checkout'::text, 'checkout_intent'::text, c.id,
         ('etapa ' || c.stage::text)::text, c.status::text,
         (case when c.status = 'failed' then 'error' else 'info' end)::text
    from public.checkout_intents c
   where c.correlation_id = v_id and ebim.can_access(c.organization_id, c.company_id)
  union all
  select o.placed_at, 'orders', 'order', o.id, o.order_number, o.status::text, 'info'::text
    from public.orders o
   where o.correlation_id = v_id and ebim.can_access(o.organization_id, o.company_id)
  union all
  select p.created_at, 'payments', 'payment_intent', p.id,
         coalesce(p.provider_code, 'sin proveedor'), p.status::text,
         (case when p.status = 'failed' then 'error' else 'info' end)::text
    from public.payment_intents p
   where p.correlation_id = v_id and ebim.can_access(p.organization_id, p.company_id)
  union all
  select pe.created_at, 'payments', 'payment_event', pe.id, pe.event_type, null::text, 'info'::text
    from public.payment_events pe
   where pe.correlation_id = v_id and ebim.can_access(pe.organization_id, pe.company_id)
  union all
  select f.created_at, 'fulfillment', 'fulfillment', f.id, f.method_code, f.state::text, 'info'::text
    from public.fulfillments f
   where f.correlation_id = v_id and ebim.can_access(f.organization_id, f.company_id)
  union all
  select d.created_at, 'events', 'domain_event', d.id, d.event_type, d.status::text,
         (case when d.status = 'dead' then 'critical' else 'info' end)::text
    from public.domain_events d
   where d.correlation_id = v_id and ebim.can_access(d.organization_id, d.company_id)
  union all
  select ob.created_at, 'integrations', 'integration_outbox', ob.id,
         (ob.provider_code || ' · ' || ob.operation)::text, ob.status::text,
         (case when ob.status = 'dead' then 'critical'
               when ob.status = 'failed' then 'warning' else 'info' end)::text
    from public.integration_outbox ob
   where ob.correlation_id = v_id and ebim.can_access(ob.organization_id, ob.company_id)
  union all
  select ib.created_at, 'integrations', 'integration_inbox', ib.id,
         (ib.provider_code || ' · ' || ib.event_type)::text,
         (case when ib.processed_at is null then 'pending' else 'processed' end)::text,
         'info'::text
    from public.integration_inbox ib
   where ib.correlation_id = v_id and ebim.can_access(ib.organization_id, ib.company_id)
  -- P14: la ENTREGA del aviso. Es el salto que faltaba entre «el hecho se
  -- publico» y «el sistema del cliente se entero».
  union all
  select wd.created_at, 'webhooks', 'webhook_delivery', wd.id,
         (we.name || ' · ' || wd.event_type)::text,
         coalesce(wo.status::text, 'pending'),
         (case when wo.status = 'dead' then 'critical'
               when wd.replay_of is not null then 'warning' else 'info' end)::text
    from public.webhook_deliveries wd
    join public.webhook_endpoints we on we.id = wd.endpoint_id
    left join public.integration_outbox wo on wo.id = wd.outbox_id
   where wd.correlation_id = v_id and ebim.can_access(wd.organization_id, wd.company_id)
  -- P14: la PETICION del socio. Sin esto, un pedido creado por la API aparece
  -- en el hilo sin nada delante y parece que nacio solo.
  union all
  select ar.created_at, 'api', 'api_request', ar.id,
         (ar.method || ' ' || ar.route)::text,
         coalesce(ar.status::text, 'en curso'),
         (case when coalesce(ar.status, 0) >= 500 then 'error'
               when coalesce(ar.status, 0) >= 400 then 'warning' else 'info' end)::text
    from public.api_requests ar
   where ar.correlation_id = v_id and ebim.can_access(ar.organization_id, ar.company_id)
  union all
  select a.occurred_at, 'audit', a.entity_type, a.entity_id, a.action, null::text, 'info'::text
    from public.audit_log a
   where a.correlation_id = v_id and ebim.can_access(a.organization_id, a.company_id)
  union all
  select ae.occurred_at, 'analytics', 'analytics_event', ae.id,
         ae.event_type::text, null::text, 'info'::text
    from public.analytics_events ae
   where ae.correlation_id = v_id and ebim.can_access(ae.organization_id, ae.company_id)
  union all
  select oe.occurred_at, 'ops', 'ops_event', oe.id,
         (oe.kind::text || ' · ' || oe.code)::text,
         (case when oe.resolved_at is null then 'open' else 'resolved' end)::text,
         oe.severity::text
    from public.ops_events oe
   where oe.correlation_id = v_id and ebim.can_access(oe.organization_id, oe.company_id)
  order by 1;
end;
$fn$;

revoke execute on function public.trace_by_correlation(text) from public, anon;
grant  execute on function public.trace_by_correlation(text) to authenticated, service_role;

comment on function public.trace_by_correlation(text) is
  'Linea de tiempo de un hilo por trece dominios: compra, pedido, cobro, entrega, hechos, integraciones, WEBHOOKS, API de socio, auditoria, analitica y operacion.';
