-- S3-B keeps the v3 rows readable while adding durable production-dispatch
-- projections. The original v1/v2 state columns remain for old recovery data.
ALTER TABLE tasks
  ADD COLUMN lifecycle_state TEXT
  CHECK (lifecycle_state IN ('starting', 'running', 'stopping', 'completed', 'failed', 'canceled', 'recovering', 'interrupted'));
ALTER TABLE executions
  ADD COLUMN lifecycle_state TEXT
  CHECK (lifecycle_state IN ('starting', 'running', 'stopping', 'recovering'));
