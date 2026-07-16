-- 075: Re-point check_development_permission at the real schema.
-- The live function referenced z.name / land_parcels, which do not exist:
-- parcels are gweru_rural_farms, zones are proposed_peri_urban_zones (column
-- "zone"), and permissions come from development_matrix × land_use_groups ×
-- permission_types. Zone resolution: explicit f.zone_id first, else spatial
-- containment (largest overlap wins). Idempotent.

CREATE OR REPLACE FUNCTION check_development_permission(
    parcel_id_param INTEGER,
    proposed_use_code_param TEXT
) RETURNS TABLE (
    can_develop BOOLEAN,
    permission_code TEXT,
    permission_description TEXT,
    permission_color TEXT,
    zone_code TEXT,
    zone_description TEXT,
    current_use_code TEXT,
    proposed_use_code TEXT,
    proposed_use_description TEXT,
    conditions TEXT,
    restrictions TEXT,
    compliance_status TEXT
) AS $$
#variable_conflict use_column
DECLARE
    v_zone RECORD;
    v_perm RECORD;
    v_current_use TEXT;
BEGIN
    -- Resolve the parcel's zone: explicit assignment wins, else the zone
    -- with the largest spatial overlap.
    SELECT z.id AS zone_id, z.zone_code AS zcode, z.zone AS zname
      INTO v_zone
      FROM gweru_rural_farms f
      LEFT JOIN proposed_peri_urban_zones z
        ON (z.id = f.zone_id)
        OR (f.zone_id IS NULL AND z.is_active = TRUE AND ST_Intersects(f.geom, z.geom))
     WHERE f.id = parcel_id_param
     ORDER BY (z.id = f.zone_id) DESC NULLS LAST,
              ST_Area(ST_Intersection(f.geom, z.geom)) DESC NULLS LAST
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT
            false, 'NOT_FOUND'::TEXT, 'Parcel not found'::TEXT, '#d32f2f'::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, proposed_use_code_param,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, 'PARCEL_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    IF v_zone.zone_id IS NULL THEN
        RETURN QUERY SELECT
            false, 'UNZONED'::TEXT, 'Parcel lies outside every active zoning layer'::TEXT, '#9e9e9e'::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, proposed_use_code_param,
            NULL::TEXT, NULL::TEXT, 'Assign a zone before assessment'::TEXT, 'PENDING_REVIEW'::TEXT;
        RETURN;
    END IF;

    SELECT g2.group_code INTO v_current_use
      FROM gweru_rural_farms f2
      LEFT JOIN land_use_groups g2 ON g2.group_id = f2.current_land_use_group_id
     WHERE f2.id = parcel_id_param;

    -- Matrix lookup: zone × proposed use group → P / SC / X
    SELECT p.permission_code AS pcode, p.description AS pdesc, p.color AS pcolor,
           dm.conditions AS pconditions, g.description AS use_desc
      INTO v_perm
      FROM development_matrix dm
      JOIN land_use_groups g ON g.group_id = dm.group_id AND g.is_active = TRUE
      JOIN permission_types p ON p.permission_code = dm.permission_code
     WHERE dm.zone_id = v_zone.zone_id
       AND dm.is_active = TRUE
       AND g.group_code = proposed_use_code_param
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT
            false, 'X'::TEXT, 'Use not listed in the development matrix for this zone — prohibited by default'::TEXT, '#d32f2f'::TEXT,
            v_zone.zcode::TEXT, v_zone.zname::TEXT, v_current_use::TEXT, proposed_use_code_param::TEXT,
            NULL::TEXT, NULL::TEXT, 'Not scheduled for this zone'::TEXT, 'NON_COMPLIANT'::TEXT;
        RETURN;
    END IF;

    -- ::TEXT casts throughout: the source columns are varchar and RETURN
    -- QUERY demands exact type matches.
    RETURN QUERY SELECT
        (v_perm.pcode = 'P'),
        v_perm.pcode::TEXT,
        v_perm.pdesc::TEXT,
        v_perm.pcolor::TEXT,
        v_zone.zcode::TEXT,
        v_zone.zname::TEXT,
        v_current_use::TEXT,
        proposed_use_code_param::TEXT,
        v_perm.use_desc::TEXT,
        v_perm.pconditions::TEXT,
        (CASE v_perm.pcode
            WHEN 'X'  THEN 'Prohibited use in this zone'
            WHEN 'SC' THEN 'Special consent required from the local planning authority'
            ELSE NULL
        END)::TEXT,
        (CASE v_perm.pcode
            WHEN 'P'  THEN 'COMPLIANT'
            WHEN 'SC' THEN 'PENDING_REVIEW'
            ELSE 'NON_COMPLIANT'
        END)::TEXT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_development_permission IS
  'Zone × use-group permission check against development_matrix (P/SC/X); zone via f.zone_id or spatial containment.';
