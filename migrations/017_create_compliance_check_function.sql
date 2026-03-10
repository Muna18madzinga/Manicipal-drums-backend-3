-- Migration 017: Create compliance check function for development control
-- This function checks if a proposed development is permitted on a parcel

-- Create the main compliance check function
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
DECLARE
    parcel_zone TEXT;
    permission_result RECORD;
BEGIN
    -- Get the zone for the parcel
    SELECT zone_name INTO parcel_zone
    FROM land_parcels
    WHERE id = parcel_id_param;
    
    IF parcel_zone IS NULL THEN
        -- Return empty result if parcel not found
        RETURN QUERY SELECT 
            false, 'NOT_FOUND', 'Parcel not found', '#ff0000',
            NULL, NULL, NULL, proposed_use_code_param, 'Unknown use',
            NULL, NULL, 'PARCEL_NOT_FOUND';
        RETURN;
    END IF;
    
    -- Check development permission based on zone and proposed use
    -- This is a simplified logic - in reality, this would query a development matrix table
    BEGIN
        -- For now, return a basic permission check
        -- TODO: Implement proper development matrix lookup
        IF proposed_use_code_param IN ('A', 'B', 'C') THEN
            -- Residential uses typically allowed in most zones
            IF parcel_zone LIKE '%Residential%' OR parcel_zone LIKE '%Density%' THEN
                RETURN QUERY SELECT 
                    true, 'PERMITTED', 'Development permitted', '#00ff00',
                    parcel_zone, parcel_zone, 'EXISTING', proposed_use_code_param, 
                    CASE proposed_use_code_param
                        WHEN 'A' THEN 'Residential Type A'
                        WHEN 'B' THEN 'Residential Type B'
                        WHEN 'C' THEN 'Residential Type C'
                        ELSE 'Unknown'
                    END,
                    'Standard conditions apply', 'No specific restrictions', 'COMPLIANT';
                RETURN;
            ELSE
                RETURN QUERY SELECT 
                    false, 'NOT_PERMITTED', 'Development not permitted in this zone', '#ff0000',
                    parcel_zone, parcel_zone, 'EXISTING', proposed_use_code_param,
                    CASE proposed_use_code_param
                        WHEN 'A' THEN 'Residential Type A'
                        WHEN 'B' THEN 'Residential Type B'
                        WHEN 'C' THEN 'Residential Type C'
                        ELSE 'Unknown'
                    END,
                    NULL, 'Zone does not permit this use', 'NON_COMPLIANT';
                RETURN;
            END IF;
        ELSIF proposed_use_code_param IN ('D', 'E', 'F') THEN
            -- Commercial uses
            IF parcel_zone LIKE '%Commercial%' OR parcel_zone LIKE '%Business%' OR parcel_zone LIKE '%Economic%' THEN
                RETURN QUERY SELECT 
                    true, 'PERMITTED', 'Commercial development permitted', '#00ff00',
                    parcel_zone, parcel_zone, 'EXISTING', proposed_use_code_param,
                    CASE proposed_use_code_param
                        WHEN 'D' THEN 'Commercial Type D'
                        WHEN 'E' THEN 'Commercial Type E'
                        WHEN 'F' THEN 'Commercial Type F'
                        ELSE 'Unknown'
                    END,
                    'Commercial conditions apply', 'Business operating hours restrictions', 'COMPLIANT';
                RETURN;
            ELSE
                RETURN QUERY SELECT 
                    false, 'NOT_PERMITTED', 'Commercial development not permitted', '#ff0000',
                    parcel_zone, parcel_zone, 'EXISTING', proposed_use_code_param,
                    CASE proposed_use_code_param
                        WHEN 'D' THEN 'Commercial Type D'
                        WHEN 'E' THEN 'Commercial Type E'
                        WHEN 'F' THEN 'Commercial Type F'
                        ELSE 'Unknown'
                    END,
                    NULL, 'Commercial use not allowed in residential zone', 'NON_COMPLIANT';
                RETURN;
            END IF;
        ELSE
            -- Unknown or other uses
            RETURN QUERY SELECT 
                false, 'REQUIRES_ASSESSMENT', 'Use requires special assessment', '#ffaa00',
                parcel_zone, parcel_zone, 'EXISTING', proposed_use_code_param,
                'Special Use', 'Requires detailed assessment', 'May require special approval', 'PENDING_REVIEW';
            RETURN;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Return error result
        RETURN QUERY SELECT 
            false, 'ERROR', 'Error checking permission', '#ff0000',
            parcel_zone, parcel_zone, 'EXISTING', proposed_use_code_param,
            'Error', SQLERRM, 'ERROR_OCCURRED';
        RETURN;
    END;
END;
$$ LANGUAGE plpgsql;

-- Create a simple development matrix table for future use
CREATE TABLE IF NOT EXISTS development_matrix (
    id SERIAL PRIMARY KEY,
    zone_code TEXT NOT NULL,
    use_code TEXT NOT NULL,
    permission_code TEXT NOT NULL,
    permission_description TEXT,
    conditions TEXT,
    restrictions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_development_matrix_zone_use ON development_matrix(zone_code, use_code);

-- Add some sample data to the development matrix
INSERT INTO development_matrix (zone_code, use_code, permission_code, permission_description, conditions, restrictions) VALUES
('Low Density Residential', 'A', 'PERMITTED', 'Residential Type A permitted', 'Standard building codes', 'Maximum 2 storeys'),
('Low Density Residential', 'B', 'PERMITTED', 'Residential Type B permitted', 'Standard building codes', 'Maximum 1 storey'),
('Medium Density Residential', 'A', 'PERMITTED', 'Residential Type A permitted', 'Fire safety requirements', 'Maximum 3 storeys'),
('High Density Residential', 'A', 'PERMITTED', 'Residential Type A permitted', 'Enhanced fire safety', 'No height restriction'),
('Economic Corridor', 'D', 'PERMITTED', 'Commercial Type D permitted', 'Business license required', 'Operating hours 6am-10pm'),
('Economic Corridor', 'E', 'PERMITTED', 'Commercial Type E permitted', 'Business license required', 'Operating hours 6am-11pm'),
('Densification Zone', 'A', 'PERMITTED', 'Residential Type A permitted', 'Density bonuses apply', 'Minimum lot size 300m²')
ON CONFLICT DO NOTHING;

COMMENT ON FUNCTION check_development_permission IS 'Checks if a proposed development use is permitted on a specific parcel based on its zone';
COMMENT ON TABLE development_matrix IS 'Matrix defining permitted uses for each zone type';
