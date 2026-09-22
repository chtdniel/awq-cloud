-- Draft Schema D1 (SQLite) untuk AWQ - CLOUD
-- Ini adalah translasi awal dari tabel Sheet sebelumnya (FLT INFO, NOTAM, FIR, dll.)

CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callsign TEXT NOT NULL,
    dep TEXT,
    dest TEXT,
    ac_type TEXT,
    etd DATETIME,
    eta DATETIME,
    alt TEXT,
    taf_dep TEXT,
    taf_arr TEXT,
    cgo TEXT,
    enr1 TEXT,
    enr2 TEXT,
    enr3 TEXT,
    atc TEXT,
    remarks TEXT,
    dof TEXT,
    active_route_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notams (
    id TEXT PRIMARY KEY, -- Nomor NOTAM, e.g., A1234/23
    location TEXT NOT NULL, -- ICAO code
    q_code TEXT,
    message TEXT,
    valid_from DATETIME,
    valid_to DATETIME,
    kind TEXT DEFAULT 'AD', -- 'FIR' = halaman FIR, 'AD' = aerodrome (Update NOTAM)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Audit of NOTAM dataset writes (see migrations/014_notam_update_log.sql).
-- Feeds the LAST DATASET UPDATE panel on the UPDATE NOTAM (kind='AD') and FIR
-- UPDATE (kind='FIR') pages: timestamp, account, row count and the airports/FIRs
-- written. Rows are capped per kind by pruneNotamUpdateLog (functions/api/rpc.js).
CREATE TABLE IF NOT EXISTS notam_update_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,               -- 'AD' | 'FIR'
    action TEXT NOT NULL,             -- IMPORT | APPEND | OVERWRITE | NEW | EDIT | DELETE
    actor_user_id INTEGER,
    actor_email TEXT,
    actor_name TEXT,
    row_count INTEGER NOT NULL DEFAULT 0,
    locations TEXT,                   -- JSON array of ICAO / FIR codes
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notam_update_log_kind_id ON notam_update_log(kind, id DESC);

CREATE TABLE IF NOT EXISTS firs (
    id TEXT PRIMARY KEY,
    name TEXT,
    risk_level TEXT, -- e.g., 'HIGH', 'MED', 'LOW'
    lat REAL,
    lon REAL,        -- FIR centre point (single source of truth for FIR map)
    geometry TEXT    -- ponytail: polygon GeoJSON for the far future; NULL = titik pusat saja
);

CREATE TABLE IF NOT EXISTS airport_firs (
    airport_icao TEXT NOT NULL,
    fir_code TEXT NOT NULL,
    PRIMARY KEY (airport_icao, fir_code)
);

-- Seed FIR: kode FIR ICAO real (WIIF/WAAF/dst, dipakai kolom FIR flights.csv
-- dan badge risk FIR_Ui) + id gaya kode bandara (kompat handler lama).
-- Risk: WIIF/WAAF MEDIUM (tersibuk + abu vulkanik); transit LOW.
INSERT OR IGNORE INTO firs (id, name, risk_level) VALUES
    ('WIIF', 'Jakarta FIR', 'MEDIUM'),
    ('WAAF', 'Ujung Pandang FIR', 'MEDIUM'),
    ('WMFC', 'Kuala Lumpur FIR', 'LOW'),
    ('WSJC', 'Singapore FIR', 'LOW'),
    ('VTBB', 'Bangkok FIR', 'LOW'),
    ('VVTS', 'Ho Chi Minh FIR', 'LOW'),
    ('YBBB', 'Brisbane FIR', 'LOW'),
    ('YMMM', 'Melbourne FIR', 'LOW'),
    ('WIII', 'Jakarta FIR', 'LOW'),
    ('WAAA', 'Makassar FIR', 'LOW'),
    ('WADD', 'Bali FIR', 'LOW'),
    ('WARR', 'Surabaya FIR', 'LOW'),
    ('WITT', 'Banda Aceh FIR', 'LOW'),
    ('WMSA', 'Subang FIR', 'LOW');
UPDATE firs SET risk_level = 'MEDIUM' WHERE id = 'WIIF';
UPDATE firs SET risk_level = 'MEDIUM' WHERE id = 'WAAF';

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

-- Mapping bandara -> FIR real (sumber: kolom FIR 1-5 archive/flights.csv
-- + geografi FIR; WKKK asumsi WAAF — verifikasi manual bila perlu).
INSERT OR IGNORE INTO airport_firs (airport_icao, fir_code) VALUES
    ('WIII', 'WIII'),
    ('WIII', 'WIIF'),
    ('WILL', 'WIIF'),
    ('WIMM', 'WIIF'),
    ('WIPP', 'WIIF'),
    ('WARR', 'WIIF'),
    ('WAAA', 'WAAA'),
    ('WAAA', 'WAAF'),
    ('WADD', 'WADD'),
    ('WADD', 'WAAF'),
    ('WADL', 'WAAF'),
    ('WATO', 'WAAF'),
    ('WKKK', 'WAAF'),
    ('WITT', 'WITT'),
    ('WITT', 'WIIF'),
    ('WMSA', 'WMSA'),
    ('WMSA', 'WMFC'),
    ('WMKK', 'WMFC'),
    ('WMKP', 'WMFC'),
    ('WMKJ', 'WMFC'),
    ('WSSS', 'WSJC'),
    ('VTSP', 'VTBB'),
    ('VVDN', 'VVTS'),
    ('VVTS', 'VVTS'),
    ('YPPH', 'YMMM'),
    ('YPPD', 'YMMM'),
    ('YPKG', 'YMMM'),
    ('YMML', 'YMMM'),
    ('YPAD', 'YMMM'),
    ('YPDN', 'YBBB'),
    ('YSSY', 'YBBB'),
    ('YSCB', 'YBBB');

CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    dep_airport TEXT,
    arr_airport TEXT,
    dep_rwy TEXT,
    sid TEXT,
    waypoint_seq TEXT,
    star TEXT,
    arr_rwy TEXT,
    route_string TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aircraft (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration TEXT UNIQUE NOT NULL,
    ac_type TEXT,
    type_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tafs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station TEXT NOT NULL,
    raw_text TEXT,
    issue_time DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tafs_station ON tafs(station);

CREATE TABLE IF NOT EXISTS latlong (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT,
    waypoint TEXT,
    latitude TEXT,
    longitude TEXT,
    sequence_order INTEGER
);
CREATE INDEX IF NOT EXISTS idx_latlong_route ON latlong(route_id);
CREATE INDEX IF NOT EXISTS idx_latlong_route_order ON latlong(route_id, sequence_order, id);

-- Flight Board aktif per akun (lihat migrations/012_user_board_state.sql).
-- row_ids = JSON array flights.id, urut sesuai tampilan board.
CREATE TABLE IF NOT EXISTS user_board_state (
    user_id INTEGER PRIMARY KEY,              -- 1:1 dengan auth_users.id
    row_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS briefing_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flights_key TEXT NOT NULL,
    flights TEXT,
    content_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Versioned: tiap save menambah baris baru; latest = ORDER BY id DESC LIMIT 1.
-- Migrasi dari skema lama ber-UNIQUE INDEX: drop dulu (no-op di DB baru).
DROP INDEX IF EXISTS idx_briefing_reports_flights_key;
CREATE INDEX IF NOT EXISTS idx_briefing_reports_flights_key ON briefing_reports(flights_key);

-- Note: Schema ini bisa disesuaikan lagi mengikuti kebutuhan data spesifik dari Apps Script sebelumnya.
