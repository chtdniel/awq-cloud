-- WX WARNING page: tropical-cyclone and volcanic-ash overlay.
--
-- Two kinds of rows share this table because the page treats them identically
-- until render time:
--   * ingested rows  (is_manual = 0) — JTWC TC warnings and VAAC advisories from
--     NOAA's WMO/GTS raw feed, plus VA/TC SIGMET polygons from
--     aviationweather.gov. The cron worker refreshes them every 4 hours and
--     deletes everything it did not see in that cycle, so a storm that has
--     dissipated disappears on its own.
--   * manual rows    (is_manual = 1) — products pasted by an operator on the page.
--     They are shared by every operator (the page is a shift handover tool), are
--     never touched by the ingest cycle, and expire after 7 days so nobody
--     briefs on last week's paste.
--
-- (source, external_id) is the identity: re-ingesting the same product revision
-- updates the row instead of cloning it, and re-pasting the same text updates the
-- operator's row in place.
CREATE TABLE IF NOT EXISTS wx_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,                    -- JTWC | VAAC | ISIGMET | MANUAL
    external_id TEXT NOT NULL,               -- WMO header + revision, or MANUAL:<fingerprint>
    kind TEXT NOT NULL,                      -- TC | VA
    title TEXT,
    basin TEXT,                              -- JTWC basin token (NORTHWESTPAC, SOUTHIO, ...)
    fir TEXT,                                -- FIR / VAAC office code when known
    volcano_name TEXT,
    volcano_number TEXT,                     -- Smithsonian GVP number from the VAA
    advisory_nr TEXT,                        -- WARNING NR 022 / ADVISORY NR 2026/1078
    dtg TEXT,                                -- product issue time, ISO-8601 UTC
    valid_from TEXT,
    valid_to TEXT,                           -- NXT ADVISORY deadline when published
    center_lat REAL,
    center_lon REAL,
    fl_base INTEGER,                         -- feet
    fl_top INTEGER,                          -- feet
    move_dir TEXT,
    move_deg INTEGER,
    move_kt INTEGER,
    wind_kt INTEGER,
    gust_kt INTEGER,
    mslp_mb INTEGER,
    polygons_json TEXT NOT NULL DEFAULT '[]',-- [{role,validAt,flBase,flTop,coords:[[lon,lat]...]}]
    track_json TEXT NOT NULL DEFAULT '[]',   -- [{tauHr,validAt,lat,lon,windKt,gustKt,radii,note}]
    raw_text TEXT,                           -- verbatim product, for verification
    source_url TEXT,                         -- official page to check by hand
    parse_notes TEXT NOT NULL DEFAULT '[]',
    fetched_at TEXT NOT NULL,                -- last successful ingest/save (ISO)
    is_manual INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,                         -- operator identity for manual rows
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_wx_warnings_kind ON wx_warnings (kind);
CREATE INDEX IF NOT EXISTS idx_wx_warnings_fetched ON wx_warnings (fetched_at);
CREATE INDEX IF NOT EXISTS idx_wx_warnings_manual ON wx_warnings (is_manual, created_at);
