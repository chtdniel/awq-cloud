-- Migration 012: minima registry for AIP extracted approach minima.
--
-- Why this exists
--   PRD §5 and acceptance §27 make the AIP approach chart PDF in R2 the only
--   source file for minima, and require the numeric values the engine uses to
--   live in a structured record that an ADMIN dispatcher has verified against
--   that PDF. This table is that record.
--
-- Approval gate
--   A row is created by AI extraction with status `draft`. Only the approval
--   endpoint moves it to `approved`, and it records who approved it and when.
--   The engine only ever reads `approved` rows, so a draft cannot be used by an
--   assessment (PRD acceptance §29).
--
-- Source immutability
--   `source_object_key` and `pdf_hash` point at the untouched R2 object, so a
--   record can always be traced back to the exact bytes it was transcribed from.
--   Nothing in this feature writes to or deletes an R2 object.
--
-- Reversibility
--   Run `DROP TABLE airport_minima_audit; DROP TABLE airport_minima;` to undo.
--   No existing table is altered by this migration.

CREATE TABLE IF NOT EXISTS airport_minima (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'rejected')),
  kind TEXT NOT NULL DEFAULT 'landing' CHECK (kind IN ('landing', 'alternate')),

  -- Provenance of the source PDF.
  source_object_key TEXT NOT NULL,
  pdf_hash TEXT NOT NULL,
  ais_authority TEXT NOT NULL,
  country TEXT NOT NULL,
  icao TEXT NOT NULL,

  -- Chart identity.
  chart_identifier TEXT NOT NULL,
  chart_page TEXT,
  runway TEXT,
  approach TEXT NOT NULL,
  approach_type TEXT,
  aircraft_category TEXT,

  -- Values. NULL means the value was not readable on the chart and is flagged
  -- for review; it is never guessed (PRD §5, acceptance §29).
  ceiling_ft INTEGER,
  visibility_m INTEGER,
  value_type TEXT,

  -- Publication cycle.
  aip_cycle TEXT,
  effective_from TEXT,
  effective_to TEXT,

  -- Extraction transparency.
  extraction_model TEXT,
  extraction_confidence TEXT CHECK (extraction_confidence IN ('high', 'medium', 'low')),
  review_notes TEXT,

  -- Approval. Recorded for every approval, as PRD acceptance §28 requires.
  approved_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  approved_at TEXT,
  superseded_by INTEGER REFERENCES airport_minima(id) ON DELETE SET NULL,

  content_hash TEXT NOT NULL,
  created_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_airport_minima_icao_status ON airport_minima (icao, status, kind);
CREATE INDEX IF NOT EXISTS idx_airport_minima_source ON airport_minima (source_object_key);
CREATE INDEX IF NOT EXISTS idx_airport_minima_chart ON airport_minima (icao, chart_identifier, approach);

-- Audit history. Every value that is replaced stays readable here, including the
-- value before and after an admin correction (PRD §9, acceptance §29).
CREATE TABLE IF NOT EXISTS airport_minima_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  minima_id INTEGER NOT NULL REFERENCES airport_minima(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('extracted', 'corrected', 'approved', 'rejected', 'superseded', 'reactivated', 'deleted')),
  actor_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  before_json TEXT,
  after_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_airport_minima_audit_minima ON airport_minima_audit (minima_id, created_at);
