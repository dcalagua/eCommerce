-- =============================================================================
-- P11-SaaS · 5/5 — `content.cms` pasa a `implemented` y la vista del backoffice.
--
-- `content.cms` estaba en `app_capabilities` como vendible y `declared` desde
-- P02-SaaS: una intencion sin superficie. A partir de esta fase existen las
-- paginas, los bloques, la resolucion por canal y vigencia, el editor y la
-- vista previa, asi que pasa a `implemented`. El `entitlement_code` NO cambia
-- (`ecommerce.content.cms`): lo que el hub tiene que activar es lo que ya
-- esperaba.
--
-- `content.white_label` ya estaba en `implemented` desde P02 —lo unico que
-- habia era el interruptor `white_label`— y su fila NO cambia: lo que crece es
-- CUANTO cubre, no si esta hecha. `app_capabilities` guarda el registro tecnico
-- (codigo, frontera, entitlement, estado) y no el texto comercial; lo que
-- describe la capacidad al usuario vive en `src/domain/capabilities.ts`, y ahi
-- si se actualiza.
-- =============================================================================

update public.app_capabilities
   set state = 'implemented'
 where code = 'content.cms';

-- ---------------------------------------------------------------------------
-- public.content_page_overview — la pagina, su estado REAL y lo que lleva
-- dentro.
--
-- Existe por lo mismo que `promotion_overview` en P10: el estado guardado
-- responde «¿alguien la publico?» y no responde «¿se esta viendo ahora?». Una
-- pagina `published` con `publish_from` manana esta `scheduled`; una caducada
-- esta `expired`. Guardar eso como estado crearia dos verdades —la columna y el
-- reloj— que se contradicen el dia que nadie pase a corregirlas.
--
-- Y se deriva AQUI y no en el navegador porque es la misma pregunta que
-- responde `ebim.content_pick_page`: dos respuestas distintas a «¿esta visible?»
-- es exactamente lo que hace que nadie se fie de la pantalla.
-- ---------------------------------------------------------------------------
create view public.content_page_overview
with (security_invoker = on) as
select
  p.id,
  p.organization_id,
  p.company_id,
  p.store_id,
  p.slug,
  p.title,
  p.kind,
  p.status,
  case
    when p.status <> 'published'                        then p.status::text
    when p.publish_from > now()                         then 'scheduled'
    when p.publish_to is not null and p.publish_to <= now() then 'expired'
    else 'live'
  end                                                   as effective_status,
  p.channel_id,
  ch.code                                               as channel_code,
  ch.name                                               as channel_name,
  p.priority,
  p.publish_from,
  p.publish_to,
  p.show_in_nav,
  p.nav_position,
  p.seo_title,
  p.seo_description,
  p.og_image_url,
  p.created_at,
  p.updated_at,
  (select count(*) from public.content_blocks b where b.page_id = p.id)      as block_count,
  (select count(*) from public.content_blocks b
    where b.page_id = p.id and b.is_active)                                  as active_block_count,
  -- Lo que el editor necesita para no publicar una pagina vacia sin darse
  -- cuenta: cuantos bloques estan vigentes AHORA, que no es lo mismo que
  -- cuantos hay activos.
  (select count(*) from public.content_blocks b
    where b.page_id = p.id
      and b.is_active
      and b.publish_from <= now()
      and (b.publish_to is null or b.publish_to > now()))                    as live_block_count
from public.content_pages p
left join public.channels ch on ch.id = p.channel_id;

revoke all on public.content_page_overview from public, anon;
grant select on public.content_page_overview to authenticated, service_role;

comment on view public.content_page_overview is
  'Pagina con su estado EFECTIVO (live/scheduled/expired, derivado del reloj) y el recuento de bloques vigentes. security_invoker: las policies del dominio siguen mandando.';

-- ---------------------------------------------------------------------------
-- Lo que esta fase NO hace, y cual es el disparador de cada cosa
--
--  · **No hay `content_revisions`.** Un historial de versiones del contenido es
--    util, pero la pregunta que resuelve —«¿quien cambio la portada?»— hoy la
--    responde `updated_at` mas el hecho de que solo `owner`/`admin` escriben.
--    El disparador para crearla es el primer tenant con mas de un editor y
--    permiso de publicacion delegado, que es una decision de roles (P16) antes
--    que de contenido.
--
--  · **No hay `content_experiments` (A/B).** Repartir visitantes entre dos
--    variantes exige una identidad estable del visitante anonimo y un modelo de
--    medicion; lo primero choca con que el comprador de esta vitrina es anonimo
--    por diseno y lo segundo es P13. Declararlo ahora seria una casilla que no
--    mide nada.
--
--  · **No hay traduccion del contenido por idioma.** `store_settings` ya tiene
--    `default_locale` y la app es ES/EN, pero un bloque con dos textos exige
--    decidir que pasa cuando solo uno esta escrito —¿se esconde el bloque, se
--    ensena en el otro idioma?— y esa decision es de producto. El disparador es
--    el primer tenant que venda en dos idiomas a la vez.
--
--  · **La comprobacion DNS del dominio propio no se ejecuta.** El metadato y el
--    token existen (`20260828140200`); comprobar el TXT es trabajo de
--    infraestructura, fuera del alcance de una migracion.
-- ---------------------------------------------------------------------------
