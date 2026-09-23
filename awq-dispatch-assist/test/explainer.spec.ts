import { describe, expect, it } from 'vitest';
import { assessDispatch, type DispatchInput } from '../src/dispatch';
import {
	DEFAULT_DEEPSEEK_ENDPOINT,
	DEFAULT_DEEPSEEK_MODEL,
	composeExplainerPrompt,
	explainDispatch,
	extractNarrative,
	hashPrompt,
	type ExplainerInput
} from '../src/explainer';

/**
 * Explainer contract tests.
 *
 * Two properties matter more than the prose: the model is told the assessment
 * outcome is fixed, and clause text never reaches the provider. Both are asserted
 * here rather than left to the prompt text alone.
 */

const STA = new Date(Date.UTC(2026, 8, 21, 20, 0, 0));
const DOF = new Date(Date.UTC(2026, 8, 21));

/** A case with a destination TEMPO group and an unreviewed NOTAM check. */
function explainerInput(overrides: Partial<DispatchInput> = {}): ExplainerInput {
	const dispatchInput: DispatchInput = {
		dof: DOF,
		staZ: STA,
		diversionMinutes: 60,
		destinationTaf: 'TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020 TEMPO 2119/2122 3000 TSRA BKN010CB',
		alternateIcao: null,
		alternateTaf: null,
		destinationMinima: { approach: 'ILS RWY 25L', ceilingFt: 500, visibilityM: 1500, references: ['OM Part A 8.1.2.2.3'] },
		alternateLandingMinima: null,
		alternatePlanningMinima: null,
		selectedNotams: [],
		...overrides
	};
	const assessment = assessDispatch(dispatchInput);
	return {
		flightLabel: 'AWQ123',
		origin: 'WIII',
		destination: 'WADD',
		registration: 'PK-AXA',
		destinationAlternates: dispatchInput.alternateIcao ? [dispatchInput.alternateIcao] : [],
		outcome: assessment.outcome,
		windows: assessment.windows,
		diversionMinutes: dispatchInput.diversionMinutes,
		findings: assessment.findings,
		fuel: assessment.fuel,
		notamReviewed: assessment.notamReviewed
	};
}

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

describe('prompt composition', () => {
	it('states the assessment outcome is fixed and must be reproduced', () => {
		const messages = composeExplainerPrompt(explainerInput());
		const system = messages.find(message => message.role === 'system')!.content;
		expect(system).toMatch(/assessment outcome is FIXED/i);
		expect(system).toMatch(/Never upgrade or downgrade/i);
	});

	it('carries the engine outcome, the findings and their clause references', () => {
		const input = explainerInput();
		const prompt = composeExplainerPrompt(input).map(message => message.content).join('\n');
		expect(prompt).toContain(`Assessment outcome (fixed, reproduce exactly): ${input.outcome}`);
		for (const finding of input.findings) {
			expect(prompt).toContain(finding.code);
		}
		// Only clause identifiers travel, and every finding's own references must be
		// among them.
		for (const finding of input.findings) {
			for (const reference of finding.references) {
				expect(prompt).toContain(reference);
			}
		}
		expect(input.findings.length).toBeGreaterThan(0);
	});

	it('requests the three-section output structure', () => {
		const prompt = composeExplainerPrompt(explainerInput()).map(message => message.content).join('\n');
		expect(prompt).toContain('**1. ETA Windows & Operational Status**');
		expect(prompt).toContain('**2. Weather & Minima Evaluation**');
		expect(prompt).toContain('**3. Assessment Outcome & Fuel**');
	});

	it('marks the NOTAM review as pending when no NOTAM was selected', () => {
		const prompt = composeExplainerPrompt(explainerInput()).map(message => message.content).join('\n');
		expect(prompt).toContain('NOTAM REVIEW PENDING');
		expect(prompt).toContain('not a statement that NOTAM is clear');
	});

	it('states the 2-hour default diversion time when none is published', () => {
		const prompt = composeExplainerPrompt(explainerInput({ diversionMinutes: null })).map(message => message.content).join('\n');
		expect(prompt).toContain('2 hour default applied');
		expect(prompt).toContain('STA +1 hr to +3 hr');
	});

	it('renders the windows as unambiguous Zulu timestamps', () => {
		const prompt = composeExplainerPrompt(explainerInput()).map(message => message.content).join('\n');
		expect(prompt).toContain('211900Z - 212100Z');
		expect(prompt).toContain('212000Z - 212200Z');
	});

	it('never carries clause text or the manual footer, only identifiers', () => {
		const prompt = composeExplainerPrompt(explainerInput()).map(message => message.content).join('\n');
		// Strings that exist verbatim in the CONFIDENTIAL corpus. Their absence is the
		// data-minimisation decision, asserted rather than assumed.
		expect(prompt).not.toContain('PT Indonesia AirAsia');
		expect(prompt).not.toContain('Authority: Director of Flight Operations');
		expect(prompt).not.toContain('CONFIDENTIAL');
	});

	it('does not expose the engine-internal release flag', () => {
		// A live run turned the old `incompatible with release: no` line into "Not
		// incompatible with release", which reads as a release statement. The model is
		// not told about release at all beyond the instruction not to authorise one.
		const prompt = composeExplainerPrompt(explainerInput()).map(message => message.content).join('\n');
		expect(prompt).not.toContain('incompatible with release');
		expect(prompt).not.toContain('blocksRelease');
	});

	it('is deterministic for the same input', async () => {
		const input = explainerInput();
		expect(await hashPrompt(composeExplainerPrompt(input))).toBe(await hashPrompt(composeExplainerPrompt(input)));
	});

	it('changes the prompt hash when the outcome-bearing data changes', async () => {
		const base = await hashPrompt(composeExplainerPrompt(explainerInput()));
		const changed = await hashPrompt(
			composeExplainerPrompt(
				explainerInput({
					selectedNotams: [
						{
							id: 'A1234/26',
							location: 'WIII',
							message: 'A1234/26 NOTAMN A) WIII E) RWY 25L SERVICEABLE',
							validFrom: null,
							validTo: null,
							riskLevel: null,
							fetchedAt: '2026-09-21T18:00:00.000Z'
						}
					]
				})
			)
		);
		expect(changed).not.toBe(base);
	});
});

