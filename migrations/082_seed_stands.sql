-- Migration 082: Seed demo stands for Vungu RDC planning portal
-- Places 20 realistic stands across 4 zones in the Vungu district.
-- Each stand is a ~300–1200 sqm polygon in EPSG:4326.
-- Status mix: 12 available, 4 allocated, 3 reserved, 1 withdrawn.

BEGIN;

-- Helper: create a rectangular stand polygon given centre + half-dims in degrees
-- lng_c: centre longitude, lat_c: centre latitude
-- dw: half-width (longitude degrees), dh: half-height (latitude degrees)

INSERT INTO stands (
  stand_number, ward, zone_id, zone_type, use_scale,
  area_sqm, frontage_m, depth_m, price_usd, status, description, geom
) VALUES

-- ── HIGH DENSITY RESIDENTIAL (zone c6807ee5) ────────────────────────────
('HDR-001', 'Ward 3', 'c6807ee5-0f30-47d0-b3d4-9bef336403a8', 'High Density Residential', 'small_scale',
  300.00, 20.0, 15.0, 4500.00, 'available',
  'Corner stand, close to community hall. Services connected.',
  ST_GeomFromText('POLYGON((29.7295 -19.4830, 29.7297 -19.4830, 29.7297 -19.4832, 29.7295 -19.4832, 29.7295 -19.4830))', 4326)),

('HDR-002', 'Ward 3', 'c6807ee5-0f30-47d0-b3d4-9bef336403a8', 'High Density Residential', 'small_scale',
  325.00, 20.0, 16.25, 4875.00, 'available',
  'Quiet cul-de-sac stand. Water and electricity available.',
  ST_GeomFromText('POLYGON((29.7300 -19.4827, 29.7302 -19.4827, 29.7302 -19.4829, 29.7300 -19.4829, 29.7300 -19.4827))', 4326)),

('HDR-003', 'Ward 3', 'c6807ee5-0f30-47d0-b3d4-9bef336403a8', 'High Density Residential', 'small_scale',
  280.00, 20.0, 14.0, 4200.00, 'reserved',
  'Compact stand suitable for single-family dwelling.',
  ST_GeomFromText('POLYGON((29.7305 -19.4833, 29.7307 -19.4833, 29.7307 -19.4835, 29.7305 -19.4835, 29.7305 -19.4833))', 4326)),

('HDR-004', 'Ward 3', 'c6807ee5-0f30-47d0-b3d4-9bef336403a8', 'High Density Residential', 'small_scale',
  350.00, 20.0, 17.5, 5250.00, 'allocated',
  'Stand with river view. Development permit issued.',
  ST_GeomFromText('POLYGON((29.7312 -19.4836, 29.7314 -19.4836, 29.7314 -19.4838, 29.7312 -19.4838, 29.7312 -19.4836))', 4326)),

('HDR-005', 'Ward 3', 'c6807ee5-0f30-47d0-b3d4-9bef336403a8', 'High Density Residential', 'small_scale',
  320.00, 20.0, 16.0, 4800.00, 'available',
  'Prime location near road. Electricity pole on boundary.',
  ST_GeomFromText('POLYGON((29.7318 -19.4820, 29.7320 -19.4820, 29.7320 -19.4822, 29.7318 -19.4822, 29.7318 -19.4820))', 4326)),

-- ── HIGH DENSITY RESIDENTIAL (zone 243dcf46) ────────────────────────────
('HDR-101', 'Ward 5', '243dcf46-5f2b-4b55-95c0-0b1bddfbceb0', 'High Density Residential', 'small_scale',
  400.00, 20.0, 20.0, 6000.00, 'available',
  'Large stand in established neighbourhood. Flat terrain.',
  ST_GeomFromText('POLYGON((29.7488 -19.4820, 29.7490 -19.4820, 29.7490 -19.4823, 29.7488 -19.4823, 29.7488 -19.4820))', 4326)),

