ALTER TABLE aircraft ADD COLUMN type_code TEXT;

CREATE INDEX IF NOT EXISTS idx_aircraft_type_code
    ON aircraft(type_code);
