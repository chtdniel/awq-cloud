-- Migration 007: seed armada dari archive/aircraft_reg.csv (master list resmi, 27 registrasi).
-- Jalankan: wrangler d1 execute DB --remote --file=./migrations/007_aircraft_seed.sql
-- INSERT OR IGNORE = idempotent, aman diulang.
-- ponytail: kolom ac_type dibiarkan NULL hari ini; nanti diisi tipe (B738/A320...) bila perlu filter.

INSERT OR IGNORE INTO aircraft (registration, ac_type) VALUES
('PK-AXD', NULL), ('PK-AXE', NULL), ('PK-AXT', NULL), ('PK-AXU', NULL),
('PK-AXV', NULL), ('PK-AXX', NULL), ('PK-AXY', NULL), ('PK-AZA', NULL),
('PK-AZD', NULL), ('PK-AZE', NULL), ('PK-AZF', NULL), ('PK-AZG', NULL),
('PK-AZH', NULL), ('PK-AZI', NULL), ('PK-AZJ', NULL), ('PK-AZK', NULL),
('PK-AZL', NULL), ('PK-AZM', NULL), ('PK-AZN', NULL), ('PK-AZO', NULL),
('PK-AZS', NULL), ('PK-AZT', NULL), ('PK-AZU', NULL), ('PK-AZV', NULL),
('PK-AZW', NULL), ('PK-AZX', NULL), ('PK-AZY', NULL);

-- Sinkron juga registrasi historis yang ada di flight tapi tidak di master list (jangan sampai hilang dari dropdown).
INSERT OR IGNORE INTO aircraft (registration)
SELECT DISTINCT ac_type FROM flights WHERE ac_type IS NOT NULL AND ac_type <> '';
