-- 010_chunk_generation_uniqueness.sql
--
-- Problem
--   The original schema declared UNIQUE (reference_document_id, chunk_index).
--   That makes generational re-ingestion impossible: version 2 re-segments into a
--   different number of chunks, and every index it shares with version 1 collides.
--   The first ingestion attempt failed with SQLITE_CONSTRAINT_UNIQUE for exactly
--   this reason.
--
-- Fix
--   Include ingest_version in the uniqueness key: (reference_document_id,
--   ingest_version, chunk_index). Chunk order is only meaningful within a
--   generation, so this is the correct key, and it is what allows a new
--   generation to be written while the previous one stays readable.
--
-- SQLite cannot alter a constraint in place, so the table is rebuilt. The indexed
-- columns are copied explicitly. Indexes are recreated afterwards because they
-- belong to the dropped table.

CREATE TABLE reference_document_chunks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_document_id INTEGER NOT NULL REFERENCES reference_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    page_number INTEGER,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    clause_id TEXT,
    clause_scheme TEXT,
    section_title TEXT,
    ingest_version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(reference_document_id, ingest_version, chunk_index)
);

INSERT INTO reference_document_chunks_new
  (id, reference_document_id, chunk_index, page_number, content, created_at,
   clause_id, clause_scheme, section_title, ingest_version)
SELECT id, reference_document_id, chunk_index, page_number, content, created_at,
       clause_id, clause_scheme, section_title, ingest_version
  FROM reference_document_chunks;

DROP TABLE reference_document_chunks;

ALTER TABLE reference_document_chunks_new RENAME TO reference_document_chunks;

CREATE INDEX IF NOT EXISTS idx_rdc_clause ON reference_document_chunks (reference_document_id, clause_id);
CREATE INDEX IF NOT EXISTS idx_rdc_version ON reference_document_chunks (reference_document_id, ingest_version, chunk_index);
