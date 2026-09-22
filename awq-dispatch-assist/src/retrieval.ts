/**
 * Hybrid retrieval over the reference corpus.
 *
 * Why not vector search alone
 *   Regulatory text is full of exact identifiers: `121.635`, `4.8.11.1`, "RVR".
 *   Dense embeddings are poor at exact-token matching — an embedding of "121.635"
 *   sits near other clause numbers — while lexical search is exact by construction.
 *   Conversely lexical search cannot match a paraphrase ("runway visual range"
 *   against a query about "RVR"). Either method alone fails on a whole class of
 *   real dispatch questions, so both run and their rankings are fused.
 *
 * Fusion
 *   Reciprocal rank fusion: each result scores sum(1 / (k + rank)) across the
 *   rankings it appears in. RRF needs no score calibration between a cosine
 *   similarity and a lexical rank, which is what makes it the right choice here —
 *   the two scores are not comparable and any weighted sum would be arbitrary.
 *
 * Traceability
 *   The response reports which ranker(s) produced each result and the raw cosine
 *   score, so a citation can be audited: a clause that only lexical search found is
 *   a different kind of evidence from one the embedding model also ranked highly.
 */

import { embedQuery, EMBEDDING_MODEL } from './embeddings';
import { normaliseTerm } from './query-plan';
import type { ClauseScheme } from './clause';

/** RRF constant. 60 is the value from the original RRF paper and is insensitive in practice. */
const RRF_K = 60;

/** Candidates pulled from each ranker before fusion. */
const LEXICAL_CANDIDATES = 60;
const VECTOR_CANDIDATES = 30;

export type RetrievedChunk = {
	chunkId: number;
	documentId: number;
	fileName: string;
	category: string;
	clauseId: string | null;
	clauseScheme: ClauseScheme | null;
	sectionTitle: string | null;
	excerpt: string;
	fusionScore: number;
	vectorScore: number | null;
	vectorRank: number | null;
	lexicalRank: number | null;
	foundBy: Array<'lexical' | 'vector'>;
};

export type RetrievalResult = {
	query: string;
	/** The tokens the lexical ranker actually used, after merging and bounding. */
	terms: string[];
	method: 'hybrid' | 'lexical-only';
	candidates: { lexical: number; vector: number };
	results: RetrievedChunk[];
};

type ChunkRow = {
	id: number;
	reference_document_id: number;
	clause_id: string | null;
	clause_scheme: string | null;
	section_title: string | null;
	content: string;
	file_name: string;
	category: string;
};

/**
 * Query tokens used by the lexical ranker.
 *
 * Two classes are extracted, and the order of the alternatives matters:
 *   1. Dotted clause numbers (`121.635`, `4.8.11.1`), kept whole. If these were
 *      split on the dot the lexical search could never use its exact `clause_id`
 *      match, and the fragments (`121`, `635`) would match almost any clause in
 *      the part, which is worse than not matching at all.
 *   2. Alphanumeric identifiers of three or more characters (ICAO codes,
 *      abbreviations).
 *
 * Input is uppercased, so ordinary prose words are produced too. They are removed
 * later by the frequency filter, once it is known which of them are actually
 * distinctive.
 */
export function queryTokens(question: string): string[] {
	const matches = String(question).toUpperCase().match(/\d{1,4}(?:\.\d{1,4}){1,5}|[A-Z0-9]{3,}/g) || [];
	return [...new Set(matches)].slice(0, 8);
}

/**
 * Largest token set handed to the lexical ranker.
 *
 * Bounded by D1's limit of 100 bound parameters per query, which the lexical
 * statement reaches three times per token (content, section title, exact clause id)
 * plus the version and the limit: `3T + 2 <= 100`. The document-frequency probe
 * binds each token twice plus the version: `2T + 1`. At 12 tokens that is 38 and 25
 * respectively, both with headroom, and `%TERM%` stays far inside the 50-byte
 * `LIKE` pattern ceiling given `MAX_TERM_CHARS`.
 */
export const MAX_LEXICAL_TOKENS = 12;

/**
 * Combine the pattern's tokens with any planned terms.
 *
 * Order matters: pattern tokens come first because an identifier the operator typed
 * is stronger evidence than a term a model inferred. Nothing is ever removed, so a
 * plan can only widen the candidate set — and when no plan is supplied this returns
 * exactly what `queryTokens` produced, capped at the same effective length.
 */
export function mergeTokens(patternTokens: readonly string[], planTerms: readonly string[] = []): string[] {
	const out: string[] = [];
	for (const value of [...patternTokens, ...planTerms]) {
		const token = normaliseTerm(value);
		if (!token || out.includes(token)) continue;
		if (out.length >= MAX_LEXICAL_TOKENS) break;
		out.push(token);
	}
	return out;
}

/**
 * A token appearing in more than this share of chunks is treated as noise.
 *
 * Measured on the live corpus without this filter, queries returned the Operations
 * Manual abbreviation lists (`0.2`, `0.1.12`) in the top results of every single
 * question, because English function words such as FOR, THE and ARE match nearly
 * every chunk. The lexical ranker is a substring matcher, so it cannot tell a
 * meaningful term from a common one on its own; document frequency is what
 * distinguishes them.
 */
