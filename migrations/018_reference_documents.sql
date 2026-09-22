CREATE TABLE IF NOT EXISTS reference_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('operations-manual', 'regulation', 'dispatch-manual', 'other')),
    file_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/pdf',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reference_documents_created
    ON reference_documents(created_at DESC, id DESC);
