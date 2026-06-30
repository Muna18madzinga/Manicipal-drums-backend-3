-- Auto-generated import for vungu_cemeteries
DROP TABLE IF EXISTS vungu_cemeteries CASCADE;
CREATE TABLE vungu_cemeteries (
  fid SERIAL PRIMARY KEY,
  id TEXT,
  name TEXT,
  geom GEOMETRY(MULTIPOLYGON, 4326)
);

INSERT INTO vungu_cemeteries (id, name, geom) VALUES (NULL, 'Cemetery', ST_SetSRID(ST_GeomFromWKB(decode('010600000001000000010300000001000000070000004d3e8265bed13d4096beee5bd3a033c0b9ba60281dd13d409656fb45999f33c074412cd8aed03d40d07ddc64d09e33c019476da378d23d4089f506b67f9c33c0a24ffa2063d33d401e19ecfb449e33c0956f249babd23d401f65d57e6b9f33c04d3e8265bed13d4096beee5bd3a033c0','hex')), 4326));

-- Total: 1 features
CREATE INDEX IF NOT EXISTS idx_vungu_cemeteries_geom ON vungu_cemeteries USING GIST(geom);
