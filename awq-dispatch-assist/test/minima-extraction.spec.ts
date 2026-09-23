import { describe, expect, it } from 'vitest';
import {
	MAX_CHART_BYTES,
	EXTRACTION_SYSTEM_PROMPT,
	extractChart,
	parseJsonObject,
	toDraftRows,
	type ChartSource,
	type ExtractChartOptions
} from '../src/minima-extraction';
import { MINIMA_STATUSES } from './helpers/minima-values';

/**
 * Minima extraction contract tests.
 *
 * The bounds worth defending:
 *   - a chart the model cannot read produces nulls, never a guess,
 *   - a draft is only ever a draft: extraction cannot produce an approved value,
 *   - a conversion or provider failure is reported, not swallowed,
 *   - the configured API key is only ever sent as an Authorization header.
 */

const CHART_JSON = JSON.stringify({
	aisAuthority: 'Airservices Australia',
	country: 'Australia',
	icao: 'YPPH',
	chartIdentifier: 'ILS-Z RWY 21',
	chartPage: '2',
	aipCycle: 'AIRAC 2601',
	effectiveFrom: '2026-01-22',
	effectiveTo: null,
	approaches: [
		{
			approach: 'ILS-Z',
			approachType: 'CAT I',
			runway: '21',
			landing: [
				{ aircraftCategory: 'A', ceilingFt: 200, visibilityM: 800, valueType: 'DA/H with RVR' },
				{ aircraftCategory: 'B', ceilingFt: 200, visibilityM: null, valueType: 'DA/H with RVR' }
			],
			alternate: [{ aircraftCategory: 'A', ceilingFt: 400, visibilityM: 1500, valueType: 'DA/H with RVR' }],
			confidence: 'high'
		}
	],
	notes: 'Category B visibility group could not be read.'
});

