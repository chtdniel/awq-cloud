# Development-only tools

Nothing in this directory runs in production. `wrangler.jsonc` points the
production Worker at `src/index.ts`; these files exist so the parts of the system
that cannot be measured through the product UI can still be measured.

## Why they exist

| Tool | What it measures | Why it cannot go through the UI |
|---|---|---|
| `minima-harness.ts`, `dev-entry.ts` | The chart-to-draft pipeline: R2 read, Workers AI markdown conversion, DeepSeek extraction, and the draft rows it proposes | Transcription accuracy has to be measured against the real charts before any of it is trusted, and going through the UI would couple the measurement to the interface |
| `../scratch/smoke-production-token.mjs` | The eight production smoke tests, using a temporary ADMIN session created in D1 and deleted afterwards | Production access needs an AWQ Cloud SSO login, which only a human can complete |
| `../scratch/visual-qa.mjs` | Screenshots and overflow measurements at desktop, tablet and mobile widths | Same reason |
| `../scratch/diagnose-overflow.mjs` | Which element sets a document's scroll width, and where a given token appears in the rendered text | Locating a reflow defect needs measurements, not a visual guess |

## The harness Worker

```bash
npx wrangler secret put DEV_HARNESS_SECRET --config wrangler.dev.jsonc
npx wrangler secret put DEEPSEEK_API_KEY   --config wrangler.dev.jsonc
npx wrangler deploy --config wrangler.dev.jsonc
```

It deploys as a separate Worker (`awq-dispatch-assist-dev`) under `workers.dev`,
with no custom domain and no route, so it cannot receive production traffic. It
reads the same R2 bucket and binds the same D1 database, and it writes nothing:
the endpoint returns what the extractor proposed and never calls the registry's
insert path.

```bash
curl -X POST "https://awq-dispatch-assist-dev.<subdomain>.workers.dev/dev/minima-extract?secret=$DEV_HARNESS_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"objectKeys":["airport/YPPH/RNP RWY 24.pdf"]}'
```

Without a configured `DEV_HARNESS_SECRET` the endpoint answers `404`, so
deploying this module by accident does not expose it.

```bash
npx wrangler delete --name awq-dispatch-assist-dev --force
```

Delete it when the measurement is done. It exists to answer a question, not to
serve anything.

## What the harness established

Measured against the real YPPH charts:

**The conversion is not the slow part.** Workers AI markdown conversion of a chart
PDF takes 0.2–1 second over three charts, whether or not the document has been
converted before. It does emit the minima values, but flattened: the ILS-Z RWY 21
chart yields fragments such as `GP 3 300RVR DA 143 (100) RA 102`, `350/400RVR`,
`DA 193 (150) 450RVR RA 154` and `75RVR`, in no usable row order.

**The model call is the variable part.** Two production extraction runs returned
`timeout` at the 120-second budget for charts whose conversion had already been
measured under a second, which places the time in the DeepSeek call rather than in
the pipeline. The exact cost of that call was not measured to completion: setting a
second copy of the API key on the harness was declined partway through, so the
remaining measurements returned `http-error-401` in 0.2s. The honest statement is
therefore that the conversion cost is known and the model cost is not, and that
extraction is correct but its latency is unproven.

**Three models disagree about the same chart.** `deepseek-flash` and
`deepseek-reasoner` both produced 16 rows and agreed on the decision heights but
disagreed about which minima line the `CAT A-C 350 / CAT D 400` RVR note belongs to;
`deepseek-chat` produced 12 rows that contradict both. All three returned `null`
rather than a guessed value for the CAT IIIb decision height, which the chart does
not print, and all three set confidence to `low` with a written explanation.

That disagreement is the evidence behind the design decision that the ADMIN approval
step is load-bearing, and behind requiring every extracted row to quote the chart
fragment it came from. See `DESIGN.md` section 11.

## Open work on extraction

Latency is the unresolved part, and the fix is a shape change rather than a longer
timeout:

1. Move the conversion and the model call off the request path into a Queue
   consumer, write the draft rows from the consumer, and have the registry view poll
   a status endpoint. This removes the request budget from the problem entirely and
   is what the registry was designed to accommodate — drafts are inert, so the delay
   has no safety consequence.
2. Until then, one chart per request and a retry after a `timeout` is the
   supported workflow, and the registry UI already reports per-chart outcomes so a
   timed-out chart is visible rather than silent.

