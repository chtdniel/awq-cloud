/**
 * Dispatch explanation layer.
 *
 * Boundary: the model explains, it does not decide
 *   The verdict, the ETA windows and the fuel requirement are produced by the
 *   deterministic engine in src/dispatch.ts. This module hands those results to a
 *   language model and asks it to write them up. The prompt states that the
 *   verdict is fixed and must be reproduced exactly, and nothing this module
 *   returns can alter it — which is what keeps a model outage, or a model
 *   mistake, from changing a release decision (DESIGN.md §10). When the call
 *   fails the deterministic assessment still stands on its own; the explanation
 *   degrades, the decision does not.
 *
 * Data minimisation
 *   The IAA manuals in the reference corpus are marked CONFIDENTIAL and are the
 *   property of PT Indonesia AirAsia (DESIGN.md §9), so clause text is
 *   deliberately NOT part of `ExplainerInput` and never leaves the Worker. What
 *   is sent is what the deterministic engine already computed: the findings,
 *   their evidence (operational weather values) and clause *identifiers* such as
 *   `OM Part A 8.1.2`. The application displays the excerpt from D1 alongside
 *   the identifier, so the reader still sees the source without the corpus being
 *   transmitted to a third party.
 *
 * Provider
 *   DeepSeek's API is OpenAI-compatible, so the request is a plain chat
 *   completion. The endpoint and model are configuration, not constants baked
 *   into call sites, so switching provider is a configuration change.
 *
 * Auditability
 *   Each call returns the model name and a hash of the exact prompt, so a
 *   recommendation can be reproduced and audited after the fact, as DESIGN.md
 *   §10 requires.
 */

import type { DispatchFinding, DispatchVerdict, EtaWindows, FuelRequirement } from './dispatch';

export type ExplainerRole = 'system' | 'user';

export type ExplainerMessage = {
	role: ExplainerRole;
	content: string;
};

/**
 * Everything the model is allowed to see.
 *
 * There is intentionally no field for clause text, corpus excerpts or manual
 * content. Adding one would breach the data-minimisation decision that governs
 * this module, so the omission is the enforcement, not an oversight.
 */
export type ExplainerInput = {
	flightLabel: string;
	origin: string | null;
	destination: string | null;
	registration: string | null;
	destinationAlternates: readonly string[];
	/** Fixed by the deterministic engine. The model must reproduce it verbatim. */
	verdict: DispatchVerdict;
	windows: EtaWindows | null;
	diversionMinutes: number | null;
	findings: readonly DispatchFinding[];
	fuel: FuelRequirement;
	/** False when no NOTAM or remarks were supplied, so the check is unevaluated. */
	notamEvaluated: boolean;
};

export type ExplainerSuccess = {
	ok: true;
	narrative: string;
	model: string;
	/** SHA-256 of the exact prompt, for the audit trail. */
	promptHash: string;
};

export type ExplainerFailure = {
	ok: false;
	model: string;
	/** Short machine-readable reason. Never carries provider response text. */
	reason: 'no-api-key' | 'http-error' | 'malformed-response' | 'timeout' | 'network-error';
	status?: number;
};

export type ExplainerResult = ExplainerSuccess | ExplainerFailure;

export type ExplainerConfig = {
	/** Bearer credential. Read from a Wrangler secret, never from source. */
	apiKey?: string;
	model?: string;
	endpoint?: string;
	timeoutMs?: number;
	/** Injected in tests so the suite never reaches the network. */
	fetchImpl?: typeof fetch;
};

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
export const DEFAULT_DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Ceiling on stored narrative, so a runaway response cannot bloat a snapshot. */
const MAX_NARRATIVE_CHARS = 20_000;

/**
 * Zulu timestamp as `DDHHMMZ`.
 *
 * The workflow document shows `HHMMZ`, but a diversion window routinely crosses
 * midnight, where a bare hour is ambiguous. Including the day keeps the window
 * readable without the reader having to infer the date.
 */