('HDR-102', 'Ward 5', '243dcf46-5f2b-4b55-95c0-0b1bddfbceb0', 'High Density Residential', 'small_scale',
  380.00, 20.0, 19.0, 5700.00, 'available',
  'Near school and clinic. Water and sewer connected.',
  ST_GeomFromText('POLYGON((29.7494 -19.4825, 29.7496 -19.4825, 29.7496 -19.4828, 29.7494 -19.4828, 29.7494 -19.4825))', 4326)),

('HDR-103', 'Ward 5', '243dcf46-5f2b-4b55-95c0-0b1bddfbceb0', 'High Density Residential', 'small_scale',
  290.00, 17.0, 17.0, 4350.00, 'allocated',
  'Compact stand — foundation works in progress.',
  ST_GeomFromText('POLYGON((29.7500 -19.4832, 29.7502 -19.4832, 29.7502 -19.4834, 29.7500 -19.4834, 29.7500 -19.4832))', 4326)),

('HDR-104', 'Ward 5', '243dcf46-5f2b-4b55-95c0-0b1bddfbceb0', 'High Density Residential', 'small_scale',
  310.00, 18.0, 17.0, 4650.00, 'reserved',
  'Pending application VNG-2026-00312. Reserved 72h.',
  ST_GeomFromText('POLYGON((29.7506 -19.4840, 29.7508 -19.4840, 29.7508 -19.4842, 29.7506 -19.4842, 29.7506 -19.4840))', 4326)),

('HDR-105', 'Ward 5', '243dcf46-5f2b-4b55-95c0-0b1bddfbceb0', 'High Density Residential', 'small_scale',
  365.00, 20.0, 18.25, 5475.00, 'available',
  'End-of-row stand with extra yard space.',
  ST_GeomFromText('POLYGON((29.7512 -19.4844, 29.7514 -19.4844, 29.7514 -19.4847, 29.7512 -19.4847, 29.7512 -19.4844))', 4326)),

-- ── MIXED DENSITY RESIDENTIAL (zone 53b4600e) ───────────────────────────
('MDR-201', 'Ward 7', '53b4600e-49d2-4b8e-b201-80ea86f62abb', 'Mixed Density Residential', 'mixed_scale',
  600.00, 24.0, 25.0, 9000.00, 'available',
  'Larger stand permits low-density townhouse development.',
  ST_GeomFromText('POLYGON((29.7950 -19.5285, 29.7953 -19.5285, 29.7953 -19.5289, 29.7950 -19.5289, 29.7950 -19.5285))', 4326)),

('MDR-202', 'Ward 7', '53b4600e-49d2-4b8e-b201-80ea86f62abb', 'Mixed Density Residential', 'mixed_scale',
  720.00, 25.0, 28.8, 10800.00, 'available',
  'Corner stand. Suitable for duplex or 4-unit complex.',
  ST_GeomFromText('POLYGON((29.7958 -19.5291, 29.7961 -19.5291, 29.7961 -19.5295, 29.7958 -19.5295, 29.7958 -19.5291))', 4326)),

('MDR-203', 'Ward 7', '53b4600e-49d2-4b8e-b201-80ea86f62abb', 'Mixed Density Residential', 'mixed_scale',
  580.00, 22.0, 26.4, 8700.00, 'allocated',
  'Stand 203 — certificate of occupation issued 2026-03-14.',
  ST_GeomFromText('POLYGON((29.7964 -19.5298, 29.7967 -19.5298, 29.7967 -19.5302, 29.7964 -19.5302, 29.7964 -19.5298))', 4326)),

('MDR-204', 'Ward 7', '53b4600e-49d2-4b8e-b201-80ea86f62abb', 'Mixed Density Residential', 'mixed_scale',
  650.00, 25.0, 26.0, 9750.00, 'available',
  'Flat stand near tarred road. Borehole on site.',
  ST_GeomFromText('POLYGON((29.7970 -19.5304, 29.7973 -19.5304, 29.7973 -19.5308, 29.7970 -19.5308, 29.7970 -19.5304))', 4326)),

