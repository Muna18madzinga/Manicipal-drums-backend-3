-- 102_survey_task_manager.sql
-- Survey Task Manager (formerly SurveyPro) shared objects, ported from the
-- standalone surveypro_v1 database (pg_dump --schema-only, public -> survey).
-- Per-surveyor schemas (surveyor_<username>) are created at runtime by
-- survey.create_surveyor_schema(); runtime search_path is
-- "surveyor_<x>, survey, public". PostGIS stays in public.

--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS survey;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA survey IS 'Shared data across all surveyors (users, districts, control points)';

--
-- Name: auto_calculate_parcel_metrics(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.auto_calculate_parcel_metrics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Only calculate if geometry exists and is valid
  IF NEW.geom IS NOT NULL AND ST_IsValid(NEW.geom) THEN
    
    -- Calculate area in square meters
    -- Geometry should be in EPSG:22291 (Cape / Lo31) for accurate area calculation
    NEW.area_m2 := ST_Area(NEW.geom);
    
    -- Convert to hectares
    NEW.area_ha := NEW.area_m2 / 10000.0;
    
    -- Calculate perimeter in meters
    NEW.perimeter_m := ST_Perimeter(NEW.geom);
    
    -- Calculate centroid coordinates
    NEW.centroid_y := ST_Y(ST_Centroid(NEW.geom));
    NEW.centroid_x := ST_X(ST_Centroid(NEW.geom));
    
    -- Calculate closure error from metadata if available
    -- This is the traverse closure error from the survey calculations
    IF NEW.metadata IS NOT NULL AND 
       NEW.metadata ? 'residuals' AND 
       NEW.metadata->'residuals' ? 'closureError' THEN
      NEW.closure_error_m := (NEW.metadata->'residuals'->>'closureError')::NUMERIC;
    END IF;
    
    -- Calculate closure ratio (perimeter / closure_error)
    -- Only if closure error is available and non-zero
    IF NEW.closure_error_m IS NOT NULL AND NEW.closure_error_m > 0 THEN
      NEW.closure_ratio := NEW.perimeter_m / NEW.closure_error_m;
    ELSE
      NEW.closure_ratio := NULL;
    END IF;
    
    -- Mark that area has been calculated
    NEW.area_calculated := TRUE;
    
    -- Log calculation for debugging (optional - comment out in production)
    RAISE DEBUG 'Auto-calculated metrics for parcel %: area=% m², perimeter=% m', 
      NEW.stand, ROUND(NEW.area_m2::NUMERIC, 2), ROUND(NEW.perimeter_m::NUMERIC, 2);
    
  ELSE
    -- If geometry is NULL or invalid, clear calculated fields
    NEW.area_m2 := NULL;
    NEW.area_ha := NULL;
    NEW.perimeter_m := NULL;
    NEW.centroid_y := NULL;
    NEW.centroid_x := NULL;
    NEW.closure_error_m := NULL;
    NEW.closure_ratio := NULL;
    NEW.area_calculated := FALSE;
    
    IF NEW.geom IS NOT NULL AND NOT ST_IsValid(NEW.geom) THEN
      RAISE WARNING 'Invalid geometry for parcel %. Area not calculated.', NEW.stand;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

--
-- Name: FUNCTION auto_calculate_parcel_metrics(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.auto_calculate_parcel_metrics() IS 'Automatically calculates area, perimeter, centroid, and closure metrics from geometry. Triggered on INSERT or UPDATE of land_parcels.geom column.';

--
-- Name: check_parcel_overlap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.check_parcel_overlap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  overlap_count INT;
  overlapping_stand VARCHAR;
  overlap_area NUMERIC;
BEGIN
  -- Check for overlaps with other parcels in the same project
  -- Allow small overlaps (< 1m²) due to digitization precision
  SELECT COUNT(*), 
         MAX(stand),
         MAX(ST_Area(ST_Intersection(geom, NEW.geom)))
  INTO overlap_count, overlapping_stand, overlap_area
  FROM land_parcels
  WHERE project_id = NEW.project_id
    AND id != COALESCE(NEW.id, -1)  -- Exclude self on UPDATE
    AND ST_Overlaps(geom, NEW.geom)
    AND ST_Area(ST_Intersection(geom, NEW.geom)) > 1.0;  -- > 1m² overlap
  
  IF overlap_count > 0 THEN
    RAISE EXCEPTION 
      'Parcel "%" overlaps with existing parcel "%" by %.2f m². Please adjust boundaries.',
      NEW.stand, overlapping_stand, overlap_area
      USING HINT = 'Check your parcel boundaries in QGIS to avoid overlaps';
  END IF;
  
  RETURN NEW;
END;
$$;

--
-- Name: create_project_views(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.create_project_views(p_project_id integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $_$
DECLARE
  v_coord_view_name TEXT;
  v_parcel_view_name TEXT;
  v_project_name TEXT;
  v_result jsonb;
BEGIN
  -- Get project name for documentation
  SELECT name INTO v_project_name 
  FROM survey_projects 
  WHERE id = p_project_id;
  
  IF v_project_name IS NULL THEN
    RAISE EXCEPTION 'Project % not found', p_project_id;
  END IF;
  
  -- Generate view names
  v_coord_view_name := 'coordinate_points_project_' || p_project_id;
  v_parcel_view_name := 'land_parcels_project_' || p_project_id;
  
  -- ========================================
  -- CREATE COORDINATE POINTS VIEW
  -- ========================================
  
  EXECUTE format('
    CREATE OR REPLACE VIEW %I AS
    SELECT 
      id,
      project_id,
      name,
      geom,
      ST_X(geom) as y,
      ST_Y(geom) as x,
      elevation,
      description,
      survey_date,
      surveyor,
      created_at,
      updated_at
    FROM coordinate_points
    WHERE project_id = %s
  ', v_coord_view_name, p_project_id);
  
  -- Grant permissions
  EXECUTE format('GRANT SELECT ON %I TO postgres', v_coord_view_name);
  
  -- Add comment
  EXECUTE format('
    COMMENT ON VIEW %I IS %L
  ', v_coord_view_name, 'Coordinate points for project ' || p_project_id || ' (' || v_project_name || ') - READ ONLY reference layer for QGIS');
  
  -- ========================================
  -- CREATE LAND PARCELS VIEW
  -- ========================================
  
  EXECUTE format('
    CREATE OR REPLACE VIEW %I AS
    SELECT 
      id,
      project_id,
      stand,
      designation,
      geom,
      owner,
      title_deed,
      survey_date,
      surveyor,
      notes,
      area_m2,
      area_ha,
      perimeter_m,
      centroid_y,
      centroid_x,
      closure_error_m,
      closure_ratio,
      status,
      digitized_by,
      metadata,
      created_at,
      updated_at
    FROM land_parcels
    WHERE project_id = %s
  ', v_parcel_view_name, p_project_id);
  
  -- Grant full permissions for editing
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO postgres', v_parcel_view_name);
  
  -- Create unique index on id to help QGIS identify primary key
  EXECUTE format('
    CREATE UNIQUE INDEX IF NOT EXISTS %I ON land_parcels(id) 
    WHERE project_id = %s
  ', v_parcel_view_name || '_pkey', p_project_id);
  
  -- Add comment
  EXECUTE format('
    COMMENT ON VIEW %I IS %L
  ', v_parcel_view_name, 'Land parcels for project ' || p_project_id || ' (' || v_project_name || ') - EDITABLE layer for QGIS digitization');
  
  -- ========================================
  -- CREATE INSERT TRIGGER
  -- ========================================
  
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      -- Force project_id
      NEW.project_id = %s;
      
      INSERT INTO land_parcels (
        project_id, stand, designation, geom, owner, title_deed, 
        survey_date, surveyor, notes, centroid_y, centroid_x, 
        closure_error_m, closure_ratio, status, digitized_by, metadata
      ) VALUES (
        NEW.project_id, NEW.stand, NEW.designation, NEW.geom, NEW.owner, 
        NEW.title_deed, NEW.survey_date, NEW.surveyor, NEW.notes, 
        NEW.centroid_y, NEW.centroid_x, NEW.closure_error_m, NEW.closure_ratio, 
        COALESCE(NEW.status, ''draft''), NEW.digitized_by, NEW.metadata
      )
      RETURNING * INTO NEW;
      
      -- Notify application of new parcel
      PERFORM pg_notify(''parcel_change'', json_build_object(
        ''action'', ''INSERT'',
        ''project_id'', NEW.project_id,
        ''parcel_id'', NEW.id,
        ''stand'', NEW.stand
      )::text);
      
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  ', v_parcel_view_name || '_insert', p_project_id);
  
  EXECUTE format('
    DROP TRIGGER IF EXISTS %I ON %I;
    CREATE TRIGGER %I
    INSTEAD OF INSERT ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ', 
    v_parcel_view_name || '_insert_trigger',
    v_parcel_view_name,
    v_parcel_view_name || '_insert_trigger',
    v_parcel_view_name,
    v_parcel_view_name || '_insert'
  );
  
  -- ========================================
  -- CREATE UPDATE TRIGGER
  -- ========================================
  
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      UPDATE land_parcels
      SET
        stand = NEW.stand,
        designation = NEW.designation,
        geom = NEW.geom,
        owner = NEW.owner,
        title_deed = NEW.title_deed,
        survey_date = NEW.survey_date,
        surveyor = NEW.surveyor,
        notes = NEW.notes,
        centroid_y = NEW.centroid_y,
        centroid_x = NEW.centroid_x,
        closure_error_m = NEW.closure_error_m,
        closure_ratio = NEW.closure_ratio,
        status = NEW.status,
        digitized_by = NEW.digitized_by,
        metadata = NEW.metadata
      WHERE id = NEW.id AND project_id = %s
      RETURNING * INTO NEW;
      
      -- Notify application of update
      PERFORM pg_notify(''parcel_change'', json_build_object(
        ''action'', ''UPDATE'',
        ''project_id'', NEW.project_id,
        ''parcel_id'', NEW.id,
        ''stand'', NEW.stand
      )::text);
      
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  ', v_parcel_view_name || '_update', p_project_id);
  
  EXECUTE format('
    DROP TRIGGER IF EXISTS %I ON %I;
    CREATE TRIGGER %I
    INSTEAD OF UPDATE ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ',
    v_parcel_view_name || '_update_trigger',
    v_parcel_view_name,
    v_parcel_view_name || '_update_trigger',
    v_parcel_view_name,
    v_parcel_view_name || '_update'
  );
  
  -- ========================================
  -- CREATE DELETE TRIGGER
  -- ========================================
  
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      DELETE FROM land_parcels
      WHERE id = OLD.id AND project_id = %s;
      
      -- Notify application of deletion
      PERFORM pg_notify(''parcel_change'', json_build_object(
        ''action'', ''DELETE'',
        ''project_id'', OLD.project_id,
        ''parcel_id'', OLD.id,
        ''stand'', OLD.stand
      )::text);
      
      RETURN OLD;
    END;
    $func$ LANGUAGE plpgsql;
  ', v_parcel_view_name || '_delete', p_project_id);
  
  EXECUTE format('
    DROP TRIGGER IF EXISTS %I ON %I;
    CREATE TRIGGER %I
    INSTEAD OF DELETE ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ',
    v_parcel_view_name || '_delete_trigger',
    v_parcel_view_name,
    v_parcel_view_name || '_delete_trigger',
    v_parcel_view_name,
    v_parcel_view_name || '_delete'
  );
  
  -- Build result
  v_result := jsonb_build_object(
    'project_id', p_project_id,
    'project_name', v_project_name,
    'coordinate_view', v_coord_view_name,
    'parcel_view', v_parcel_view_name,
    'status', 'created'
  );
  
  RETURN v_result;
END;
$_$;

--
-- Name: create_surveyor_schema(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.create_surveyor_schema(p_username character varying) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_schema_name VARCHAR;
BEGIN
  -- Generate schema name
  v_schema_name := generate_schema_name(p_username);
  
  -- Create schema
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema_name);
  
  -- =========================================
  -- Create survey_projects table
  -- =========================================
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.survey_projects (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      client_name VARCHAR(255),
      survey_type VARCHAR(100),
      township VARCHAR(255),
      designation TEXT,
      survey_date DATE,
      district VARCHAR(100),
      central_meridian VARCHAR(10),
      instruments VARCHAR(255),
      datum VARCHAR(50),
      working_directory TEXT,
      status VARCHAR(50) DEFAULT ''active'',
      metadata JSONB,
      workflow_state JSONB DEFAULT ''{"completed_steps": [], "current_step": "project-setup", "step_data": {}, "generated_documents": {}, "can_finalize": false}''::jsonb,
      last_used TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )', v_schema_name);
  
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_projects_name ON %I.survey_projects(name)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_projects_date ON %I.survey_projects(survey_date)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_projects_status ON %I.survey_projects(status)', v_schema_name);
  
  -- =========================================
  -- Create coordinate_points table
  -- =========================================
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.coordinate_points (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES %I.survey_projects(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      geom GEOMETRY(Point, 22291),
      elevation NUMERIC(10, 3),
      description TEXT,
      survey_date DATE,
      surveyor VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(project_id, name)
    )', v_schema_name, v_schema_name);
  
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_coord_points_project ON %I.coordinate_points(project_id)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_coord_points_name ON %I.coordinate_points(name)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_coord_points_geom ON %I.coordinate_points USING GIST(geom)', v_schema_name);
  
  -- =========================================
  -- Create land_parcels table
  -- =========================================
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.land_parcels (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES %I.survey_projects(id) ON DELETE CASCADE,
      stand VARCHAR(50),
      designation VARCHAR(255),
      owner VARCHAR(255),
      title_deed VARCHAR(100),
      survey_date DATE,
      surveyor VARCHAR(255),
      notes TEXT,
      centroid_y NUMERIC(12, 3),
      centroid_x NUMERIC(12, 3),
      closure_error_m NUMERIC(10, 3),
      closure_ratio VARCHAR(20),
      area_m2 NUMERIC(12, 2),
      area_ha NUMERIC(12, 4),
      perimeter_m NUMERIC(12, 2),
      area_calculated BOOLEAN DEFAULT FALSE,
      calculation_data JSONB,
      status VARCHAR(50) DEFAULT ''draft'',
      digitized_by INTEGER,
      finalized_at TIMESTAMP,
      geom GEOMETRY(Polygon, 22291),
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT unique_project_stand UNIQUE(project_id, stand)
    )', v_schema_name, v_schema_name);
  
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_land_parcels_project ON %I.land_parcels(project_id)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_land_parcels_stand ON %I.land_parcels(stand)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_land_parcels_status ON %I.land_parcels(status)', v_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_land_parcels_geom ON %I.land_parcels USING GIST(geom)', v_schema_name);
  
  -- Grant permissions to application role (if exists)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'surveypro_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO surveypro_app', v_schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO surveypro_app', v_schema_name);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO surveypro_app', v_schema_name);
    
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON TABLES TO surveypro_app', v_schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON SEQUENCES TO surveypro_app', v_schema_name);
  END IF;
  
  RAISE NOTICE 'Created schema: % with all tables', v_schema_name;
  RETURN v_schema_name;
END;
$$;

--
-- Name: FUNCTION create_surveyor_schema(p_username character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.create_surveyor_schema(p_username character varying) IS 'Creates a complete surveyor schema with all necessary tables and permissions (updated with all project fields)';

--
-- Name: drop_project_views(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.drop_project_views(p_project_id integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_coord_view_name TEXT;
  v_parcel_view_name TEXT;
  v_result jsonb;
BEGIN
  v_coord_view_name := 'coordinate_points_project_' || p_project_id;
  v_parcel_view_name := 'land_parcels_project_' || p_project_id;
  
  -- Drop triggers
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 
    v_parcel_view_name || '_insert_trigger', v_parcel_view_name);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 
    v_parcel_view_name || '_update_trigger', v_parcel_view_name);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 
    v_parcel_view_name || '_delete_trigger', v_parcel_view_name);
  
  -- Drop functions
  EXECUTE format('DROP FUNCTION IF EXISTS %I()', v_parcel_view_name || '_insert');
  EXECUTE format('DROP FUNCTION IF EXISTS %I()', v_parcel_view_name || '_update');
  EXECUTE format('DROP FUNCTION IF EXISTS %I()', v_parcel_view_name || '_delete');
  
  -- Drop views
  EXECUTE format('DROP VIEW IF EXISTS %I', v_coord_view_name);
  EXECUTE format('DROP VIEW IF EXISTS %I', v_parcel_view_name);
  
  v_result := jsonb_build_object(
    'project_id', p_project_id,
    'coordinate_view', v_coord_view_name,
    'parcel_view', v_parcel_view_name,
    'status', 'dropped'
  );
  
  RETURN v_result;
END;
$$;

--
-- Name: drop_surveyor_schema(character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.drop_surveyor_schema(p_username character varying, p_confirm character varying) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_schema_name VARCHAR;
BEGIN
  v_schema_name := generate_schema_name(p_username);
  
  IF p_confirm != v_schema_name THEN
    RAISE EXCEPTION 'Confirmation does not match schema name. Expected: %, Got: %', v_schema_name, p_confirm;
  END IF;
  
  EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_schema_name);
  
  RETURN TRUE;
END;
$$;

--
-- Name: FUNCTION drop_surveyor_schema(p_username character varying, p_confirm character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.drop_surveyor_schema(p_username character varying, p_confirm character varying) IS 'Safely drops a surveyor schema with confirmation (CASCADE removes all data!)';

--
-- Name: extract_vertices_from_geometry(public.geometry, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.extract_vertices_from_geometry(geom_input public.geometry, stand_prefix text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  vertices JSONB := '[]'::JSONB;
  point_geom GEOMETRY;
  point_count INTEGER;
  i INTEGER;
  vertex_id TEXT;
  vertex_obj JSONB;
BEGIN
  -- Only process valid polygon geometries
  IF geom_input IS NULL OR NOT ST_IsValid(geom_input) OR ST_GeometryType(geom_input) != 'ST_Polygon' THEN
    RETURN vertices;
  END IF;
  
  -- Get exterior ring
  point_geom := ST_ExteriorRing(geom_input);
  point_count := ST_NPoints(point_geom) - 1; -- Exclude duplicate closing point
  
  -- Extract each vertex
  FOR i IN 1..point_count LOOP
    -- Generate default vertex ID if stand_prefix provided
    IF stand_prefix IS NOT NULL THEN
      vertex_id := stand_prefix || chr(64 + i); -- A, B, C, D, ...
    ELSE
      vertex_id := 'V' || i::TEXT;
    END IF;
    
    -- Create vertex object
    vertex_obj := jsonb_build_object(
      'id', vertex_id,
      'y', ST_Y(ST_PointN(point_geom, i)),
      'x', ST_X(ST_PointN(point_geom, i)),
      'order', i
    );
    
    -- Append to vertices array
    vertices := vertices || vertex_obj;
  END LOOP;
  
  RETURN vertices;
END;
$$;

--
-- Name: FUNCTION extract_vertices_from_geometry(geom_input public.geometry, stand_prefix text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.extract_vertices_from_geometry(geom_input public.geometry, stand_prefix text) IS 'Extracts vertices from polygon geometry and returns as JSONB array. If stand_prefix provided, generates IDs like "1463A", "1463B", etc. Otherwise uses generic "V1", "V2", etc.';

--
-- Name: generate_parcel_metadata(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.generate_parcel_metadata(parcel_id integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  parcel_geom GEOMETRY;
  parcel_stand VARCHAR;
  project_id_val INTEGER;
  vertices GEOMETRY[];
  vertex_count INTEGER;
  i INTEGER;
  current_point GEOMETRY;
  next_point GEOMETRY;
  distance NUMERIC;
  bearing NUMERIC;
  dy NUMERIC;
  dx NUMERIC;
  from_y NUMERIC;
  from_x NUMERIC;
  to_y NUMERIC;
  to_x NUMERIC;
  edges JSONB := '[]'::JSONB;
  points JSONB := '[]'::JSONB;
  matched_point RECORD;
  point_id TEXT;
  point_y NUMERIC;
  point_x NUMERIC;
  tolerance NUMERIC := 0.5; -- 0.5 meter tolerance for matching
  metadata JSONB;
BEGIN
  -- Get parcel geometry and info (uses current search_path)
  SELECT geom, stand, project_id INTO parcel_geom, parcel_stand, project_id_val
  FROM land_parcels
  WHERE id = parcel_id;
  
  IF parcel_geom IS NULL THEN
    RAISE EXCEPTION 'Parcel % not found', parcel_id;
  END IF;
  
  -- Extract vertices from polygon exterior ring
  SELECT ARRAY(
    SELECT ST_PointN(ST_ExteriorRing(parcel_geom), generate_series(1, ST_NPoints(ST_ExteriorRing(parcel_geom))))
  ) INTO vertices;
  
  vertex_count := array_length(vertices, 1) - 1; -- Exclude duplicate closing point
  
  -- Loop through vertices to calculate edges and match points
  FOR i IN 1..vertex_count LOOP
    current_point := vertices[i];
    next_point := vertices[(i % vertex_count) + 1];
    
    -- Extract Y (Westing) and X (Southing) coordinates
    point_y := ST_Y(current_point);
    point_x := ST_X(current_point);
    
    -- Try to match vertex to coordinate_points within tolerance (uses current search_path)
    SELECT name, ST_Y(geom) as y, ST_X(geom) as x INTO matched_point
    FROM coordinate_points
    WHERE project_id = project_id_val
      AND ST_DWithin(geom, current_point, tolerance)
    ORDER BY ST_Distance(geom, current_point)
    LIMIT 1;
    
    -- Use matched point name or generate sequential name
    IF matched_point.name IS NOT NULL THEN
      point_id := matched_point.name;
      point_y := matched_point.y;
      point_x := matched_point.x;
    ELSE
      -- Generate sequential name: A, B, C, D...
      point_id := chr(64 + i); -- 65=A, 66=B, etc.
    END IF;
    
    -- Calculate distance to next point
    distance := ST_Distance(current_point, next_point);
    
    -- Calculate dy and dx (coordinate differences)
    -- Cape Lo: Y = Westing (increases west), X = Southing (increases south)
    dy := ST_Y(next_point) - point_y;
    dx := ST_X(next_point) - point_x;
    
    -- Calculate bearing using the SAME formula as backend's calculateEdgesFromGeometry
    -- This matches pdfkitGeoPDF.js lines 1040-1073
    -- bearing = atan2(dy, dx) converted to degrees, then adjusted for south orientation
    bearing := ATAN2(dy, dx) * (180.0 / PI());
    
    -- Convert to south-oriented (0° = South, clockwise)
    -- This matches the backend formula: bearing = 90 - bearing
    bearing := 90.0 - bearing;
    
    -- Normalize to 0-360 range
    IF bearing < 0.0 THEN
      bearing := bearing + 360.0;
    END IF;
    IF bearing >= 360.0 THEN
      bearing := bearing - 360.0;
    END IF;
    
    -- Store from/to coordinates for direction verification
    from_y := point_y;
    from_x := point_x;
    to_y := ST_Y(next_point);
    to_x := ST_X(next_point);
    
    -- Add edge to edges array with from/to coordinates
    edges := edges || jsonb_build_object(
      'distance', ROUND(distance::NUMERIC, 3),
      'bearingDeg', ROUND(bearing::NUMERIC, 6),
      'bearing', ROUND(bearing::NUMERIC, 6),
      'dy', ROUND(dy::NUMERIC, 3),
      'dx', ROUND(dx::NUMERIC, 3),
      'from', jsonb_build_object(
        'y', ROUND(from_y::NUMERIC, 6),
        'x', ROUND(from_x::NUMERIC, 6)
      ),
      'to', jsonb_build_object(
        'y', ROUND(to_y::NUMERIC, 6),
        'x', ROUND(to_x::NUMERIC, 6)
      )
    );
    
    -- Add point to points array
    points := points || jsonb_build_object(
      'id', point_id,
      'y', ROUND(point_y::NUMERIC, 2),
      'x', ROUND(point_x::NUMERIC, 2)
    );
  END LOOP;
  
  -- Build complete metadata structure
  metadata := jsonb_build_object(
    'cape_lo_points', points,
    'residuals', jsonb_build_object(
      'edges', edges
    ),
    'points_count', vertex_count,
    'generated_from_geometry', true,
    'generated_at', NOW()
  );
  
  RETURN metadata;
END;
$$;

--
-- Name: FUNCTION generate_parcel_metadata(parcel_id integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.generate_parcel_metadata(parcel_id integer) IS 'Generates traverse metadata (edges with south-oriented bearings using atan2(dy,dx) formula, points) from parcel geometry. Schema-agnostic - uses current search_path. Matches backend calculateEdgesFromGeometry formula.';

--
-- Name: generate_parcel_metadata_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.generate_parcel_metadata_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parcel_geom GEOMETRY;
  parcel_stand VARCHAR;
  project_id_val INTEGER;
  vertices GEOMETRY[];
  vertex_count INTEGER;
  i INTEGER;
  current_point GEOMETRY;
  next_point GEOMETRY;
  distance NUMERIC;
  bearing NUMERIC;
  dy NUMERIC;
  dx NUMERIC;
  from_y NUMERIC;
  from_x NUMERIC;
  to_y NUMERIC;
  to_x NUMERIC;
  edges JSONB := '[]'::JSONB;
  points JSONB := '[]'::JSONB;
  matched_point RECORD;
  point_id TEXT;
  point_y NUMERIC;
  point_x NUMERIC;
  tolerance NUMERIC := 0.5;
  metadata JSONB;
BEGIN
  -- Only process if geometry exists
  IF NEW.geom IS NULL THEN
    RETURN NEW;
  END IF;

  parcel_geom := NEW.geom;
  parcel_stand := NEW.stand;
  project_id_val := NEW.project_id;
  
  -- Extract vertices from polygon exterior ring
  SELECT ARRAY(
    SELECT ST_PointN(ST_ExteriorRing(parcel_geom), generate_series(1, ST_NPoints(ST_ExteriorRing(parcel_geom))))
  ) INTO vertices;
  
  vertex_count := array_length(vertices, 1) - 1; -- Exclude duplicate closing point
  
  -- Loop through vertices to calculate edges and match points
  FOR i IN 1..vertex_count LOOP
    current_point := vertices[i];
    next_point := vertices[(i % vertex_count) + 1];
    
    -- Extract Y (Westing) and X (Southing) coordinates
    point_y := ST_Y(current_point);
    point_x := ST_X(current_point);
    
    -- Try to match vertex to coordinate_points within tolerance
    IF project_id_val IS NOT NULL THEN
      SELECT name, ST_Y(geom) as y, ST_X(geom) as x INTO matched_point
      FROM coordinate_points
      WHERE project_id = project_id_val
        AND ST_DWithin(geom, current_point, tolerance)
      ORDER BY ST_Distance(geom, current_point)
      LIMIT 1;
    END IF;
    
    -- Use matched point name or generate sequential name
    IF matched_point.name IS NOT NULL THEN
      point_id := matched_point.name;
      point_y := matched_point.y;
      point_x := matched_point.x;
    ELSE
      -- Generate sequential name: A, B, C, D...
      point_id := chr(64 + i); -- 65=A, 66=B, etc.
    END IF;
    
    distance := ST_Distance(current_point, next_point);
    
    -- CORRECT BEARING CALCULATION - matches backend pdfkitGeoPDF.js
    dy := ST_Y(next_point) - point_y;
    dx := ST_X(next_point) - point_x;
    
    -- Use atan2(dy, dx) formula, then convert to south-oriented
    bearing := ATAN2(dy, dx) * (180.0 / PI());
    bearing := 90.0 - bearing;
    
    -- Normalize to 0-360 range
    IF bearing < 0.0 THEN
      bearing := bearing + 360.0;
    END IF;
    IF bearing >= 360.0 THEN
      bearing := bearing - 360.0;
    END IF;
    
    from_y := point_y;
    from_x := point_x;
    to_y := ST_Y(next_point);
    to_x := ST_X(next_point);
    
    edges := edges || jsonb_build_object(
      'distance', ROUND(distance::NUMERIC, 3),
      'bearingDeg', ROUND(bearing::NUMERIC, 6),
      'bearing', ROUND(bearing::NUMERIC, 6),
      'dy', ROUND(dy::NUMERIC, 3),
      'dx', ROUND(dx::NUMERIC, 3),
      'from', jsonb_build_object(
        'y', ROUND(from_y::NUMERIC, 6),
        'x', ROUND(from_x::NUMERIC, 6)
      ),
      'to', jsonb_build_object(
        'y', ROUND(to_y::NUMERIC, 6),
        'x', ROUND(to_x::NUMERIC, 6)
      )
    );
    
    points := points || jsonb_build_object(
      'id', point_id,
      'y', ROUND(point_y::NUMERIC, 2),
      'x', ROUND(point_x::NUMERIC, 2)
    );
  END LOOP;
  
  -- Build complete metadata structure
  metadata := jsonb_build_object(
    'cape_lo_points', points,
    'residuals', jsonb_build_object(
      'edges', edges
    ),
    'points_count', vertex_count,
    'generated_from_geometry', true,
    'generated_at', NOW()
  );
  
  -- Merge with existing metadata
  NEW.metadata := COALESCE(NEW.metadata, '{}'::JSONB) || metadata;
  
  RETURN NEW;
END;
$$;

--
-- Name: FUNCTION generate_parcel_metadata_trigger(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.generate_parcel_metadata_trigger() IS 'Automatically generates edge metadata (south-oriented bearings, distances, from/to coordinates) when parcels are inserted or updated from QGIS. Enables seamless workflow with single source of truth for edge data used in UI and PDF generation.';

--
-- Name: generate_schema_name(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.generate_schema_name(p_username character varying) RETURNS character varying
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  RETURN 'surveyor_' || lower(regexp_replace(p_username, '[^a-zA-Z0-9]', '_', 'g'));
END;
$$;

--
-- Name: list_project_views(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.list_project_views() RETURNS TABLE(project_id integer, coordinate_view text, parcel_view text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    (regexp_match(viewname, 'coordinate_points_project_(\d+)'))[1]::INTEGER as project_id,
    viewname::TEXT as coordinate_view,
    ('land_parcels_project_' || (regexp_match(viewname, 'coordinate_points_project_(\d+)'))[1])::TEXT as parcel_view
  FROM pg_views
  WHERE schemaname = 'public'
    AND viewname LIKE 'coordinate_points_project_%'
  ORDER BY project_id;
END;
$$;

--
-- Name: migrate_surveyor_to_schema(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.migrate_surveyor_to_schema(p_surveyor_id integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_schema_name TEXT;
  v_surveyor_name TEXT;
  v_projects_count INTEGER;
  v_points_count INTEGER;
  v_parcels_count INTEGER;
BEGIN
  -- Get surveyor info
  SELECT name, schema_name 
  INTO v_surveyor_name, v_schema_name
  FROM surveyor_profiles 
  WHERE id = p_surveyor_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Surveyor with id % not found', p_surveyor_id;
  END IF;
  
  IF v_schema_name IS NULL THEN
    RAISE EXCEPTION 'Surveyor % has no schema assigned', v_surveyor_name;
  END IF;
  
  -- Migrate survey_projects
  EXECUTE format('
    INSERT INTO %I.survey_projects 
      (id, name, client_name, survey_type, survey_date, district, 
       central_meridian, working_directory, status, created_at, updated_at)
    SELECT id, name, client_name, survey_type, survey_date, district,
           central_meridian::VARCHAR(10), working_directory, status, created_at, updated_at
    FROM survey.survey_projects
    WHERE surveyor_profile_id = %s
    ON CONFLICT (id) DO NOTHING
  ', v_schema_name, p_surveyor_id);
  
  GET DIAGNOSTICS v_projects_count = ROW_COUNT;
  
  -- Migrate coordinate_points
  EXECUTE format('
    INSERT INTO %I.coordinate_points 
      (id, project_id, name, geom, elevation, description, created_at, updated_at)
    SELECT cp.id, cp.project_id, cp.name, cp.geom, cp.elevation, 
           cp.description, cp.created_at, cp.updated_at
    FROM survey.coordinate_points cp
    WHERE cp.project_id IN (
      SELECT id FROM survey.survey_projects WHERE surveyor_profile_id = %s
    )
    ON CONFLICT (project_id, name) DO NOTHING
  ', v_schema_name, p_surveyor_id);
  
  GET DIAGNOSTICS v_points_count = ROW_COUNT;
  
  -- Migrate land_parcels
  EXECUTE format('
    INSERT INTO %I.land_parcels 
      (id, project_id, stand, designation, area_m2, area_ha, 
       closure_error_m, geom, created_at, updated_at)
    SELECT lp.id, lp.project_id, lp.stand, lp.designation, 
           lp.area_m2, lp.area_ha, lp.closure_error_m, lp.geom,
           lp.created_at, lp.updated_at
    FROM survey.land_parcels lp
    WHERE lp.project_id IN (
      SELECT id FROM survey.survey_projects WHERE surveyor_profile_id = %s
    )
    ON CONFLICT (project_id, stand) DO NOTHING
  ', v_schema_name, p_surveyor_id);
  
  GET DIAGNOSTICS v_parcels_count = ROW_COUNT;
  
  -- NOTE: Skipping workflow_states - table doesn't exist in surveyor schema yet
  -- Workflow data will stay in survey.workflow_states for now
  
  RETURN format('✅ Successfully migrated surveyor "%s" (ID: %s) to schema %s

📊 Migration Summary:
  • Projects:          %s
  • Coordinate Points: %s  
  • Land Parcels:      %s
  • Workflow States:   (skipped - not in surveyor schema yet)', 
                v_surveyor_name, p_surveyor_id, v_schema_name,
                v_projects_count, v_points_count, v_parcels_count);
END;
$$;

--
-- Name: FUNCTION migrate_surveyor_to_schema(p_surveyor_id integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.migrate_surveyor_to_schema(p_surveyor_id integer) IS 'Migrates surveyor data from public to surveyor schema (excluding workflow_states)';

--
-- Name: update_control_points_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_control_points_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

--
-- Name: update_csv_import_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_csv_import_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

--
-- Name: update_import_has_parcels(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_import_has_parcels() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE project_csv_imports 
    SET has_land_parcels = TRUE 
    WHERE id = NEW.import_id;
  ELSIF TG_OP = 'DELETE' THEN
    -- Check if any parcels remain for this import
    UPDATE project_csv_imports 
    SET has_land_parcels = EXISTS(
      SELECT 1 FROM land_parcels WHERE import_id = OLD.import_id
    )
    WHERE id = OLD.import_id;
  END IF;
  RETURN NULL;
END;
$$;

--
-- Name: update_land_parcels_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_land_parcels_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

--
-- Name: update_parcel_vertices(integer, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_parcel_vertices(parcel_id integer, vertex_labels text[] DEFAULT NULL::text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  parcel_geom GEOMETRY;
  parcel_stand TEXT;
  vertices JSONB;
  current_metadata JSONB;
BEGIN
  -- Get parcel geometry and stand
  SELECT geom, stand INTO parcel_geom, parcel_stand
  FROM land_parcels
  WHERE id = parcel_id;
  
  IF parcel_geom IS NULL THEN
    RAISE EXCEPTION 'Parcel % not found or has no geometry', parcel_id;
  END IF;
  
  -- Extract vertices
  IF vertex_labels IS NOT NULL THEN
    -- Use provided labels
    vertices := '[]'::JSONB;
    FOR i IN 1..array_length(vertex_labels, 1) LOOP
      vertices := vertices || jsonb_build_object(
        'id', vertex_labels[i],
        'y', ST_Y(ST_PointN(ST_ExteriorRing(parcel_geom), i)),
        'x', ST_X(ST_PointN(ST_ExteriorRing(parcel_geom), i)),
        'order', i
      );
    END LOOP;
  ELSE
    -- Auto-generate from geometry
    vertices := extract_vertices_from_geometry(parcel_geom, parcel_stand);
  END IF;
  
  -- Update metadata
  UPDATE land_parcels
  SET metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object('vertices', vertices)
  WHERE id = parcel_id;
  
  RAISE NOTICE 'Updated vertices for parcel % (stand %): % vertices', parcel_id, parcel_stand, jsonb_array_length(vertices);
END;
$$;

--
-- Name: FUNCTION update_parcel_vertices(parcel_id integer, vertex_labels text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.update_parcel_vertices(parcel_id integer, vertex_labels text[]) IS 'Updates the vertices array in parcel metadata. If vertex_labels provided, uses those IDs. Otherwise auto-generates from stand + letters.';

--
-- Name: update_parcels_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_parcels_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

--
-- Name: update_parcels_with_missing_metadata(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_parcels_with_missing_metadata(p_project_id integer DEFAULT NULL::integer) RETURNS TABLE(parcel_id integer, parcel_stand character varying, updated boolean, error_message text)
    LANGUAGE plpgsql
    AS $$
DECLARE
  parcel_record RECORD;
  generated_metadata JSONB;
BEGIN
  FOR parcel_record IN 
    SELECT lp.id, lp.stand, lp.metadata
    FROM land_parcels lp
    WHERE (p_project_id IS NULL OR lp.project_id = p_project_id)
      AND (
        lp.metadata IS NULL 
        OR NOT (lp.metadata ? 'residuals')
        OR NOT (lp.metadata->'residuals' ? 'edges')
        OR jsonb_array_length(COALESCE(lp.metadata->'residuals'->'edges', '[]'::jsonb)) = 0
      )
  LOOP
    BEGIN
      -- Generate metadata from geometry
      generated_metadata := generate_parcel_metadata(parcel_record.id);
      
      -- Update parcel with generated metadata
      UPDATE land_parcels
      SET metadata = COALESCE(metadata, '{}'::jsonb) || generated_metadata
      WHERE id = parcel_record.id;
      
      parcel_id := parcel_record.id;
      parcel_stand := parcel_record.stand;
      updated := TRUE;
      error_message := NULL;
      RETURN NEXT;
      
    EXCEPTION WHEN OTHERS THEN
      parcel_id := parcel_record.id;
      parcel_stand := parcel_record.stand;
      updated := FALSE;
      error_message := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;
END;
$$;

--
-- Name: FUNCTION update_parcels_with_missing_metadata(p_project_id integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.update_parcels_with_missing_metadata(p_project_id integer) IS 'Updates all parcels with missing metadata by generating from geometry. Schema-agnostic - uses current search_path.';

--
-- Name: update_project_last_used(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_project_last_used(project_id_param integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE survey_projects 
  SET last_used = CURRENT_TIMESTAMP 
  WHERE id = project_id_param;
END;
$$;

--
-- Name: FUNCTION update_project_last_used(project_id_param integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION survey.update_project_last_used(project_id_param integer) IS 'Updates the last_used timestamp for a project when it is accessed';

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

--
-- Name: update_workflow_states_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION survey.update_workflow_states_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: surveyor_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.surveyor_profiles (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(255) NOT NULL,
    surveyor_type character varying(50) NOT NULL,
    license_number character varying(100),
    registration_number character varying(100),
    student_number character varying(100),
    firm character varying(255),
    address text,
    phone character varying(50),
    institution character varying(255),
    supervisor_id integer,
    qualification_date date,
    specializations text[],
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    schema_name character varying(63),
    CONSTRAINT check_registered_has_license CHECK ((((surveyor_type)::text <> 'registered'::text) OR (license_number IS NOT NULL))),
    CONSTRAINT check_student_has_number CHECK ((((surveyor_type)::text <> 'student'::text) OR (student_number IS NOT NULL))),
    CONSTRAINT surveyor_profiles_surveyor_type_check CHECK (((surveyor_type)::text = ANY ((ARRAY['registered'::character varying, 'in_training'::character varying, 'technician'::character varying, 'student'::character varying])::text[])))
);

--
-- Name: COLUMN surveyor_profiles.schema_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.surveyor_profiles.schema_name IS 'PostgreSQL schema name for this surveyor (e.g., surveyor_john_doe)';

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.users (
    id integer CONSTRAINT users_new_id_not_null NOT NULL,
    email character varying(255) CONSTRAINT users_new_email_not_null NOT NULL,
    password_hash character varying(255) CONSTRAINT users_new_password_hash_not_null NOT NULL,
    user_type character varying(50) CONSTRAINT users_new_user_type_not_null NOT NULL,
    is_active boolean DEFAULT true,
    last_login timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_new_user_type_check CHECK (((user_type)::text = ANY ((ARRAY['registered_surveyor'::character varying, 'surveyor_in_training'::character varying, 'technician'::character varying, 'student'::character varying])::text[])))
);

--
-- Name: land_parcels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.land_parcels (
    id integer CONSTRAINT land_parcels_id_not_null1 NOT NULL,
    project_id integer,
    stand character varying(100) NOT NULL,
    geom public.geometry(Polygon,22291) NOT NULL,
    owner character varying(255),
    title_deed character varying(100),
    survey_date date,
    surveyor character varying(255),
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    area_m2 numeric GENERATED ALWAYS AS (public.st_area(geom)) STORED,
    area_ha numeric GENERATED ALWAYS AS ((public.st_area(geom) / (10000)::double precision)) STORED,
    perimeter_m numeric GENERATED ALWAYS AS (public.st_perimeter(geom)) STORED,
    area_calculated boolean DEFAULT false,
    centroid_y numeric(15,3),
    centroid_x numeric(15,3),
    calculation_data jsonb,
    closure_error_m numeric(15,3),
    import_id integer,
    parcel_status character varying(20) DEFAULT 'active'::character varying,
    status character varying(20) DEFAULT 'draft'::character varying,
    digitized_by integer,
    finalized_at timestamp without time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    designation character varying(100),
    closure_ratio character varying(50),
    CONSTRAINT land_parcels_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'finalized'::character varying, 'approved'::character varying])::text[])))
);

--
-- Name: TABLE land_parcels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.land_parcels IS 'Land parcels with geometries in Cape Lo convention (y=Westing, x=Southing) - updated by migration 063';

--
-- Name: COLUMN land_parcels.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.updated_at IS 'Timestamp of last update (auto-updated by trigger)';

--
-- Name: COLUMN land_parcels.area_m2; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.area_m2 IS 'Calculated area in square meters';

--
-- Name: COLUMN land_parcels.area_calculated; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.area_calculated IS 'Whether area has been calculated using shoelace method';

--
-- Name: COLUMN land_parcels.centroid_y; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.centroid_y IS 'Centroid Y coordinate (Westing) in Cape Lo 31';

--
-- Name: COLUMN land_parcels.centroid_x; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.centroid_x IS 'Centroid X coordinate (Southing) in Cape Lo 31';

--
-- Name: COLUMN land_parcels.calculation_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.calculation_data IS 'Full area calculation results (JSONB)';

--
-- Name: COLUMN land_parcels.closure_error_m; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.closure_error_m IS 'Closure error in meters from area calculation';

--
-- Name: COLUMN land_parcels.parcel_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.parcel_status IS 'Status: active, orphaned (no matching points), partial (some points missing), pending_review';

--
-- Name: COLUMN land_parcels.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.status IS 'Parcel status: draft (auto-saved), finalized (user confirmed), approved (surveyor approved)';

--
-- Name: COLUMN land_parcels.digitized_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.digitized_by IS 'User ID who digitized this parcel';

--
-- Name: COLUMN land_parcels.finalized_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.finalized_at IS 'Timestamp when parcel was finalized';

--
-- Name: COLUMN land_parcels.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.metadata IS 'JSONB metadata for land parcel. Expected structure:
  {
    "vertices": [
      {"id": "1463A", "y": 18862.52, "x": 2268555.01, "order": 1},
      {"id": "1462A", "y": 18875.14, "x": 2268541.39, "order": 2},
      ...
    ],
    "cape_lo_points": [...],  // Legacy: auto-generated points
    "residuals": {
      "sumDy": 0.001,
      "sumDx": -0.002,
      "closureError": 0.0022,
      "edges": [...]
    }
  }
  
  vertices: Array of actual beacon identifiers with coordinates (for QGIS parcels)
  cape_lo_points: Array of points for UI-digitized parcels
  residuals: Traverse closure data from area computation';

--
-- Name: COLUMN land_parcels.designation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.designation IS 'Parcel designation/stand number (modern naming, alias for stand)';

--
-- Name: COLUMN land_parcels.closure_ratio; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.land_parcels.closure_ratio IS 'Closure ratio in format 1:XXXX';

--
-- Name: area_parcels; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW survey.area_parcels AS
 SELECT id,
    project_id,
    designation,
    geom AS geometry,
    area_m2 AS area_sqm,
    perimeter_m,
        CASE
            WHEN ((perimeter_m > (0)::numeric) AND (closure_error_m > (0)::numeric)) THEN ('1:'::text || (round((perimeter_m / closure_error_m)))::text)
            ELSE 'N/A'::text
        END AS closure_ratio,
    closure_error_m AS closure_error,
    status,
    created_at AS digitized_at,
    digitized_by,
    finalized_at,
    metadata,
    created_at,
    updated_at
   FROM survey.land_parcels;

--
-- Name: VIEW area_parcels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW survey.area_parcels IS 'Backward compatibility view - maps land_parcels to old area_parcels schema';

--
-- Name: zim_control_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.zim_control_points (
    id integer CONSTRAINT control_points_id_not_null NOT NULL,
    monu_num character varying(20) CONSTRAINT control_points_monu_num_not_null NOT NULL,
    monu_name character varying(100),
    type character varying(10) CONSTRAINT control_points_type_not_null NOT NULL,
    comp_sheet character varying(20),
    topo character varying(20),
    gauss_lo integer,
    y_gauss numeric(15,3),
    x_gauss numeric(15,3),
    msl_hgt numeric(10,3),
    ped_hgt numeric(10,3),
    pill_hgt numeric(10,3),
    top_signal numeric(10,3),
    bot_signal numeric(10,3),
    last_insp date,
    deg_sqr character varying(10),
    remark text,
    area_nm character varying(100),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    lat_wgs84 numeric(10,7),
    lng_wgs84 numeric(10,7),
    CONSTRAINT control_points_gauss_lo_check CHECK ((gauss_lo = ANY (ARRAY[27, 29, 31, 33]))),
    CONSTRAINT control_points_type_check CHECK (((type)::text = ANY (ARRAY['PRIM'::text, 'SEC'::text, 'TERT'::text, 'QUART'::text, 'TSM'::text])))
);

--
-- Name: TABLE zim_control_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.zim_control_points IS 'Zimbabwe national control point database';

--
-- Name: COLUMN zim_control_points.monu_num; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.monu_num IS 'Monument number (unique identifier)';

--
-- Name: COLUMN zim_control_points.monu_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.monu_name IS 'Monument name (can be NULL for TSM records)';

--
-- Name: COLUMN zim_control_points.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.type IS 'Monument type: PRIM (Primary), SEC (Secondary), TERT (Tertiary), QUART (Quaternary)';

--
-- Name: COLUMN zim_control_points.comp_sheet; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.comp_sheet IS 'Computation sheet reference';

--
-- Name: COLUMN zim_control_points.topo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.topo IS 'Topographic map reference';

--
-- Name: COLUMN zim_control_points.gauss_lo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.gauss_lo IS 'Gauss-Conformal longitude zone (27, 29, 31, 33)';

--
-- Name: COLUMN zim_control_points.y_gauss; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.y_gauss IS 'Y coordinate (Gauss-Conformal, Westing)';

--
-- Name: COLUMN zim_control_points.x_gauss; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.x_gauss IS 'X coordinate (Gauss-Conformal, Southing)';

--
-- Name: COLUMN zim_control_points.msl_hgt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.msl_hgt IS 'Mean sea level height (meters)';

--
-- Name: COLUMN zim_control_points.ped_hgt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.ped_hgt IS 'Pedestal height (meters)';

--
-- Name: COLUMN zim_control_points.pill_hgt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.pill_hgt IS 'Pillar height (meters)';

--
-- Name: COLUMN zim_control_points.top_signal; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.top_signal IS 'Top of signal height (meters)';

--
-- Name: COLUMN zim_control_points.bot_signal; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.bot_signal IS 'Bottom of signal height (meters)';

--
-- Name: COLUMN zim_control_points.last_insp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.last_insp IS 'Last inspection date';

--
-- Name: COLUMN zim_control_points.deg_sqr; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.deg_sqr IS 'Degree square reference';

--
-- Name: COLUMN zim_control_points.area_nm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.area_nm IS 'Area name / locality';

--
-- Name: COLUMN zim_control_points.lat_wgs84; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.lat_wgs84 IS 'Latitude in WGS84 decimal degrees';

--
-- Name: COLUMN zim_control_points.lng_wgs84; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.zim_control_points.lng_wgs84 IS 'Longitude in WGS84 decimal degrees';

--
-- Name: control_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.control_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: control_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.control_points_id_seq OWNED BY survey.zim_control_points.id;

--
-- Name: coordinate_point_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.coordinate_point_history (
    id integer NOT NULL,
    point_id integer,
    import_id integer NOT NULL,
    previous_point_id integer,
    action character varying(20) NOT NULL,
    point_name character varying(50),
    coordinates jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);

--
-- Name: TABLE coordinate_point_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.coordinate_point_history IS 'Maintains history of coordinate point changes across imports for audit trail';

--
-- Name: coordinate_point_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.coordinate_point_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: coordinate_point_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.coordinate_point_history_id_seq OWNED BY survey.coordinate_point_history.id;

--
-- Name: coordinate_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.coordinate_points (
    id integer NOT NULL,
    project_id integer,
    name character varying(50) NOT NULL,
    geom public.geometry(Point,22291) NOT NULL,
    elevation numeric,
    description text,
    survey_date date,
    surveyor character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    import_id integer
);

--
-- Name: coordinate_points_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW survey.coordinate_points_full AS
 SELECT id,
    project_id,
    name,
    geom,
    elevation,
    description,
    survey_date,
    surveyor,
    created_at,
    updated_at,
    (public.st_asgeojson(geom))::jsonb AS geojson,
    public.st_x(geom) AS y,
    public.st_y(geom) AS x
   FROM survey.coordinate_points cp;

--
-- Name: coordinate_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.coordinate_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: coordinate_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.coordinate_points_id_seq OWNED BY survey.coordinate_points.id;

--
-- Name: features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.features (
    id integer NOT NULL,
    geometry jsonb,
    properties jsonb,
    layer_id integer NOT NULL,
    project_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    bbox jsonb,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    geom public.geometry,
    name character varying(255)
);

--
-- Name: features_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.features_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: land_parcels_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW survey.land_parcels_full AS
 SELECT id,
    project_id,
    stand,
    geom,
    owner,
    title_deed,
    survey_date,
    surveyor,
    notes,
    created_at,
    updated_at,
    area_m2,
    area_ha,
    perimeter_m,
    public.st_centroid(geom) AS centroid,
    (public.st_asgeojson(geom))::jsonb AS geojson,
    public.st_npoints(geom) AS vertex_count,
    public.st_x(public.st_centroid(geom)) AS centroid_y,
    public.st_y(public.st_centroid(geom)) AS centroid_x
   FROM survey.land_parcels lp;

--
-- Name: land_parcels_id_seq1; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.land_parcels_id_seq1
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.layers (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    layer_type character varying(50),
    geom_type character varying(50),
    srid integer DEFAULT 4326,
    project_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    params jsonb
);

--
-- Name: layers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.layers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: layers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.layers_id_seq OWNED BY survey.layers.id;

--
-- Name: migrations_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.migrations_history (
    id integer NOT NULL,
    migration_name character varying(255) NOT NULL,
    applied_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: migrations_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.migrations_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: parcels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.parcels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: project_control_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.project_control_points (
    id integer NOT NULL,
    project_id integer NOT NULL,
    control_point_id integer NOT NULL,
    point_order integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: TABLE project_control_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.project_control_points IS 'Control points used to connect survey project to national trig system';

--
-- Name: COLUMN project_control_points.point_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_control_points.point_order IS 'Display order in coordinate list (1, 2, 3...)';

--
-- Name: project_control_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.project_control_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: project_control_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.project_control_points_id_seq OWNED BY survey.project_control_points.id;

--
-- Name: project_csv_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.project_csv_imports (
    id integer NOT NULL,
    project_id integer NOT NULL,
    import_date timestamp without time zone DEFAULT now(),
    csv_hash character varying(64) NOT NULL,
    point_count integer NOT NULL,
    filename character varying(255),
    imported_by integer,
    coordinate_system character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb,
    has_generated_documents boolean DEFAULT false,
    has_land_parcels boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);

--
-- Name: TABLE project_csv_imports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.project_csv_imports IS 'Tracks CSV imports for projects to enable smart re-import and merge functionality';

--
-- Name: COLUMN project_csv_imports.csv_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_csv_imports.csv_hash IS 'SHA256 hash of CSV content to detect duplicate imports';

--
-- Name: COLUMN project_csv_imports.has_generated_documents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_csv_imports.has_generated_documents IS 'TRUE if Field Book, Calculations, etc. have been generated from this import';

--
-- Name: COLUMN project_csv_imports.has_land_parcels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_csv_imports.has_land_parcels IS 'TRUE if land parcels have been digitized based on this import';

--
-- Name: project_csv_imports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.project_csv_imports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: project_csv_imports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.project_csv_imports_id_seq OWNED BY survey.project_csv_imports.id;

--
-- Name: project_meridian_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.project_meridian_cache (
    id integer NOT NULL,
    project_id integer,
    meridian integer NOT NULL,
    control_point_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_meridian_cache_meridian_check CHECK ((meridian = ANY (ARRAY[27, 29, 31, 33])))
);

--
-- Name: TABLE project_meridian_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.project_meridian_cache IS 'Temporary cache of control point selections per meridian during project editing';

--
-- Name: COLUMN project_meridian_cache.project_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_meridian_cache.project_id IS 'Reference to survey project';

--
-- Name: COLUMN project_meridian_cache.meridian; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_meridian_cache.meridian IS 'Central meridian (Lo27, Lo29, Lo31, Lo33)';

--
-- Name: COLUMN project_meridian_cache.control_point_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_meridian_cache.control_point_ids IS 'Array of control point IDs selected for this meridian';

--
-- Name: COLUMN project_meridian_cache.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.project_meridian_cache.updated_at IS 'Last update timestamp';

--
-- Name: project_meridian_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.project_meridian_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: project_meridian_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.project_meridian_cache_id_seq OWNED BY survey.project_meridian_cache.id;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.projects (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    code character varying(50),
    description text,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.projects_id_seq OWNED BY survey.projects.id;

--
-- Name: survey_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.survey_projects (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    project_id integer,
    client_name character varying(255),
    district text,
    survey_type character varying(100),
    survey_date date,
    instruments text,
    designation text,
    status character varying(50) DEFAULT 'active'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    central_meridian integer,
    working_directory text,
    surveyor_profile_id integer NOT NULL,
    supervising_surveyor_id integer,
    workflow_state jsonb DEFAULT '{"step_data": {}, "can_finalize": false, "current_step": "import_csv", "finalized_at": null, "completed_steps": [], "generated_documents": {}}'::jsonb,
    last_used timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    stand_reference character varying(255),
    township character varying(255),
    parent_property character varying(500),
    CONSTRAINT survey_projects_central_meridian_check CHECK ((central_meridian = ANY (ARRAY[27, 29, 31, 33])))
);

--
-- Name: COLUMN survey_projects.survey_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.survey_type IS 'Survey type (subdivision, mining-lease, state-land, municipal-land, private-land, servitude, replacement, other) - from Project Setup';

--
-- Name: COLUMN survey_projects.central_meridian; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.central_meridian IS 'Gauss-Conformal central meridian (Lo27, Lo29, Lo31, Lo33)';

--
-- Name: COLUMN survey_projects.working_directory; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.working_directory IS 'Working directory path for project files (input CSV, output PDFs, etc.)';

--
-- Name: COLUMN survey_projects.workflow_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.workflow_state IS 'Tracks cadastral workflow progress: completed steps, current step, document metadata, and finalization status';

--
-- Name: COLUMN survey_projects.last_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.last_used IS 'Timestamp of when project was last accessed/selected by user';

--
-- Name: COLUMN survey_projects.stand_reference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.stand_reference IS 'Stand/Reference number (e.g., STANDS 1-50, STAND 9723, Mining Lease No.44) - from Project Setup';

--
-- Name: COLUMN survey_projects.township; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.survey_projects.township IS 'Township name (e.g., Shabani Mine Surface Rights A, Gweru Township) - from Project Setup';

--
-- Name: survey_projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.survey_projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: survey_projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.survey_projects_id_seq OWNED BY survey.survey_projects.id;

--
-- Name: surveyor_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.surveyor_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: surveyor_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.surveyor_profiles_id_seq OWNED BY survey.surveyor_profiles.id;

--
-- Name: surveyors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.surveyors (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    license_number character varying(100) NOT NULL,
    firm character varying(255),
    address text,
    phone character varying(50),
    email character varying(255),
    user_id integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: surveyors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.surveyors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: surveyors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.surveyors_id_seq OWNED BY survey.surveyors.id;

--
-- Name: users_new_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.users_new_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: users_new_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.users_new_id_seq OWNED BY survey.users.id;

--
-- Name: v_import_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW survey.v_import_summary AS
 SELECT i.id,
    i.project_id,
    i.import_date,
    i.point_count,
    i.filename,
    i.has_generated_documents,
    i.has_land_parcels,
    count(DISTINCT p.id) AS parcel_count,
    count(DISTINCT cp.id) AS active_point_count,
    u.email AS imported_by_username
   FROM (((survey.project_csv_imports i
     LEFT JOIN survey.land_parcels p ON (((p.import_id = i.id) AND ((p.parcel_status)::text = 'active'::text))))
     LEFT JOIN survey.coordinate_points cp ON ((cp.import_id = i.id)))
     LEFT JOIN survey.users u ON ((u.id = i.imported_by)))
  GROUP BY i.id, i.project_id, i.import_date, i.point_count, i.filename, i.has_generated_documents, i.has_land_parcels, u.email;

--
-- Name: workflow_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE survey.workflow_states (
    id integer NOT NULL,
    project_id integer NOT NULL,
    current_step character varying(100) NOT NULL,
    step_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_steps text[] DEFAULT '{}'::text[],
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: TABLE workflow_states; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE survey.workflow_states IS 'Stores cadastral workflow state for each project including imported points, calculations, and step progress';

--
-- Name: COLUMN workflow_states.project_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.workflow_states.project_id IS 'Foreign key to survey_projects table';

--
-- Name: COLUMN workflow_states.current_step; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.workflow_states.current_step IS 'Current workflow step (e.g., csv-import, field-book, calculations-part1)';

--
-- Name: COLUMN workflow_states.step_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.workflow_states.step_data IS 'JSONB object containing data for each step (points, calculations, documents, etc.)';

--
-- Name: COLUMN workflow_states.completed_steps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN survey.workflow_states.completed_steps IS 'Array of completed step names';

--
-- Name: workflow_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE survey.workflow_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: workflow_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE survey.workflow_states_id_seq OWNED BY survey.workflow_states.id;

--
-- Name: coordinate_point_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_point_history ALTER COLUMN id SET DEFAULT nextval('survey.coordinate_point_history_id_seq'::regclass);

--
-- Name: coordinate_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_points ALTER COLUMN id SET DEFAULT nextval('survey.coordinate_points_id_seq'::regclass);

--
-- Name: features id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.features ALTER COLUMN id SET DEFAULT nextval('survey.features_id_seq'::regclass);

--
-- Name: land_parcels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.land_parcels ALTER COLUMN id SET DEFAULT nextval('survey.land_parcels_id_seq1'::regclass);

--
-- Name: layers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.layers ALTER COLUMN id SET DEFAULT nextval('survey.layers_id_seq'::regclass);

--
-- Name: project_control_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_control_points ALTER COLUMN id SET DEFAULT nextval('survey.project_control_points_id_seq'::regclass);

--
-- Name: project_csv_imports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_csv_imports ALTER COLUMN id SET DEFAULT nextval('survey.project_csv_imports_id_seq'::regclass);

--
-- Name: project_meridian_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_meridian_cache ALTER COLUMN id SET DEFAULT nextval('survey.project_meridian_cache_id_seq'::regclass);

--
-- Name: projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.projects ALTER COLUMN id SET DEFAULT nextval('survey.projects_id_seq'::regclass);

--
-- Name: survey_projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.survey_projects ALTER COLUMN id SET DEFAULT nextval('survey.survey_projects_id_seq'::regclass);

--
-- Name: surveyor_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyor_profiles ALTER COLUMN id SET DEFAULT nextval('survey.surveyor_profiles_id_seq'::regclass);

--
-- Name: surveyors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyors ALTER COLUMN id SET DEFAULT nextval('survey.surveyors_id_seq'::regclass);

--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.users ALTER COLUMN id SET DEFAULT nextval('survey.users_new_id_seq'::regclass);

--
-- Name: workflow_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.workflow_states ALTER COLUMN id SET DEFAULT nextval('survey.workflow_states_id_seq'::regclass);

--
-- Name: zim_control_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.zim_control_points ALTER COLUMN id SET DEFAULT nextval('survey.control_points_id_seq'::regclass);

--
-- Name: zim_control_points control_points_monu_num_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.zim_control_points
    ADD CONSTRAINT control_points_monu_num_key UNIQUE (monu_num);

--
-- Name: zim_control_points control_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.zim_control_points
    ADD CONSTRAINT control_points_pkey PRIMARY KEY (id);

--
-- Name: coordinate_point_history coordinate_point_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_point_history
    ADD CONSTRAINT coordinate_point_history_pkey PRIMARY KEY (id);

--
-- Name: coordinate_points coordinate_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_points
    ADD CONSTRAINT coordinate_points_pkey PRIMARY KEY (id);

--
-- Name: coordinate_points coordinate_points_project_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_points
    ADD CONSTRAINT coordinate_points_project_id_name_key UNIQUE (project_id, name);

--
-- Name: features features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.features
    ADD CONSTRAINT features_pkey PRIMARY KEY (id);

--
-- Name: land_parcels land_parcels_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.land_parcels
    ADD CONSTRAINT land_parcels_pkey1 PRIMARY KEY (id);

--
-- Name: layers layers_name_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.layers
    ADD CONSTRAINT layers_name_project_id_key UNIQUE (name, project_id);

--
-- Name: layers layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.layers
    ADD CONSTRAINT layers_pkey PRIMARY KEY (id);

--
-- Name: migrations_history migrations_history_migration_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.migrations_history
    ADD CONSTRAINT migrations_history_migration_name_key UNIQUE (migration_name);

--
-- Name: project_control_points project_control_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_control_points
    ADD CONSTRAINT project_control_points_pkey PRIMARY KEY (id);

--
-- Name: project_control_points project_control_points_project_id_control_point_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_control_points
    ADD CONSTRAINT project_control_points_project_id_control_point_id_key UNIQUE (project_id, control_point_id);

--
-- Name: project_csv_imports project_csv_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_csv_imports
    ADD CONSTRAINT project_csv_imports_pkey PRIMARY KEY (id);

--
-- Name: project_meridian_cache project_meridian_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_meridian_cache
    ADD CONSTRAINT project_meridian_cache_pkey PRIMARY KEY (id);

--
-- Name: project_meridian_cache project_meridian_cache_project_id_meridian_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_meridian_cache
    ADD CONSTRAINT project_meridian_cache_project_id_meridian_key UNIQUE (project_id, meridian);

--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

--
-- Name: survey_projects survey_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.survey_projects
    ADD CONSTRAINT survey_projects_pkey PRIMARY KEY (id);

--
-- Name: surveyor_profiles surveyor_profiles_license_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyor_profiles
    ADD CONSTRAINT surveyor_profiles_license_number_key UNIQUE (license_number);

--
-- Name: surveyor_profiles surveyor_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyor_profiles
    ADD CONSTRAINT surveyor_profiles_pkey PRIMARY KEY (id);

--
-- Name: surveyor_profiles surveyor_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyor_profiles
    ADD CONSTRAINT surveyor_profiles_user_id_key UNIQUE (user_id);

--
-- Name: surveyors surveyors_license_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyors
    ADD CONSTRAINT surveyors_license_number_key UNIQUE (license_number);

--
-- Name: surveyors surveyors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyors
    ADD CONSTRAINT surveyors_pkey PRIMARY KEY (id);

--
-- Name: land_parcels unique_project_stand; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.land_parcels
    ADD CONSTRAINT unique_project_stand UNIQUE (project_id, stand);

--
-- Name: CONSTRAINT unique_project_stand ON land_parcels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT unique_project_stand ON survey.land_parcels IS 'Ensures each stand number is unique within a project';

--
-- Name: users users_new_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.users
    ADD CONSTRAINT users_new_email_key UNIQUE (email);

--
-- Name: users users_new_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.users
    ADD CONSTRAINT users_new_pkey PRIMARY KEY (id);

--
-- Name: workflow_states workflow_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.workflow_states
    ADD CONSTRAINT workflow_states_pkey PRIMARY KEY (id);

--
-- Name: workflow_states workflow_states_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.workflow_states
    ADD CONSTRAINT workflow_states_project_id_key UNIQUE (project_id);

--
-- Name: coordinate_points_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coordinate_points_geom_idx ON survey.coordinate_points USING gist (geom);

--
-- Name: coordinate_points_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coordinate_points_name_idx ON survey.coordinate_points USING btree (name);

--
-- Name: coordinate_points_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coordinate_points_project_idx ON survey.coordinate_points USING btree (project_id);

--
-- Name: features_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX features_geom_gix ON survey.features USING gist (geom);

--
-- Name: features_layer_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX features_layer_name_idx ON survey.features USING btree (layer_id, name);

--
-- Name: features_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX features_name_idx ON survey.features USING btree (name);

--
-- Name: idx_control_points_area_nm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_area_nm ON survey.zim_control_points USING btree (area_nm);

--
-- Name: idx_control_points_deg_sqr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_deg_sqr ON survey.zim_control_points USING btree (deg_sqr);

--
-- Name: idx_control_points_gauss_lo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_gauss_lo ON survey.zim_control_points USING btree (gauss_lo);

--
-- Name: idx_control_points_lat_wgs84; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_lat_wgs84 ON survey.zim_control_points USING btree (lat_wgs84);

--
-- Name: idx_control_points_lng_wgs84; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_lng_wgs84 ON survey.zim_control_points USING btree (lng_wgs84);

--
-- Name: idx_control_points_monu_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_monu_name ON survey.zim_control_points USING btree (monu_name);

--
-- Name: idx_control_points_monu_num; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_monu_num ON survey.zim_control_points USING btree (monu_num);

--
-- Name: idx_control_points_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_points_type ON survey.zim_control_points USING btree (type);

--
-- Name: idx_coordinate_point_history_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coordinate_point_history_action ON survey.coordinate_point_history USING btree (action);

--
-- Name: idx_coordinate_point_history_import_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coordinate_point_history_import_id ON survey.coordinate_point_history USING btree (import_id);

--
-- Name: idx_coordinate_point_history_point_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coordinate_point_history_point_id ON survey.coordinate_point_history USING btree (point_id);

--
-- Name: idx_coordinate_points_import_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coordinate_points_import_id ON survey.coordinate_points USING btree (import_id);

--
-- Name: idx_land_parcels_area_calculated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_area_calculated ON survey.land_parcels USING btree (area_calculated);

--
-- Name: idx_land_parcels_designation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_designation ON survey.land_parcels USING btree (designation);

--
-- Name: idx_land_parcels_digitized_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_digitized_by ON survey.land_parcels USING btree (digitized_by);

--
-- Name: idx_land_parcels_import_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_import_id ON survey.land_parcels USING btree (import_id);

--
-- Name: idx_land_parcels_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_metadata ON survey.land_parcels USING gin (metadata);

--
-- Name: idx_land_parcels_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_status ON survey.land_parcels USING btree (status);

--
-- Name: idx_land_parcels_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_land_parcels_updated_at ON survey.land_parcels USING btree (updated_at);

--
-- Name: idx_project_control_points_control_point; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_control_points_control_point ON survey.project_control_points USING btree (control_point_id);

--
-- Name: idx_project_control_points_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_control_points_project ON survey.project_control_points USING btree (project_id);

--
-- Name: idx_project_csv_imports_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_csv_imports_project_id ON survey.project_csv_imports USING btree (project_id);

--
-- Name: idx_project_csv_imports_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_project_csv_imports_unique ON survey.project_csv_imports USING btree (project_id, csv_hash);

--
-- Name: idx_project_meridian_cache_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_meridian_cache_project_id ON survey.project_meridian_cache USING btree (project_id);

--
-- Name: idx_survey_projects_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_survey_projects_last_used ON survey.survey_projects USING btree (surveyor_profile_id, last_used DESC);

--
-- Name: idx_survey_projects_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_survey_projects_project ON survey.survey_projects USING btree (project_id);

--
-- Name: idx_survey_projects_stand_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_survey_projects_stand_reference ON survey.survey_projects USING btree (stand_reference);

--
-- Name: idx_survey_projects_survey_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_survey_projects_survey_type ON survey.survey_projects USING btree (survey_type);

--
-- Name: idx_survey_projects_workflow_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_survey_projects_workflow_state ON survey.survey_projects USING gin (workflow_state);

--
-- Name: idx_surveyor_profiles_license; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyor_profiles_license ON survey.surveyor_profiles USING btree (license_number);

--
-- Name: idx_surveyor_profiles_schema_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyor_profiles_schema_name ON survey.surveyor_profiles USING btree (schema_name);

--
-- Name: idx_surveyor_profiles_supervisor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyor_profiles_supervisor ON survey.surveyor_profiles USING btree (supervisor_id);

--
-- Name: idx_surveyor_profiles_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyor_profiles_type ON survey.surveyor_profiles USING btree (surveyor_type);

--
-- Name: idx_surveyor_profiles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyor_profiles_user_id ON survey.surveyor_profiles USING btree (user_id);

--
-- Name: idx_surveyors_license; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyors_license ON survey.surveyors USING btree (license_number);

--
-- Name: idx_surveyors_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveyors_user_id ON survey.surveyors USING btree (user_id);

--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON survey.users USING btree (email);

--
-- Name: idx_users_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_type ON survey.users USING btree (user_type);

--
-- Name: idx_workflow_states_current_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_states_current_step ON survey.workflow_states USING btree (current_step);

--
-- Name: idx_workflow_states_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_states_project_id ON survey.workflow_states USING btree (project_id);

--
-- Name: idx_workflow_states_step_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_states_step_data ON survey.workflow_states USING gin (step_data);

--
-- Name: idx_workflow_states_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_states_updated_at ON survey.workflow_states USING btree (updated_at);

--
-- Name: land_parcels_area_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX land_parcels_area_idx ON survey.land_parcels USING btree (area_m2);

--
-- Name: land_parcels_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX land_parcels_geom_idx ON survey.land_parcels USING gist (geom);

--
-- Name: land_parcels_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX land_parcels_project_idx ON survey.land_parcels USING btree (project_id);

--
-- Name: land_parcels_stand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX land_parcels_stand_idx ON survey.land_parcels USING btree (stand);

--
-- Name: land_parcels auto_generate_metadata; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auto_generate_metadata BEFORE INSERT OR UPDATE OF geom ON survey.land_parcels FOR EACH ROW EXECUTE FUNCTION survey.generate_parcel_metadata_trigger();

--
-- Name: TRIGGER auto_generate_metadata ON land_parcels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER auto_generate_metadata ON survey.land_parcels IS 'Automatically calculates and stores edge metadata whenever parcel geometry is created or modified.';

--
-- Name: coordinate_points coordinate_points_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER coordinate_points_updated_at BEFORE UPDATE ON survey.coordinate_points FOR EACH ROW EXECUTE FUNCTION survey.update_updated_at_column();

--
-- Name: land_parcels land_parcel_auto_calculate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER land_parcel_auto_calculate BEFORE INSERT OR UPDATE OF geom ON survey.land_parcels FOR EACH ROW EXECUTE FUNCTION survey.auto_calculate_parcel_metrics();

--
-- Name: land_parcels land_parcels_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER land_parcels_updated_at BEFORE UPDATE ON survey.land_parcels FOR EACH ROW EXECUTE FUNCTION survey.update_updated_at_column();

--
-- Name: land_parcels prevent_parcel_overlap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_parcel_overlap BEFORE INSERT OR UPDATE OF geom ON survey.land_parcels FOR EACH ROW EXECUTE FUNCTION survey.check_parcel_overlap();

--
-- Name: TRIGGER prevent_parcel_overlap ON land_parcels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER prevent_parcel_overlap ON survey.land_parcels IS 'Prevents inserting or updating parcels that overlap with existing parcels (>1m² overlap)';

--
-- Name: zim_control_points trigger_update_control_points_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_control_points_updated_at BEFORE UPDATE ON survey.zim_control_points FOR EACH ROW EXECUTE FUNCTION survey.update_control_points_updated_at();

--
-- Name: project_csv_imports trigger_update_csv_import_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_csv_import_timestamp BEFORE UPDATE ON survey.project_csv_imports FOR EACH ROW EXECUTE FUNCTION survey.update_csv_import_timestamp();

--
-- Name: land_parcels trigger_update_import_has_parcels; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_import_has_parcels AFTER INSERT OR DELETE ON survey.land_parcels FOR EACH ROW EXECUTE FUNCTION survey.update_import_has_parcels();

--
-- Name: survey_projects update_survey_projects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_survey_projects_updated_at BEFORE UPDATE ON survey.survey_projects FOR EACH ROW EXECUTE FUNCTION survey.update_updated_at_column();

--
-- Name: surveyor_profiles update_surveyor_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_surveyor_profiles_updated_at BEFORE UPDATE ON survey.surveyor_profiles FOR EACH ROW EXECUTE FUNCTION survey.update_updated_at_column();

--
-- Name: surveyors update_surveyors_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_surveyors_updated_at BEFORE UPDATE ON survey.surveyors FOR EACH ROW EXECUTE FUNCTION survey.update_updated_at_column();

--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON survey.users FOR EACH ROW EXECUTE FUNCTION survey.update_updated_at_column();

--
-- Name: workflow_states workflow_states_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_states_updated_at_trigger BEFORE UPDATE ON survey.workflow_states FOR EACH ROW EXECUTE FUNCTION survey.update_workflow_states_updated_at();

--
-- Name: coordinate_point_history coordinate_point_history_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_point_history
    ADD CONSTRAINT coordinate_point_history_import_id_fkey FOREIGN KEY (import_id) REFERENCES survey.project_csv_imports(id) ON DELETE CASCADE;

--
-- Name: coordinate_point_history coordinate_point_history_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_point_history
    ADD CONSTRAINT coordinate_point_history_point_id_fkey FOREIGN KEY (point_id) REFERENCES survey.coordinate_points(id) ON DELETE CASCADE;

--
-- Name: coordinate_point_history coordinate_point_history_previous_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_point_history
    ADD CONSTRAINT coordinate_point_history_previous_point_id_fkey FOREIGN KEY (previous_point_id) REFERENCES survey.coordinate_points(id) ON DELETE SET NULL;

--
-- Name: coordinate_points coordinate_points_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.coordinate_points
    ADD CONSTRAINT coordinate_points_import_id_fkey FOREIGN KEY (import_id) REFERENCES survey.project_csv_imports(id) ON DELETE SET NULL;

--
-- Name: features features_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.features
    ADD CONSTRAINT features_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES survey.layers(id) ON DELETE CASCADE;

--
-- Name: features features_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.features
    ADD CONSTRAINT features_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey.projects(id);

--
-- Name: land_parcels land_parcels_digitized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.land_parcels
    ADD CONSTRAINT land_parcels_digitized_by_fkey FOREIGN KEY (digitized_by) REFERENCES survey.users(id);

--
-- Name: land_parcels land_parcels_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.land_parcels
    ADD CONSTRAINT land_parcels_import_id_fkey FOREIGN KEY (import_id) REFERENCES survey.project_csv_imports(id) ON DELETE SET NULL;

--
-- Name: project_control_points project_control_points_control_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_control_points
    ADD CONSTRAINT project_control_points_control_point_id_fkey FOREIGN KEY (control_point_id) REFERENCES survey.zim_control_points(id) ON DELETE CASCADE;

--
-- Name: project_control_points project_control_points_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_control_points
    ADD CONSTRAINT project_control_points_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey.survey_projects(id) ON DELETE CASCADE;

--
-- Name: project_csv_imports project_csv_imports_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_csv_imports
    ADD CONSTRAINT project_csv_imports_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES survey.users(id) ON DELETE SET NULL;

--
-- Name: project_csv_imports project_csv_imports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_csv_imports
    ADD CONSTRAINT project_csv_imports_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey.survey_projects(id) ON DELETE CASCADE;

--
-- Name: project_meridian_cache project_meridian_cache_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.project_meridian_cache
    ADD CONSTRAINT project_meridian_cache_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey.survey_projects(id) ON DELETE CASCADE;

--
-- Name: survey_projects survey_projects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.survey_projects
    ADD CONSTRAINT survey_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey.projects(id);

--
-- Name: survey_projects survey_projects_supervising_surveyor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.survey_projects
    ADD CONSTRAINT survey_projects_supervising_surveyor_id_fkey FOREIGN KEY (supervising_surveyor_id) REFERENCES survey.surveyor_profiles(id);

--
-- Name: survey_projects survey_projects_surveyor_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.survey_projects
    ADD CONSTRAINT survey_projects_surveyor_profile_id_fkey FOREIGN KEY (surveyor_profile_id) REFERENCES survey.surveyor_profiles(id);

--
-- Name: surveyor_profiles surveyor_profiles_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyor_profiles
    ADD CONSTRAINT surveyor_profiles_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES survey.surveyor_profiles(id);

--
-- Name: surveyor_profiles surveyor_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.surveyor_profiles
    ADD CONSTRAINT surveyor_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES survey.users(id) ON DELETE CASCADE;

--
-- Name: workflow_states workflow_states_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY survey.workflow_states
    ADD CONSTRAINT workflow_states_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey.survey_projects(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--



-- restore session search_path for the migration runner's tracking insert
SET search_path = public;
