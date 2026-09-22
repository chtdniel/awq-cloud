/**
 * Scoring for the retrieval evaluation harness.
 *
 * Kept pure and free of any binding so it can be tested without a corpus. Nothing in
 * `src/index.ts` imports it, so none of it ships in the Worker bundle.
 *
 * The question is narrow and has to stay narrow: given a question and the clause(s) a
 * dispatcher should have been shown, did retrieval surface one of them, and at what
 * rank? Recall, not answer quality — the assistant returns excerpts and does not
 * generate prose yet, so there is nothing else to measure.
 *
 * One unit per case, using the best rank among the expected clauses. That is the
 * standard information-retrieval treatment of "any of these is a correct answer":
 * a question about additional fuel is answered by any of three clauses, and scoring
 * each separately would mark a correct retrieval as two thirds wrong.
 */

export type ExpectedClause = {
	/** Clause number as stored in the corpus, for example `8.1.2` or `121.639`. */
	clause: string;
	/** Disambiguates the same number across documents. Omitted means any scheme. */
	scheme?: 'om' | 'fdm' | 'casr' | 'generic';
	/**
	 * Characters of text the corpus actually holds for this clause.
	 *
	 * Recorded because several targets survived extraction as a bare heading. A miss
	 * against a 453-character clause is a different finding from a miss against a
	 * 5,931-character one, and without this the two look identical in the report.
	 */
	corpusChars?: number;
};

export type ReviewStatus = 'confirmed' | 'unreviewed' | 'suspect';

export type GoldCase = {
	id: string;
	question: string;
	/** `id` for Indonesian, `en` for English. The hypothesis is language-specific. */
	language: 'id' | 'en';
	/**
	 * Whether a human has verified that this clause is the passage that answers the
	 * question.
	 *
	 * `CLAUSE_REFERENCES` records which clause *justifies* a rule, and that is not
	 * always the passage that *answers* a question. A case stays `unreviewed` until a
	 * dispatcher adjudicates it, and one with evidence against its expectation is
	 * `suspect` — excluded from the headline aggregate so a wrong fixture cannot move
	 * the number that a decision rests on.
	 */
	review: ReviewStatus;
	/** Why a case is suspect, or what still needs checking. */
	notes?: string;
	expect: ExpectedClause[];
	/** Where this expectation came from, so it can be challenged rather than trusted. */
	provenance: string;
};

/** A retrieved row, narrowed to the fields scoring needs. */
export type ScoredResult = {
	clauseId: string | null;
	clauseScheme: string | null;
	foundBy: Array<'lexical' | 'vector'>;
};

export type CaseOutcome = {
	/** Best 1-based rank among the expected clauses, or null when none was retrieved. */
	rank: number | null;
	/** Which expectation was satisfied. Null on a miss. */
	matched: ExpectedClause | null;
	foundBy: Array<'lexical' | 'vector'> | null;
	/** Character count of the matched clause, for attributing a hit to thin data. */
	corpusChars: number | null;
};

export type ArmResult = {
	/** The terms the lexical ranker actually searched. */
	terms: string[];
	outcome: CaseOutcome;
};

export type CaseResult = {
	id: string;
	question: string;
	language: 'id' | 'en';
	review: ReviewStatus;
	/**
	 * The acceptable clauses, carried through so a miss can still name what was
	 * expected — and how much text the corpus actually holds for it. Reporting a
	 * character count only on a hit would hide it precisely where it explains most.
	 */
	expect: ExpectedClause[];
	unplanned: ArmResult;
	planned: ArmResult | null;
	plannedTerms: string[] | null;
	planNote: string;
};

export type ArmScore = {
	cases: number;
	hit1: number;
	hitK: number;
	mrr: number;
	misses: number;
};

/**
 * Best rank among the expected clauses.
 *
 * An expectation is satisfied by clause number, and by scheme when one is given —
 * the same number can exist in more than one manual, and crediting the wrong document
 * would overstate recall.
 */
export function scoreCase(expectations: readonly ExpectedClause[], results: readonly ScoredResult[]): CaseOutcome {
	let best: CaseOutcome = { rank: null, matched: null, foundBy: null, corpusChars: null };
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		if (result.clauseId === null) continue;
		const matched = expectations.find(expectation => {
			if (expectation.clause !== result.clauseId) return false;
			if (expectation.scheme && result.clauseScheme !== expectation.scheme) return false;
			return true;
		});
		if (!matched) continue;
		const rank = index + 1;
		if (best.rank !== null && best.rank <= rank) continue;
		best = { rank, matched, foundBy: result.foundBy, corpusChars: matched.corpusChars ?? null };
	}
	return best;
}

