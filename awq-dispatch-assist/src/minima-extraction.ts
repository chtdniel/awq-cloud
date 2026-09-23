/**
 * AI extraction of approach minima from an AIP chart PDF.
 *
 * Why the PDF, and only the PDF
 *   PRD §5 makes the AIP chart PDF in R2 the single source file for minima, and
 *   forbids a Markdown sidecar. The PDF is therefore read as-is from R2, converted
 *   to text by Workers AI markdown conversion, and the values are proposed by the
 *   DeepSeek gateway. Nothing this module produces is usable by an assessment: it
 *   only ever writes `draft` rows, and an ADMIN dispatcher has to compare each one
 *   against the chart and approve it (PRD acceptance §29).
 *
 * Why the conversion text is not a source of truth
 *   Flattening a chart to text loses table structure, so a column boundary can
 *   disappear. That is exactly why the numeric values are verified against the
 *   PDF by a human and then stored as structured records, and why a value the
 *   model cannot read must be reported as unreadable rather than inferred.
 *
 * The extractor is instructed to return `null` for anything it cannot read, and
 * the prompt repeats that a plausible guess is a failure. Nulls survive into the
 * draft and are shown to the reviewer as values that still have to be read off
 * the chart.
 */

import type { MinimaDraftInput } from './minima-registry';

/** A chart PDF larger than this is not converted, to keep the request bounded. */
export const MAX_CHART_BYTES = 8 * 1024 * 1024;

/** Ceiling on converted text handed to the model, in characters. */
const MAX_MARKDOWN_CHARS = 120_000;

/** Reasoning and output budget for one chart. */
const EXTRACTION_TIMEOUT_MS = 60_000;

export type ChartSource = {
	objectKey: string;
	icao: string;
	fileName: string;
	bytes: Uint8Array;
	pdfHash: string;
};

export type ExtractionOutcome =
	| { ok: true; objectKey: string; icao: string; markdownChars: number; drafts: MinimaDraftInput[] }
	| { ok: false; objectKey: string; icao: string; reason: string };

/**
 * The system instruction.
 *
 * It carries no corpus text: the only content it receives is the converted chart.
 * The chart is public aeronautical publication data, so it is not subject to the
 * manual-confidentiality rule that governs the explainer, but the same
 * data-minimisation discipline is kept.
 *
 * Why every entry must quote its source fragment
 *   Converting a chart to text flattens its table, so a value can end up next to
 *   the wrong row label. Measured against the real YPPH charts, three different
 *   models produced three different, mutually contradictory readings of the same
 *   RVR note, and each one looked plausible. Asking for the exact fragment does
 *   not remove the ambiguity, but it makes it visible: a reviewer can check the
 *   quoted text against the chart in seconds, and a model that cannot find a
 *   fragment is instructed to report the ambiguity rather than pick a row. That
 *   is what keeps the human approval step meaningful instead of ceremonial.
 */
