-- =============================================================================
-- P16-SaaS · 2/3 — Las nueve claves ajenas que no llevaban el tenant dentro
--
-- El patron del repo desde P01 es la FK COMPUESTA: una fila hija no puede
-- apuntar a un padre de otro tenant porque la clave ajena arrastra el tenant.
-- Es aislamiento ESTRUCTURAL, no declarativo — no depende de que la funcion que
-- inserta se acuerde de filtrar.
--
-- Auditando el catalogo (`pg_constraint`) salieron 218 FK hacia tablas con
-- `organization_id`. Doscientas nueve llevaban `organization_id`, `company_id` o
-- `store_id` dentro. NUEVE no llevaban nada:
--
--   api_access_tokens      -> api_clients        (api_client_id)
--   api_idempotency        -> api_clients        (api_client_id)
--   api_requests           -> api_clients        (api_client_id)
--   carts                  -> carts              (merged_into)
--   integration_messages   -> integration_outbox (outbox_id)
--   order_tokens           -> orders             (order_id)
--   reconciliation_records -> payments           (payment_id)
--   webhook_deliveries     -> integration_outbox (outbox_id)
--   webhook_deliveries     -> webhook_deliveries (replay_of)
--
-- Ninguna de las nueve tiene HOY un camino de escritura desde el navegador: las
-- nueve tablas hijas se escriben solo desde funciones `SECURITY DEFINER` que
-- derivan el tenant de la fila del padre, y ninguna tiene GRANT de INSERT o
-- UPDATE para `anon` ni `authenticated`. Por eso esto no es la correccion de un
-- agujero abierto: es cerrar la via por la que un fallo FUTURO en cualquiera de
-- esas funciones —un `insert` al que se le pasa el tenant equivocado— se
-- convertiria en una fila que cruza tenants sin que nada se queje.
--
-- MATCH SIMPLE (el de por defecto) es justo lo que hace falta en las tres
-- columnas opcionales (`merged_into`, `replay_of`, `payment_id`): si alguna
-- columna de la clave es NULL, la restriccion no se comprueba. Como
-- `organization_id`/`company_id` son NOT NULL en las nueve tablas, la unica
-- forma de que la FK no se evalue es que la referencia sea NULL, que es
-- exactamente el caso que debe seguir permitido.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Las claves candidatas que faltaban en los padres
--
-- `orders` y `carts` ya tenian su `*_tenant_key` desde P07/P08. Estas cuatro
-- son nuevas y no cambian ninguna semantica: `id` ya es unico por si solo, asi
-- que anadirle el tenant no rechaza ninguna fila que antes entrara.
-- ---------------------------------------------------------------------------
alter table public.api_clients
  add constraint api_clients_tenant_key unique (id, organization_id, company_id);

alter table public.integration_outbox
  add constraint integration_outbox_tenant_key unique (id, organization_id, company_id);

alter table public.payments
  add constraint payments_tenant_key unique (id, organization_id, company_id);

alter table public.webhook_deliveries
  add constraint webhook_deliveries_tenant_key unique (id, organization_id, company_id);

-- ---------------------------------------------------------------------------
-- 2. Las nueve FK, cambiadas por su version con tenant
--
-- Se conserva el `on delete` de cada una tal cual estaba: cambiarlo aqui seria
-- cambiar conducta de negocio en una migracion de seguridad.
--   · api_access_tokens / api_idempotency / api_requests -> cascade
--     (`api_requests.api_client_id` es NULL cuando la peticion ni llego a
--     autenticarse; ver `20260828170300`)
--   · carts.merged_into        -> set null
--   · integration_messages     -> cascade
--   · order_tokens             -> cascade
--   · reconciliation_records   -> set null
--   · webhook_deliveries       -> cascade / set null
-- ---------------------------------------------------------------------------
alter table public.api_access_tokens
  drop constraint api_access_tokens_api_client_id_fkey,
  add  constraint api_access_tokens_client_fk
    foreign key (api_client_id, organization_id, company_id)
    references public.api_clients (id, organization_id, company_id) on delete cascade;

alter table public.api_idempotency
  drop constraint api_idempotency_api_client_id_fkey,
  add  constraint api_idempotency_client_fk
    foreign key (api_client_id, organization_id, company_id)
    references public.api_clients (id, organization_id, company_id) on delete cascade;

alter table public.api_requests
  drop constraint api_requests_api_client_id_fkey,
  add  constraint api_requests_client_fk
    foreign key (api_client_id, organization_id, company_id)
    references public.api_clients (id, organization_id, company_id) on delete cascade;

alter table public.carts
  drop constraint carts_merged_into_fkey,
  add  constraint carts_merged_into_fk
    foreign key (merged_into, organization_id, company_id)
    references public.carts (id, organization_id, company_id) on delete set null;

alter table public.integration_messages
  drop constraint integration_messages_outbox_id_fkey,
  add  constraint integration_messages_outbox_fk
    foreign key (outbox_id, organization_id, company_id)
    references public.integration_outbox (id, organization_id, company_id) on delete cascade;

alter table public.order_tokens
  drop constraint order_tokens_order_id_fkey,
  add  constraint order_tokens_order_fk
    foreign key (order_id, organization_id, company_id)
    references public.orders (id, organization_id, company_id) on delete cascade;

alter table public.reconciliation_records
  drop constraint reconciliation_records_payment_id_fkey,
  add  constraint reconciliation_records_payment_fk
    foreign key (payment_id, organization_id, company_id)
    references public.payments (id, organization_id, company_id) on delete set null;

alter table public.webhook_deliveries
  drop constraint webhook_deliveries_outbox_id_fkey,
  add  constraint webhook_deliveries_outbox_fk
    foreign key (outbox_id, organization_id, company_id)
    references public.integration_outbox (id, organization_id, company_id) on delete cascade;

alter table public.webhook_deliveries
  drop constraint webhook_deliveries_replay_of_fkey,
  add  constraint webhook_deliveries_replay_fk
    foreign key (replay_of, organization_id, company_id)
    references public.webhook_deliveries (id, organization_id, company_id) on delete set null;

comment on constraint order_tokens_order_fk on public.order_tokens is
  'FK con tenant dentro (P16-SaaS): la fila del token no puede declarar una organizacion distinta a la del pedido al que da acceso.';
