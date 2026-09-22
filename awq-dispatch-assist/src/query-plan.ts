/**
 * Query planning for corpus retrieval.
 *
 * The problem this solves
 *   `queryTokens` pulls search terms out of a question with a pattern, and the
 *   lexical ranker then drops terms that appear in more than 2% of chunks
 *   (`COMMON_TOKEN_SHARE`). That filter is sound for an English question against an
 *   English corpus, because function words such as FOR and THE appear everywhere.
 *   It cannot work for an Indonesian question against an English corpus: `APAKAH`,
 *   `MASIH` and `BOLEH` appear in almost no chunk, so they are not recognised as
 *   common, they survive as "distinctive", they consume the eight-token budget, and
 *   they match nothing. The filter assumes the query and the corpus share a language,
 *   and here they do not — which is the same mismatch `@cf/baai/bge-m3` was chosen
 *   to absorb on the vector side, and which the lexical side had no answer for.
 *
 * What this does
 *   The model receives the operator's question — and nothing else — and returns
 *   search terms in the corpus's own vocabulary (`PLANNING MINIMA`, `HOLDING FUEL`,
 *   `TEMPO`). Those are *added* to whatever the pattern extractor already found, so
 *   the lexical ranker sees manual terminology no matter which language the operator
 *   typed in. Nothing is ever removed, so a plan can only widen the candidate set.
 *
 * What it deliberately does not do
 *   No clause text, excerpt, section title or manual content is sent. The only input
 *   is the operator's own question, which is not confidential material. The absence
 *   of a corpus field is the enforcement, not an oversight — the same boundary
 *   `explainer.ts` holds, and `test/query-plan.spec.ts` asserts it.
 *
 * Why the plan is advisory
 *   A plan is an optimisation, never a dependency. Every failure — no key, HTTP
 *   error, timeout, malformed body — returns `ok: false` and the caller retrieves
 *   exactly as it did before this module existed. The same applies to a plan that
 *   parses but is useless: it can only add terms that match nothing.
 */

import { DEFAULT_DEEPSEEK_ENDPOINT, DEFAULT_DEEPSEEK_MODEL } from './explainer';

export type PlanMessage = {
	role: 'system' | 'user';
	content: string;
};

export type QueryPlanConfig = {
	/** Bearer credential. Read from a Wrangler secret, never from source. */
	apiKey?: string;
	model?: string;
	endpoint?: string;
	timeoutMs?: number;
	/** Injected in tests so the provider is never called for real. */
	fetchImpl?: typeof fetch;
};

export type QueryPlan =
	| { ok: true; model: string; terms: string[] }
	| { ok: false; model: string; reason: 'no-api-key' | 'http-error' | 'malformed-response' | 'timeout' | 'network-error' | 'empty-plan'; status?: number };

/** The assistant question is already capped at 500 characters by the route. */
const MAX_QUESTION_CHARS = 500;

/** Upper bound on planned terms. Kept small: every term widens a D1 `LIKE` OR-clause. */
export const MAX_PLAN_TERMS = 8;

/**
 * Longest accepted term, set by the platform rather than by taste.
 *
 * D1 caps a `LIKE` pattern at 50 bytes and a term is wrapped as `%TERM%`, so the
 * real ceiling is 46 ASCII bytes. Terms are drawn only from `[A-Z0-9.]`, so bytes
 * and characters coincide. Choosing anything tighter would silently stop searching
 * for a long alphanumeric token that the pattern extractor had already accepted,
 * which is a regression rather than a bound.
 */
export const MAX_TERM_CHARS = 46;

/** Terms shorter than this cannot discriminate: they are substrings of everything. */
const MIN_TERM_CHARS = 3;

/**
 * A clause number the operator typed is already an exact lexical match.
 *
 * Planning for it would spend a model round-trip to add terms to a query whose
 * strongest signal is an exact `clause_id` equality, so the slowest, least
 * certain component is skipped exactly where the deterministic path is best.
 */
export function isIdentifierLookup(question: string): boolean {
	return /\b\d{1,4}(?:\.\d{1,4}){1,5}\b/.test(String(question));
}

export type PlanningMode = 'disabled' | 'identifier-lookup' | 'plan';

/**
 * Decide whether to plan a query.
 *
 * Planning buys recall with a model round-trip in front of an operator-facing
 * search box, and the recall gain has not yet been measured against the live
 * corpus. `QUERY_PLAN_DISABLED` therefore makes the whole feature reversible by
 * configuration — an operator can turn it off without a redeploy, and the audit
 * log records which mode produced a result so an A/B comparison is possible.
 *
 * The flag is read through a narrow shape because it is a Wrangler variable rather
 * than a generated binding, the same way `DEEPSEEK_API_KEY` is read.
 */
export function planningMode(question: string, disabledFlag?: string): PlanningMode {
	const flag = String(disabledFlag ?? '').trim().toLowerCase();
	if (flag === '1' || flag === 'true' || flag === 'yes') return 'disabled';
	return isIdentifierLookup(question) ? 'identifier-lookup' : 'plan';
}

/**
 * Normalise one candidate term onto the alphabet the lexical ranker can use.
 *
 * The ranker matches `UPPER(content) LIKE %TERM%` against a token set that
 * `queryTokens` produces, which is uppercase alphanumeric with dotted clause
 * numbers kept whole. Anything outside that alphabet — punctuation, quotes,
 * markdown — would be carried into the SQL pattern and could never match, so it is
 * stripped rather than passed through.
 */
