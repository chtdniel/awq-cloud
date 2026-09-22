import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import gold from './gold-questions.json';
import { retrieve } from '../src/retrieval';
import { scoreCase, type GoldCase } from '../src/retrieval-metrics';

/**
 * Adjudication aid: prints what retrieval actually returned for each question.
 *
 * Run it yourself, locally:
 *
 *   npm run eval:inspect > .tmp/retrieval-inspect.md
 *
 * Why it is a separate file from `retrieval-eval.eval.ts`
 *   This one prints corpus excerpts. Those are CONFIDENTIAL, and the whole point of
 *   the isolation in `src/explainer.ts` is that manual text does not leave the
 *   approved infrastructure. Printing to your own terminal keeps it inside that
 *   boundary; routing it through a hosted model would not. So the measurement run
 *   never prints excerpts, and this one is invoked deliberately, by you.
 *
 * What to do with the output
 *   For each case, look at the clause numbers that came back and ask: is the clause
 *   in `expect` really the passage that answers this question? If a better passage
 *   is in the list, move it into `expect` and mark the case `confirmed`. If the
 *   expected clause is wrong and nothing better is present, mark it `suspect` with a
 *   note. That review is what makes the harness's numbers mean anything.
 */

const dataset = gold as unknown as { topK: number; cases: GoldCase[] };
const INGEST_VERSION = 2;
const HEAD_CHARS = 240;

describe('retrieval inspection', () => {
	it('prints the retrieved clauses for adjudication', async () => {
		const lines: string[] = ['# Retrieval inspection', '', 'Read each case and decide whether the expected clause is really the passage that answers the question.', ''];

		for (const entry of dataset.cases) {
			const retrieval = await retrieve(env, INGEST_VERSION, entry.question, dataset.topK, []);
			const outcome = scoreCase(entry.expect, retrieval.results);
			const expected = entry.expect.map(clause => `${clause.scheme ? `${clause.scheme} ` : ''}${clause.clause}`).join(', ');

			lines.push(`## ${entry.id} (${entry.language}, ${entry.review})`);
			lines.push('');
			lines.push(`> ${entry.question}`);
			lines.push('');
			lines.push(`Expected: ${expected} — ${outcome.rank === null ? 'NOT RETRIEVED' : `rank #${outcome.rank}`}`);
			lines.push('');
			lines.push(`Terms searched: ${retrieval.terms.join(' ')}`);
			lines.push('');
			retrieval.results.forEach((result, index) => {
				const isExpected = entry.expect.some(clause => clause.clause === result.clauseId && (!clause.scheme || clause.scheme === result.clauseScheme));
				lines.push(`${index + 1}. ${isExpected ? '**' : ''}${result.clauseScheme ?? 'generic'} ${result.clauseId ?? '(no clause number)'}${isExpected ? '**' : ''} — ${result.sectionTitle ?? '(no section title)'} — ${result.foundBy.join('+') || 'unattributed'}`);
				lines.push(`   ${result.excerpt.replace(/\s+/g, ' ').slice(0, HEAD_CHARS)}`);
				lines.push('');
			});
		}

		console.log(`\n${lines.join('\n')}\n`);
		expect(dataset.cases.length).toBeGreaterThan(0);
	});
});
