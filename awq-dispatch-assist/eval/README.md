# Retrieval evaluation harness

Measures one narrow question against the live corpus: **when a dispatcher asks
something, does retrieval show them the clause they needed, and at what rank?**

It exists because query planning (`src/query-plan.ts`) trades a model round-trip in
front of an operator-facing search box for an unmeasured recall gain. This produces the
number before that trade is made.

## Running it

```bash
npm run eval:retrieval > .tmp/retrieval-eval.md
```

To adjudicate the expectations — that is, to check whether each `expect` really names
the passage that answers its question — run the inspection mode **locally**:

```bash
npm run eval:inspect > .tmp/retrieval-inspect.md
```

That second command prints corpus excerpts, so it is a separate file invoked
deliberately. Those excerpts are CONFIDENTIAL and the whole point of the isolation in
`src/explainer.ts` is that manual text stays inside the approved infrastructure.
Printing to your own terminal keeps it there; routing it through a hosted model does
not. The measurement run never prints excerpts.

It runs against the **production** D1, Vectorize and Workers AI resources, because the
reference corpus only exists there — the local D1 has no corpus tables. It only issues
`SELECT`s. The binding is remote in `wrangler.eval.jsonc`, which nothing else uses;
`vitest.config.mts` stays on `wrangler.jsonc` with a local D1, so `npm test` can never
reach production data.

To exercise the planned arm as well as the baseline, put a credential in `.dev.vars`
(gitignored) and re-run:

```
DEEPSEEK_API_KEY=...
```

Without it the harness runs the unplanned arm only and says so in the report rather
than printing two identical arms.

## Review status

Every case carries a `review` field, and it is what keeps the headline number honest:

- `unreviewed` — the expectation traces to a rule citation and no dispatcher has
  confirmed it is the answering passage. This is the default and the whole set started
  here.
- `confirmed` — a human checked it against the manual.
- `suspect` — there is evidence against the expectation. It needs a `notes` field saying
  what, the harness fails without one, and the case is **excluded from the headline
  aggregate** while still being measured and shown in the `all cases` row.

Four `tempo-alternate` cases are `suspect`: the engine cites `OM Part A 8.1.2` as the
rule authority, but that clause's text is "Criteria for Determining the Usability of
Aerodromes" — navigation aids, runways, curfews, RRF — which is aerodrome facility
adequacy, not weather-versus-alternate planning. The answering passage is probably a
weather sub-clause of 8.1.2 and a dispatcher needs to name it.

## Known finding: an exact clause number is not reliably retrievable

Found by the first full run, and the most actionable output so far. Two control cases
that quote a clause number in the question — `What does OM Part A 8.4.4.2.2.1 say?` and
`Show me CASR 121.639.` — both **miss**, in both arms. The planner is skipped for these
by design, so planning cannot explain it and cannot fix it.

Verified against the corpus with metadata-only queries (no prose read):

| Fact | Value |
|---|---|
| Chunks containing `CASR` | 284 of 2,969 = **9.57%**, so the frequency filter classifies it as common and drops it |
| Chunks containing `SHOW` | 112 = **3.77%**, also dropped |
| Chunks containing `121.639` | 6 |
| Chunks containing both `SHOW` and `121.639` | **0** |

Mechanism, as a hypothesis that fits those facts and is not yet directly instrumented:
with `CASR` and `SHOW` dropped, the effective token set collapses to the clause number
alone, and the six chunks that match it score coverage 1. They are found by lexical
search only, because the vector ranker is weak on exact identifiers — which is the whole
reason the hybrid exists. Reciprocal rank fusion then works against them: a chunk found
by **both** rankers at mediocre ranks scores about `1/90 + 1/120 ≈ 0.019`, while a chunk
found by **lexical alone at rank 1** scores `1/61 ≈ 0.016`. So single-ranker hits lose to
two-ranker hits, and an exact clause-number match that only lexical search can make is
pushed out of the top-k.

A second code-level observation supports it: `lexicalSearch` sorts only by coverage and
has no tiebreaker, so among the six equal-coverage chunks the order is whatever SQLite
returns — which makes the RRF contribution of exactly those chunks arbitrary.

The next step is to instrument it rather than keep inferring: report the lexical rank and
vector rank of an expected clause even when it falls outside the top-k. That is
metadata-only and would turn the hypothesis into a measurement.

## Reading the output

- **hit@1** — the correct clause was the first result. This is the number that matters
  most, because the operator reads the top excerpt first.
- **hit@k** — it appeared somewhere in the top 8, which is what `proxyAssistant` shows.
- **MRR** — mean reciprocal rank; rewards putting the right clause higher.
- **Thin target** — the corpus holds under 1,000 characters for that clause. A miss
  against one is an extraction finding, not a retrieval finding: several tables did not
  survive extraction from the source PDFs, and no retrieval change can rank text that
  is not there.

## Caveats, in order of how much they limit the numbers

1. **The expectations are rule authority, not retrieval targets.** Every `expect` traces
   to `CLAUSE_REFERENCES` in `src/dispatch.ts`, which records which clause *justifies* a
   rule. That is not always the passage that *answers* a question. The `tempo-alternate`
   case is the worked example: the engine cites `OM Part A 8.1.2`, but that clause's text
   is "Criteria for Determining the Usability of Aerodromes" — navigation aids, runways,
   curfews, RFFS — not weather-versus-alternate planning. Both languages miss it, which
   is a signal that the expectation is wrong rather than that retrieval failed.
2. **Ten cases is not enough to conclude anything statistically.** One case moving
   changes hit@1 by 10 points. Treat the first run as a smoke test and the shape of the
   numbers, not as a verdict.
3. **The questions were written by the same session that wrote the planner.** They were
   written to sound like a dispatcher rather than like the manual, which is the condition
   under test, but a dispatcher's review is what makes the set trustworthy.
4. **The planned arm is stochastic.** The unplanned arm is fully reproducible — the
   lexical ranker is deterministic and the query embedding is too — but a plan comes from
   a model, so repeated runs differ. Compare aggregates, and read the plan terms column
   when a single case moves.

## Extending the dataset

Edit `eval/gold-questions.json`. Each case needs an `id`, a `language`, a `question`, at
least one expected clause, and a `provenance` string naming where the expectation came
from. The harness validates this shape and fails on a malformed entry, so a broken fixture
cannot present itself as a low score.

When adding a case, verify the clause number and its text length against the corpus
first:

```bash
npx wrangler d1 execute awq-db --remote --command \
  "SELECT clause_scheme, clause_id, LENGTH(content) AS len FROM reference_document_chunks \
   WHERE ingest_version = 2 AND clause_id = '8.4.4.2.2.1';"
```

Recording `corpusChars` from that reading is what lets a later miss be attributed to thin
data instead of to retrieval.

## What it deliberately does not do

- It does not gate the build. `npm test` does not include it, and no score is asserted —
  a measurement that turns the build red when recall is low is a measurement nobody runs.
- It does not reimplement retrieval. It calls the same `retrieve()` and `planQuery()` the
  Worker calls. A harness that reimplemented them would measure the harness.
- It does not send corpus text anywhere. `src/retrieval-metrics.ts` is pure and nothing in
  `src/index.ts` imports it, so none of it ships in the Worker bundle.
