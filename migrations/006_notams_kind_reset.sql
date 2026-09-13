-- Migration 006: reset kind — backfill 005 salah (aerodrome NOTAM A)WADD dianggap FIR).
-- Data lama tidak sumbernya dikenal (semua tabel satu pin); set semua 'AD'.
-- FIR NOTAM masuk lagi otomatis: import FIR UPDATE baru (kind='FIR', writer memberi nilai panjang baru).
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/006_notams_kind_reset.sql

UPDATE notams SET kind = 'AD' WHERE kind = 'FIR';
