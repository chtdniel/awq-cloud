-- Migration 003: tabel meta untuk counter kuota harian Gemini (rate limiter rpc.js).
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/003_meta_table.sql

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
