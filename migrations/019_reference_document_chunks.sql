CREATE TABLE IF NOT EXISTS reference_document_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_document_id INTEGER NOT NULL REFERENCES reference_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    page_number INTEGER,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reference_document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_reference_document_chunks_document
    ON reference_document_chunks(reference_document_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_reference_document_chunks_content
    ON reference_document_chunks(content);
