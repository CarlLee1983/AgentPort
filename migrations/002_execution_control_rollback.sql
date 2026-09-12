-- Downgrade marker only. Do not drop AP-003 records: the AP-002 binary
-- tolerates extra tables but recognizes only schema version 1.
BEGIN IMMEDIATE;
DELETE FROM schema_migrations WHERE version=2;
COMMIT;
