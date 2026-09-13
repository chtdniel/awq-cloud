-- Migration 004: index hasil code review (N+1 / full scan notams — dataset >1000 row).
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/004_notams_indexes.sql
-- CREATE INDEX IF NOT EXISTS = idempotent, aman diulang.

CREATE INDEX IF NOT EXISTS idx_notams_location ON notams(location);
CREATE INDEX IF NOT EXISTS idx_notams_dates ON notams(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_notams_updated_at ON notams(updated_at);