const COMMON_TOKEN_SHARE = 0.02;

/** Tokens too common to be informative. Computed per query, since it needs the corpus. */
async function commonTokens(env: Env, version: number, tokens: readonly string[]): Promise<Set<string>> {
	if (!tokens.length) return new Set();
	const totalRow = await env.DB.prepare(
		'SELECT COUNT(*) AS total FROM reference_document_chunks WHERE ingest_version = ?'
	).bind(version).first<{ total: number }>();
	const total = Number(totalRow?.total || 0);
	if (!total) return new Set();

	const clauses = tokens.map(() => 'UPPER(c.content) LIKE ?').join(' OR ');
	const row = await env.DB.prepare(
		`SELECT ${tokens.map((_, index) => `SUM(CASE WHEN UPPER(c.content) LIKE ? THEN 1 ELSE 0 END) AS t${index}`).join(', ')}
		   FROM reference_document_chunks c
		  WHERE c.ingest_version = ? AND (${clauses})`
	)
		.bind(...tokens.map(token => `%${token}%`), version, ...tokens.map(token => `%${token}%`))
		.first<Record<string, number>>();

	const common = new Set<string>();
	tokens.forEach((token, index) => {
		const count = Number(row?.[`t${index}`] || 0);
		if (count / total > COMMON_TOKEN_SHARE) common.add(token);
	});
	return common;
}

/**
 * Lexical ranking from D1, ranked by how many distinctive query tokens a chunk
 * satisfies.
 *
 * Common tokens are dropped before matching, and a chunk must satisfy more than one
 * token to rank (unless the query only produced one distinctive token). Without
 * that coverage requirement a chunk matching a single common word could outrank a
 * genuinely relevant clause.
 */
async function lexicalSearch(env: Env, version: number, tokens: readonly string[]): Promise<ChunkRow[]> {
	if (!tokens.length) return [];

	const common = await commonTokens(env, version, tokens);
	const distinctive = tokens.filter(token => !common.has(token));
	// If every token was common, fall back to all of them rather than returning
	// nothing: a vague question should still retrieve something to read.
	const effective = distinctive.length ? distinctive : tokens;
	const minimumCoverage = effective.length > 1 ? 2 : 1;

	const clauses = effective.map(() => '(UPPER(c.content) LIKE ? OR UPPER(c.section_title) LIKE ? OR UPPER(c.clause_id) = ?)').join(' OR ');
	// Bind each token three times: content, section title, and exact clause id.
	const bindings = effective.flatMap(token => [`%${token}%`, `%${token}%`, token]);

	const { results } = await env.DB.prepare(
		`SELECT c.id, c.reference_document_id, c.clause_id, c.clause_scheme, c.section_title, c.content,
		        d.file_name, d.category
		   FROM reference_document_chunks c
		   JOIN reference_documents d ON d.id = c.reference_document_id
		  WHERE c.ingest_version = ? AND (${clauses})
		  LIMIT ?`
	)
		.bind(version, ...bindings, LEXICAL_CANDIDATES)
		.all<ChunkRow>();

	const coverage = (row: ChunkRow): number => {
		const haystack = `${row.clause_id || ''} ${row.section_title || ''} ${row.content}`.toUpperCase();
		return effective.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
	};

	return (results || [])
		.map(row => ({ row, score: coverage(row) }))
		.filter(entry => entry.score >= minimumCoverage)
		.sort((left, right) => right.score - left.score)
		.map(entry => entry.row);
}

/**
 * Candidate window for the vector ranker.
 *
 * 100 is the hard ceiling Vectorize imposes on `topK` when values or metadata are
 * not requested; a larger value is rejected with `max top K is 100`. The window is
 * kept at the maximum because it is also what bounds recall after the generation
 * filter is applied.
 */
const VECTOR_FILTER_CANDIDATES = 100;

/**
 * Vector ranking from Vectorize.
 *
 * Generation scoping is deliberately not done here. Two approaches were tried
 * against the live index and both failed:
 *
 *   1. A Vectorize metadata `filter` narrowed the candidate set before ranking and
 *      returned zero matches, because the ranked pool was drawn from a superset that
 *      the filter then discarded entirely.
 *   2. Reading `ingestVersion` back from returned metadata produced nothing, so
 *      every match looked as if it had no generation and was skipped.
 *
 * The generation is instead enforced where the text is loaded: `loadChunksById`
 * selects only rows at the active `ingest_version`, so a vector left over from a
 * superseded generation can never reach a citation, even if it ranks highly. That
 * places the invariant in the same query that supplies the quoted text, which is
 * the only place it actually matters.
 */
