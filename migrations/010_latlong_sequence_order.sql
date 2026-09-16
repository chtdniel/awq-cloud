ALTER TABLE latlong ADD COLUMN sequence_order INTEGER;

UPDATE latlong
SET sequence_order = id
WHERE sequence_order IS NULL;

CREATE INDEX IF NOT EXISTS idx_latlong_route_order
ON latlong(route_id, sequence_order, id);
