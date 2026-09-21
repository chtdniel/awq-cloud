-- Migration 014: NOTAM dataset update log.
-- Backs the "LAST UPDATE" panel on the NOTAM UPDATE (aerodrome, kind='AD') and
-- FIR UPDATE (kind='FIR') pages: when, which account, and which airports/FIRs
-- were written. Replaces the hardcoded getNotamUpdateHistory stub in rpc.js and
-- the old Apps Script NOTAM_HISTORY sheet (TIMESTAMP, USER, ROW_COUNT, QUERY_STR).
-- Run: wrangler d1 execute awq-db --remote --file=./migrations/014_notam_update_log.sql

CREATE TABLE IF NOT EXISTS notam_update_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,               -- 'AD' (UPDATE NOTAM page) | 'FIR' (FIR UPDATE page)
    action TEXT NOT NULL,             -- IMPORT | APPEND | OVERWRITE | NEW | EDIT | DELETE
    actor_user_id INTEGER,            -- auth_users.id of the account that wrote
    actor_email TEXT,
    actor_name TEXT,                  -- profile full name at write time (may be empty)
    row_count INTEGER NOT NULL DEFAULT 0,
    locations TEXT,                   -- JSON array of ICAO / FIR codes actually written
    detail TEXT,                      -- DINS query header or a short note
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The panel always reads the newest rows (per kind and overall).
CREATE INDEX IF NOT EXISTS idx_notam_update_log_kind_id ON notam_update_log(kind, id DESC);
