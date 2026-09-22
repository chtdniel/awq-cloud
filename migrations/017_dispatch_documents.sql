CREATE TABLE IF NOT EXISTS dispatch_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('flight-plan', 'weather', 'notam', 'loadsheet', 'operational')),
    file_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/pdf',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dispatch_documents_flight
    ON dispatch_documents(flight_id, created_at DESC);
