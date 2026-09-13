-- Migration 005: kind discriminant (FIR vs aerodrome) di tabel notams.
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/005_notams_kind.sql
-- ALTER pertama error "duplicate column" = sudah applied.

ALTER TABLE notams ADD COLUMN kind TEXT DEFAULT 'AD';

-- Backfill best-effort: baris dengan location = kode FIR (tabel firs) dianggap FIR NOTAM.
-- Ambigu (bandara & FIR kode sama, mis. WIII) tidak bisa ditebak dari data lama;
-- import ulang lewat jalur yang benar akan menimpa ke nilai resmi.
UPDATE notams SET kind = 'FIR' WHERE location IN (SELECT id FROM firs);
UPDATE notams SET kind = 'AD' WHERE kind IS NULL OR kind = ''
