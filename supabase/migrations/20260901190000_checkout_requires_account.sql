-- =============================================================================
-- P18 · Comprar exige cuenta.
--
-- El comercio puede exigir que quien compra haya iniciado sesion. Hasta ahora
-- eso solo lo podia decir el CANAL (`channels.requires_auth`), y un CHECK ata
-- ese campo al tipo: un canal `b2c` NO puede exigir sesion —seria una
-- contradiccion, porque la vitrina publica solo ve canales abiertos—. Asi que
-- la regla no cabia ahi: es de la TIENDA, no del canal.
--
-- ## Por que es un ajuste y no una constante
--
-- Principio 4 del contrato: todo activable desde Configuracion por cuenta y
-- sociedad. Una farmacia que factura a nombre del comprador querra exigirlo;
-- una tienda de regalos que vive de la compra por impulso, no. Apagado por
-- defecto: encenderlo cambia quien puede comprar, y eso no se le hace a una
-- tienda ya en produccion por una migracion.
--
-- ## Donde se aplica de verdad
--
-- En `validate_account`, la etapa 2 del pipeline, con la identidad VERIFICADA
-- que devuelve `public.current_buyer()` — no con el `sub` que trae el token sin
-- comprobar. Esa diferencia es la que separa un guard de un adorno: cualquiera
-- puede escribir un JWT con un `sub` dentro; solo PostgREST puede decir si la
-- firma es buena. La vitrina tambien lo comprueba, pero para no dejar rellenar
-- un formulario que se va a rechazar: quien decide es el servidor.
-- =============================================================================

alter table public.store_settings
  add column if not exists checkout_requires_account boolean not null default false;

comment on column public.store_settings.checkout_requires_account is
  'Si esta activo, el checkout exige una sesion verificada. Lo impone el pipeline en validate_account.';

-- La vitrina lo necesita para no enseñar un formulario que el servidor va a
-- rechazar. Es un booleano de presentacion: no dice nada de nadie.
grant select (checkout_requires_account) on public.store_settings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- La vista publica, recreada con la columna nueva.
--
-- DROP + CREATE en migracion NUEVA, nunca editando la que ya existe: migracion
-- aplicada es inmutable (regla del repositorio).
-- ---------------------------------------------------------------------------
drop view if exists public.public_stores;

create view public.public_stores
with (security_invoker = on) as
select
  s.id            as store_id,
  s.slug,
  s.name,
  s.currency,
  s.domain,
  ss.accent_color,
  ss.logo_url,
  ss.favicon_url,
  ss.white_label,
  ss.default_locale,
  ss.support_email,
  ss.banner_url,
  ss.hero_title,
  ss.hero_subtitle,
  ss.contact_phone,
  ss.contact_address,
  ss.font_family,
  ss.ui_radius,
  ss.ui_density,
  ss.business_display_name,
  coalesce(ss.checkout_requires_account, false) as checkout_requires_account
from public.stores s
left join public.store_settings ss on ss.store_id = s.id
where s.status = 'active';

revoke all on public.public_stores from public;
grant select on public.public_stores to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.current_buyer — quien esta comprando, DE VERDAD.
--
-- Devuelve el usuario de la sesion tal y como lo ve la base. Es la unica forma
-- honesta de responderlo desde una Edge Function: el orquestador tiene el token
-- del llamante pero no la clave con la que se firmo, asi que leer el `sub` de
-- ese token no prueba nada —cualquiera puede escribir uno—. Al preguntarlo por
-- PostgREST con ese mismo token, la firma se comprueba antes de llegar aqui:
-- si es falsa, la llamada ni entra.
--
-- Con la clave anonima devuelve `null` y no un error: no tener sesion es una
-- respuesta valida, y quien decide que hacer con ella es el que pregunta.
-- ---------------------------------------------------------------------------
create or replace function public.current_buyer()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object('user_id', ebim.user_id());
$fn$;

revoke execute on function public.current_buyer() from public;
grant  execute on function public.current_buyer() to anon, authenticated, service_role;

comment on function public.current_buyer() is
  'El usuario de la sesion VERIFICADA por PostgREST, o null. security invoker a proposito.';

-- ---------------------------------------------------------------------------
-- checkout_context devuelve tambien la regla de la tienda.
--
-- Se reescribe entera —no se puede añadir una clave a un `jsonb_build_object`
-- de otra forma— y el unico cambio es la clave `requires_account`.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_context(p_store_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_store     public.stores%rowtype;
  v_channel   public.channels%rowtype;
  v_inclusive boolean;
  v_account   boolean;
begin
  v_store   := ebim.active_store_by_slug(p_store_slug);
  v_channel := ebim.public_channel(v_store.id);

  select coalesce(ss.tax_inclusive, false),
         coalesce(ss.checkout_requires_account, false)
    into v_inclusive, v_account
  from public.store_settings ss where ss.store_id = v_store.id;

  return jsonb_build_object(
    'store_slug',    v_store.slug,
    'store_name',    v_store.name,
    'currency',      v_store.currency,
    'channel',       v_channel.code,
    'channel_kind',  v_channel.kind,
    'requires_auth', v_channel.requires_auth,
    -- La regla de la TIENDA, distinta de la del canal: aquella dice que ese
    -- canal es cerrado; esta, que este comercio no vende a desconocidos.
    'requires_account', coalesce(v_account, false),
    'tax_inclusive', coalesce(v_inclusive, false));
end;
$fn$;

revoke execute on function public.checkout_context(text) from public;
grant  execute on function public.checkout_context(text) to anon, authenticated, service_role;

comment on function public.checkout_context(text) is
  'Etapa 1 del pipeline: moneda, canal, impuesto y si la tienda exige cuenta. Sin ids internos y sin aceptar tenant.';
