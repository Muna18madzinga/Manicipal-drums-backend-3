"""
Import Vungu_RDC_Master_Plan.gpkg layers into PostgreSQL using only sqlite3.
Each GeoPackage geometry is stored as WKB with a small 8-byte header that we strip.
We output SQL files that psql can execute directly.
"""
import sqlite3
import struct
import os
import sys

GPKG = r"C:\Users\munya\Desktop\finale\Vungu_RDC_Master_Plan.gpkg"
OUT_DIR = r"C:\Users\munya\Desktop\finale\backend\scripts"

LAYER_MAP = {
    "proposed_peri_urban_zones": "vungu_proposed_peri_urban_zones",
    "beyond_peri_urban_zones":   "vungu_beyond_peri_urban_zones",
    "Cemetery":                  "vungu_cemeteries",
    "Waste management":          "vungu_waste_management",
    "Zim_national_farm_cadastre_wgs_84": "vungu_farm_cadastre",
    "parcels":                   "vungu_parcels",
}

def strip_gpkg_header(blob):
    """GeoPackage WKB has a 8+ byte envelope header before the ISO WKB.
    Magic: 0x47 0x50, version, flags, srid (4 bytes LE), then optional envelope, then WKB.
    """
    if blob is None:
        return None
    b = bytes(blob)
    if b[:2] != b'GP':
        return b  # not gpkg, return raw
    flags = b[3]
    env_code = (flags >> 1) & 0x07
    env_sizes = [0, 32, 48, 48, 64]
    env_size = env_sizes[env_code] if env_code < len(env_sizes) else 0
    offset = 8 + env_size
    return b[offset:]

db = sqlite3.connect(GPKG)
db.row_factory = sqlite3.Row
cur = db.cursor()

# Find tables in gpkg_contents
cur.execute("SELECT table_name, data_type FROM gpkg_contents")
contents = cur.fetchall()
print("GPKG contents:", [(r['table_name'], r['data_type']) for r in contents])

for row in contents:
    layer_name = row['table_name']
    if row['data_type'] != 'features':
        continue
    pg_table = LAYER_MAP.get(layer_name)
    if not pg_table:
        print(f"  Skipping unmapped layer: {layer_name}")
        continue

    # Get column info
    cur.execute(f"SELECT * FROM \"{layer_name}\" LIMIT 1")
    if cur.description is None:
        print(f"  Empty layer: {layer_name}")
        continue
    cols = [d[0] for d in cur.description]
    print(f"\nLayer: {layer_name} -> {pg_table}")
    print(f"  Columns: {cols}")

    # Get geom column from gpkg_geometry_columns
    cur.execute("SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name=?", (layer_name,))
    gc = cur.fetchone()
    geom_col = gc['column_name'] if gc else 'geom'
    srs_id = gc['srs_id'] if gc else 4326
    print(f"  Geom col: {geom_col}, SRS: {srs_id}")

    # Non-geom columns
    data_cols = [c for c in cols if c != geom_col and c != 'fid']

    cur.execute(f"SELECT count(*) as n FROM \"{layer_name}\"")
    count = cur.fetchone()['n']
    print(f"  Feature count: {count}")

    out_path = os.path.join(OUT_DIR, f"import_{pg_table}.sql")
    with open(out_path, 'w', encoding='utf-8') as f:
        # Create table
        f.write(f"-- Auto-generated import for {pg_table}\n")
        f.write(f"DROP TABLE IF EXISTS {pg_table} CASCADE;\n")
        f.write(f"CREATE TABLE {pg_table} (\n")
        f.write(f"  fid SERIAL PRIMARY KEY,\n")
        for c in data_cols:
            f.write(f"  {c} TEXT,\n")
        f.write(f"  geom GEOMETRY(MULTIPOLYGON, 4326)\n")
        f.write(f");\n\n")

        # Insert rows
        cur2 = db.cursor()
        cur2.execute(f"SELECT * FROM \"{layer_name}\"")
        batch = []
        n = 0
        for feat in cur2:
            feat_d = dict(feat)
            geom_blob = feat_d.get(geom_col)
            wkb = strip_gpkg_header(geom_blob)
            if wkb is None:
                continue
            wkb_hex = wkb.hex()
            vals = []
            for c in data_cols:
                v = feat_d.get(c)
                if v is None:
                    vals.append("NULL")
                else:
                    escaped = str(v).replace("'", "''")
                    vals.append(f"'{escaped}'")
            val_str = ", ".join(vals)
            if val_str:
                f.write(f"INSERT INTO {pg_table} ({', '.join(data_cols)}, geom) VALUES ({val_str}, ST_SetSRID(ST_GeomFromWKB(decode('{wkb_hex}','hex')), 4326));\n")
            else:
                f.write(f"INSERT INTO {pg_table} (geom) VALUES (ST_SetSRID(ST_GeomFromWKB(decode('{wkb_hex}','hex')), 4326));\n")
            n += 1
            if n % 100 == 0:
                print(f"  {n}/{count} rows written...")

        f.write(f"\n-- Total: {n} features\n")
        f.write(f"CREATE INDEX IF NOT EXISTS idx_{pg_table}_geom ON {pg_table} USING GIST(geom);\n")
    print(f"  Written: {out_path} ({n} features)")

db.close()
print("\nDone.")
