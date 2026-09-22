/**
 * Embedding generation for the reference corpus, via Workers AI.
 *
 * Model choice
 *   `@cf/baai/bge-m3` is multilingual and has a 60,000-token context window. The
 *   corpus mixes English and Indonesian (the CASR text is Indonesian-regulation
 *   English, the manuals carry Indonesian terms), so a multilingual model is
 *   required rather than a convenience: an English-only model would silently
 *   degrade recall on Indonesian queries.
 *
 * Dimension contract
 *   Vectorize fixes its dimensions at index creation and cannot change them, and
 *   the index was created for 1024. The model's real output size is therefore
 *   verified at runtime rather than trusted: if the provider ever returns a
 *   different width, the job fails loudly with the measured value instead of
 *   writing mismatched vectors that Vectorize would reject one by one.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** Must match the Vectorize index configuration. */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Texts per Workers AI call.
 *
 * Kept well below the model's token window because a single batch competes for the
 * same request budget: 50 chunks of up to 4000 characters is roughly 25k tokens,
 * leaving headroom for the largest observed chunk.
 */
export const EMBED_BATCH_SIZE = 50;

/** Vectors per upsert. Vectorize accepts 1000 per batch from a Worker. */
export const UPSERT_BATCH_SIZE = 100;

export class EmbeddingDimensionError extends Error {
	constructor(expected: number, received: number) {
		super(
			`Embedding model ${EMBEDDING_MODEL} returned ${received} dimensions but the Vectorize index expects ${expected}. ` +
				`Create a new index matching the model output, or switch to a model that produces ${expected}.`
		);
		this.name = 'EmbeddingDimensionError';
	}
}

type AiEmbeddingResponse = number[][] | { data?: number[][]; response?: number[][] };

/**
 * Normalise the several shapes the binding can return into an array of vectors.
 * `text` input yields an array of embeddings; the request/response form is also
 * accepted so a provider change does not silently produce zero vectors.
 *
 * Exported for testing: this is the seam where a provider response-shape change
 * would otherwise produce zero vectors and a silently empty index.
 */
export function normaliseEmbeddings(payload: AiEmbeddingResponse): number[][] {
	if (Array.isArray(payload)) {
		// Either number[][] or a single number[], which we never request.
		if (payload.length && Array.isArray(payload[0])) return payload as number[][];
		return [];
	}
	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.response)) return payload.response;
	return [];
}

/**
 * Embed a batch of texts. Callers are responsible for keeping the batch within
 * `EMBED_BATCH_SIZE`.
 */
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	if (!texts.length) return [];
	if (texts.length > EMBED_BATCH_SIZE) {
		throw new Error(`embedTexts received ${texts.length} texts, above the batch size of ${EMBED_BATCH_SIZE}.`);
	}
	// `truncate_inputs` is off: silent truncation would index an incomplete clause
	// while still citing the whole of it, which is worse than a visible failure.
	const payload = (await env.AI.run(EMBEDDING_MODEL as never, { text: texts } as never)) as AiEmbeddingResponse;
	const vectors = normaliseEmbeddings(payload);
	if (vectors.length !== texts.length) {
		throw new Error(`Embedding model returned ${vectors.length} vectors for ${texts.length} inputs.`);
	}
	for (const vector of vectors) {
		if (vector.length !== EMBEDDING_DIMENSIONS) {
			throw new EmbeddingDimensionError(EMBEDDING_DIMENSIONS, vector.length);
		}
	}
	return vectors;
}

/** Embed a single search query. */
export async function embedQuery(env: Env, query: string): Promise<number[]> {
	const [vector] = await embedTexts(env, [query.slice(0, 4000)]);
	if (!vector) throw new Error('The embedding model returned no vector for the query.');
	return vector;
}

export type EmbeddableChunk = {
	id: number;
	reference_document_id: number;
	clause_id: string | null;
	clause_scheme: string | null;
	section_title: string | null;
	content: string;
};

/**
 * Chunks still awaiting a vector.
 *
 * Ordering puts `pending` ahead of `failed`. Without that, a chunk that fails
 * embedding would be re-selected first on every subsequent slice and the job would
 * never move past it — the failure would block all later chunks. Failed chunks are
 * still returned, so a transient provider error is retried rather than abandoned.
 */
export async function listPendingChunks(
	env: Env,
	version: number,
	limit: number
): Promise<EmbeddableChunk[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, reference_document_id, clause_id, clause_scheme, section_title, content
		   FROM reference_document_chunks
		  WHERE ingest_version = ? AND embedding_status != 'done'
		  ORDER BY CASE WHEN embedding_status = 'pending' THEN 0 ELSE 1 END,
		           reference_document_id ASC, chunk_index ASC
		  LIMIT ?`
	).bind(version, limit).all<EmbeddableChunk>();
	return results || [];
}

/**
 * Wipe the failure list so the remaining chunks are attempted again.
 *
 * Called at the start of an indexing run. Failures recorded by a previous run are
 * usually transient (provider throttling, a timeout), and the ordering rule above
 * defers them, so clearing the flags is what stops a handful of bad chunks from
 * permanently skewing the ordering.
 */
export async function resetFailedChunks(env: Env, version: number): Promise<number> {
	const result = await env.DB.prepare(
		`UPDATE reference_document_chunks
		    SET embedding_status = 'pending', embedding_error = NULL
		  WHERE ingest_version = ? AND embedding_status = 'failed'`
	).bind(version).run();
	return Number(result.meta.changes ?? 0);
}

/** Remaining work, used to report progress and to decide when the job is finished. */
export async function embeddingProgress(
	env: Env,
	version: number
): Promise<{ total: number; done: number; failed: number; pending: number }> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS total,
		        SUM(CASE WHEN embedding_status = 'done' THEN 1 ELSE 0 END) AS done,
		        SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END) AS failed,
		        SUM(CASE WHEN embedding_status = 'pending' THEN 1 ELSE 0 END) AS pending
		   FROM reference_document_chunks
		  WHERE ingest_version = ?`
	).bind(version).first<{ total: number; done: number; failed: number; pending: number }>();
	return {
		total: Number(row?.total || 0),
		done: Number(row?.done || 0),
		failed: Number(row?.failed || 0),
		pending: Number(row?.pending || 0)
	};
}

/**
 * Vector metadata.
 *
 * Vectorize caps indexed metadata fields at 64 bytes, so each field here is a
 * short identifier, never text. The chunk text is read back from D1 by id, which
 * keeps the index small and means correcting a chunk does not require re-embedding
 * it just to fix metadata.
 */
export function vectorMetadata(chunk: EmbeddableChunk, version: number) {
	return {
		chunkId: String(chunk.id),
		documentId: String(chunk.reference_document_id),
		ingestVersion: String(version),
		clauseScheme: chunk.clause_scheme ?? 'none',
		hasClause: chunk.clause_id ? 'yes' : 'no'
	};
}
