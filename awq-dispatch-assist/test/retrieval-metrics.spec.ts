import { describe, expect, it } from 'vitest';
import { formatReport, scoreArm, scoreCase, summarise, type CaseResult, type ExpectedClause, type ScoredResult } from '../src/retrieval-metrics';

/**
 * The metric has to be right before any number it produces can be trusted, and none
 * of it can be checked against a live corpus. These tests pin the arithmetic and the
 * two decisions that are easy to get subtly wrong: that a case with several acceptable
 * clauses scores as one unit, and that the same clause number in a different manual
 * does not count as a hit.
 */

function result(clauseId: string | null, clauseScheme: string | null, foundBy: Array<'lexical' | 'vector'> = ['lexical']): ScoredResult {
	return { clauseId, clauseScheme, foundBy };
}

const OM_812: ExpectedClause = { scheme: 'om', clause: '8.1.2', corpusChars: 3670 };
const OM_812231: ExpectedClause = { scheme: 'om', clause: '8.1.2.2.3.1', corpusChars: 1106 };

describe('scoring one case', () => {
	it('returns the best rank among several acceptable clauses', () => {
		const outcome = scoreCase([OM_812, OM_812231], [result('x', 'om'), result('8.1.2.2.3.1', 'om'), result('8.1.2', 'om')]);
		expect(outcome.rank).toBe(2);
		expect(outcome.matched?.clause).toBe('8.1.2.2.3.1');
	});

	it('reports the matched clause character count so a hit can be judged', () => {
		expect(scoreCase([OM_812], [result('8.1.2', 'om')]).corpusChars).toBe(3670);
	});

	it('does not credit the same clause number from a different manual', () => {
		const outcome = scoreCase([{ scheme: 'casr', clause: '121.639' }], [result('121.639', 'om')]);
		expect(outcome.rank).toBeNull();
	});

	it('credits any scheme when no scheme is required', () => {
		expect(scoreCase([{ clause: '121.639' }], [result('121.639', 'om')]).rank).toBe(1);
	});

	it('misses when nothing matches, and skips results with no clause number', () => {
		expect(scoreCase([OM_812], [result(null, null), result('9.9.9', 'om')]).rank).toBeNull();
	});

	it('carries which ranker found the hit', () => {
		expect(scoreCase([OM_812], [result('8.1.2', 'om', ['lexical', 'vector'])]).foundBy).toEqual(['lexical', 'vector']);
	});

	it('is a miss on an empty result set', () => {
		expect(scoreCase([OM_812], []).rank).toBeNull();
	});
});

describe('scoring an arm', () => {
	const outcomes = (ranks: Array<number | null>) => ranks.map(rank => ({ outcome: { rank, matched: null, foundBy: null, corpusChars: null } }));

	it('computes hit@1, hit@k and MRR', () => {
		const score = scoreArm(outcomes([1, 2, 4, null]), 8);
		expect(score.cases).toBe(4);
		expect(score.hit1).toBeCloseTo(0.25);
		expect(score.hitK).toBeCloseTo(0.75);
		expect(score.mrr).toBeCloseTo((1 + 0.5 + 0.25) / 4);
		expect(score.misses).toBe(1);
	});

	it('counts a rank beyond k as a hit@k failure but still credits MRR', () => {
		const score = scoreArm(outcomes([9]), 8);
		expect(score.hitK).toBe(0);
		expect(score.mrr).toBeCloseTo(1 / 9);
	});

	it('returns zeroes rather than NaN for an empty arm', () => {
		expect(scoreArm([], 8)).toEqual({ cases: 0, hit1: 0, hitK: 0, mrr: 0, misses: 0 });
	});
});

function caseResult(id: string, language: 'id' | 'en', unplannedRank: number | null, plannedRank: number | null): CaseResult {
	const outcome = (rank: number | null) => ({ rank, matched: rank === null ? null : OM_812, foundBy: null, corpusChars: rank === null ? null : 3670 });
	return {
		id,
		question: id,
		language,
		review: 'unreviewed',
		expect: [OM_812],
		unplanned: { terms: ['TAF'], outcome: outcome(unplannedRank) },
		planned: plannedRank === null && unplannedRank === null ? { terms: ['TAF'], outcome: outcome(null) } : { terms: ['TAF', 'PLANNING'], outcome: outcome(plannedRank) },
		plannedTerms: ['PLANNING', 'MINIMA'],
		planNote: 'model'
	};
}

