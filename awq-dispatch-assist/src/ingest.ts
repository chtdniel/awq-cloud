/**
 * Reference corpus ingestion.
 *
 * The corpus text is already in D1, so ingestion re-segments it rather than
 * re-extracting the PDFs. That keeps the operation cheap and reversible.
 *
 * Generational writes
 *   New chunks are written with a higher `ingest_version` and switched to by
 *   lowering `CHUNK_INGEST_VERSION` in src/index.ts. The previous generation is
 *   left untouched so a bad re-ingestion is recoverable, and the only copy of the
 *   corpus is never destroyed. Cleanup of the superseded generation is a separate,
 *   explicit action.
 */

import { rebuildChunks, type CorpusDocumentClass, type RawChunk } from './clause';

/** Rows written per D1 batch, keeping each statement well inside request limits. */
const WRITE_BATCH_SIZE = 20;

export type IngestDocument = {
	id: number;
	category: string;
	file_name: string;
	ingest_status: string;
};

export type IngestPlan = {
	documentId: number;
	className: CorpusDocumentClass;
	targetVersion: number;
	sourceChunks: number;
	supersededChunks: number;
};

export type IngestResult = {
	documentId: number;
	fileName: string;
	sourceChunks: number;
	writtenChunks: number;
	/** Chunks that carry a clause identity and can therefore be cited. */
	citableChunks: number;
	distinctClauses: number;
	/** Chunks with no numbering, such as a cover page or abbreviation list. */
	unreferencedChunks: number;
	clausesDropped: number;
};

/** Map the stored category onto the numbering convention used for segmentation. */
export function documentClassOf(category: string): CorpusDocumentClass {
	if (category === 'regulation') return 'regulation';
	if (category === 'operations-manual') return 'operations-manual';
	if (category === 'dispatch-manual') return 'dispatch-manual';
	return 'other';
}

/** Number of citable clauses currently stored for a document at a version. */
export async function countClauses(env: Env, documentId: number, version: number): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(DISTINCT clause_id) AS clauses
		   FROM reference_document_chunks
		  WHERE reference_document_id = ? AND ingest_version = ? AND clause_id IS NOT NULL`
	).bind(documentId, version).first<{ clauses: number }>();
	return Number(row?.clauses || 0);
}

async function loadRawChunks(env: Env, documentId: number, version: number): Promise<RawChunk[]> {
	const { results } = await env.DB.prepare(
		`SELECT chunk_index, content, page_number
		   FROM reference_document_chunks
		  WHERE reference_document_id = ? AND ingest_version = ?
		  ORDER BY chunk_index ASC`
	).bind(documentId, version).all<RawChunk>();
	return results || [];
}

/**
 * Ingest one reference document into the target version.
 *
 * The document is marked `processing` for the duration and `ready` only after
 * every chunk is committed, so a partial run is visible as a failure rather than
 * looking like a successful ingestion.
 */
export async function ingestDocument(
	env: Env,
	document: IngestDocument,
	sourceVersion: number,
	targetVersion: number
): Promise<IngestResult> {
	const className = documentClassOf(document.category);
	const raw = await loadRawChunks(env, document.id, sourceVersion);

	if (!raw.length) {
		await env.DB.prepare(
			`UPDATE reference_documents
			    SET ingest_status = 'failed', ingest_note = ?, ingested_at = CURRENT_TIMESTAMP
			  WHERE id = ?`
		).bind(`No source chunks found at ingest version ${sourceVersion}.`, document.id).run();
		throw new Error(`Reference document ${document.id} has no source chunks to re-segment.`);
	}

	const previousClauses = await countClauses(env, document.id, sourceVersion);
	const chunks = rebuildChunks(raw, className);

	await env.DB.prepare(
		`UPDATE reference_documents SET ingest_status = 'processing', ingest_note = ? WHERE id = ?`
	).bind(`Re-segmenting ${raw.length} chunks into ${chunks.length} clause-aligned chunks.`, document.id).run();

	// Remove any previous partial run at the target version before writing, so the
	// target version is either complete or absent.
	await env.DB.prepare('DELETE FROM reference_document_chunks WHERE reference_document_id = ? AND ingest_version = ?')
		.bind(document.id, targetVersion)
		.run();

	let written = 0;
	for (let offset = 0; offset < chunks.length; offset += WRITE_BATCH_SIZE) {
		const slice = chunks.slice(offset, offset + WRITE_BATCH_SIZE);
		const statements = slice.map(chunk =>
			env.DB.prepare(
				`INSERT INTO reference_document_chunks
				   (reference_document_id, chunk_index, page_number, content, clause_id, clause_scheme, section_title, ingest_version)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(
				document.id,
				chunk.chunk_index,
				chunk.page_number,
				chunk.content,
				chunk.clause_id,
				chunk.clause_scheme,
				chunk.section_title,
				targetVersion
			)
		);
		await env.DB.batch(statements);
		written += slice.length;
	}

	const citable = chunks.filter(chunk => chunk.clause_id !== null);
	const distinctClauses = new Set(citable.map(chunk => chunk.clause_id)).size;
	const note =
		`${written} chunks at version ${targetVersion}; ` +
		`${distinctClauses} distinct clauses; ${chunks.length - citable.length} chunks without a clause id.`;

	await env.DB.prepare(
		`UPDATE reference_documents
		    SET ingest_status = 'ready', ingest_note = ?, chunk_count = ?, ingested_at = CURRENT_TIMESTAMP
		  WHERE id = ?`
	).bind(note, written, document.id).run();

	return {
		documentId: document.id,
		fileName: document.file_name,
		sourceChunks: raw.length,
		writtenChunks: written,
		citableChunks: citable.length,
		distinctClauses,
		unreferencedChunks: chunks.length - citable.length,
		// Positive means the re-ingestion lost citable clauses and should be
		// reviewed before the version is switched over.
		clausesDropped: previousClauses - distinctClauses,
	};
}
