import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import gold from './gold-questions.json';
import { retrieve } from '../src/retrieval';
import { DEFAULT_DEEPSEEK_MODEL } from '../src/explainer';
import { planQuery } from '../src/query-plan';
import { formatReport, scoreCase, type CaseResult, type GoldCase } from '../src/retrieval-metrics';

/**
 * Retrieval evaluation harness.
 *
 * Measures one narrow hypothesis against the live corpus: does query planning improve
 * the chance that the clause a dispatcher should have been shown appears in the top-k,
 * particularly for an Indonesian question against an English corpus?
 *
 * Run with `npm run eval:retrieval`. Output goes to stdout as markdown:
 *
 *   npm run eval:retrieval > .tmp/retrieval-eval.md
 *
 * Two properties this harness must have:
 *
 *   1. It measures the production code path. It calls the same `retrieve()` and
 *      `planQuery()` the Worker calls, against the same D1, Vectorize and Workers AI
 *      resources. A harness that reimplemented retrieval would measure the harness.
 *   2. It never gates on the score. A measurement that fails the build whenever recall
 *      is low is a measurement nobody will run. The only assertions here are that the
 *      harness itself is sound: the corpus is reachable, and the dataset is coherent.
 *
 * The planner needs a DeepSeek credential to exercise the planned arm. It is read from
 * `.dev.vars` (gitignored) as `DEEPSEEK_API_KEY`. Without it the harness runs the
 * unplanned arm only and says so, rather than silently reporting two identical arms.
 */

const dataset = gold as unknown as { version: number; topK: number; cases: GoldCase[] };
const INGEST_VERSION = 2;

/** The credential is a Wrangler secret / dev var, so it is read through a narrow shape. */
function deepSeekKey(bindings: Env): string {
	return String((bindings as unknown as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY ?? '').trim();
}

/** Sanity checks on the dataset, so a broken fixture cannot masquerade as a low score. */
function validateDataset(cases: GoldCase[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const entry of cases) {
		if (seen.has(entry.id)) problems.push(`duplicate case id: ${entry.id}`);
		seen.add(entry.id);
		if (!entry.question?.trim()) problems.push(`${entry.id}: empty question`);
		if (!entry.expect?.length) problems.push(`${entry.id}: no expected clause`);
		if (!entry.provenance?.trim()) problems.push(`${entry.id}: no provenance`);
		if (!['confirmed', 'unreviewed', 'suspect'].includes(entry.review)) problems.push(`${entry.id}: review must be confirmed, unreviewed or suspect`);
		// A suspect case has to say why, or the exclusion from the headline cannot be
		// challenged by the person reading the report.
		if (entry.review === 'suspect' && !entry.notes?.trim()) problems.push(`${entry.id}: suspect without a note explaining why`);
		for (const expectation of entry.expect) {
			if (!expectation.clause?.trim()) problems.push(`${entry.id}: expectation without a clause number`);
		}
	}
	return problems;
}

describe('retrieval evaluation harness', () => {
	it('has a coherent dataset', () => {
		expect(validateDataset(dataset.cases)).toEqual([]);
		expect(dataset.cases.length).toBeGreaterThan(0);
	});

	it('reaches the corpus it claims to measure', async () => {
		// Harness sanity, not a quality gate: an unreachable or empty corpus would make
		// every case a miss and read as a retrieval failure.
		const row = await env.DB.prepare(
			'SELECT COUNT(*) AS chunks FROM reference_document_chunks WHERE ingest_version = ?'
		)
			.bind(INGEST_VERSION)
			.first<{ chunks: number }>();
		const chunks = Number(row?.chunks || 0);
		expect(chunks).toBeGreaterThan(1000);
	});

	it('measures planned against unplanned and prints the report', async () => {
		const apiKey = deepSeekKey(env);
		const cases: CaseResult[] = [];

		for (const entry of dataset.cases) {
			const unplannedRetrieval = await retrieve(env, INGEST_VERSION, entry.question, dataset.topK, []);
			const unplanned = {
				terms: unplannedRetrieval.terms,
				outcome: scoreCase(entry.expect, unplannedRetrieval.results)
			};

			let planned: CaseResult['planned'] = null;
			let plannedTerms: string[] | null = null;
			let planNote = 'not run (no DEEPSEEK_API_KEY in .dev.vars)';

			if (apiKey) {
				const plan = await planQuery({ apiKey }, entry.question);
				if (plan.ok) {
					plannedTerms = plan.terms;
					planNote = 'model';
					const plannedRetrieval = await retrieve(env, INGEST_VERSION, entry.question, dataset.topK, plan.terms);
					planned = {
						terms: plannedRetrieval.terms,
						outcome: scoreCase(entry.expect, plannedRetrieval.results)
					};
				} else {
					planNote = `planner failed: ${plan.reason}`;
				}
			}

			cases.push({
				id: entry.id,
				question: entry.question,
				language: entry.language,
				review: entry.review,
				expect: entry.expect,
				unplanned,
				planned,
				plannedTerms,
				planNote
			});
		}

		const report = formatReport(cases, {
			topK: dataset.topK,
			model: DEFAULT_DEEPSEEK_MODEL,
			corpusNote: `awq-db, ingest_version ${INGEST_VERSION}, remote D1 + Vectorize + Workers AI`
		});

		// The report is the artefact. Printing it keeps the harness free of filesystem
		// access, which is unavailable inside the Workers runtime pool.
		console.log(`\n${report}\n`);

		// Every case must have produced a scored outcome; that is the harness working,
		// not the retrieval succeeding.
		expect(cases.length).toBe(dataset.cases.length);
		expect(cases.every(entry => entry.unplanned.outcome.rank !== undefined)).toBe(true);
		if (apiKey) {
			// If a credential was present, at least one planned arm must have run, or the
			// comparison is silently an unplanned-only run reported as a comparison.
			expect(cases.some(entry => entry.planned !== null)).toBe(true);
		}
	});
});
