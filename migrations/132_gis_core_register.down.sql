-- 132_gis_core_register.down.sql — rollback for 132_gis_core_register.sql
-- Fails on the role CHECK while any user still holds a GIS Branch role;
-- re-grade those accounts first.
BEGIN;
DROP TRIGGER IF EXISTS trg_admin_audit_event_guard ON public.admin_audit_event;
DROP FUNCTION IF EXISTS public.admin_audit_event_guard();
DROP SCHEMA IF EXISTS integration CASCADE;
DROP SCHEMA IF EXISTS revenue_link CASCADE;
DROP SCHEMA IF EXISTS land CASCADE;
DROP SCHEMA IF EXISTS admin CASCADE;
DELETE FROM public.spatial_ref_sys WHERE srid IN (922027, 922029, 922031, 922033);
DROP SCHEMA IF EXISTS gis_ops CASCADE;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN (
  'public', 'registered', 'viewer', 'admin', 'planner', 'eo', 'env_officer',
  'building_inspector', 'planning_clerk', 'surveyor', 'gis_officer'));
COMMIT;