function zulu(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z`;
}

function windowLine(label: string, window: { from: Date; to: Date } | null): string {
	if (!window) return `${label}: not available`;
	return `${label}: ${zulu(window.from)} - ${zulu(window.to)}`;
}

/**
 * The instruction given to the model.
 *
 * Kept as a separate exported function so the exact text is testable and so the
 * audit hash covers what is actually sent.
 */
export function composeExplainerPrompt(input: ExplainerInput): ExplainerMessage[] {
	const system = [
		'You are a flight dispatch analyst assistant. You write up an operational assessment that has already been decided by a deterministic rules engine.',
		'',
		'Hard rules:',
		'- The verdict is FIXED by the engine. Reproduce it exactly. Never upgrade or downgrade it, and never introduce a GO the engine did not return.',
		'- Cite only the clause identifiers given to you. Never quote or paraphrase clause text, and never invent a clause number, a document name, or a value.',
		'- If something is missing, state that it is missing. Do not fill a gap with a plausible figure.',
		'- Use the ICAO identifiers, dates and Zulu times exactly as given.',
		'- Never describe the assessment as authorising a flight. A flight operations officer retains release authority.',
		'',
		'Write the assessment in exactly this structure:',
		'**1. ETA Windows & Operational Status**',
		'- **Destination ([ICAO]):** ETA window | operational status',
		'- **Primary Alternate ([ICAO]):** ETA window | approach/operational status',
		'- **Secondary Alternate ([ICAO], if provided):** ETA window | status',
		'**2. Weather & Minima Evaluation**',
		'- **Destination ([ICAO]):** prevailing and conditional weather inside the window | landing minima compliance vs alternate planning criteria',
		'- **Primary Alternate ([ICAO]):** weather assessment vs alternate planning criteria',
		'**3. Dispatch Recommendations & Verdict**',
		'- **Feasibility:** the engine verdict, per the cited rules',
		'- **Legal Fuel Requirement:** the required holding fuel, or the alternate selection that satisfies it',
		'- **Advisory Fuel Padding:** the recommended discretionary padding and its rationale',
		'- **Alternate Recommendation:** confirm the primary alternate, or nominate an alternative if it fails criteria',
		'',
		'Every statement in section 3 must name the clause identifier(s) it rests on.'
	].join('\n');

	const lines: string[] = [
		`Flight: ${input.flightLabel}`,
		`Route: ${input.origin ?? 'unknown'} to ${input.destination ?? 'unknown'}`,
		`Registration: ${input.registration ?? 'unknown'}`,
		`Nominated destination alternates: ${input.destinationAlternates.length ? input.destinationAlternates.join(', ') : 'none'}`,
		`Estimated diversion time: ${input.diversionMinutes === null ? 'not specified (60 min assumed)' : `${input.diversionMinutes} min`}`,
		`Verdict (fixed, reproduce exactly): ${input.verdict}`,
		`NOTAM/remarks evaluated: ${input.notamEvaluated ? 'yes' : 'no - the check is unevaluated'}`,
		'',
		'ETA windows (Zulu):',
		windowLine('  destination', input.windows?.destination ?? null),
		windowLine('  primary alternate', input.windows?.primaryAlternate ?? null),
		'',
		`Findings (${input.findings.length}), highest severity first:`
	];

	if (!input.findings.length) {
		lines.push('  none');
	}
	for (const finding of input.findings) {
		lines.push(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
		lines.push(`    evidence: ${finding.evidence}`);
		lines.push(`    references: ${finding.references.length ? finding.references.join(', ') : 'none'}`);
		// `blocksRelease` is deliberately NOT sent. It is engine-internal bookkeeping,
		// and exposing it invited the model to editorialise — a live run produced
		// "Not incompatible with release", which reads as a release statement. The
		// verdict already summarises the outcome, and the boundary is that the model
		// never discusses release at all.
	}

	lines.push('');
	lines.push('Fuel:');
	lines.push(`  mandatory additional holding: ${input.fuel.mandatoryHoldingMinutes} min (${input.fuel.basis})`);
	lines.push(`  rationale: ${input.fuel.rationale}`);
	lines.push(`  references: ${input.fuel.references.length ? input.fuel.references.join(', ') : 'none'}`);
	lines.push(
		`  advisory padding: ${input.fuel.advisoryPaddingMinutes} min${input.fuel.advisoryRationale ? ` (${input.fuel.advisoryRationale})` : ''}`
	);

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: lines.join('\n') }
	];
}

/** SHA-256 of the prompt, base64url. Used as the audit key for a recommendation. */
export async function hashPrompt(messages: readonly ExplainerMessage[]): Promise<string> {
	const text = messages.map(message => `${message.role}\n${message.content}`).join('\n---\n');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let binary = '';
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Pull the narrative out of an OpenAI-compatible response.
 *
 * The provider response is untrusted: a shape change must produce a visible
 * failure rather than an empty narrative that looks like a successful run.
 */
export function extractNarrative(payload: unknown): string | null {
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
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_NARRATIVE_CHARS);
}

/**
 * Ask the model to write up a deterministic assessment.
 *
 * Never throws: every failure becomes an `ok: false` result, because the caller
 * is rendering an assessment that must survive an AI outage.
 */
export async function explainDispatch(config: ExplainerConfig, input: ExplainerInput): Promise<ExplainerResult> {
	const model = config.model ?? DEFAULT_DEEPSEEK_MODEL;
	const apiKey = String(config.apiKey ?? '').trim();
	if (!apiKey) return { ok: false, model, reason: 'no-api-key' };

	const messages = composeExplainerPrompt(input);
	const promptHash = await hashPrompt(messages);
	const call = config.fetchImpl ?? fetch;
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
			// request content, and this text can end up in an operator-facing log.
			return { ok: false, model, reason: 'http-error', status: response.status };
		}

		const payload = await response.json().catch(() => null);
		const narrative = extractNarrative(payload);
		if (!narrative) return { ok: false, model, reason: 'malformed-response' };

		return { ok: true, model, narrative, promptHash };
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return { ok: false, model, reason: aborted ? 'timeout' : 'network-error' };
	} finally {
		clearTimeout(timer);
	}
}