describe('aggregating and reporting', () => {
	it('restricts an aggregate to one language', () => {
		const cases = [caseResult('a', 'id', null, 1), caseResult('b', 'en', 1, 1)];
		expect(summarise(cases, 'unplanned', { language: 'id' }).hit1).toBe(0);
		expect(summarise(cases, 'unplanned', { language: 'en' }).hit1).toBe(1);
	});

	it('keeps a suspect case out of the headline but still counts it in all cases', () => {
		// A fixture whose expectation has evidence against it must not move the number a
		// decision rests on, while staying visible so it can be challenged.
		const good = caseResult('good', 'id', 1, 1);
		const doubtful: CaseResult = { ...caseResult('doubtful', 'id', null, null), review: 'suspect' };
		const cases = [good, doubtful];
		const scored = cases.filter(entry => entry.review !== 'suspect');
		expect(summarise(scored, 'unplanned').cases).toBe(1);
		expect(summarise(scored, 'unplanned').hit1).toBe(1);
		expect(summarise(cases, 'unplanned').cases).toBe(2);
		expect(summarise(cases, 'unplanned').misses).toBe(1);
	});

	it('marks the excluded count and the review column in the report', () => {
		const report = formatReport([caseResult('good', 'id', 1, 1), { ...caseResult('doubtful', 'id', null, null), review: 'suspect' }], { topK: 8, model: 'deepseek-flash' });
		expect(report).toContain('Excluded from the headline as suspect: 1');
		expect(report).toContain('| all cases | unplanned |');
		expect(report).toContain('| suspect |');
	});

	it('reports an unplanned-only run as unplanned only, not as a comparison', () => {
		const cases: CaseResult[] = [
			{ id: 'a', question: 'a', language: 'id', review: 'unreviewed', expect: [OM_812], unplanned: { terms: ['TAF'], outcome: { rank: 1, matched: OM_812, foundBy: null, corpusChars: 3670 } }, planned: null, plannedTerms: null, planNote: 'not run (no DEEPSEEK_API_KEY in .dev.vars)' }
		];
		const report = formatReport(cases, { topK: 8, model: 'deepseek-flash' });
		expect(report).toContain('unplanned only');
		expect(report).not.toContain('Delta:');
		expect(report).toContain('not run (no DEEPSEEK_API_KEY');
	});

	it('prints a signed delta and a per-language breakdown once planning ran', () => {
		const report = formatReport([caseResult('a', 'id', null, 1), caseResult('b', 'en', 1, 1)], { topK: 8, model: 'deepseek-flash' });
		expect(report).toContain('planned vs unplanned');
		expect(report).toContain('Delta:');
		expect(report).toContain('Indonesian questions');
		expect(report).toContain('English questions');
	});

	it('names the expected clause and its character count even on a miss', () => {
		// The character count matters most on a miss: it is what separates "retrieval
		// failed" from "the manual's table never survived extraction".
		const report = formatReport([caseResult('thin', 'id', null, null)], { topK: 8, model: 'deepseek-flash' });
		expect(report).toContain('| miss |');
		expect(report).toContain('om 8.1.2 (3670)');
	});

	it('marks a thin target so a miss is not read as a retrieval failure', () => {
		const thinCase: CaseResult = {
			id: 'very-thin',
			question: 'q',
			language: 'id',
			review: 'unreviewed',
			expect: [{ scheme: 'om', clause: '8.4.4.2.2.1', corpusChars: 453 }],
			unplanned: { terms: ['TEMPO'], outcome: { rank: null, matched: null, foundBy: null, corpusChars: null } },
			planned: null,
			plannedTerms: null,
			planNote: 'not run'
		};
		expect(formatReport([thinCase], { topK: 8, model: 'deepseek-flash' })).toContain('thin target');
	});
});