/** Mean over the cases present in one arm. */
export function scoreArm(results: ReadonlyArray<{ outcome: CaseOutcome }>, topK: number): ArmScore {
	const total = results.length;
	if (!total) return { cases: 0, hit1: 0, hitK: 0, mrr: 0, misses: 0 };
	let hit1 = 0;
	let hitK = 0;
	let reciprocal = 0;
	let misses = 0;
	for (const { outcome } of results) {
		if (outcome.rank === null) {
			misses += 1;
			continue;
		}
		if (outcome.rank === 1) hit1 += 1;
		if (outcome.rank <= topK) hitK += 1;
		reciprocal += 1 / outcome.rank;
	}
	return { cases: total, hit1: hit1 / total, hitK: hitK / total, mrr: reciprocal / total, misses };
}

export type SummaryOptions = {
	language?: 'id' | 'en';
	reviews?: readonly ReviewStatus[];
};

/** Aggregate an arm over cases, optionally restricted by language and review status. */
export function summarise(cases: readonly CaseResult[], arm: 'unplanned' | 'planned', options: SummaryOptions = {}): ArmScore {
	let selected = options.language ? cases.filter(entry => entry.language === options.language) : [...cases];
	if (options.reviews) selected = selected.filter(entry => options.reviews!.includes(entry.review));
	const results = selected.map(entry => entry[arm]).filter((result): result is ArmResult => Boolean(result));
	return scoreArm(results, Number.POSITIVE_INFINITY);
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
	return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

/**
 * Render the comparison as markdown.
 *
 * Reports the paired per-case delta as well as the aggregate: with a stochastic
 * planner an aggregate can hide that one case improved while another regressed, which
 * is exactly the trade a reviewer has to see before enabling it for dispatchers.
 */
export function formatReport(cases: readonly CaseResult[], options: { topK: number; model: string; corpusNote?: string }): string {
	const lines: string[] = [];
	const unplanned = summarise(cases, 'unplanned');
	const planned = summarise(cases, 'planned');
	const hasPlanned = planned.cases > 0;

	lines.push('# Retrieval evaluation');
	lines.push('');
	const scored = cases.filter(entry => entry.review !== 'suspect');
	lines.push(`- Top-k: ${options.topK}`);
	lines.push(`- Planner model: ${options.model}`);
	lines.push(`- Arms: ${hasPlanned ? 'planned vs unplanned' : 'unplanned only'}`);
	lines.push(`- Cases: ${cases.length} (${cases.filter(entry => entry.language === 'id').length} Indonesian, ${cases.filter(entry => entry.language === 'en').length} English)`);
	lines.push(`- Excluded from the headline as suspect: ${cases.length - scored.length}`);
	if (options.corpusNote) lines.push(`- Corpus: ${options.corpusNote}`);
	lines.push('');
	lines.push('## Aggregate');
	lines.push('');
	lines.push('The headline set excludes cases marked `suspect`, whose expectation has evidence against it. They are still measured and reported in the `all cases` row, so a doubtful fixture stays visible instead of being silently averaged in.');
	lines.push('');
	lines.push('| Set | Arm | Cases | hit@1 | hit@k | MRR | misses |');
	lines.push('|---|---|---:|---:|---:|---:|---:|');
	const scoredUnplanned = summarise(scored, 'unplanned');
	const scoredPlanned = summarise(scored, 'planned');
	lines.push(`| scored | unplanned | ${scoredUnplanned.cases} | ${percent(scoredUnplanned.hit1)} | ${percent(scoredUnplanned.hitK)} | ${scoredUnplanned.mrr.toFixed(3)} | ${scoredUnplanned.misses} |`);
	if (scoredPlanned.cases) {
		lines.push(`| scored | planned | ${scoredPlanned.cases} | ${percent(scoredPlanned.hit1)} | ${percent(scoredPlanned.hitK)} | ${scoredPlanned.mrr.toFixed(3)} | ${scoredPlanned.misses} |`);
	}
	lines.push(`| all cases | unplanned | ${unplanned.cases} | ${percent(unplanned.hit1)} | ${percent(unplanned.hitK)} | ${unplanned.mrr.toFixed(3)} | ${unplanned.misses} |`);
	if (hasPlanned) {
		lines.push(`| all cases | planned | ${planned.cases} | ${percent(planned.hit1)} | ${percent(planned.hitK)} | ${planned.mrr.toFixed(3)} | ${planned.misses} |`);
	}
	if (scoredPlanned.cases) {
		lines.push('');
		lines.push(`Delta on the scored set: hit@1 ${signed(scoredPlanned.hit1 - scoredUnplanned.hit1)} · hit@k ${signed(scoredPlanned.hitK - scoredUnplanned.hitK)} · MRR ${(scoredPlanned.mrr - scoredUnplanned.mrr).toFixed(3)}`);
	}
	lines.push('');

	for (const language of ['id', 'en'] as const) {
		const label = language === 'id' ? 'Indonesian' : 'English';
		if (!scored.some(entry => entry.language === language)) continue;
		const base = summarise(scored, 'unplanned', { language });
		const withPlan = summarise(scored, 'planned', { language });
		lines.push(`### ${label} questions`);
		lines.push('');
		lines.push('| Arm | Cases | hit@1 | hit@k | MRR | misses |');
		lines.push('|---|---:|---:|---:|---:|---:|');
		lines.push(`| unplanned | ${base.cases} | ${percent(base.hit1)} | ${percent(base.hitK)} | ${base.mrr.toFixed(3)} | ${base.misses} |`);
		if (withPlan.cases) {
			lines.push(`| planned | ${withPlan.cases} | ${percent(withPlan.hit1)} | ${percent(withPlan.hitK)} | ${withPlan.mrr.toFixed(3)} | ${withPlan.misses} |`);
			lines.push('');
			lines.push(`Delta: hit@1 ${signed(withPlan.hit1 - base.hit1)} · hit@k ${signed(withPlan.hitK - base.hitK)} · MRR ${(withPlan.mrr - base.mrr).toFixed(3)}`);
		}
		lines.push('');
	}

	lines.push('## Per case');
	lines.push('');
	lines.push('One row per case, scored on the best rank among its acceptable clauses. Every case is measured; the Review column is what keeps a doubtful fixture out of the headline.');
	lines.push('');
	lines.push('| Case | Lang | Review | Expected clause (corpus chars) | Unplanned | Planned | Plan terms |');
	lines.push('|---|---|---|---|---:|---:|---|');
	for (const entry of cases) {
		// The expected clause is named even on a miss, together with how much text the
		// corpus holds for it: that is what separates "retrieval failed" from "the
		// manual's table never survived extraction".
		const expected = entry.expect
			.map(clause => `${clause.scheme ? `${clause.scheme} ` : ''}${clause.clause}${clause.corpusChars ? ` (${clause.corpusChars})` : ''}`)
			.join(', ');
		const thin = entry.expect.length > 0 && entry.expect.every(clause => (clause.corpusChars ?? 0) < 1000);
		const outcome = entry.unplanned.outcome;
		const unplannedCell = outcome.rank === null ? 'miss' : `#${outcome.rank}${outcome.foundBy ? ` ${outcome.foundBy.join('+')}` : ''}`;
		const plannedOutcome = entry.planned?.outcome;
		const plannedCell = plannedOutcome ? (plannedOutcome.rank === null ? 'miss' : `#${plannedOutcome.rank}${plannedOutcome.foundBy ? ` ${plannedOutcome.foundBy.join('+')}` : ''}`) : 'n/a';
		const plan = entry.plannedTerms?.length ? entry.plannedTerms.join(' ') : entry.planNote;
		lines.push(`| ${entry.id} | ${entry.language} | ${entry.review} | ${expected}${thin ? ' — thin target' : ''} | ${unplannedCell} | ${plannedCell} | ${plan.slice(0, 64)} |`);
	}
	lines.push('');
	lines.push('A `thin target` is a clause the corpus holds under 1,000 characters of text for. A `miss` against one is a corpus-extraction finding rather than a retrieval finding: several tables in the source manuals did not survive extraction, so the text a question refers to may barely exist, and no retrieval change can rank prose that is not there.');
	lines.push('');
	lines.push('`unreviewed` means the expectation traces to a rule citation and no dispatcher has yet confirmed it is the passage that answers the question. A rule citation is not always the answering passage. See `eval/README.md`.');
	return lines.join('\n');
}
