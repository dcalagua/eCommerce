-- =============================================================================
-- CCP fase 09 · `masteradmin` como origen de la caché de entitlements
--
-- Migración AISLADA a propósito: `ALTER TYPE … ADD VALUE` no puede usarse en la
-- misma transacción que lo añade, y la migración siguiente
-- (20261001100000_masteradmin_entitlements) ya lo usa.
--
-- Valor ADITIVO: `hub` y `provisioning` no cambian. Quien escribe con este
-- origen es SOLO el receptor de snapshots de EBIM MasterAdmin (la migración
-- siguiente lo impide a cualquier otro llamador de `sync_platform_context`).
-- =============================================================================

alter type public.entitlement_source add value if not exists 'masteradmin';