export const EXTRACTION_SYSTEM_PROMPT = [
	'You transcribe landing minima from an aeronautical approach chart into structured data.',
	'',
	'Hard rules:',
	'- Report only values that are readable in the supplied chart text. If a value cannot be read or is absent, return null for it. Never estimate, interpolate or carry a value over from a similar approach.',
	'- Never invent a chart identifier, a runway, an approach type, a page number, an AIP cycle or an effective date. Use null when the chart text does not state it.',
	'- A null ceiling or visibility is a correct and expected answer. A guessed number is a failure.',
	'- Read values in the units the chart prints. Ceiling and decision height are feet. Visibility and RVR are metres.',
	'- For each approach on the chart, emit one landing entry for every aircraft category column the chart prints, and one alternate entry for every category column of the chart\'s published alternate minima. Omit the alternate entry when the chart publishes no alternate minima.',
	'- For every entry, copy the exact fragment of the supplied text the value came from into "sourceText". A number that does not appear in its own "sourceText" is a transcription error.',
	'- When the flattened text makes a value ambiguous - it could belong to more than one row or category - write "ambiguous:" followed by the competing fragments in "sourceText", and set that entry\'s confidence to "low". Never resolve an ambiguity by choosing the most likely row.',
	'- Set "confidence" to "low" whenever the table structure in the supplied text is ambiguous, and say what was ambiguous in "notes".',
	'',
	'Return a single JSON object and nothing else, in exactly this shape:',
	'{',
	'  "aisAuthority": "string, for example Airservices Australia",',
	'  "country": "string, for example Australia",',
	'  "icao": "string, four letters",',
	'  "chartIdentifier": "string, for example ILS-Z RWY 21",',
	'  "chartPage": "string or null",',
	'  "aipCycle": "string or null",',
	'  "effectiveFrom": "ISO date string or null",',
	'  "effectiveTo": "ISO date string or null",',
	'  "approaches": [',
	'    {',
	'      "approach": "string, for example ILS-Z or LOC-Z",',
	'      "approachType": "string, for example CAT I, CAT II/III, Non-precision or Circling",',
	'      "runway": "string or null, for example 21",',
	'      "landing": [',
	'        { "aircraftCategory": "A", "ceilingFt": 200, "visibilityM": 800, "valueType": "DA/H with RVR or null", "sourceText": "the exact fragment the values came from" }',
	'      ],',
	'      "alternate": [',
	'        { "aircraftCategory": "A", "ceilingFt": 400, "visibilityM": 1500, "valueType": "DA/H with RVR or null", "sourceText": "the exact fragment the values came from" }',
	'      ],',
	'      "confidence": "high"',
	'    }',
	'  ],',
	'  "notes": "string or null, what could not be read"',
	'}'
].join('\n');

