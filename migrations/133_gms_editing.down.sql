-- 133_gms_editing.down.sql — rollback for 133_gms_editing.sql
BEGIN;
DROP TABLE IF EXISTS gis_ops.feature_version;
DROP TABLE IF EXISTS gis_ops.edit_session;
DROP TABLE IF EXISTS gis_ops.feature;
DROP TABLE IF EXISTS gis_ops.layer;
COMMIT;
