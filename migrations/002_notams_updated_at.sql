-- Migration 002: updated_at untuk optimistic locking editor multi-tab.
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/002_notams_updated_at.sql
-- ALTER pertama error "duplicate column" = sudah applied; sisanya aman diulang.

ALTER TABLE notams ADD COLUMN updated_at DATETIME;

UPDATE notams SET updated_at = created_at WHERE updated_at IS NULL AND created_at IS NOT NULL;
UPDATE notams SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