export function normaliseTerm(raw: unknown): string | null {
	const text = String(raw ?? '').trim().toUpperCase();
	if (!text) return null;
	const cleaned = text.replace(/[^A-Z0-9.]+/g, '');
	if (cleaned.length < MIN_TERM_CHARS || cleaned.length > MAX_TERM_CHARS) return null;
	// A term of only dots or leading/trailing dots is noise from a sentence.
	if (!/[A-Z0-9]/.test(cleaned)) return null;
	return cleaned;
}

/**
 * Split planned phrases into single terms.
 *
 * `PLANNING MINIMA` as one term would only match where those two words are
 * adjacent; as two terms the coverage score rewards a chunk that contains both,
 * which is the ranking signal the lexical ranker actually uses.
 */
function splitPhrase(value: string): string[] {
	return value.split(/[\s,;/]+/).filter(Boolean);
}

/**
 * Turn a raw `terms` value into a bounded, deduplicated term list.
 *
 * Exported so the parser can be tested against adversarial shapes without a
 * provider: the model's output is untrusted input like any other.
 */
export function normaliseTerms(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string') continue;
		for (const piece of splitPhrase(entry)) {
			const term = normaliseTerm(piece);
			if (!term) continue;
			if (!out.includes(term)) out.push(term);
			if (out.length >= MAX_PLAN_TERMS) return out;
		}
	}
	return out;
}

/**
 * Pull the message content out of an OpenAI-compatible response.
 *
 * The provider body is untrusted: a shape change must produce a visible failure
 * rather than an empty plan that looks like a successful one.
 */
function extractContent(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0];
	if (!first || typeof first !== 'object') return null;
	const message = (first as { message?: unknown }).message;
	if (!message || typeof message !== 'object') return null;
	const content = (message as { content?: unknown }).content;
	if (typeof content !== 'string') return null;
	const trimmed = content.trim();
	return trimmed || null;
}

/**
 * Parse the model's answer into terms.
 *
 * JSON only, deliberately. A prose answer such as "Here are the terms: planning
 * minima, holding fuel" splits into words that are individually indistinguishable
 * from real terms ("HERE", "ARE", "THE"), and a term list polluted with function
 * words is worse than no plan at all. A response that is not JSON is therefore a
 * failure, not a best-effort parse.
 *
 * Markdown fences are tolerated because models add them habitually, and they are
 * stripped rather than parsed around.
 */
export function extractPlanTerms(payload: unknown): string[] | null {
	const content = extractContent(payload);
	if (!content) return null;

	const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
	const candidates: unknown[] = [];

	try {
		candidates.push(JSON.parse(unfenced));
	} catch {
		// A model that wrapped the array in a sentence still often emits a valid
		// array; try the span between the outermost brackets before giving up.
		const start = unfenced.indexOf('[');
		const end = unfenced.lastIndexOf(']');
		if (start !== -1 && end > start) {
			try {
				candidates.push(JSON.parse(unfenced.slice(start, end + 1)));
			} catch {
				return null;
			}
		} else {
			return null;
		}
	}

	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			const terms = normaliseTerms(candidate);
			return terms.length ? terms : null;
		}
		if (candidate && typeof candidate === 'object') {
			const terms = normaliseTerms((candidate as { terms?: unknown }).terms);
			return terms.length ? terms : null;
		}
	}
	return null;
}

/**
 * The instruction given to the planner.
 *
 * Kept as a separate exported function so the exact text is testable and so the
 * test can assert, over the real prompt, that no corpus material reaches the model.
 */
export function composePlanPrompt(question: string): PlanMessage[] {
	const system = [
		'You convert a flight dispatcher\'s question into search terms for an aviation regulatory manual index.',
		'',
		'Rules:',
		'- Output one JSON object and nothing else, in this exact shape: {"terms":["TERM","TERM"]}',
		'- The index is written in English. Even when the question is in Indonesian, output the English terminology the manual itself uses.',
		'- Prefer the manual\'s own vocabulary: planning minima, holding fuel, destination alternate, en-route alternate, visibility, ceiling, TEMPO, BECMG, RVR, NOTAM, dispatch, fuel supply.',
		'- Return between 3 and 8 terms. Single words or two-word phrases. No sentences, no punctuation, no explanation, no restatement of the question.',
		'- Never invent a clause number, a document name, or a figure. Repeat a clause number only if the question contains it.',
		'- If the question is unrelated to flight dispatch, return an empty array.'
	].join('\n');

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: String(question ?? '').trim().slice(0, MAX_QUESTION_CHARS) }
	];
}

/**
 * Ask the model for search terms.
 *
 * Never throws: an outage, a missing key or a malformed body must leave retrieval
 * working exactly as it did before, because a search box that stops searching when
 * an unrelated provider has a bad minute is worse than one that searches less well.
 */
export async function planQuery(config: QueryPlanConfig, question: string): Promise<QueryPlan> {
	const model = config.model ?? DEFAULT_DEEPSEEK_MODEL;
	const apiKey = String(config.apiKey ?? '').trim();
	if (!apiKey) return { ok: false, model, reason: 'no-api-key' };

	const messages = composePlanPrompt(question);
	const call = config.fetchImpl ?? fetch;
	const timeoutMs = config.timeoutMs ?? 8_000;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await call(config.endpoint ?? DEFAULT_DEEPSEEK_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({ model, messages, stream: false }),
			signal: controller.signal
		});

		if (!response.ok) {
			// The body is deliberately not read or echoed: a provider error can quote
			// request content, and this text can reach an operator-facing log.
			return { ok: false, model, reason: 'http-error', status: response.status };
		}

		const payload = await response.json().catch(() => null);
		const terms = extractPlanTerms(payload);
		if (!terms) return { ok: false, model, reason: 'malformed-response' };
		return { ok: true, model, terms };
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return { ok: false, model, reason: aborted ? 'timeout' : 'network-error' };
	} finally {
		clearTimeout(timer);
	}
}