async function vectorSearch(env: Env, question: string): Promise<Array<{ id: string; score: number }>> {
	let vector: number[];
	try {
		vector = await embedQuery(env, question);
	} catch (error) {
		// A retrieval-time embedding failure must not take down lexical search: the
		// caller degrades to lexical-only rather than returning nothing.
		console.warn('[DISPATCH] query embedding failed, falling back to lexical search', error);
		return [];
	}

	const matches = await env.VECTORIZE.query(vector, { topK: VECTOR_FILTER_CANDIDATES });
	return (matches.matches || [])
		.slice(0, VECTOR_CANDIDATES)
		.map(match => ({ id: String(match.id), score: Number(match.score ?? 0) }));
}

/** Load chunk text by id. The index stores identifiers only, so text comes from D1. */
async function loadChunksById(env: Env, version: number, ids: number[]): Promise<Map<number, ChunkRow>> {
	if (!ids.length) return new Map();
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await env.DB.prepare(
		`SELECT c.id, c.reference_document_id, c.clause_id, c.clause_scheme, c.section_title, c.content,
		        d.file_name, d.category
		   FROM reference_document_chunks c
		   JOIN reference_documents d ON d.id = c.reference_document_id
		  WHERE c.ingest_version = ? AND c.id IN (${placeholders})`
	)
		.bind(version, ...ids)
		.all<ChunkRow>();
	return new Map((results || []).map(row => [Number(row.id), row]));
}

/**
 * Retrieve the most relevant corpus chunks for a question.
 *
 * `topK` is capped at 25 because every result is eventually placed in a model
 * prompt, and an unbounded excerpt list is the fastest way to make a prompt both
 * expensive and less accurate.
 *
 * `planTerms` are optional search terms supplied by the query planner. They are
 * additive: with no plan the tokens, the ranking and the result set are identical
 * to the behaviour before the planner existed.
 */
export async function retrieve(env: Env, version: number, question: string, topK = 8, planTerms: readonly string[] = []): Promise<RetrievalResult> {
	const limit = Math.max(1, Math.min(25, topK));
	const terms = mergeTokens(queryTokens(question), planTerms);
	const [lexical, vector] = await Promise.all([
		lexicalSearch(env, version, terms),
		vectorSearch(env, question)
	]);

	const lexicalRank = new Map<number, number>();
	lexical.forEach((row, index) => lexicalRank.set(Number(row.id), index + 1));

	const vectorRank = new Map<number, number>();
	const vectorScore = new Map<number, number>();
	vector.forEach((match, index) => {
		const id = Number(match.id);
		vectorRank.set(id, index + 1);
		vectorScore.set(id, match.score);
	});

	// Accumulate the fused score, then load text for the surviving ids.
	const fused = new Map<number, number>();
	for (const [id, rank] of lexicalRank) fused.set(id, 1 / (RRF_K + rank));
	for (const [id, rank] of vectorRank) fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank));

	const ordered = [...fused.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit);
	const rows = await loadChunksById(
		env,
		version,
		ordered.map(([id]) => id)
	);

	/**
	 * Collapse chunks that resolve to the same clause.
	 *
	 * A long clause is stored as several consecutive chunks, each with its own
	 * vector, so without this a single clause could occupy every result slot. Earlier
	 * testing returned the same Operations Manual clause five times. Chunks with no
	 * clause number are keyed by identifier instead, since unnumbered material has no
	 * clause to collapse onto.
	 */
	const bestByClause = new Map<string, { id: number; score: number; row: ChunkRow }>();
	for (const [id, score] of ordered) {
		const row = rows.get(id);
		if (!row) continue;
		const key = row.clause_id ? `${row.reference_document_id}::${row.clause_id}` : `chunk::${id}`;
		const existing = bestByClause.get(key);
		if (!existing || score > existing.score) bestByClause.set(key, { id, score, row });
	}
	const deduped = [...bestByClause.values()].sort((left, right) => right.score - left.score).slice(0, limit);

	const results: RetrievedChunk[] = [];
	for (const { id, score, row } of deduped) {
		// The scheme is stored as free text in D1; narrow it so callers can rely on
		// the union rather than on an arbitrary string.
		const scheme = row.clause_scheme === 'casr' || row.clause_scheme === 'om' || row.clause_scheme === 'fdm' || row.clause_scheme === 'generic'
			? (row.clause_scheme as ClauseScheme)
			: null;
		const foundBy: Array<'lexical' | 'vector'> = [];
		if (lexicalRank.has(id)) foundBy.push('lexical');
		if (vectorRank.has(id)) foundBy.push('vector');
		results.push({
			chunkId: id,
			documentId: Number(row.reference_document_id),
			fileName: row.file_name,
			category: row.category,
			clauseId: row.clause_id,
			clauseScheme: scheme,
			sectionTitle: row.section_title,
			excerpt: row.content.slice(0, 1200),
			fusionScore: Number(score.toFixed(6)),
			vectorScore: vectorScore.get(id) ?? null,
			vectorRank: vectorRank.get(id) ?? null,
			lexicalRank: lexicalRank.get(id) ?? null,
			foundBy
		});
	}

	return {
		query: question,
		terms,
		method: vector.length ? 'hybrid' : 'lexical-only',
		candidates: { lexical: lexical.length, vector: vector.length },
		results
	};
}

export { EMBEDDING_MODEL };
