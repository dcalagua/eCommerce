-- =============================================================================
-- Rollback CCP fase 17 · outbox de uso (20261002100000_usage_outbox.sql)
--
-- NO es una migración: lo ejecuta un operador, con autorización, solo si hay que
-- retirar la fase. Probado en seco (dry-run) sobre PGlite con TODAS las
-- migraciones: `supabase/tests/usage-outbox-rollback.test.ts`.
--
-- Antes: apagar el emisor (`USAGE_OUTBOX_SENDER_ENABLED` distinto de 'true') y,
-- si se quiere conservar lo pendiente, exportarlo:
--   copy (select * from platform_usage.usage_outbox where status = 'PENDING') to stdout with csv header;
--
-- Efecto: la traza de IA (`ai_record*`, `ai_interactions`, `ai_usage`) sigue
-- exactamente como antes de la fase; solo deja de encolar uso. Los eventos del
-- outbox se BORRAN con el esquema (MasterAdmin conserva lo ya aceptado).
--
-- Después (solo en el entorno donde se aplicó): marcar la migración como
-- revertida en el historial, p. ej. `supabase migration repair --status reverted 20261002100000`.
-- =============================================================================
begin;

drop trigger if exists ai_interactions_usage_outbox on public.ai_interactions;
drop function if exists public.platform_usage_outbox_claim(integer, integer);
drop function if exists public.platform_usage_outbox_mark(jsonb);
drop schema if exists platform_usage cascade;

commit;
