import { describe, expect, it } from 'vitest';
import {
	MAX_CHART_BYTES,
	EXTRACTION_SYSTEM_PROMPT,
	collidingDraftIdentities,
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
		// The real backoff exists to survive a provider hiccup; a unit test asserting the
		// retry behaviour should not spend ten seconds asleep to do it.
		retryDelayMs: 0,
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
		// The reason carries what was returned and why the provider stopped, because "the
		// reply was not JSON" alone does not say whether to retry or to shrink the chart.
		if (!outcome.ok) expect(outcome.reason).toMatch(/^unparseable-json:/);
	});

	/**
	 * A failed extraction has to carry the evidence of the failure.
	 *
	 * Measured on the YPPH LIDO chart: the job failed with `unparseable-json` and the row
	 * recorded `markdown_chars = 0` and no model reply, which cannot distinguish "the
	 * chart produced no text" from "the chart produced 74,000 characters and the model
	 * answered with something unusable". Those two need different fixes, so the sizes and
	 * the reply are reported on the failure path as well as the success path.
	 */
	it('keeps the converted size and the model reply when the body cannot be parsed', async () => {
		const outcome = await extractChart(
			SOURCE,
			options({ toMarkdown: async () => 'C ft - m/km\nft390 - 2.2V1590\n', fetchImpl: (async () => completion('I could not read this chart.')) as unknown as typeof fetch })
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toMatch(/^unparseable-json:/);
			expect(outcome.markdownChars).toBeGreaterThan(0);
			expect(outcome.rawModelResponse).toContain('could not read');
		}
	});

	it('reports a conversion that succeeded as a size, not as zero', async () => {
		const outcome = await extractChart(
			SOURCE,
			options({ toMarkdown: async () => 'chart text', fetchImpl: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch })
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('http-error-502');
			expect(outcome.markdownChars).toBe('chart text'.length);
		}
	});

	it('reports no converted size at all when the conversion itself failed', async () => {
		const outcome = await extractChart(SOURCE, options({ toMarkdown: async () => { throw new Error('conversion exploded'); } }));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toMatch(/markdown-conversion-failed/);
			// Not zero: the conversion never produced a size, and reporting 0 would claim it
			// produced nothing rather than that it never ran.
			expect(outcome.markdownChars).toBeUndefined();
		}
	});

	it('reports a response with no recognisable approach', async () => {
		const outcome = await extractChart(
			SOURCE,
			options({ fetchImpl: (async () => completion(JSON.stringify({ icao: 'YPPH', approaches: [] }))) as unknown as typeof fetch })
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toMatch(/^no-approaches-found/);
	});

	/**
	 * The collapse that was measured in production.
	 *
	 * A LIDO chart prints several minima lines for one procedure and runway - a CAT 1 SA
	 * DME line, a CAT 1 DME line, a LOC DME line and a circling line - and their values
	 * differ by hundreds of feet. The registry keys a record without any of that, so
	 * storing them silently kept the first and discarded the rest. On YPPH that was 58 of
	 * 88 lines, and the discarded ones were the more restrictive values for the LOC and
	 * circling procedures, which is the direction that clears a flight the chart does not
	 * clear.
	 */
	describe('minima lines that would collapse into one record', () => {
		const line = (approach: string, ceilingFt: number, visibilityM: number) => ({
			approach,
			approachType: 'CAT I',
			runway: '03',
			landing: [{ aircraftCategory: 'C', ceilingFt, visibilityM, visibilityUnit: 'm', valueType: approach }],
			alternate: [],
			confidence: 'high'
		});
		const chartOf = (approaches: unknown[]) =>
			JSON.stringify({ aisAuthority: 'Airservices Australia', country: 'Australia', icao: 'YPPH', chartIdentifier: 'YPPH LIDO', approaches });

		it('detects two lines that share a record identity, and names them', () => {
			const drafts = toDraftRows(
				JSON.parse(chartOf([line('ILS Z or LOC Z - Cat 1 DME', 210, 550), line('ILS Z or LOC Z - LOC DME', 460, 1700)])),
				'airport/YPPH/YPKG LIDO.pdf',
				'YPPH'
			);
			// Both were given the SAME approach on purpose: this is the shape the model
			// produced before the prompt required the line label in "approach".
			const sameLabel = drafts.map(draft => ({ ...draft, approach: 'ILS Z or LOC Z' }));
			const collisions = collidingDraftIdentities(sameLabel);
			expect(collisions).toHaveLength(1);
			expect(collisions[0]).toContain('ILS Z or LOC Z');
			expect(collisions[0]).toContain('rwy 03');
			expect(collisions[0]).toContain('cat C');
			expect(collisions[0]).toContain('landing');
		});

		it('finds no collision once each minima line carries its own label', () => {
			const drafts = toDraftRows(
				JSON.parse(
					chartOf([
						line('ILS Z or LOC Z - Cat 1 SA DME', 150, 450),
						line('ILS Z or LOC Z - Cat 1 DME', 210, 550),
						line('ILS Z or LOC Z - LOC DME', 460, 1700),
						line('ILS Z or LOC Z - Circling', 1380, 4000)
					])
				),
				'airport/YPPH/YPPH LIDO.pdf',
				'YPPH'
			);
			expect(drafts).toHaveLength(4);
			expect(collidingDraftIdentities(drafts)).toEqual([]);
		});

		it('fails the extraction instead of storing only the surviving lines', async () => {
			const outcome = await extractChart(
				SOURCE,
				options({
					toMarkdown: async () => 'chart text',
					fetchImpl: (async () =>
						completion(
							chartOf([
								{ ...line('ILS Z or LOC Z', 150, 450), landing: [{ aircraftCategory: 'C', ceilingFt: 150, visibilityM: 450, visibilityUnit: 'm' }] },
								{ ...line('ILS Z or LOC Z', 1380, 4000), landing: [{ aircraftCategory: 'C', ceilingFt: 1380, visibilityM: 4000, visibilityUnit: 'm' }] }
							])
						)) as unknown as typeof fetch
				})
			);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.reason).toMatch(/^collapsed-minima-lines:/);
				// The count is the point: it says how many lines were read so the operator can
				// tell a collapse from a chart that genuinely holds one line.
				expect(outcome.reason).toContain('2 minima lines read');
				expect(outcome.reason).toMatch(/nothing was stored/i);
				expect(outcome.rawModelResponse).toBeTruthy();
			}
		});

		it('tells the model to give every minima line its own approach label', () => {
			expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/one entry per minima line/i);
			expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/never merge two lines/i);
			expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/LOC DME/);
		});
	});

	/**
	 * The transient provider failure, and the retry that absorbs it.
	 *
	 * Measured on this deployment: the YPPD LIDO chart returned an empty body once and a
	 * complete answer on the next attempt, and YPPH LIDO failed twice and succeeded once.
	 * None of those was a property of the chart - the same bytes produced different
	 * answers - so a bounded retry is the correct response, and the provider's own
	 * finish reason is carried into the failure text for the case where it is not.
	 */
	describe('a provider reply that is empty or unusable', () => {
		const emptyReply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 });
		const validReply = () => completion(CHART_JSON);

		it('retries an empty reply and succeeds on the next attempt', async () => {
			let calls = 0;
			const outcome = await extractChart(
				SOURCE,
				options({
					fetchImpl: (async () => {
						calls += 1;
						return calls === 1 ? emptyReply() : validReply();
					}) as unknown as typeof fetch
				})
			);
			expect(calls).toBe(2);
			expect(outcome.ok).toBe(true);
		});

		it('names the empty reply and the provider finish reason when every attempt fails', async () => {
			let calls = 0;
			const outcome = await extractChart(
				SOURCE,
				options({
					fetchImpl: (async () => {
						calls += 1;
						return emptyReply();
					}) as unknown as typeof fetch
				})
			);
			expect(calls).toBe(3);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.reason).toMatch(/empty reply/i);
				expect(outcome.reason).toContain('finish_reason=stop');
			}
		}, 20000);

		it('retries a 5xx but does not retry a 4xx', async () => {
			let serverCalls = 0;
			await extractChart(
				SOURCE,
				options({
					fetchImpl: (async () => {
						serverCalls += 1;
						return new Response('upstream down', { status: 503 });
					}) as unknown as typeof fetch
				})
			);
			expect(serverCalls).toBe(3);

			let clientCalls = 0;
			const rejected = await extractChart(
				SOURCE,
				options({
					fetchImpl: (async () => {
						clientCalls += 1;
						return new Response('bad request', { status: 400 });
					}) as unknown as typeof fetch
				})
			);
			// Retrying a request the provider has rejected on its merits would only delay
			// the report the operator needs.
			expect(clientCalls).toBe(1);
			if (!rejected.ok) expect(rejected.reason).toBe('http-error-400');
		}, 20000);

		it('does not retry a chart problem, because the same input gives the same answer', async () => {
			let calls = 0;
			const outcome = await extractChart(
				SOURCE,
				options({
					fetchImpl: (async () => {
						calls += 1;
						return completion(JSON.stringify({ icao: 'YPPH', approaches: [] }));
					}) as unknown as typeof fetch
				})
			);
			// An empty minima set IS retried: on a large chart the same converted text produced
			// 88 minima lines on one attempt and "no minima tables present" on another, so this
			// is not a property of the chart. A chart that truly holds no minima costs two
			// extra calls to establish.
			expect(calls).toBe(3);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.reason).toMatch(/no-approaches-found/);
		});

		it('still retries nothing when the minima lines collide, because that is the chart', async () => {
			let calls = 0;
			const colliding = JSON.stringify({
				aisAuthority: 'Airservices Australia',
				country: 'Australia',
				icao: 'YPPH',
				chartIdentifier: 'YPPH LIDO',
				approaches: [
					{ approach: 'ILS Z', approachType: 'CAT I', runway: '03', landing: [{ aircraftCategory: 'C', ceilingFt: 150, visibilityM: 450, visibilityUnit: 'm' }], alternate: [], confidence: 'high' },
					{ approach: 'ILS Z', approachType: 'CAT I', runway: '03', landing: [{ aircraftCategory: 'C', ceilingFt: 1380, visibilityM: 4000, visibilityUnit: 'm' }], alternate: [], confidence: 'high' }
				]
			});
			const outcome = await extractChart(
				SOURCE,
				options({
					fetchImpl: (async () => {
						calls += 1;
						return completion(colliding);
					}) as unknown as typeof fetch
				})
			);
			expect(calls).toBe(1);
			if (!outcome.ok) expect(outcome.reason).toMatch(/^collapsed-minima-lines:/);
		});
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

	/**
	 * The request has to turn thinking mode off, and the reason is not performance alone.
	 *
	 * This API enables thinking by default at effort `high`, and while it is enabled
	 * `temperature` is accepted and ignored - so the `temperature: 0` this call has always
	 * sent was not doing anything, and the extraction was not deterministic in the way the
	 * product says it is. It is also what made the largest chart slow and erratic: about 250
	 * seconds per attempt on the YPPH LIDO chart, with an empty reply on two attempts in
	 * three.
	 */
	it('disables thinking mode and states a temperature that can take effect', async () => {
		let sent: Record<string, unknown> = {};
		await extractChart(
			SOURCE,
			options({
				fetchImpl: (async (_url: unknown, init: unknown) => {
					sent = JSON.parse(String((init as RequestInit).body));
					return completion(CHART_JSON);
				}) as unknown as typeof fetch
			})
		);
		expect(sent.thinking).toEqual({ type: 'disabled' });
		expect(sent.temperature).toBe(0);
		expect(sent.stream).toBe(false);
	});

	/**
	 * The output budget, which is what actually truncated the largest chart.
	 *
	 * The API defaults `max_tokens` to 8K in non-thinking mode. The YPPH LIDO chart lists 88
	 * minima lines and each record quotes its own chart fragment, so the answer is larger
	 * than that: with thinking disabled and no explicit budget the reply came back as 28,097
	 * characters with `finish_reason=length`, cut off inside the JSON. A smaller default is
	 * not a safe default for this task.
	 */
	it('asks for a large enough output and for JSON that is guaranteed to parse', async () => {
		let sent: Record<string, unknown> = {};
		await extractChart(
			SOURCE,
			options({
				fetchImpl: (async (_url: unknown, init: unknown) => {
					sent = JSON.parse(String((init as RequestInit).body));
					return completion(CHART_JSON);
				}) as unknown as typeof fetch
			})
		);
		expect(Number(sent.max_tokens)).toBeGreaterThanOrEqual(16_384);
		// The model's maximum is 384K, so the budget has to stay inside it.
		expect(Number(sent.max_tokens)).toBeLessThanOrEqual(393_216);
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
