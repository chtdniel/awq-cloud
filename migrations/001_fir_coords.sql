-- Migration 001: kolom koordinat pusat FIR (pengganti firFallbackCoords frontend).
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/001_fir_coords.sql
-- Idempotent: aman dijalankan berulang. ALTER kolom yang sudah ada akan error
-- "duplicate column" — SQLite tidak punya IF NOT EXISTS untuk ADD COLUMN;
-- script dianggap sudah applied kalau muncul error itu di statement pertama.

ALTER TABLE firs ADD COLUMN lat REAL;
ALTER TABLE firs ADD COLUMN lon REAL;
ALTER TABLE firs ADD COLUMN geometry TEXT;

-- Seed koordinat pusat FIR (perkiraan pusat wilayah; sumber pengganti firFallbackCoords frontend)
UPDATE firs SET lat = -4,    lon = 108    WHERE id = 'WIIF';
UPDATE firs SET lat = -3,    lon = 124    WHERE id = 'WAAF';
UPDATE firs SET lat = 4,     lon = 103    WHERE id = 'WMFC';
UPDATE firs SET lat = 1.5,   lon = 104    WHERE id = 'WSJC';
UPDATE firs SET lat = 13,    lon = 101    WHERE id = 'VTBB';
UPDATE firs SET lat = 10,    lon = 108    WHERE id = 'VVTS';
UPDATE firs SET lat = -27,   lon = 153    WHERE id = 'YBBB';
UPDATE firs SET lat = -35,   lon = 144    WHERE id = 'YMMM';
UPDATE firs SET lat = -4,    lon = 108    WHERE id = 'WIII';
UPDATE firs SET lat = -5,    lon = 119    WHERE id = 'WAAA';
UPDATE firs SET lat = -8.5,  lon = 115    WHERE id = 'WADD';
UPDATE firs SET lat = -7,    lon = 112    WHERE id = 'WARR';
UPDATE firs SET lat = 5,     lon = 95     WHERE id = 'WITT';
UPDATE firs SET lat = 3,     lon = 101.5  WHERE id = 'WMSA';