describe('response handling', () => {
	it('reads a well-formed completion', () => {
		expect(extractNarrative({ choices: [{ message: { content: 'report' } }] })).toBe('report');
	});

	it('rejects malformed or empty payloads instead of returning an empty narrative', () => {
		expect(extractNarrative(null)).toBeNull();
		expect(extractNarrative({})).toBeNull();
		expect(extractNarrative({ choices: [] })).toBeNull();
		expect(extractNarrative({ choices: [{ message: { content: '   ' } }] })).toBeNull();
		expect(extractNarrative({ choices: [{ message: {} }] })).toBeNull();
		expect(extractNarrative('not an object')).toBeNull();
	});
});

describe('calling the provider', () => {
	it('fails cleanly when no API key is configured', async () => {
		const result = await explainDispatch({}, explainerInput());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('no-api-key');
			expect(result.model).toBe(DEFAULT_DEEPSEEK_MODEL);
		}
	});

	it('returns the narrative, model and prompt hash on success', async () => {
		const { impl, calls } = recordingFetch(completion('the report'));
		const result = await explainDispatch({ apiKey: 'test-key', fetchImpl: impl }, explainerInput());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.narrative).toBe('the report');
			expect(result.model).toBe(DEFAULT_DEEPSEEK_MODEL);
			expect(result.promptHash).toMatch(/^[A-Za-z0-9_-]+$/);
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(DEFAULT_DEEPSEEK_ENDPOINT);
	});

	it('sends the key as a bearer header and never in the request body', async () => {
		const { impl, calls } = recordingFetch(completion('ok'));
		await explainDispatch({ apiKey: 'secret-value', fetchImpl: impl }, explainerInput());
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer secret-value');
		expect(String(calls[0]!.init.body)).not.toContain('secret-value');
	});

	it('sends a non-streaming chat completion for the configured model', async () => {
		const { impl, calls } = recordingFetch(completion('ok'));
		await explainDispatch({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl: impl }, explainerInput());
		const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; stream: boolean; messages: unknown[] };
		expect(body.model).toBe('deepseek-v4-pro');
		expect(body.stream).toBe(false);
		expect(body.messages).toHaveLength(2);
	});

	it('reports an HTTP failure without echoing the provider body', async () => {
		const { impl } = recordingFetch(new Response('{"error":"insufficient balance for key sk-abc"}', { status: 402 }));
		const result = await explainDispatch({ apiKey: 'k', fetchImpl: impl }, explainerInput());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('http-error');
			expect(result.status).toBe(402);
			expect(JSON.stringify(result)).not.toContain('sk-abc');
		}
	});

	it('reports a malformed response rather than an empty narrative', async () => {
		const { impl } = recordingFetch(new Response('{"choices":[]}', { status: 200 }));
		const result = await explainDispatch({ apiKey: 'k', fetchImpl: impl }, explainerInput());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('malformed-response');
	});

	it('reports a timeout when the request is aborted', async () => {
		const aborting = (async () => {
			const error = new Error('aborted');
			error.name = 'AbortError';
			throw error;
		}) as unknown as typeof fetch;
		const result = await explainDispatch({ apiKey: 'k', fetchImpl: aborting }, explainerInput());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('timeout');
	});

	it('never throws when the network call fails', async () => {
		const failing = (async () => {
			throw new Error('connection reset');
		}) as unknown as typeof fetch;
		const result = await explainDispatch({ apiKey: 'k', fetchImpl: failing }, explainerInput());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('network-error');
	});
});
