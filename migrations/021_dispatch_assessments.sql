CREATE TABLE IF NOT EXISTS dispatch_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('READY', 'REVIEW_REQUIRED', 'NO_DATA')),
    decision TEXT NOT NULL DEFAULT 'OPEN' CHECK(decision IN ('OPEN', 'ACCEPTED', 'REJECTED')),
    contract_version TEXT NOT NULL DEFAULT '1',
    snapshot_json TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
    review_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispatch_assessments_flight_created
    ON dispatch_assessments(flight_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_assessments_user_created
    ON dispatch_assessments(user_id, created_at DESC, id DESC);