/** Pull a JSON object out of a model response, tolerating a fenced block. */
export function parseJsonObject(content: string): unknown {
	const text = String(content ?? '').trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const candidate = (fenced ? fenced[1] : text).trim();
	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf('{');
		const end = candidate.lastIndexOf('}');
		if (start === -1 || end <= start) return null;
		try {
			return JSON.parse(candidate.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

function text(value: unknown): string | null {
	const raw = value === null || value === undefined ? '' : String(value).trim();
	return raw ? raw : null;
}

function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function confidenceOf(value: unknown): 'high' | 'medium' | 'low' {
	const raw = String(value ?? '').trim().toLowerCase();
	return raw === 'high' || raw === 'medium' ? raw : 'low';
}

/**
 * Convert the model's JSON into draft rows.
 *
 * The shape is validated field by field rather than trusted, because a model
 * response is untrusted input: a malformed entry must produce a visible gap, not
 * a fabricated record.
 */
export function toDraftRows(payload: unknown, objectKey: string, fallbackIcao: string): MinimaDraftInput[] {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
	const root = payload as Record<string, unknown>;
	const icao = (text(root.icao) || fallbackIcao).toUpperCase().slice(0, 4);
	if (!/^[A-Z]{4}$/.test(icao)) return [];

	const shared = {
		aisAuthority: text(root.aisAuthority) || 'AIS authority not stated on the chart',
		country: text(root.country) || 'not stated',
		icao,
		chartIdentifier: text(root.chartIdentifier) || objectKey.split('/').pop() || 'chart',
		chartPage: text(root.chartPage),
		aipCycle: text(root.aipCycle),
		effectiveFrom: text(root.effectiveFrom),
		effectiveTo: text(root.effectiveTo)
	};

	const approaches = Array.isArray(root.approaches) ? root.approaches : [];
	const rows: MinimaDraftInput[] = [];
	const notes = text(root.notes);

	for (const entry of approaches) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const approach = entry as Record<string, unknown>;
		const approachLabel = text(approach.approach) || shared.chartIdentifier;
		const approachType = text(approach.approachType);
		const runway = text(approach.runway);
		const confidence = confidenceOf(approach.confidence);

		const emit = (kind: 'landing' | 'alternate', list: unknown): void => {
			if (!Array.isArray(list) || !list.length) return;
			for (const value of list) {
				if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
				const row = value as Record<string, unknown>;
				const ceilingFt = numberOrNull(row.ceilingFt);
				const visibilityM = numberOrNull(row.visibilityM);
				rows.push({
					...shared,
					runway,
					approach: approachLabel,
					approachType,
					aircraftCategory: text(row.aircraftCategory),
					kind,
					ceilingFt,
					visibilityM,
					valueType: text(row.valueType),
					sourceText: text(row.sourceText),
					confidence: ceilingFt === null || visibilityM === null ? 'low' : confidence,
					notes:
						ceilingFt === null || visibilityM === null
							? [notes, `A value for ${kind} category ${text(row.aircraftCategory) ?? 'unstated'} could not be read from the chart; read it from the PDF before approving.`]
									.filter(Boolean)
									.join(' ')
							: notes
				});
			}
		};

		emit('landing', approach.landing);
		emit('alternate', approach.alternate);
	}

	return rows;
}

export type ExtractChartOptions = {
	apiKey: string;
	model: string;
	/** Workers AI markdown conversion, injected so tests never reach the network. */
	toMarkdown: (source: { objectKey: string; fileName: string; bytes: Uint8Array }) => Promise<string>;
	fetchImpl?: typeof fetch;
	endpoint?: string;
	timeoutMs?: number;
};

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * Extract draft minima from one chart.
 *
 * Never throws: a conversion failure, a missing key, an HTTP error, a timeout or
 * an unparseable body each produce an `ok: false` outcome with a machine-readable
 * reason, so a partial batch can still store what did work.
 */
export async function extractChart(
	source: ChartSource,
	options: ExtractChartOptions
): Promise<ExtractionOutcome> {
	const base = { objectKey: source.objectKey, icao: source.icao };
	const apiKey = String(options.apiKey ?? '').trim();
	if (!apiKey) return { ...base, ok: false, reason: 'no-api-key' };

	let markdown = '';
	try {
		markdown = await options.toMarkdown({ objectKey: source.objectKey, fileName: source.fileName, bytes: source.bytes });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'conversion failed';
		return { ...base, ok: false, reason: `markdown-conversion-failed: ${message.slice(0, 200)}` };
	}
	const trimmed = String(markdown ?? '').trim();
	if (!trimmed) return { ...base, ok: false, reason: 'markdown-conversion-empty' };

	const call = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? EXTRACTION_TIMEOUT_MS);

	try {
		const response = await call(options.endpoint ?? DEFAULT_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: options.model,
				messages: [
					{ role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
					{
						role: 'user',
						content: `Chart file: ${source.fileName}\nICAO from the object key: ${source.icao}\n\nConverted chart text follows.\n\n${trimmed.slice(0, MAX_MARKDOWN_CHARS)}`
					}
				],
				stream: false,
				temperature: 0
			}),
			signal: controller.signal
		});

		if (!response.ok) {
			// The provider body is not read: it can quote request content, and this
			// reason string reaches an operator-facing response.
			return { ...base, ok: false, reason: `http-error-${response.status}` };
		}

		const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
		const content = payload?.choices?.[0]?.message?.content;
		if (typeof content !== 'string') return { ...base, ok: false, reason: 'malformed-response' };

		const parsed = parseJsonObject(content);
		if (!parsed) return { ...base, ok: false, reason: 'unparseable-json' };

		const drafts = toDraftRows(parsed, source.objectKey, source.icao);
		if (!drafts.length) return { ...base, ok: false, reason: 'no-approaches-found' };

		return { ...base, ok: true, markdownChars: trimmed.length, drafts };
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return { ...base, ok: false, reason: aborted ? 'timeout' : 'network-error' };
	} finally {
		clearTimeout(timer);
	}
}
