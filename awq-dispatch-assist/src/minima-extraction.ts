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

/**
 * How many charts one extraction request may carry.
 *
 * One. Measured against the real charts, a single chart costs a Workers AI markdown
 * conversion plus a model call, and the conversion alone was observed ranging from
 * under two seconds to two minutes depending on whether the document had been
 * converted before. A batch of three therefore cannot be given a useful timeout:
 * the request would either abort a chart that was still converting, or hold the
 * client for minutes. The caller iterates, so each chart gets its own budget and one
 * slow chart cannot fail the others.
 */
export const MAX_CHARTS_PER_REQUEST = 1;

/**
 * Budget for one chart, in milliseconds.
 *
 * Set from measurement rather than taste: the slowest observed end-to-end run was
 * 120 seconds for a cold conversion, and the request has to survive that without
 * being killed by the platform. A timeout here is reported as `timeout` so the
 * caller can retry the same chart, and retrying is cheap once the conversion has
 * been cached.
 */
export const EXTRACTION_TIMEOUT_MS = 120_000;

/** Ceiling on converted text handed to the model, in characters. */
const MAX_MARKDOWN_CHARS = 120_000;

export type ChartSource = {
	objectKey: string;
	icao: string;
	fileName: string;
	bytes: Uint8Array;
	pdfHash: string;
};

export type ExtractionOutcome =
	| { ok: true; objectKey: string; icao: string; markdownChars: number; drafts: MinimaDraftInput[]; rawModelResponse: string }
	| { ok: false; objectKey: string; icao: string; reason: string; rawModelResponse?: string };

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
	'Reading the minima line:',
	'- An approach minima line commonly prints a height in feet followed by a parenthesised group that contains the visibility in metres, for example `560 (502-1.9)`, `430 (372-1.2)` or `1873 (1193-4.4)`. In that form the first number is the decision height or minimum descent height in FEET (ceilingFt) and the number before the hyphen inside the parentheses is the visibility in METRES (visibilityM). The number after the hyphen is a distance in nautical miles and is not a minima value.',
	'- So `560 (502-1.9)` means ceilingFt 560 and visibilityM 502. Report both rather than reporting only the height and leaving the visibility null.',
	'- This is a reading rule, not an inference: the values are printed, and you are being told how the chart formats them. It does not license estimating a value that is genuinely absent, and it does not apply when the parenthesised number cannot be found in "sourceText".',
	'- Where a row prints only a height with no parenthesised group, leave visibilityM null and set confidence to "low". Where a row prints only an RVR, for example `75RVR` or `350/400RVR`, report visibilityM from the RVR figure and leave ceilingFt null.',
	'',
	'Visibility units:',
	'- Charts differ in the unit they print. Report the number exactly as it appears in "visibilityM", and report the unit the chart uses in "visibilityUnit" as either "m" or "km".',
	'- A LIDO chart prints the visibility in KILOMETRES as a decimal, for example `ft610 - 3.4` or `ft280 - 1.5`, where 3.4 means 3.4 km. Report visibilityM as 3.4 and visibilityUnit as "km" — do NOT convert it and do NOT report it as 3.4 metres.',
	'- An Australian AIP chart prints the visibility in METRES, for example `560 (502-1.9)`, where 502 means 502 m. Report visibilityM as 502 and visibilityUnit as "m".',
	'- When the unit cannot be determined from the text, report visibilityUnit as null and say so in "notes". The value is converted from the unit by the application, not by you.',
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
	'        { "aircraftCategory": "A", "ceilingFt": 200, "visibilityM": 800, "visibilityUnit": "m", "valueType": "DA/H with RVR or null", "sourceText": "the exact fragment the values came from" }',
	'      ],',
	'      "alternate": [',
	'        { "aircraftCategory": "A", "ceilingFt": 400, "visibilityM": 1500, "visibilityUnit": "m", "valueType": "DA/H with RVR or null", "sourceText": "the exact fragment the values came from" }',
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

/**
 * A chart number kept unrounded.
 *
 * Separate from `numberOrNull` because rounding a value before its unit is known
 * destroys the information that identifies the unit. A LIDO chart prints visibility in
 * kilometres as `2.2`; rounding it to `2` first turned 2.2 km into 2000 m instead of
 * 2200 m. Measured on the real YPKG chart, that is the bug this function exists to
 * prevent: rounding now happens once, on the final value, in the unit the registry
 * stores.
 */
function numberUnroundedOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Visibility in metres, from a chart that may print kilometres.
 *
 * Why this is a code step and not a prompt instruction
 *   LIDO approach charts print the visibility in kilometres with a decimal —
 *   `610 - 3.4`, `280 - 1.5`, `960 - 5.0` — while the registry stores metres and the
 *   engine compares against a metre minima. Measured on the real YPKG chart, the model
 *   reported `3.4` as **3 metres**: a wrong value by a factor of 1000, in the
 *   direction that removes an operational restriction. Asking a model to do arithmetic
 *   is how that happens, so the conversion is done here, deterministically, and the
 *   original chart value travels with the record so a reviewer can see what was
 *   converted.
 *
 * How the unit is recognised
 *   `unit` from the model is honoured when it states one. Otherwise a value below
 *   `KILOMETRE_CEILING` that carries a decimal is read as kilometres: no chart prints
 *   a visibility minima of 3.4 metres, and every chart that prints kilometres uses a
 *   decimal. A whole number under the ceiling is left alone, because `800` is metres
 *   on every chart measured and `3` would have to be kilometres to be a minima at all —
 *   which is precisely the ambiguity this function refuses to resolve silently: it
 *   reports the conversion, and the record's source fragment still shows the chart.
 */
