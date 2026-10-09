-- 172: second batch of the tenancy debt (migration 165's `pending` list): the stands register, the revenue link, and the
-- superseded planning_clerk tables.
--
-- planning_clerk.*   (7 tables) were created by migration 124 and superseded by spatial_planning.clerk_* in 128; no code reads or writes
--                    them and they hold no rows. They are classified `system` (no access for the application role) rather than dropped:
--                    dropping data is a decision for a person, closing the door is not.
-- revenue_link.*     the link between a parcel and the council's ERP account, and the account's billing band. Written by the integration
--                    (system plane), owned by the authority: tenant data.
-- public.stands      the stand register. Staff of the owning authority manage it, but a stand is also PUBLIC information while it is for
--                    sale, and a citizen reserves one: so besides the standard tenant policies,
--                      * anyone may read a stand that is available, and a citizen may read the stand they have reserved or been allocated;
--                      * a citizen may update a stand that is available, or one they have reserved (to reserve it, or let it go).
--                    Row-level security cannot restrict WHICH columns a citizen touches; the route is the only path a citizen has,
--                    and it decides that.
-- public.stand_allocation   follows its stand.
-- The views over the stands become tenant views that run as the caller.
--
-- Guarded by to_regclass: a database behind the migration chain converts what it has.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['planning_clerk.abutter_notification', 'planning_clerk.acknowledgement_letter', 'planning_clerk.correspondence',
                           'planning_clerk.fee_receipt', 'planning_clerk.notice_certificate', 'planning_clerk.permit_dispatch',
                           'planning_clerk.refusal_letter'] LOOP
    IF to_regclass(r) IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN EXECUTE format('REVOKE ALL ON %s FROM vungu_app', r); END IF;
      PERFORM tenancy.classify(r, 'system', 'superseded by spatial_planning.clerk_* (migration 128); unused, kept until a person decides to drop it');
    END IF;
  END LOOP;
  IF to_regnamespace('planning_clerk') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    EXECUTE 'REVOKE USAGE ON SCHEMA planning_clerk FROM vungu_app';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.local_authorities WHERE code = 'VUNGU') THEN
    RAISE NOTICE 'no VUNGU authority here: the stands and the revenue link stay pending until converted by hand';
    RETURN;
  END IF;

  FOREACH r IN ARRAY ARRAY['revenue_link.account_link', 'revenue_link.billing_status'] LOOP
    IF to_regclass(r) IS NOT NULL THEN PERFORM tenancy.make_tenant(r::regclass, 'VUNGU'); END IF;
  END LOOP;

  IF to_regclass('public.stands') IS NOT NULL THEN
    PERFORM tenancy.make_tenant('public.stands'::regclass, 'VUNGU');
    DROP POLICY IF EXISTS tenant_select ON public.stands;
    CREATE POLICY tenant_select ON public.stands FOR SELECT USING (
      app.is_platform() OR authority_id = ANY (app.visible_authorities())
      OR status_code = 'available' OR reserved_by = app.user_id()::uuid OR allocated_to = app.user_id()::uuid);
    DROP POLICY IF EXISTS citizen_reserve ON public.stands;
    CREATE POLICY citizen_reserve ON public.stands FOR UPDATE
      USING (app.user_id() IS NOT NULL AND (status_code = 'available' OR reserved_by = app.user_id()::uuid))
      WITH CHECK (app.user_id() IS NOT NULL AND (reserved_by IS NULL OR reserved_by = app.user_id()::uuid));
  END IF;
  IF to_regclass('public.stand_allocation') IS NOT NULL AND to_regclass('public.stands') IS NOT NULL THEN
    PERFORM tenancy.make_tenant_child('public.stand_allocation'::regclass, 'public.stands'::regclass, 'stand_id');
  END IF;

  -- the views over the stands run as the caller, so the policies above decide what they show
  FOREACH r IN ARRAY ARRAY['public.v_stands', 'public.stands_tile_view'] LOOP
    IF to_regclass(r) IS NOT NULL THEN
      EXECUTE format('ALTER VIEW %s SET (security_invoker = true)', r);
      PERFORM tenancy.classify(r, 'tenant_view', 'runs as the caller; the stands policies decide what it shows (migration 172)');
    END IF;
  END LOOP;
END $$;
