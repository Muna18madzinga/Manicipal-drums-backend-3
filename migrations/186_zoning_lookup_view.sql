-- "What can I build here" was returning 500 because zone_effective_controls
-- was never created on this database, and the control table's zone key is a
-- uuid while the zone polygons use integer ids. This adds a polygon matrix
-- the lookup can read, and fills a working decision for each real land use.
-- Notes say it is not a gazetted resolution.

BEGIN;

ALTER TABLE public.land_use_groups
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.zone_polygon_decision (
  zone_id integer NOT NULL REFERENCES public.proposed_peri_urban_zones(id) ON DELETE CASCADE,
  land_use_group_id uuid NOT NULL REFERENCES public.land_use_groups(id) ON DELETE CASCADE,
  control_type varchar(20) NOT NULL
    CHECK (control_type IN ('permitted', 'prohibited', 'special_consent')),
  notes text,
  PRIMARY KEY (zone_id, land_use_group_id)
);

CREATE OR REPLACE VIEW public.zone_effective_controls AS
SELECT NULL::uuid AS id,
       d.zone_id,
       d.land_use_group_id,
       d.control_type,
       'Vungu RDC'::varchar(100) AS authority,
       d.notes,
       NULL::text AS conditions,
       now() AS created_at,
       now() AS updated_at,
       NULL::timestamptz AS deleted_at,
       NULL::uuid AS deleted_by
  FROM public.zone_polygon_decision d;

CREATE OR REPLACE VIEW public.zone_decision_status AS
SELECT z.id AS zone_id,
       NULL::uuid AS plan_id,
       'Vungu working matrix'::text AS plan_title,
       1 AS plan_version,
       'draft'::text AS plan_status,
       true AS provisional,
       z.zone_type AS zone_type_code,
       'unreviewed'::text AS review_status,
       NULL::text AS reviewed_by,
       NULL::timestamptz AS reviewed_at
  FROM public.proposed_peri_urban_zones z;

INSERT INTO public.zone_polygon_decision (zone_id, land_use_group_id, control_type, notes)
SELECT z.id, g.id,
       CASE
         WHEN z.zone ILIKE '%cemet%' THEN
           CASE WHEN g.group_code = 'OS' THEN 'permitted' ELSE 'prohibited' END
         WHEN z.zone ILIKE '%railway%' THEN
           CASE WHEN g.group_code IN ('I1', 'OS') THEN 'special_consent' ELSE 'prohibited' END
         WHEN z.zone ILIKE '%light industry%' THEN
           CASE
             WHEN g.group_code = 'I1' THEN 'permitted'
             WHEN g.group_code IN ('I2', 'C2', 'OS') THEN 'special_consent'
             ELSE 'prohibited'
           END
         WHEN z.zone ILIKE '%agricultural%' THEN
           CASE
             WHEN g.group_code IN ('AG', 'OS') THEN 'permitted'
             WHEN g.group_code = 'R1' THEN 'special_consent'
             ELSE 'prohibited'
           END
         WHEN z.zone ILIKE '%economic corridor%' OR z.zone ILIKE '%mixed business%' THEN
           CASE
             WHEN g.group_code IN ('C1', 'C2', 'OS') THEN 'permitted'
             WHEN g.group_code IN ('R2', 'I1') THEN 'special_consent'
             ELSE 'prohibited'
           END
         WHEN z.zone ILIKE '%institutional%' THEN
           CASE
             WHEN g.group_code = 'OS' THEN 'permitted'
             WHEN g.group_code IN ('C1', 'R1', 'R2') THEN 'special_consent'
             ELSE 'prohibited'
           END
         WHEN z.zone ILIKE '%high density%' THEN
           CASE
             WHEN g.group_code IN ('R2', 'OS') THEN 'permitted'
             WHEN g.group_code IN ('R1', 'C1') THEN 'special_consent'
             ELSE 'prohibited'
           END
         WHEN z.zone ILIKE '%low density%' OR z.zone ILIKE '%densification%' THEN
           CASE
             WHEN g.group_code IN ('R1', 'OS') THEN 'permitted'
             WHEN g.group_code IN ('R2', 'C1', 'AG') THEN 'special_consent'
             ELSE 'prohibited'
           END
         WHEN z.zone ILIKE '%medium density%' OR z.zone ILIKE '%mixed density%' THEN
           CASE
             WHEN g.group_code IN ('R1', 'R2', 'OS') THEN 'permitted'
             WHEN g.group_code = 'C1' THEN 'special_consent'
             ELSE 'prohibited'
           END
         ELSE 'special_consent'
       END,
       'Working matrix so a check returns permitted, consent or prohibited. Not a gazetted council resolution.'
  FROM public.proposed_peri_urban_zones z
  CROSS JOIN public.land_use_groups g
 WHERE g.group_code NOT IN ('P', 'SC')
ON CONFLICT (zone_id, land_use_group_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_runtime') THEN
    GRANT SELECT ON public.zone_effective_controls, public.zone_decision_status TO vungu_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.zone_polygon_decision TO vungu_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    GRANT SELECT ON public.zone_effective_controls, public.zone_decision_status,
      public.zone_polygon_decision, public.land_use_groups, public.proposed_peri_urban_zones
      TO vungu_app;
  END IF;
END $$;

COMMIT;