('MDR-205', 'Ward 8', '93f1f6e9-7de7-425e-ba80-3f7d22d24aa7', 'Mixed Density Residential', 'mixed_scale',
  700.00, 26.0, 26.9, 10500.00, 'withdrawn',
  'Stand 205 withdrawn — boundary dispute under statutory adjudication.',
  ST_GeomFromText('POLYGON((29.7930 -19.5392, 29.7933 -19.5392, 29.7933 -19.5396, 29.7930 -19.5396, 29.7930 -19.5392))', 4326)),

-- ── ECONOMIC CORRIDOR [MIXED BUSINESS] (zone bf214ea8) ───────────────────
('EC-301', 'Ward 9', 'bf214ea8-0855-4393-8bc0-fc9a7d3edb90', 'Economic Corridor [Mixed Business]', 'large_scale',
  1200.00, 40.0, 30.0, 24000.00, 'available',
  'Commercial stand on A5 corridor. 3-phase power available.',
  ST_GeomFromText('POLYGON((29.9220 -19.5192, 29.9225 -19.5192, 29.9225 -19.5197, 29.9220 -19.5197, 29.9220 -19.5192))', 4326)),

('EC-302', 'Ward 9', 'bf214ea8-0855-4393-8bc0-fc9a7d3edb90', 'Economic Corridor [Mixed Business]', 'large_scale',
  1500.00, 50.0, 30.0, 30000.00, 'available',
  'Prime highway-facing stand. Ideal for service station / retail.',
  ST_GeomFromText('POLYGON((29.9228 -19.5198, 29.9234 -19.5198, 29.9234 -19.5203, 29.9228 -19.5203, 29.9228 -19.5198))', 4326)),

('EC-303', 'Ward 9', 'bf214ea8-0855-4393-8bc0-fc9a7d3edb90', 'Economic Corridor [Mixed Business]', 'large_scale',
  1350.00, 45.0, 30.0, 27000.00, 'allocated',
  'Stand 303 — Vungu Market Cooperative (development permit VNG-2025-0089).',
  ST_GeomFromText('POLYGON((29.9237 -19.5205, 29.9242 -19.5205, 29.9242 -19.5210, 29.9237 -19.5210, 29.9237 -19.5205))', 4326)),

('EC-304', 'Ward 9', 'bf214ea8-0855-4393-8bc0-fc9a7d3edb90', 'Economic Corridor [Mixed Business]', 'large_scale',
  1100.00, 40.0, 27.5, 22000.00, 'reserved',
  'Reserved for Small Business Development Centre. Decision deadline 2026-08-01.',
  ST_GeomFromText('POLYGON((29.9245 -19.5211, 29.9250 -19.5211, 29.9250 -19.5216, 29.9245 -19.5216, 29.9245 -19.5211))', 4326)),

('EC-305', 'Ward 9', 'bf214ea8-0855-4393-8bc0-fc9a7d3edb90', 'Economic Corridor [Mixed Business]', 'large_scale',
  1250.00, 42.0, 29.8, 25000.00, 'available',
  'Mixed-use stand. Ground floor commercial + upper residential permitted.',
  ST_GeomFromText('POLYGON((29.9253 -19.5217, 29.9258 -19.5217, 29.9258 -19.5222, 29.9253 -19.5222, 29.9253 -19.5217))', 4326));

-- Back-fill centroid (it is a generated column — already computed on INSERT,
-- but we still need to sync the 3NF denorm columns that are regular columns).
UPDATE stands SET
  zone_type_cache = zone_type,
  use_scale_code  = use_scale,
  status_code     = status
WHERE zone_type_cache IS NULL
   OR use_scale_code  IS NULL
   OR status_code     IS NULL;

COMMIT;