function completion(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

const SOURCE: ChartSource = {
	objectKey: 'airport/YPPH/ILS-Z RWY 21 - PAGE 2.pdf',
	icao: 'YPPH',
	fileName: 'ILS-Z RWY 21 - PAGE 2.pdf',
	bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
	pdfHash: 'a'.repeat(64)
};

function options(overrides: Partial<ExtractChartOptions> = {}): ExtractChartOptions {
	return {
		apiKey: 'test-key',
		model: 'deepseek-flash',
		toMarkdown: async () => '# ILS-Z RWY 21 minima table',
		fetchImpl: (async () => completion(CHART_JSON)) as unknown as typeof fetch,
		...overrides
	};
}

describe('parsing the model response', () => {
	it('reads a bare JSON object', () => {
		expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
	});

	it('reads a fenced JSON block', () => {
		expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it('reads JSON embedded in prose', () => {
		expect(parseJsonObject('Here is the result: {"a":1} -- end')).toEqual({ a: 1 });
	});

	it('returns null for a body with no JSON object', () => {
		expect(parseJsonObject('no data')).toBeNull();
		expect(parseJsonObject('')).toBeNull();
	});
});

describe('converting a model response into draft rows', () => {
	it('produces one row per landing category and one per alternate category', () => {
		const rows = toDraftRows(JSON.parse(CHART_JSON), SOURCE.objectKey, 'YPPH');
		expect(rows).toHaveLength(3);
		expect(rows.filter(row => row.kind === 'landing')).toHaveLength(2);
		expect(rows.filter(row => row.kind === 'alternate')).toHaveLength(1);
	});

	it('keeps an unreadable value as null and lowers the confidence instead of guessing', () => {
		const rows = toDraftRows(JSON.parse(CHART_JSON), SOURCE.objectKey, 'YPPH');
		const categoryB = rows.find(row => row.aircraftCategory === 'B')!;
		expect(categoryB.visibilityM).toBeNull();
		expect(categoryB.confidence).toBe('low');
		expect(categoryB.notes).toContain('could not be read');
	});

	it('carries the chart identity, cycle and page onto every row', () => {
		const rows = toDraftRows(JSON.parse(CHART_JSON), SOURCE.objectKey, 'YPPH');
		for (const row of rows) {
			expect(row.icao).toBe('YPPH');
			expect(row.chartIdentifier).toBe('ILS-Z RWY 21');
			expect(row.chartPage).toBe('2');
			expect(row.aipCycle).toBe('AIRAC 2601');
			expect(row.approachType).toBe('CAT I');
			expect(row.runway).toBe('21');
		}
	});

	it('falls back to the object key for the ICAO when the model omits it', () => {
		const rows = toDraftRows({ approaches: [{ approach: 'RNP', landing: [{ aircraftCategory: 'A', ceilingFt: 500, visibilityM: 2000 }] }] }, SOURCE.objectKey, 'YPKG');
		expect(rows[0]!.icao).toBe('YPKG');
	});

	it('produces nothing from a payload with no approaches', () => {
		expect(toDraftRows({ icao: 'YPPH', approaches: [] }, SOURCE.objectKey, 'YPPH')).toEqual([]);
		expect(toDraftRows(null, SOURCE.objectKey, 'YPPH')).toEqual([]);
		expect(toDraftRows('not an object', SOURCE.objectKey, 'YPPH')).toEqual([]);
	});

	it('rejects an unusable ICAO rather than storing a record that names no aerodrome', () => {
		expect(toDraftRows({ icao: 'X', approaches: [{ approach: 'RNP', landing: [{ ceilingFt: 1, visibilityM: 1 }] }] }, 'airport/unknown/chart.pdf', '')).toEqual([]);
	});
});

describe('extraction outcomes', () => {
	it('returns drafts for a readable chart', async () => {
		const outcome = await extractChart(SOURCE, options());
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.drafts).toHaveLength(3);
			expect(outcome.markdownChars).toBeGreaterThan(0);
		}
	});

	it('reports a missing API key instead of calling the provider', async () => {
		let called = false;
		const outcome = await extractChart(
			SOURCE,
			options({
				apiKey: '',
				fetchImpl: (async () => {
					called = true;
					return completion(CHART_JSON);
				}) as unknown as typeof fetch
			})
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('no-api-key');
		expect(called).toBe(false);
	});

	it('reports a conversion failure with its reason', async () => {
		const outcome = await extractChart(
			SOURCE,
			options({
				toMarkdown: async () => {
					throw new Error('unsupported format');
				}
			})
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain('markdown-conversion-failed');
	});

	it('reports an empty conversion rather than asking the model about nothing', async () => {
		const outcome = await extractChart(SOURCE, options({ toMarkdown: async () => '   ' }));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('markdown-conversion-empty');
	});

	it('reports an HTTP failure without echoing the provider body', async () => {
		const outcome = await extractChart(
			SOURCE,
			options({
				fetchImpl: (async () => new Response('DATABASE ERROR: connection refused', { status: 500 })) as unknown as typeof fetch
			})
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('http-error-500');
			expect(JSON.stringify(outcome)).not.toContain('connection refused');
		}
	});

	it('reports an unparseable body', async () => {
		const outcome = await extractChart(SOURCE, options({ fetchImpl: (async () => completion('no json here')) as unknown as typeof fetch }));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('unparseable-json');
	});

	it('reports a response with no recognisable approach', async () => {
		const outcome = await extractChart(
			SOURCE,
			options({ fetchImpl: (async () => completion(JSON.stringify({ icao: 'YPPH', approaches: [] }))) as unknown as typeof fetch })
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('no-approaches-found');
	});

	it('sends the key only as an Authorization header', async () => {
		let seen: RequestInit | undefined;
		await extractChart(
			SOURCE,
			options({
				apiKey: 'super-secret-value',
				fetchImpl: (async (_url: unknown, init: unknown) => {
					seen = init as RequestInit;
					return completion(CHART_JSON);
				}) as unknown as typeof fetch
			})
		);
		const headers = new Headers(seen?.headers as HeadersInit);
		expect(headers.get('Authorization')).toBe('Bearer super-secret-value');
		expect(String(seen?.body)).not.toContain('super-secret-value');
	});

	it('bounds the converted text handed to the model', async () => {
		let body = '';
		await extractChart(
			SOURCE,
			options({
				toMarkdown: async () => 'x'.repeat(200_000),
				fetchImpl: (async (_url: unknown, init: unknown) => {
					body = String((init as RequestInit).body);
					return completion(CHART_JSON);
				}) as unknown as typeof fetch
			})
		);
		expect(body.length).toBeLessThan(180_000);
	});

	it('instructs the model never to guess an unreadable value', () => {
		expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/return null/i);
		expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Never estimate, interpolate/i);
		expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/A guessed number is a failure/i);
	});
});

describe('extraction limits', () => {
	it('caps the chart size it will convert', () => {
		expect(MAX_CHART_BYTES).toBe(8 * 1024 * 1024);
	});

	it('cannot produce an approved record', () => {
		// The module has no status field at all, which is how extraction is kept
		// unable to activate a value.
		const rows = toDraftRows(JSON.parse(CHART_JSON), SOURCE.objectKey, 'YPPH');
		for (const row of rows) {
			expect(Object.keys(row)).not.toContain('status');
		}
		expect(MINIMA_STATUSES).toContain('draft');
	});
});
