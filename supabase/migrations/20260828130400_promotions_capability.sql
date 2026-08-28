-- =============================================================================
-- P10-SaaS · 5/5 — La capacidad pasa a `implemented` y las vistas del backoffice
--
-- `promotions` estaba en `app_capabilities` como vendible y `declared` desde
-- P02-SaaS: declarada como intencion, sin superficie detras. A partir de esta
-- fase existe el motor, la pantalla, el cupon y la tarjeta regalo, asi que pasa
-- a `implemented`. El `entitlement_code` NO cambia (`ecommerce.promotions`): lo
-- que el hub tiene que activar es lo mismo que ya esperaba.
--
-- Las dos vistas existen por la misma razon que `payment_intent_overview` de
-- P09: para que el conteo que la pantalla enseña salga de un sitio y no de una
-- suma que haga el navegador. `security_invoker` en las dos — no amplian ni un
-- permiso, se apoyan en las policies del dominio.
-- =============================================================================

update public.app_capabilities
   set state = 'implemented'
 where code = 'promotions';

-- ---------------------------------------------------------------------------
-- public.promotion_overview — una campana, su estado REAL y lo que ha movido.
--
-- `effective_status` es lo que hacia falta y no cabia en una columna: el estado
-- guardado responde "¿la encendio alguien?" y no responde "¿esta descontando
-- ahora mismo?". Una campana `active` con `valid_from` manana esta
-- `scheduled`; una `active` caducada esta `expired`; una `active` con el tope
-- agotado esta `exhausted`. Guardarlos como estado crearia dos verdades —la
-- columna y el reloj— que se contradicen el dia que nadie pase a corregirlas.
--
-- Se deriva AQUI y no en el navegador porque es la misma pregunta que responde
-- el motor, y dos respuestas distintas a "¿esta activa?" es exactamente el tipo
-- de discrepancia que hace que nadie se fie de la pantalla.
-- ---------------------------------------------------------------------------
create view public.promotion_overview
with (security_invoker = on) as
select
  p.id,
  p.organization_id,
  p.company_id,
  p.store_id,
  p.code,
  p.name,
  p.description,
  p.kind,
  p.status,
  case
    when p.status <> 'active'                              then p.status::text
    when p.valid_from > now()                              then 'scheduled'
    when p.valid_to is not null and p.valid_to <= now()    then 'expired'
    when p.usage_limit is not null
         and p.usage_count >= p.usage_limit                then 'exhausted'
    else 'live'
  end                                                      as effective_status,
  p.priority,
  p.stack_group,
  p.is_exclusive,
  p.requires_coupon,
  p.value_percent,
  p.value_amount,
  p.max_discount_amount,
  p.buy_quantity,
  p.free_quantity,
  p.min_subtotal,
  p.min_quantity,
  p.valid_from,
  p.valid_to,
  p.usage_limit,
  p.usage_limit_per_customer,
  p.usage_count,
  p.created_at,
  p.updated_at,
  (select count(*) from public.promotion_scopes s
    where s.promotion_id = p.id and not s.is_exclusion)      as scope_count,
  (select count(*) from public.promotion_scopes s
    where s.promotion_id = p.id and s.is_exclusion)          as exclusion_count,
  (select count(*) from public.promotion_audiences a
    where a.promotion_id = p.id)                             as audience_count,
  (select count(*) from public.promotion_tiers t
    where t.promotion_id = p.id)                             as tier_count,
  (select count(*) from public.coupons c
    where c.promotion_id = p.id)                             as coupon_count,
  (select count(*) from public.promotion_redemptions r
    where r.promotion_id = p.id)                             as redemption_count,
  -- Lo que esta campana le ha costado al comercio. Es la cifra que decide si se
  -- renueva, y sin ella la unica forma de saberlo es exportar los pedidos.
  (select coalesce(sum(r.discount_amount), 0)
     from public.promotion_redemptions r
    where r.promotion_id = p.id)                             as discount_granted
from public.promotions p;

revoke all on public.promotion_overview from public, anon;
grant select on public.promotion_overview to authenticated, service_role;

comment on view public.promotion_overview is
  'Una campana con su estado EFECTIVO (live/scheduled/expired/exhausted, derivado del reloj y del contador) y lo que ha movido. security_invoker: las policies del dominio siguen mandando.';

-- ---------------------------------------------------------------------------
-- public.gift_card_overview — el saldo emitido y el saldo vivo.
--
-- Enseña `code_last4` y NUNCA `code`: la vista hereda el GRANT por columna de
-- la tabla, pero dejarlo escrito aqui evita que la proxima ampliacion lo cuele
-- sin querer.
--
-- `effective_status` responde lo mismo que en las campanas: una tarjeta
-- `active` cuya fecha ya paso esta caducada aunque nadie haya pasado a
-- marcarla, porque `ebim.gift_card_move` la rechaza igual. La pantalla tiene
-- que decir lo mismo que dice el comando.
-- ---------------------------------------------------------------------------
create view public.gift_card_overview
with (security_invoker = on) as
select
  g.id,
  g.organization_id,
  g.company_id,
  g.store_id,
  g.code_last4,
  g.currency,
  g.initial_amount,
  g.balance,
  g.status,
  case when g.status = 'active' and g.expires_at <= now()
       then 'expired' else g.status::text end            as effective_status,
  g.issued_to_email,
  g.expires_at,
  g.notes,
  g.created_at,
  g.updated_at,
  (select count(*) from public.gift_card_transactions t
    where t.gift_card_id = g.id)                          as movement_count,
  (select coalesce(sum(-t.amount), 0) from public.gift_card_transactions t
    where t.gift_card_id = g.id and t.kind = 'redeem')    as redeemed_amount,
  (select max(t.created_at) from public.gift_card_transactions t
    where t.gift_card_id = g.id and t.kind = 'redeem')    as last_redeemed_at
from public.gift_cards g;

revoke all on public.gift_card_overview from public, anon;
grant select on public.gift_card_overview to authenticated, service_role;

comment on view public.gift_card_overview is
  'Una tarjeta regalo con su saldo vivo, su estado efectivo y lo canjeado. Enseña code_last4 y NUNCA el codigo.';

-- ---------------------------------------------------------------------------
-- Lo que esta fase NO declara vendible aparte, y por que
--
-- Se penso en `promotions.gift_cards` como capacidad propia —tarjetas regalo
-- como addon separado del motor de campanas— y se descarto: el catalogo
-- comercial es del hub (contrato §6, principio 2) y esta app no puede inventar
-- un SKU que el hub no conoce. Si el operador decide venderlas aparte, lo que
-- cambia es una fila de `app_capabilities` y el `has_capability` de los tres
-- comandos de `20260828130200` — ni una linea de motor.
-- ---------------------------------------------------------------------------
