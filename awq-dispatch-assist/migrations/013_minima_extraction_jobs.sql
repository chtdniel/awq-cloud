-- Migration 013: minima extraction jobs.
--
-- Why a job table
--   Chart extraction is a PDF conversion plus a model call and has been measured
--   taking 81 to 130 seconds per chart. On the request path that means a cold chart
--   exceeds any budget short enough for a dispatcher to wait on, and four of seven
--   charts were lost to a timeout. The work therefore moves to a Queue consumer,
--   which has a 15-minute wall-clock limit, and this table is how the client learns
--   what happened after the response has already been sent.
--
-- Why it is separate from airport_minima
--   A job is a record of an attempt, not a minima value. Keeping it out of the
--   registry means the registry's approval states stay about values only, and a
--   failed or retried attempt cannot be mistaken for a reviewable record.
--
-- Safety
--   The consumer writes draft rows through the same `insertDrafts` path the
--   synchronous request used, so a job completing still cannot approve anything.
--   Nothing here can create an `approved` record.
--
-- Reversibility
--   Run `DROP TABLE airport_minima_extraction_jobs;` to undo. No existing table is
--   altered by this migration.

CREATE TABLE IF NOT EXISTS airport_minima_extraction_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  object_key TEXT NOT NULL,
  icao TEXT,
  model TEXT NOT NULL,
  requested_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  source_bytes INTEGER,
  markdown_chars INTEGER,
  drafts_extracted INTEGER,
  drafts_stored INTEGER,
  skipped_duplicates INTEGER,
  duplicates_of_approved INTEGER,
  draft_ids TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_minima_extraction_jobs_status ON airport_minima_extraction_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_minima_extraction_jobs_icao ON airport_minima_extraction_jobs (icao, created_at);
