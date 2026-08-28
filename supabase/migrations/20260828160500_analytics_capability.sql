-- =============================================================================
-- P13-SaaS · 6/6 — La capacidad deja de estar «declarada», y la vista que la
--                  pantalla necesita
--
-- ## Por que `analytics.advanced` pasa a `implemented` y no nace una capacidad
--
-- `analytics.advanced` esta declarada desde P02 con su entitlement
-- `ecommerce.analytics.advanced` y con la promesa escrita en `capabilities.ts`:
-- «Cohortes, embudo de conversion y exportacion analitica (P13)». Hoy hay
-- embudo (`analytics_funnel`), hay terminos de busqueda
-- (`analytics_search_terms`), hay exportacion y hay pantalla detras. Eso es
-- exactamente lo que la columna `state` significa.
--
-- Las COHORTES no se hacen y no se fingen: hacen falta compradores
-- identificados a lo largo del tiempo, y esta app guarda la analitica sin PII a
-- proposito. Se documenta como no hecho en el ADR en vez de dejar una funcion
-- vacia que devuelva una lista para que la casilla quede marcada.
--
-- Ninguna capacidad nueva. Ni `observability` ni `audit`: la salud operativa y
-- la auditoria no se venden. Un tenant que no pudiera ver por que fallan sus
-- cobros porque no pago el addon de observabilidad es un tenant que llama por
-- telefono, y ademas es exactamente el mismo argumento por el que Ajustes y
-- Diagnostico no se gatean desde P02.
-- =============================================================================

update public.app_capabilities
   set state = 'implemented'
 where code = 'analytics.advanced';

-- ---------------------------------------------------------------------------
-- public.ops_incident_overview — el incidente con su EDAD ya calculada.
--
-- `security_invoker`: no amplia ni un permiso. Se apoya en
-- `ops_events_select_admin`, asi que un `viewer` no ve una fila aunque consulte
-- la vista directamente.
--
-- Existe por la misma razon que `fulfillment_overview.is_late` (P12): «cuanto
-- lleva abierto esto» es una resta entre `now()` y una fecha, y hacerla en el
-- navegador la hace depender del reloj del portatil de quien mira. Con el
-- horario mal puesto, un incidente de hace diez minutos aparece como de hace
-- dos horas — y la respuesta a un incidente se decide justamente por eso.
-- ---------------------------------------------------------------------------
create view public.ops_incident_overview
with (security_invoker = on) as
select
  e.id,
  e.organization_id,
  e.company_id,
  e.store_id,
  e.kind,
  e.severity,
  e.code,
  e.message,
  e.source,
  e.operation,
  e.duration_ms,
  e.entity_type,
  e.entity_id,
  e.correlation_id,
  e.request_id,
  e.context,
  e.occurred_at,
  e.resolved_at,
  e.resolved_by,
  e.resolution_note,
  (e.resolved_at is null) as is_open,
  floor(extract(epoch from (now() - e.occurred_at)))::bigint as age_seconds,
  -- Cuantas veces se repitio el MISMO fallo. Lo lleva `record_ops_event` en el
  -- contexto; sacarlo a columna evita que la pantalla tenga que saber que la
  -- cuenta vive dentro de un jsonb.
  coalesce((e.context ->> 'repeats')::integer, 1) as repeats
from public.ops_events e;

revoke all on public.ops_incident_overview from public, anon;
grant  select on public.ops_incident_overview to authenticated, service_role;

comment on view public.ops_incident_overview is
  'Incidente operativo con su edad y sus repeticiones ya calculadas en el servidor. security_invoker: la policy de ops_events sigue decidiendo quien ve que.';
