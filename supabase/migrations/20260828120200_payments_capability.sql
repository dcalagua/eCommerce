-- =============================================================================
-- P09-SaaS · 3/3 — El conector de pruebas, la capacidad y la vista del
--                  backoffice
--
-- ## Por que hay un proveedor `sandbox` en el catalogo GLOBAL
--
-- La Definition of Done de la fase es literal: «PASS si el checkout puede usar
-- un provider fake mediante contrato canonico». Un simulador que solo existe en
-- los tests demuestra que los tests compilan, no que el checkout funciona: el
-- `payment_methods.provider_code` tiene una FK real contra este catalogo, y sin
-- fila no hay medio de pago que crear.
--
-- No es un cliente ni una marca: es una capacidad del producto, igual que lo es
-- «hay conector para SAP R/3». Sirve para tres cosas que pasan de verdad:
--
--   · un tenant prueba su checkout de punta a punta ANTES de contratar pasarela;
--   · una demo cobra sin mover un centimo;
--   · los tests de la fase —exito, rechazo, tiempo agotado, webhook repetido y
--     devolucion— corren contra el mismo camino que la produccion, no contra
--     uno paralelo.
--
-- Su comportamiento es DETERMINISTA y vive en TypeScript
-- (`_shared/payments/sandbox.ts`), no aqui: la base no sabe simular nada, solo
-- sabe que existe un conector con ese codigo.
--
-- ## Por que la capacidad pasa a `implemented` y no nace una nueva
--
-- `payments` ya estaba declarada desde P02 con su entitlement
-- `ecommerce.payments`. Lo que cambia hoy es que detras hay pantalla y comando,
-- que es exactamente lo que la columna `state` significa. Inventar
-- `payments.reconciliation` como segunda capacidad vendible seria decidir el
-- empaquetado comercial desde el repositorio, y el catalogo comercial es del
-- hub (contrato §5/§6).
-- =============================================================================

insert into public.integration_providers (code, kind, name, capabilities) values
  ('sandbox', 'payment', 'Pasarela de pruebas',
   '{payment.authorize,payment.capture,payment.refund}')
on conflict (code) do nothing;

comment on column public.integration_providers.code is
  'Codigo del conector. `sandbox` es el simulador determinista del producto: mismo contrato canonico, sin dinero real.';

update public.app_capabilities
   set state = 'implemented'
 where code = 'payments';

-- ---------------------------------------------------------------------------
-- La vista del backoffice: un cobro, su pedido y su medio, en una fila.
--
-- `security_invoker`: no amplia ni un permiso. Se apoya en las policies de
-- `payment_intents` y de `orders`, asi que un miembro de otra sociedad no ve
-- nada aunque consulte la vista directamente.
--
-- Existe para que la pantalla no tenga que encadenar cuatro consultas y, sobre
-- todo, para que el conteo de intentos y de fallos —que es lo que pide el
-- criterio 10 de la fase— salga de un sitio y no de la suma que haga el
-- navegador.
-- ---------------------------------------------------------------------------
create view public.payment_intent_overview
with (security_invoker = on) as
select
  i.id                as intent_id,
  i.organization_id,
  i.company_id,
  i.store_id,
  i.order_id,
  o.order_number,
  o.customer_email,
  o.payment_status    as order_payment_status,
  m.code              as method_code,
  m.display_name      as method_name,
  m.kind              as method_kind,
  i.provider_code,
  i.status,
  i.capture_mode,
  i.currency,
  i.amount,
  i.amount_authorized,
  i.amount_captured,
  i.amount_refunded,
  i.provider_reference,
  i.last_error_code,
  i.created_at,
  i.updated_at,
  i.authorized_at,
  i.captured_at,
  (select count(*) from public.payment_attempts a where a.payment_intent_id = i.id)
                      as attempt_count,
  (select count(*) from public.payment_attempts a
    where a.payment_intent_id = i.id
      and a.status in ('declined', 'failed', 'timeout'))
                      as failed_attempt_count,
  (select count(*) from public.refunds r
     join public.payments p on p.id = r.payment_id
    where p.payment_intent_id = i.id and r.status = 'succeeded')
                      as refund_count
from public.payment_intents i
left join public.orders o          on o.id = i.order_id
join      public.payment_methods m on m.id = i.payment_method_id;

revoke all on public.payment_intent_overview from public, anon;
grant select on public.payment_intent_overview to authenticated, service_role;

comment on view public.payment_intent_overview is
  'Un cobro con su pedido, su medio y sus conteos de intentos y fallos. security_invoker: las policies del dominio siguen mandando.';
