-- 167: turning authority-owned data into tenant data is one call, and the council_ops registers are the first to use it.
--
-- The tenancy contract (165) lists 100 relations holding authority-owned data that have no row-level security. Closing them one
-- hand-written migration at a time would take for ever and get inconsistent, so the standard treatment is a function:
--
--   tenancy.make_tenant(relation, backfill_authority_code)
--       adds authority_id (default app.authority_id(), so an insert made as a person lands in their authority without the route
--       saying so; an insert made with no authority fails rather than guessing), gives every existing row to the named authority,
--       enables row-level security with the standard policies (read: own and combination authorities, write: own authority,
--       platform operators: all), grants the application role the table, and reclassifies it as tenant data.
--   tenancy.make_tenant_child(relation, parent, fk_column [, parent_key])
--       the same for a table whose rows belong through a parent that is already tenant data: no new column, policies follow the parent.
--
-- The backfill authority is NAMED, never defaulted: whoever converts a table has to say whose rows the existing ones are.

CREATE OR REPLACE FUNCTION tenancy.make_tenant(p_relation regclass, p_backfill_code text) RETURNS void AS $$
DECLARE
  qn text := p_relation::text;
  rel_name text;
  owner_id integer;
  sch name;
BEGIN
  SELECT id INTO owner_id FROM public.local_authorities WHERE code = p_backfill_code;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'the backfill authority % does not exist', p_backfill_code; END IF;
  SELECT n.nspname, n.nspname || '.' || c.relname INTO sch, rel_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_relation;

  EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS authority_id integer REFERENCES public.local_authorities (id)', qn);
  EXECUTE format('UPDATE %s SET authority_id = %s WHERE authority_id IS NULL', qn, owner_id);
  EXECUTE format('ALTER TABLE %s ALTER COLUMN authority_id SET DEFAULT app.authority_id()', qn);
  EXECUTE format('ALTER TABLE %s ALTER COLUMN authority_id SET NOT NULL', qn);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (authority_id)', left('idx_' || replace(rel_name, '.', '_') || '_authority', 63), qn);

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', qn);
  EXECUTE format('DROP POLICY IF EXISTS tenant_select ON %s', qn);
  EXECUTE format('DROP POLICY IF EXISTS tenant_write ON %s', qn);
  EXECUTE format('CREATE POLICY tenant_select ON %s FOR SELECT USING (app.is_platform() OR authority_id = ANY (app.visible_authorities()))', qn);
  EXECUTE format('CREATE POLICY tenant_write ON %s FOR ALL USING (app.is_platform() OR authority_id = app.authority_id()) WITH CHECK (app.is_platform() OR authority_id = app.authority_id())', qn);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO vungu_app', sch);
  END IF;
  PERFORM tenancy.grant_app(p_relation, 'write');
  PERFORM tenancy.classify(rel_name, 'tenant', 'rows belong to an authority (tenancy.make_tenant, migration 167)');
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tenancy.make_tenant_child(p_relation regclass, p_parent regclass, p_fk text, p_parent_key text DEFAULT 'id') RETURNS void AS $$
DECLARE
  qn text := p_relation::text;
  pn text := p_parent::text;
  rel_name text;
  sch name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_parent AND attname = 'authority_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '% has no authority_id: make the parent tenant data first (tenancy.make_tenant)', pn;
  END IF;
  SELECT n.nspname, n.nspname || '.' || c.relname INTO sch, rel_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_relation;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', qn);
  EXECUTE format('DROP POLICY IF EXISTS tenant_select ON %s', qn);
  EXECUTE format('DROP POLICY IF EXISTS tenant_write ON %s', qn);
  EXECUTE format('CREATE POLICY tenant_select ON %s FOR SELECT USING (EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I))', qn, pn, p_parent_key, p_fk);
  EXECUTE format('CREATE POLICY tenant_write ON %s FOR ALL USING (app.is_platform() OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I AND p.authority_id = app.authority_id())) WITH CHECK (app.is_platform() OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I AND p.authority_id = app.authority_id()))',
                 qn, pn, p_parent_key, p_fk, pn, p_parent_key, p_fk);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO vungu_app', sch);
  END IF;
  PERFORM tenancy.grant_app(p_relation, 'write');
  PERFORM tenancy.classify(rel_name, 'tenant_child', 'rows follow their parent (tenancy.make_tenant_child, migration 167)');
END $$ LANGUAGE plpgsql;

-- ---- the council_ops registers ------------------------------------------------------------------------------------------------
-- The council's own assets and service-desk tickets. Every existing row is Vungu's (it is the only authority with data); the
-- application role had no access to this schema at all, which is why these routes failed when the connection followed the person.
DO $$
DECLARE r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.local_authorities WHERE code = 'VUNGU') THEN
    RAISE NOTICE 'no VUNGU authority here: council_ops stays pending until it is converted by hand';
    RETURN;
  END IF;
  FOREACH r IN ARRAY ARRAY['council_ops.council_asset', 'council_ops.livestock_facility', 'council_ops.road_asset', 'council_ops.road_structure',
                           'council_ops.wash_asset', 'council_ops.service_desk_ticket'] LOOP
    IF to_regclass(r) IS NOT NULL THEN PERFORM tenancy.make_tenant(r::regclass, 'VUNGU'); END IF;
  END LOOP;

  -- A citizen raises a ticket and reads their own, whatever authority it is for (it is not their authority: they have none).
  IF to_regclass('council_ops.service_desk_ticket') IS NOT NULL THEN
    DROP POLICY IF EXISTS requester_select ON council_ops.service_desk_ticket;
    DROP POLICY IF EXISTS requester_insert ON council_ops.service_desk_ticket;
    CREATE POLICY requester_select ON council_ops.service_desk_ticket FOR SELECT USING (requester_user_id = app.user_id());
    CREATE POLICY requester_insert ON council_ops.service_desk_ticket FOR INSERT WITH CHECK (requester_user_id = app.user_id());
  END IF;
END $$;
