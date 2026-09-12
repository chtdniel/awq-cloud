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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS firs (
    id TEXT PRIMARY KEY,
    name TEXT,
    risk_level TEXT -- e.g., 'HIGH', 'MED', 'LOW'
);

CREATE TABLE IF NOT EXISTS airport_firs (
    airport_icao TEXT NOT NULL,
    fir_code TEXT NOT NULL,
    PRIMARY KEY (airport_icao, fir_code)
);

-- Seed minimal: FIR Indonesia (id dipakai sebagai kode FIR/region oleh UI).
INSERT OR IGNORE INTO firs (id, name, risk_level) VALUES
    ('WIII', 'Jakarta FIR', 'LOW'),
    ('WIIF', 'Jakarta FIR (ICAO FIR code)', 'LOW'),
    ('WAAA', 'Makassar FIR', 'LOW'),
    ('WADD', 'Bali FIR', 'LOW'),
    ('WARR', 'Surabaya FIR', 'LOW'),
    ('WITT', 'Banda Aceh FIR', 'LOW'),
    ('WMSA', 'Subang FIR', 'LOW');

-- Mapping bandara -> FIR (1-1) + contoh multi-FIR: WIII -> [WIII, WIIF].
INSERT OR IGNORE INTO airport_firs (airport_icao, fir_code) VALUES
    ('WIII', 'WIII'),
    ('WIII', 'WIIF'),
    ('WAAA', 'WAAA'),
    ('WADD', 'WADD'),
    ('WARR', 'WARR'),
    ('WITT', 'WITT'),
    ('WMSA', 'WMSA');

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
    longitude TEXT
);
CREATE INDEX IF NOT EXISTS idx_latlong_route ON latlong(route_id);

CREATE TABLE IF NOT EXISTS briefing_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flights_key TEXT NOT NULL,
    flights TEXT,
    content_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_briefing_reports_flights_key ON briefing_reports(flights_key);

-- Note: Schema ini bisa disesuaikan lagi mengikuti kebutuhan data spesifik dari Apps Script sebelumnya.
