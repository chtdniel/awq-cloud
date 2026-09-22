import { describe, expect, it } from 'vitest';
import {
	MAX_PLAN_TERMS,
	MAX_TERM_CHARS,
	composePlanPrompt,
	extractPlanTerms,
	isIdentifierLookup,
	normaliseTerm,
	normaliseTerms,
	planQuery,
	planningMode
} from '../src/query-plan';
import { MAX_LEXICAL_TOKENS, mergeTokens, queryTokens } from '../src/retrieval';

/**
 * Query planner contract tests.
 *
 * The property that matters most is a confidentiality one: the planner sees the
 * operator's question and nothing else. It is asserted over the real prompt rather
 * than trusted to the prompt text, the same way `explainer.spec.ts` asserts the
 * boundary it holds.
 *
 * The second property is that planning is an optimisation, never a dependency. A
 * plan can only ever add terms, and every failure mode has to leave retrieval
 * behaving as it did before the planner existed.
 */

/** A question in Indonesian, which is the case the pattern extractor handles worst. */
const QUESTION = 'Kalau TAF WADD ada TEMPO apakah alternate masih boleh dipakai untuk pendaratan?';

type FetchCall = { url: string; init: RequestInit };

function recordingFetch(outcome: Response | (() => Promise<Response>)): { impl: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const impl = (async (url: unknown, init?: unknown) => {
		calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
		return typeof outcome === 'function' ? outcome() : outcome;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function completion(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

function requestBody(call: FetchCall): { model: string; messages: Array<{ role: string; content: string }>; stream: boolean } {
	return JSON.parse(String(call.init.body)) as { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };
}

describe('prompt composition', () => {
	it('carries the operator question and no corpus material', () => {
		const messages = composePlanPrompt(QUESTION);
		const whole = messages.map(message => message.content).join('\n');

		expect(whole).toContain('WADD');
		// Strings that exist verbatim in the CONFIDENTIAL corpus. Their absence is the
		// enforcement of the data-minimisation decision, not a stylistic preference.
		expect(whole).not.toContain('CONFIDENTIAL');
		expect(whole).not.toContain('IAA/FOP/M');
		expect(whole).not.toContain('Indonesia AirAsia');
		// A planner needs the question, never an excerpt or a section title.
		expect(whole.toLowerCase()).not.toContain('excerpt');
	});

	it('asks for the manual English vocabulary even when the question is Indonesian', () => {
		const system = composePlanPrompt(QUESTION)[0].content;
		expect(system).toContain('English terminology');
		expect(system).toContain('planning minima');
	});

	it('forbids inventing a clause number or a figure', () => {
		const system = composePlanPrompt(QUESTION)[0].content;
		expect(system).toContain('Never invent a clause number');
	});

	it('truncates an over-long question rather than sending it whole', () => {
		const messages = composePlanPrompt('x'.repeat(900));
		expect(messages[1].content.length).toBe(500);
	});
});

describe('term normalisation', () => {
	it('uppercases and strips punctuation a model might add', () => {
		expect(normaliseTerm('"planning minima",')).toBe('PLANNINGMINIMA');
		expect(normaliseTerm('RVR')).toBe('RVR');
	});

	it('keeps a dotted clause number whole', () => {
		expect(normaliseTerm('121.635')).toBe('121.635');
	});

	it('rejects terms that cannot discriminate', () => {
		expect(normaliseTerm('AB')).toBeNull();
		expect(normaliseTerm('')).toBeNull();
		expect(normaliseTerm('...')).toBeNull();
	});

	it('bounds a term by the platform LIKE pattern limit, not by preference', () => {
		// `%TERM%` must fit D1's 50-byte LIKE pattern ceiling, so 46 ASCII bytes is
		// the true maximum — a tighter bound would silently stop searching for a long
		// alphanumeric token the pattern extractor had already accepted.
		const atLimit = 'A'.repeat(MAX_TERM_CHARS);
		expect(normaliseTerm(atLimit)).toBe(atLimit);
		expect(`%${atLimit}%`.length).toBeLessThanOrEqual(50);
		expect(normaliseTerm('A'.repeat(MAX_TERM_CHARS + 1))).toBeNull();
	});

	it('splits phrases so the coverage score can reward both words', () => {
		expect(normaliseTerms(['PLANNING MINIMA'])).toEqual(['PLANNING', 'MINIMA']);
	});

	it('deduplicates and bounds the list', () => {
		const terms = normaliseTerms(['ALPHA', 'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA']);
		expect(new Set(terms).size).toBe(terms.length);
		expect(terms.length).toBe(MAX_PLAN_TERMS);
	});

	it('ignores a non-array payload', () => {
		expect(normaliseTerms('PLANNING MINIMA')).toEqual([]);
		expect(normaliseTerms(null)).toEqual([]);
	});
});

describe('plan parsing', () => {
	it('reads a JSON array of terms', () => {
		expect(extractPlanTerms({ choices: [{ message: { content: '["PLANNING MINIMA","HOLDING FUEL"]' } }] })).toEqual([
			'PLANNING',
			'MINIMA',
			'HOLDING',
			'FUEL'
		]);
	});

	it('reads a JSON object with a terms member', () => {
		expect(extractPlanTerms({ choices: [{ message: { content: '{"terms":["TEMPO","ALTERNATE"]}' } }] })).toEqual(['TEMPO', 'ALTERNATE']);
	});

	it('tolerates a markdown fence', () => {
		expect(extractPlanTerms({ choices: [{ message: { content: '```json\n["TEMPO"]\n```' } }] })).toEqual(['TEMPO']);
	});

	it('recovers an array wrapped in a sentence', () => {
		expect(extractPlanTerms({ choices: [{ message: { content: 'Here you go: ["TEMPO","RVR"]' } }] })).toEqual(['TEMPO', 'RVR']);
	});

	it('rejects prose rather than treating its words as terms', () => {
		// A term list polluted with function words is worse than no plan, so an
		// answer that is not machine-readable is a failure, not a best effort.
		expect(extractPlanTerms({ choices: [{ message: { content: 'You should search for planning minima and holding fuel.' } }] })).toBeNull();
	});

	it('rejects an empty array and a malformed body', () => {
		expect(extractPlanTerms({ choices: [{ message: { content: '[]' } }] })).toBeNull();
		expect(extractPlanTerms({ choices: [] })).toBeNull();
		expect(extractPlanTerms({})).toBeNull();
		expect(extractPlanTerms(null)).toBeNull();
		expect(extractPlanTerms({ choices: [{ message: { content: '   ' } }] })).toBeNull();
	});
});

describe('identifier lookups skip planning', () => {
	it('detects a dotted clause number', () => {
		expect(isIdentifierLookup('What does 121.635 require?')).toBe(true);
		expect(isIdentifierLookup('4.8.11.1')).toBe(true);
	});

	it('does not fire on an ordinary question', () => {
		expect(isIdentifierLookup(QUESTION)).toBe(false);
		expect(isIdentifierLookup('What is the holding fuel requirement?')).toBe(false);
	});
});

describe('planning mode', () => {
	it('plans an ordinary question', () => {
		expect(planningMode(QUESTION)).toBe('plan');
	});

	it('skips an exact clause lookup', () => {
		expect(planningMode('What does 121.635 require?')).toBe('identifier-lookup');
	});

	it('is switched off entirely by the flag, whatever the question', () => {
		// The recall gain is unmeasured and planning costs a model round-trip in front
		// of an operator-facing search box, so the whole feature has to be reversible
		// by configuration rather than by a redeploy.
		expect(planningMode(QUESTION, '1')).toBe('disabled');
		expect(planningMode(QUESTION, 'TRUE')).toBe('disabled');
		expect(planningMode(QUESTION, 'yes')).toBe('disabled');
		expect(planningMode('What does 121.635 require?', '1')).toBe('disabled');
	});

	it('treats an unset or unrecognised flag as enabled', () => {
		expect(planningMode(QUESTION, undefined)).toBe('plan');
		expect(planningMode(QUESTION, '')).toBe('plan');
		expect(planningMode(QUESTION, '0')).toBe('plan');
		expect(planningMode(QUESTION, 'false')).toBe('plan');
	});
});

describe('calling the provider', () => {
	it('fails cleanly when no API key is configured', async () => {
		const { impl, calls } = recordingFetch(completion('["TEMPO"]'));
		const result = await planQuery({ fetchImpl: impl }, QUESTION);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('no-api-key');
		expect(calls.length).toBe(0);
	});

	it('returns the terms on success', async () => {
		const { impl } = recordingFetch(completion('["PLANNING MINIMA","TEMPO"]'));
		const result = await planQuery({ apiKey: 'k', fetchImpl: impl }, QUESTION);
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.terms).toEqual(['PLANNING', 'MINIMA', 'TEMPO']);
	});

	it('sends the key as a bearer header and never in the request body', async () => {
		const { impl, calls } = recordingFetch(completion('["TEMPO"]'));
		await planQuery({ apiKey: 'secret-key', fetchImpl: impl }, QUESTION);
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get('Authorization')).toBe('Bearer secret-key');
		expect(String(calls[0].init.body)).not.toContain('secret-key');
	});

	it('sends a non-streaming chat completion', async () => {
		const { impl, calls } = recordingFetch(completion('["TEMPO"]'));
		await planQuery({ apiKey: 'k', model: 'some-model', fetchImpl: impl }, QUESTION);
		const body = requestBody(calls[0]);
		expect(body.stream).toBe(false);
		expect(body.model).toBe('some-model');
		expect(body.messages.length).toBe(2);
	});

	it('reports an HTTP failure without echoing the provider body', async () => {
		const { impl } = recordingFetch(new Response('upstream said: TEMPO at WADD', { status: 502 }));
		const result = await planQuery({ apiKey: 'k', fetchImpl: impl }, QUESTION);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('http-error');
		expect(result.ok === false && result.status).toBe(502);
		expect(JSON.stringify(result)).not.toContain('upstream said');
	});

	it('reports a malformed response rather than an empty plan', async () => {
		const { impl } = recordingFetch(completion('I could not find anything relevant.'));
		const result = await planQuery({ apiKey: 'k', fetchImpl: impl }, QUESTION);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('malformed-response');
	});

	it('reports a timeout when the request is aborted', async () => {
		const { impl } = recordingFetch(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		const result = await planQuery({ apiKey: 'k', fetchImpl: impl, timeoutMs: 5 }, QUESTION);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('timeout');
	});

	it('never throws when the network call fails', async () => {
		const { impl } = recordingFetch(() => Promise.reject(new Error('socket closed')));
		const result = await planQuery({ apiKey: 'k', fetchImpl: impl }, QUESTION);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('network-error');
	});
});

describe('retrieval integration', () => {
	it('leaves the token set untouched when no plan is supplied', () => {
		const pattern = queryTokens(QUESTION);
		expect(mergeTokens(pattern)).toEqual(pattern);
		expect(mergeTokens(pattern, [])).toEqual(pattern);
	});

	it('adds planned terms after the tokens the operator actually typed', () => {
		const merged = mergeTokens(queryTokens('explain 121.635'), ['PLANNING', 'MINIMA']);
		// The operator's own identifier outranks an inferred term, so planned terms
		// are appended rather than merged into the front of the list.
		expect(merged).toContain('121.635');
		expect(merged.indexOf('121.635')).toBeLessThan(merged.indexOf('PLANNING'));
		expect(merged).toContain('MINIMA');
	});

	it('keeps the merged set inside the bound the D1 parameter limit allows', () => {
		const many = Array.from({ length: 40 }, (_, index) => `TERM${index}`);
		const merged = mergeTokens(queryTokens(QUESTION), many);
		expect(merged.length).toBe(MAX_LEXICAL_TOKENS);
		// lexicalSearch binds each token three times plus the version and the limit.
		expect(merged.length * 3 + 2).toBeLessThanOrEqual(100);
		// commonTokens binds each token twice plus the version.
		expect(merged.length * 2 + 1).toBeLessThanOrEqual(100);
	});

	it('drops duplicates and terms too short to discriminate', () => {
		const merged = mergeTokens(['TEMPO'], ['tempo', 'AB', 'RVR']);
		expect(merged).toEqual(['TEMPO', 'RVR']);
	});
});
