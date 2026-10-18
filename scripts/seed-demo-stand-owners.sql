-- Demo Property File + stand_allocation for allocated stands (local / pilot only).
-- Safe to re-run. Replace with real Property File import before council go-live.

INSERT INTO spatial_planning.property (stand_number, suburb_ward, area_sqm)
SELECT s.stand_number, s.ward, s.area_sqm FROM stands s WHERE s.status = 'allocated'
ON CONFLICT (stand_number) DO UPDATE SET suburb_ward = EXCLUDED.suburb_ward, area_sqm = EXCLUDED.area_sqm;

INSERT INTO spatial_planning.parcel_owner (property_id, name, company, role, phone, email, since)
SELECT p.id,
       CASE p.stand_number
         WHEN 'HDR-004' THEN 'Tendai Moyo'
         WHEN 'HDR-103' THEN 'Chipo Ndlovu'
         WHEN 'MDR-203' THEN 'Blessing Chirwa'
         WHEN 'EC-303'  THEN 'Vungu Trading (Pvt) Ltd'
         ELSE 'Allottee ' || p.stand_number
       END,
       CASE WHEN p.stand_number = 'EC-303' THEN 'Vungu Trading (Pvt) Ltd' ELSE NULL END,
       'owner',
       '+263 77 100 1000',
       LOWER(REPLACE(p.stand_number, '-', '.')) || '.owner@example.zw',
       CURRENT_DATE - 180
  FROM spatial_planning.property p
 WHERE p.stand_number IN (SELECT stand_number FROM stands WHERE status = 'allocated')
   AND NOT EXISTS (SELECT 1 FROM spatial_planning.parcel_owner po WHERE po.property_id = p.id);

INSERT INTO stand_allocation (stand_id, reference_no, allottee_name, purpose, status)
SELECT s.id, 'ALLOC-' || s.stand_number,
       COALESCE(
         (SELECT po.name FROM spatial_planning.property p
            JOIN spatial_planning.parcel_owner po ON po.property_id = p.id
           WHERE p.stand_number = s.stand_number LIMIT 1),
         'Allottee ' || s.stand_number),
       CASE WHEN s.stand_number LIKE 'EC%' THEN 'commercial' ELSE 'residential' END,
       'active'
  FROM stands s
 WHERE s.status = 'allocated'
   AND NOT EXISTS (
     SELECT 1 FROM stand_allocation sa
      WHERE sa.stand_id = s.id AND sa.status = 'active' AND sa.deleted_at IS NULL
   );
