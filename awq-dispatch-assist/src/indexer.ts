/**
 * Corpus indexing: embed chunks and store their vectors in Vectorize.
 *
 * Ordering rule
 *   Vectors are upserted before the chunk is marked `done` in D1. A crash between
 *   the two therefore leaves a chunk as `pending` with a vector already present,
 *   and the next run re-upserts it. Upsert by a stable numeric id is idempotent, so
 *   retrying is harmless. The reverse order would mark chunks indexed that have no
 *   vector, which is the failure that silently degrades retrieval.
 *
 * D1 stays the source of truth
 *   Vectorize holds the vectors and short identifiers only; the chunk text lives in
 *   D1. Retrieval therefore reads matches from Vectorize and then loads the text by
 *   id, which keeps the index small and the metadata within the 64-byte indexed
 *   field limit.
 */

import {
	EMBED_BATCH_SIZE,
	EMBEDDING_MODEL,
	UPSERT_BATCH_SIZE,
	embedTexts,
	listPendingChunks,
	embeddingProgress,
	resetFailedChunks,
	vectorMetadata,
	type EmbeddableChunk
} from './embeddings';

export type IndexSliceResult = {
	embedded: number;
	upserted: number;
	remaining: number;
	failedChunks: number;
	retriedChunks: number;
};

/** Aggregate progress for the corpus, used by the admin route and its responses. */
export async function indexStatus(env: Env, version: number) {
	const progress = await embeddingProgress(env, version);
	return {
		version,
		model: EMBEDDING_MODEL,
		...progress,
		complete: progress.total > 0 && progress.pending === 0 && progress.failed === 0
	};
}

/**
 * Embed and upsert up to `limit` pending chunks.
 *
 * Chunks are processed in embedding-sized batches. An embedding failure marks the
 * whole batch `failed` with the error recorded, and processing continues with the
 * next batch: one malformed chunk must not stall the remaining corpus. A vector
 * dimension mismatch is deliberately not swallowed here — it propagates, because
 * writing mismatched vectors would corrupt the whole index rather than one chunk.
 */
export async function indexChunkSlice(env: Env, version: number, limit: number): Promise<IndexSliceResult> {
	// Clear previous failures first: they are usually transient, and leaving the
	// flags set would keep them ordered behind new work indefinitely.
	const retriedChunks = await resetFailedChunks(env, version);
	const pending = await listPendingChunks(env, version, limit);
	let embedded = 0;
	let upserted = 0;
	let failedChunks = 0;

	for (let offset = 0; offset < pending.length; offset += EMBED_BATCH_SIZE) {
		const batch: EmbeddableChunk[] = pending.slice(offset, offset + EMBED_BATCH_SIZE);
		let vectors: number[][];
		try {
			vectors = await embedTexts(
				env,
				batch.map(chunk => chunk.content)
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Embedding failed.';
			// A dimension mismatch invalidates the index configuration, not just this
			// batch, so it must stop the job instead of marking chunks failed.
			if (error instanceof Error && error.name === 'EmbeddingDimensionError') throw error;
			await markFailed(env, batch.map(chunk => chunk.id), message);
			failedChunks += batch.length;
			continue;
		}

		embedded += batch.length;

		for (let start = 0; start < batch.length; start += UPSERT_BATCH_SIZE) {
			const slice = batch.slice(start, start + UPSERT_BATCH_SIZE);
			const sliceVectors = vectors.slice(start, start + UPSERT_BATCH_SIZE);
			await env.VECTORIZE.upsert(
				slice.map((chunk, index) => ({
					id: String(chunk.id),
					values: sliceVectors[index],
					metadata: vectorMetadata(chunk, version)
				}))
			);
			await markDone(
				env,
				slice.map(chunk => chunk.id)
			);
			upserted += slice.length;
		}
	}

	const remaining = (await embeddingProgress(env, version)).pending;
	return { embedded, upserted, remaining, failedChunks, retriedChunks };
}

/** Mark chunks as indexed. Only reached after their vectors were upserted. */
async function markDone(env: Env, ids: number[]): Promise<void> {
	if (!ids.length) return;
	const placeholders = ids.map(() => '?').join(', ');
	await env.DB.prepare(
		`UPDATE reference_document_chunks
		    SET embedding_status = 'done', embedding_model = ?, embedding_error = NULL,
		        embedded_at = CURRENT_TIMESTAMP
		  WHERE id IN (${placeholders})`
	)
		.bind(EMBEDDING_MODEL, ...ids)
		.run();
}

async function markFailed(env: Env, ids: number[], message: string): Promise<void> {
	if (!ids.length) return;
	const placeholders = ids.map(() => '?').join(', ');
	await env.DB.prepare(
		`UPDATE reference_document_chunks
		    SET embedding_status = 'failed', embedding_error = ?
		  WHERE id IN (${placeholders})`
	)
		.bind(message.slice(0, 500), ...ids)
		.run();
}

/**
 * Refresh per-document embedding counts so an operator can see which manuals are
 * actually searchable. Called once at the end of a job rather than per slice.
 */
export async function refreshDocumentEmbeddingCounts(env: Env, version: number): Promise<void> {
	await env.DB.prepare(
		`UPDATE reference_documents
		    SET embedding_model = ?,
		        embedded_chunk_count = (
		          SELECT COUNT(*) FROM reference_document_chunks c
		           WHERE c.reference_document_id = reference_documents.id
		             AND c.ingest_version = ?
		             AND c.embedding_status = 'done'
		        ),
		        embedded_at = CURRENT_TIMESTAMP`
	)
		.bind(EMBEDDING_MODEL, version)
		.run();
}
