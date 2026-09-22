-- 011_chunk_embeddings.sql
--
-- Purpose
--   Track which corpus chunks have a vector in Vectorize.
--
-- Why in D1 rather than only in Vectorize
--   Vectorize holds vectors and metadata, but the chunk text stays in D1 (metadata
--   is capped at 10 KiB and indexed metadata fields at 64 bytes, so content cannot
--   live there). That makes D1 the source of truth for "what should be indexed",
--   and this column makes the embedding job resumable: it selects work by status
--   instead of re-embedding the whole corpus on every attempt.
--
-- status values
--   pending  not yet embedded
--   done     a vector was upserted for this chunk
--   failed   the last attempt raised a non-retryable error

ALTER TABLE reference_document_chunks ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE reference_document_chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE reference_document_chunks ADD COLUMN embedded_at TEXT;
ALTER TABLE reference_document_chunks ADD COLUMN embedding_error TEXT;

CREATE INDEX IF NOT EXISTS idx_rdc_embedding
  ON reference_document_chunks (ingest_version, embedding_status, reference_document_id, chunk_index);

-- Record which model produced the vectors. A model change alters vector dimensions
-- and invalidates the whole index, so the value is kept alongside the index name in
-- the document row that operators read.
ALTER TABLE reference_documents ADD COLUMN embedding_model TEXT;
ALTER TABLE reference_documents ADD COLUMN embedded_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reference_documents ADD COLUMN embedded_at TEXT;