const KILOMETRE_CEILING = 100;

/**
 * A visibility printed in kilometres, recovered from a fragment when the model did not
 * state a unit.
 *
 * Why this is only a fallback
 *   The reliable source for the unit is the model's `visibilityUnit`, because only the
 *   model reads the chart. Guessing from formatting was tried first and does not hold
 *   up: anchoring on the number after `ft` matches the **height** (`ft960 - 5.0` matches
 *   `960`), and anchoring on a bracket boundary matches an AIP fragment's **nautical
 *   mile** figure (`560 (502-1.9)` matches `1.9`). Conversion of the wrong number
 *   produces a confident, badly wrong minima, which is worse than leaving it for review.
 *
 *   So one shape is recognised and nothing else: a decimal that is the **last** number
 *   in the fragment and is not inside brackets. Measured LIDO fragments are
 *   `ft610 - 3.4V1810` (the visibility is followed only by a fix name) and
 *   `ft610 - 3.4`; the AIP fragments that must not convert are `560 (502-1.9)` and
 *   `1373-4.0`, where the decimal is bracketed or follows a height with no separator.
 */
function kilometresFromText(raw: string): number | null {
	// Deciminals inside brackets are distances, not the visibility.
	const withoutBrackets = raw.replace(/\([^)]*\)/g, ' ');
	const matches = [...withoutBrackets.matchAll(/(\d+\.\d+)/g)];
	if (!matches.length) return null;
	const last = matches[matches.length - 1];
	const value = Number(last[1]);
	// A single decimal in the fragment is read as the visibility; with more than one the
	// text is too ambiguous to decide, and the record is left for review instead.
	if (matches.length > 1) return null;
	if (!Number.isFinite(value) || value <= 0 || value >= KILOMETRE_CEILING) return null;
	return value;
}

export function visibilityMetresFromChart(value: number | null, unit: unknown, raw: unknown): { metres: number | null; convertedFrom: string | null } {
	const stated = String(unit ?? '').trim().toLowerCase();
	const rawText = String(raw ?? '').trim();

	// A stated unit settles it: the chart says which unit it is, so nothing is inferred.
	if (/^(m|metre|meter|mtr)$/.test(stated)) return { metres: value, convertedFrom: null };
	if (/^(km|kilomet|kilometer)/.test(stated)) {
		if (value === null) return { metres: null, convertedFrom: null };
		return { metres: Math.round(value * 1000), convertedFrom: rawText || `${value} km` };
	}

	// No stated unit: only a fragment with exactly one unbracketed decimal is converted,
	// and only when the parsed value is small enough to be a kilometre reading. A value
	// at or above the ceiling is metres on every chart measured (`1373-4.0` is 1373 m),
	// so a decimal in its fragment is not the visibility.
	const parsedIsSmallOrAbsent = value === null || (value > 0 && value < KILOMETRE_CEILING);
	if (parsedIsSmallOrAbsent) {
		const kilometres = kilometresFromText(rawText);
		if (kilometres !== null) return { metres: Math.round(kilometres * 1000), convertedFrom: rawText };
	}

	if (value === null) return { metres: null, convertedFrom: null };
	// A parsed value that is itself fractional and small is a kilometre reading even when
	// the fragment is unhelpful.
	if (value > 0 && value < KILOMETRE_CEILING && !Number.isInteger(value)) {
		return { metres: Math.round(value * 1000), convertedFrom: rawText || String(value) };
	}
	return { metres: value, convertedFrom: null };
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
				// The visibility is converted deterministically rather than trusted from the
				// model, because a chart printed in kilometres reported as metres is wrong by
				// a factor of 1000 and in the direction that removes an operational limit.
				const visibility = visibilityMetresFromChart(numberUnroundedOrNull(row.visibilityM), row.visibilityUnit, row.visibilityRaw ?? row.sourceText);
				const visibilityM = visibility.metres;
				const sourceText = text(row.sourceText);
				// A conversion is stated on the record, so the reviewer sees both the chart's
				// own figure and the value the engine will compare against.
				const conversionNote = visibility.convertedFrom
					? `Visibility was printed as ${visibility.convertedFrom} and converted to ${visibilityM} m; confirm the printed figure against the chart.`
					: null;
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
					sourceText,
					confidence: ceilingFt === null || visibilityM === null ? 'low' : confidence,
					notes: [
						notes,
						conversionNote,
						ceilingFt === null || visibilityM === null
							? `A value for ${kind} category ${text(row.aircraftCategory) ?? 'unstated'} could not be read from the chart; read it from the PDF before approving.`
							: null
					]
						.filter(Boolean)
						.join(' ')
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
		if (!parsed) return { ...base, ok: false, reason: 'unparseable-json', rawModelResponse: content.slice(0, 2000) };

		const drafts = toDraftRows(parsed, source.objectKey, source.icao);
		if (!drafts.length) return { ...base, ok: false, reason: 'no-approaches-found' };

		return { ...base, ok: true, markdownChars: trimmed.length, drafts, rawModelResponse: content.slice(0, 20000) };
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return { ...base, ok: false, reason: aborted ? 'timeout' : 'network-error' };
	} finally {
		clearTimeout(timer);
	}
}
