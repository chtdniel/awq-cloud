-- 009_reference_chunk_citations.sql
--
-- Purpose
--   Make the reference corpus (Operations Manual, Flight Dispatch Manual, CASR)
--   citable and re-ingestable.
--
-- Why
--   reference_document_chunks already holds extracted text, but before this
--   migration it had no clause identity, no page number, and no way to tell one
--   ingestion generation from another. That makes it impossible for a dispatch
--   recommendation to cite "CASR 121.635" or "OM Part A 7.8.1", and impossible
--   to re-ingest safely: rewriting the table in place would destroy the only
--   copy of the corpus.
--
-- Design notes
--   * ingest_version separates generations. Existing rows stay at version 1;
--     clause-aware re-ingestion writes version 2. Readers select the newest
--     complete version, so a failed re-ingestion never removes working data and
--     rollback is just lowering the selected version.
--   * page_number already existed but is NULL for every current row; the
--     re-ingestion pipeline fills it when the extractor provides it.
--   * clause_id is the citation key. clause_scheme records which numbering
--     convention it came from ('casr' | 'om' | 'fdm' | 'generic') so that a
--     regulation reference is never confused with an internal manual section.
--
-- Idempotency
--   ALTER TABLE ADD COLUMN is not guarded by IF NOT EXISTS in SQLite, so this
--   file must not be applied twice. It is recorded in d1_migrations on the
--   first application.

ALTER TABLE reference_document_chunks ADD COLUMN clause_id TEXT;
ALTER TABLE reference_document_chunks ADD COLUMN clause_scheme TEXT;
ALTER TABLE reference_document_chunks ADD COLUMN section_title TEXT;
ALTER TABLE reference_document_chunks ADD COLUMN ingest_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_rdc_clause ON reference_document_chunks (reference_document_id, clause_id);
CREATE INDEX IF NOT EXISTS idx_rdc_version ON reference_document_chunks (reference_document_id, ingest_version, chunk_index);

-- Ingestion state on the document row, so an operator can see whether a manual
-- is actually searchable instead of discovering a silent no-match later.
ALTER TABLE reference_documents ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE reference_documents ADD COLUMN ingest_note TEXT;
ALTER TABLE reference_documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reference_documents ADD COLUMN ingested_at TEXT;

-- Documents that already carry chunks were embedded in place before ingestion
-- state existed. Mark them ready so the UI does not claim they are un-indexed.
UPDATE reference_documents
   SET ingest_status = 'ready',
       chunk_count = (
         SELECT COUNT(*) FROM reference_document_chunks c
          WHERE c.reference_document_id = reference_documents.id
       )
 WHERE EXISTS (
         SELECT 1 FROM reference_document_chunks c
          WHERE c.reference_document_id = reference_documents.id
       );
