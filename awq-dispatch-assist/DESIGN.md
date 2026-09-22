# AWQ Dispatch Assist Design System

## 0. Research Log

- Embedded refs: shortlisted `sentry.md`, `linear.app.md`, and `ibm.md`; picked the operational discipline of `taste-skill.md` with `sentry.md` as the closest data-dense product reference.
- Lazyweb: skipped because this first slice is an internal operational shell with no external visual reference to clone.
- Imagen drafts: skipped because the product surface is functional and does not need marketing imagery or decorative hero art.
- Style direction: dark operations cockpit, adapted from Sentry's technical density without copying its brand colors, copy, or assets.

## 1. Atmosphere & Identity

AWQ Dispatch Assist feels like a quiet flight operations desk: focused, legible, and calm under pressure. The signature is a thin amber flight-line accent that marks the selected flight on the board while the rest of the interface stays restrained.

Design read: internal aviation operations dashboard for dispatch operators, with a dark technical language and a low-glare control-room surface.

Design dials: `DESIGN_VARIANCE 3`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 7`.

The screen is a **single decision column**, read top to bottom in the order the work is done: board, context, weather, minima, verdict. Two consequences are deliberate and load-bearing:

- The verdict is a **pinned strip** directly under the header. The assessment is read while its findings are on screen, so the verdict cannot scroll away from the evidence it is drawn from.
- The **inputs sit above the output**. The minima and NOTAM that determine the verdict are entered before the assessment, not below the badge they produced.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|---|---|---:|---|
| Surface primary | `--surface-primary` | `#11161d` | Application canvas |
| Surface secondary | `--surface-secondary` | `#171e27` | Workspace panels |
| Surface elevated | `--surface-elevated` | `#202a35` | Menus and selected context |
| Text primary | `--text-primary` | `#f2f5f7` | Headings and values |
| Text secondary | `--text-secondary` | `#aab6c2` | Supporting information |
| Text tertiary | `--text-tertiary` | `#94a3b0` | Hints, field labels, unavailable values |
| Border default | `--border-default` | `#30404d` | Panel and control outlines |
| Border subtle | `--border-subtle` | `#24313c` | Internal separation |
| Accent primary | `--accent-primary` | `#e6a93a` | Selection, primary action, focus |
| Accent hover | `--accent-hover` | `#f1bd5a` | Hover state |
| Status success | `--status-success` | `#5ec28b` | Available or current |
| Status warning | `--status-warning` | `#e6a93a` | Attention or stale data |
| Status error | `--status-error` | `#e47777` | Failed requests |
| Status info | `--status-info` | `#78b7d8` | Informational state |

The page stays dark. Status colors are semantic and are not decorative accents.

Measured contrast, recomputed with the WCAG 2.x relative-luminance formula. The token is declared as `rgb(148 163 176)`, which is `#94a3b0`.

| Token | On canvas `#11161d` | On panel `#171e27` | On elevated `#202a35` |
|---|---:|---:|---:|
| `--text-primary` `#f2f5f7` | 16.59:1 | 15.33:1 | 13.28:1 |
| `--text-secondary` `#aab6c2` | 8.80:1 | 8.13:1 | 7.05:1 |
| `--text-tertiary` `#94a3b0` | 7.03:1 | 6.49:1 | 5.63:1 |
| `--accent-primary` `#e6a93a` | 8.74:1 | 8.07:1 | 7.00:1 |
| `--status-error` `#e47777` | 6.23:1 | 5.76:1 | 4.99:1 |

Every text token clears 4.5:1 on all three surfaces; the lowest pair on the page is `--status-error` on `--surface-elevated` at 4.99:1. `--text-tertiary` was `#71808d`, which measured 4.47 / 4.13 / 3.58:1 and put field labels, finding evidence and metadata below the floor on all three; it was retuned to clear the floor on the highest surface it lands on, so the token is now safe anywhere.

`--accent-primary` and `--status-warning` are currently the same value. That is a known defect, not an intention: it makes one amber mean both "primary action" and "caution" (§8, accepted debt).

## 3. Typography

| Level | Size | Weight | Line height | Usage |
|---|---:|---:|---:|---|
| Display | 32px | 700 | 1.1 | Page title |
| H1 | 24px | 700 | 1.2 | Workspace title |
| H2 | 18px | 700 | 1.3 | Panel heading |
| H3 | 12px | 700 | 1.3 | Field-group heading, uppercase |
| Body | 14px | 400 | 1.5 | Operational copy |
| Body small | 12px | 400 | 1.4 | Supporting text |
| Label | 11px | 700 | 1.3 | Uppercase field labels |
| Data | 14px | 600 | 1.3 | Callsigns, codes, times |

**No functional text below 11px.** The previous ramp put field labels, status chips, the verdict badge and citation provenance at 10px; the verdict badge is now 12px and every label is 11px. A 10px label is a legibility failure on a screen read under time pressure, not a density choice.

Primary: `ui-sans-serif`, `system-ui`, `Segoe UI`, sans-serif. Data: `ui-monospace`, `SFMono-Regular`, `Consolas`, monospace. No remote font dependency. Monospace is for identifiers, codes, times and fixed-format text (raw TAF); prose is never set in monospace, so manual excerpts and model narratives use the sans face.

## 4. Spacing & Layout

Base unit: 4px.

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | 4px | Icon and label gap |
| `--space-2` | 8px | Compact control gap |
| `--space-3` | 12px | Control padding |
| `--space-4` | 16px | Panel padding |
| `--space-5` | 20px | Group spacing |
| `--space-6` | 24px | Major panel padding |
| `--space-8` | 32px | Page section spacing |

The app uses a fixed header and a single scroll owner: `.workspace-scroll`. `.app-shell` is `block-size: 100dvb` — exactly one viewport, not `min-block-size` — so the document itself never scrolls and the header cannot be scrolled away. Verified: at 1440x1000 with data loaded, `document.scrollingElement.scrollHeight` is 1000 and `.workspace-scroll` reports `clientHeight 936 / scrollHeight 4906`.

The workspace is one column (`.workspace-stack`) capped at `1180px`, so a decision is read in one direction. Every panel body is a grid with `gap: var(--space-3)`; `min-inline-size: 0` on panels and tracks keeps long operational values from creating horizontal overflow, and every `auto-fit` track uses `minmax(min(Xpx, 100%), 1fr)` so a fixed minimum can never exceed a narrow container.

Breakpoints: `sm 640px`, `md 768px`, `lg 1024px`, `xl 1280px`.

Below `768px`: panels stack, `.flight-row` collapses to two columns, `.assessment-row` and `.document-row` stack, and `.button` plus the document form controls rise to the 44px touch floor. Desktop keeps 36px controls, because touch is not the input there.

## 5. Components

### App shell

- Structure: fixed 64px header, single scrollable workspace, one decision column.
- Variants: desktop, mobile stacked.
- States: normal, loading, unavailable, error.
- Accessibility: landmark header and main, visible focus, keyboard order follows reading order.
- Motion: no automatic motion; focus and pressed states use color and transform only.
- Layout: `.workspace-scroll` is the only scroll owner; the document does not scroll.

### Operational clock

- Structure: `UTC` label plus a `<time>` value in `DDHHMMZ` form.
- Usage: the header only. A dispatch screen with no Zulu clock makes every other time on it unverifiable.
- Motion: the value repaints every 15 seconds, which is the only recurring update on the page.

### Verdict strip

- Structure: verdict badge, flight identity, ETA windows, and the printable-report action.
- Variants: `GO`, `MARGINAL`, `NO-GO`, `NO_DATA`.
- States: hidden until an assessment exists; cleared when the selected flight changes.
- Accessibility: the text half is `role="status" aria-live="polite"`, so a new verdict is announced.
- Motion: none.
- Layout: `position: sticky; top: 0` inside `.workspace-scroll`, so it stays under the header at any scroll position. It floats, so it declares elevation with a shadow and no border.

### Flight board row

- Structure: semantic button with four data columns — callsign, route, date of flight and scheduled time, registration.
- Variants: selected, available, unavailable.
- States: default, hover, active, focus, disabled.
- Accessibility: selected state uses `aria-pressed`; a missing value renders `—` with an `aria-label` naming what is missing.
- Motion: 120ms color feedback.
- Layout: `auto minmax(0, 1fr) auto auto`, collapsing to two rows below `768px`. Time and registration use `tabular-nums` so rows compare without reading.

### Context panel

- Structure: panel heading with the selected callsign, status band, and two labelled field groups (`Route identity`, `Alternates`) marked up as `<dl>`.
- Variants: no flight selected, flight selected, request error.
- States: empty, resolved, error.
- Accessibility: field labels remain visible; unavailable values use the word `Unavailable`, never colour alone. The heading count and the status band are written from the same value, so they cannot disagree.
- Motion: none.

### Minima panel

- Structure: two `<fieldset>` groups with visible legends — `Destination minima` and `Alternate minima` — each holding approach, ceiling and visibility, plus the NOTAM field and the create action.
- Why the fieldsets: destination and alternate minima were previously laid out by one `auto-fit` run, which wrapped the sixth field onto a second row and split the two triplets. A destination ceiling typed into the alternate field silently changes a GO/NO-GO verdict.
- Variants: no flight selected (guidance only), flight selected (inputs).
- Accessibility: the legend names the group, so the three fields inside it are never ambiguous.

### Assessment result

- Structure: verdict badge, context hash, ETA windows, fuel requirement, findings, written narrative, data-quality disclosure.
- Not a card: the panel is the container, and the findings are the list items. A bordered box inside a bordered panel is a card in a card.
- States: awaiting input, stale (dimmed while a new snapshot is built), resolved, and a notice line for progress or failure.
- Accessibility: `aria-live="polite"` on the result, so a new verdict is announced; `Accept` and `Reject` are `disabled` until an assessment exists.
- Rule: **a failed or in-flight re-assess never overwrites a rendered verdict.** Progress and errors are written to the notice line; the previous verdict is dimmed, not destroyed.

### Status band

- Structure: text label plus semantic status color.
- Variants: connected, waiting, unavailable, error.
- States: default and focus when actionable.
- Accessibility: status text is explicit and announced through `aria-live` only for changes.
- Motion: no looping animation.

## 6. Motion & Interaction

Timing: micro `120ms ease-out`, standard `200ms ease-in-out`.

Only selected-row feedback, button press, and focus transitions move. `prefers-reduced-motion` disables transform transitions. No scroll listeners, parallax, or decorative animation.

## 7. Depth & Surface

Strategy: tonal shift with restrained borders. Panels are separated by surface tone first, with `--border-subtle` only where grouping would otherwise be unclear. No heavy card shadows.

Elevation is declared once per element: the panels carry a 1px border and no shadow; the pinned verdict strip carries a shadow and no border, because it genuinely floats above the content scrolling under it.

Findings state severity with a 1px tinted border and a tinted surface, never a thick coloured edge bar — a 3px accent stripe is decoration standing in for hierarchy, and the severity word is already printed next to it.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA target. Every text token clears 4.5:1 on all three surfaces it can land on (see §2).
- No functional text below 11px.
- Every interactive element is keyboard reachable and has a visible focus state, including `[tabindex]`.
- No operational value is communicated by color alone; every status chip also spells its state out.
- The `hidden` attribute is authoritative: one global `[hidden] { display: none !important }` guarantees it, because an author `display` declaration otherwise outranks the user-agent rule and rendered controls the page had asked not to show.
- The verdict and the ETA windows are live regions, so a completed assessment is announced rather than silently painted.
- Primary content reflows to one column at 360px with no horizontal scroll, in the document or in the scroll container.
- Touch targets: `.button` and the document-form controls are 44px below `768px`. `.dispatch-field input` and `.document-row a` are not yet covered (accepted debt).
- Reduced motion is respected.
- Browser surfaces are themed from the palette: selection, scrollbars, caret, focus rings, and `tabular-nums` on every data column.

### Accepted Debt

| Item | Location | Why accepted | Exit |
|---|---|---|---|
| SSO and live flight data are not connected | First shell | AWQ Cloud authorization/API contract is not deployed yet | Implement the approved SSO and read-only API contract |
| Aircraft `type_code` remains unavailable | Flight context panel | No authoritative fleet type catalog is populated | Load approved aircraft master mapping |
| Section titles are extracted heuristically and can absorb a trailing table caption | Assessment report, assistant citations | The clause number is the authoritative citation key; the title is supplementary | Add a per-document title allowlist when the manuals are next revised |
| Engineering metadata is shown in the operator's decision panel (`prompt` hash, model name, `similarity 0.842`, `FOUND BY EXACT TOKENS + SEMANTIC`) | Assessment result, assistant citations | Auditability was the intent and the printable report is the correct home for it | Move to a collapsed audit disclosure on screen |
| Clause citations are inert text (`References: OM Part A 8.1.2`) | Findings | The assistant is the only surface that holds clause text today | Make each reference open its retrieved excerpt inline |
| No favicon file exists; the mark is inlined as an SVG data URI | Document head | Avoids a second request and a 404, at the cost of a long `href` | Extract to `public/favicon.svg` if the mark changes |
| `--accent-primary` and `--status-warning` are the same value `#e6a93a`, so one amber means both "act" and "caution" | Palette, MARGINAL badge, warning chips | The accent is the brand line and the status ramp was built alongside it | Give warning a distinguishably deeper amber and demote all but one primary per state |
| `.assessment-result.is-stale { opacity: 0.45 }` measures 2.71:1 (`--text-secondary`) and 2.33:1 (`--text-tertiary`) over the panel | Assessment result, while a re-assess is in flight | The state is transient and its job is to read as superseded, which dimming communicates instantly | Raise to 0.7 (4.66:1) or mark staleness with a chip instead of opacity |
| `.dispatch-field input` is 36px at every viewport; `.document-row a` is 17px tall, below the WCAG 2.2 AA 24×24 target floor | Minima panel, document and reference lists | The mobile 44px rule was scoped to `.button` and the document-form controls | Extend the `≤767px` rule to `.dispatch-field input` and give the row links `min-block-size: 44px` |
| `#reference-upload-form` has no `hidden` attribute: the manual upload widget renders before authentication | Reference manuals panel | Predates this pass; the form is gated server-side by `authorizeUser` | Add `hidden` and unhide it only after a successful board fetch, as the document form already does |
| The board carries no verdict, finding count or reviewed state per flight, and no filter or sort | Active Flight Board | The board was built as a picker for the context panel | Add a verdict column and a needs-attention sort |
| Progress and failure notices are bare strings with no retry affordance | `#assessment-notice`, per-panel error text | The action that failed is still on screen | Put the retry on the notice |
| `renderFlightWeather` prints the upstream `validity.label` verbatim, so TAF validity notation is whatever AWQ Cloud sends while every other time on screen is `DDHHMMZ` | TAF cards | The label is upstream data | Normalise to `DDHHMMZ` at the render boundary |

## 9. Reference Corpus

Dispatch recommendations are grounded in the approved reference corpus rather than
in model memory, so retrieval quality is a product concern, not an implementation
detail. Segmentation rules live in `src/clause.ts`, are covered by `test/clause.spec.ts`, and
are applied to the live corpus by `scripts/segment-corpus.mts`.

### Embedding and retrieval

| Element | Choice | Why |
|---|---|---|
| Embedding model | `@cf/baai/bge-m3` (1024 dimensions) | Multilingual. The corpus mixes English and Indonesian, and an English-only model would silently lose recall on Indonesian queries. |
| Vector store | Vectorize index `awq-dispatch-corpus`, cosine | Dimension count is fixed at index creation and cannot change, so it is asserted at runtime against the model output. |
| Text location | Chunk text stays in D1; Vectorize holds identifiers only | Vector metadata is capped at 10 KiB with indexed fields at 64 bytes, so text cannot live in the index. Keeping it in D1 also means correcting a chunk does not require re-embedding it. |
| Retrieval | Hybrid: lexical (D1) + vector (Vectorize), fused by reciprocal rank fusion | Dense vectors are weak on exact identifiers (`121.635`, `RVR`) while lexical search cannot match a paraphrase ("runway visual range"). RRF needs no calibration between a cosine score and a lexical rank. |
| Lexical noise control | Tokens present in more than 2% of chunks are dropped, and a chunk must match at least two distinctive tokens | Measured on the live corpus, English function words (FOR, THE, ARE) otherwise matched nearly every chunk, and the abbreviation lists in OM clause `0.2` appeared in the top results of every question. |

### Query planning

The lexical noise filter above assumes the query and the corpus share a language: it
works because English function words appear in a large share of an English corpus. An
Indonesian question against the English corpus breaks that assumption — `APAKAH`,
`MASIH` and `BOLEH` appear in almost no chunk, so they are never recognised as common,
they survive as "distinctive", they consume the eight-token budget, and they match
nothing. The vector side absorbed this by choosing a multilingual embedding model; the
lexical side had no answer.

`src/query-plan.ts` closes that gap. The model receives the operator's question and
nothing else, and returns search terms in the manual's own English vocabulary
(`PLANNING MINIMA`, `HOLDING FUEL`, `TEMPO`). Those are appended to the tokens the
pattern extractor already found, so a plan can only widen the candidate set, never
narrow it.

Boundaries this holds:

| Constraint | How it is held |
|---|---|
| No corpus text reaches a provider | The prompt carries the question only. There is no field for clause text or an excerpt, and `test/query-plan.spec.ts` asserts the prompt contains no corpus string. |
| Retrieval never depends on a model | Every failure — no key, HTTP error, timeout, malformed body — returns `ok: false`, and the caller searches with the pattern tokens alone. |
| D1's 100 bound-parameter limit | The merged token set is capped at `MAX_LEXICAL_TOKENS = 12`, so the lexical statement binds `3T + 2 = 38` and the frequency probe `2T + 1 = 25`. |
| D1's 50-byte `LIKE` pattern limit | A term is capped at `MAX_TERM_CHARS = 46`, because the term is wrapped as `%TERM%`. A tighter bound would silently stop searching for a token the extractor had already accepted. |
| Reversible without a redeploy | `QUERY_PLAN_DISABLED=1` switches planning off. The audit record stores the planning mode and the terms actually searched, so a planned run can be compared against an unplanned one. |

Planning is skipped when the question contains a dotted clause number, because an exact
`clause_id` equality is already the strongest lexical signal and a model round-trip can
only add noise to it.

The vector side is deliberately untouched. Appending the planned terms to the embedded
text is a plausible further gain and is currently unmeasured, so it is left out until
there is a way to measure it against the live index.

Two Vectorize behaviours are handled in application code rather than at the index
boundary, both discovered by testing against the live index: `topK` is capped at 100,
and generation scoping is enforced by the D1 query that loads the quoted text rather
than by a vector metadata filter or by metadata read back from matches.

Indexing is resumable and reports progress through `embedding_status` on each chunk
row. Vectors are upserted before a chunk is marked `done`, so an interrupted run
leaves work to redo rather than chunks that claim to be indexed without a vector.

Re-run indexing with `POST /api/reference-index` (admin-only). Segmentation quality
and the clause baselines are re-checked with `npx tsx scripts/segment-corpus.mts`.

### Page numbers are not populated

`reference_document_chunks.page_number` exists but is NULL for every row, and the
original text extraction did not preserve page boundaries. This cannot be
reconstructed from the stored text: the Workers AI markdown conversion service
exposes only a `pdf.metadata` on/off switch and emits no page markers, and R2 holds
only the three source PDFs with no page map. Filling it would mean re-extracting all
three PDFs and re-embedding the whole corpus.

Deferred because the clause number is the authoritative citation key: `121.559` is
exactly checkable against CASR Part 121, whereas a page number is a convenience for
a human reader. If page citations are later required, the work is: re-extract with a
page-aware parser, map clauses to pages, and re-run ingestion and indexing.

| Document | Class | Clause scheme | Distinct clauses |
|---|---|---|---|
| Operations Manual Part A (IAA/FOP/M/001) | `operations-manual` | `om` | 1,641 |
| Flight Dispatch Manual (IAA/FOP/M/008) | `dispatch-manual` | `fdm` | 581 |
| CASR Part 121 (PM 61 Tahun 2017) | `regulation` | `casr` | 355 |

Clause attribution coverage — the share of stored chunks that carry a clause
identity, and therefore can be cited precisely: OM 99.9%, FDM 99.8%, CASR 96.8%.
The remainder is genuinely unnumbered front matter (cover page, contents,
appendices).

### Known data limitation: tables

The source text was extracted without table structure, and this is a data limit
rather than a retrieval or prompting problem. Measured cases:

- OM clause `1.4.2 Flight Operation Officer` is **30 characters** — a heading whose
  table body was never extracted. The content is absent from the corpus.
- OM clause `7.8.1 Duty Time Limitations` is **126 characters**. The `Table 7.8-1`
  values are largely absent.
- Where a table survives, its rows and columns are run together as prose:
  `Passenger seating accommodations: 61 through 200 3 201 through 300 4`. The values
  are present and in order, but nothing marks which number belongs to which column.
- Some tables are cleaner because the extractor emitted markdown pipes; OM clause
  `8.3.8.2.3.3` carries `Table 8.3-10` with `|` row and column markers intact.

Consequence for the UI: an excerpt that looks like a table may be unreadable, and a
value may be missing rather than merely misaligned. Appendix values must be verified
against the source PDF. No language model can recover text that was never extracted,
and none can reliably assign a number to a column when the column boundary is not in
the data. A generative model would improve how a table is *narrated*, not whether the
table is *complete*.

Re-extraction was evaluated and is viable: Workers AI markdown conversion on
CASR Part 121 produced 130 markdown table lines that are absent from the stored text,
including the hand-fire-extinguisher table. It would not restore the missing OM
tables by itself, and numeric cells still concatenate (`| 61 through 200201 through
300... | 345678 |`). Deciding to re-extract means re-running ingestion and indexing
for the whole corpus, and re-validating segmentation against markdown-formatted text.

### Generation semantics

`ingest_version` distinguishes generations. Version 1 is the original extraction;
version 2 is clause-aware segmentation. The re-segmentation corrected in this work
was applied **in place** to version 2 (`DELETE` then `INSERT` at the same version),
which means version 2 is no longer the pre-fix clause-aware generation and cannot be
used as a rollback target. Version 1 remains intact. A future re-ingestion should
write a new version rather than reuse one.

Re-check segmentation quality and regenerate ingestion SQL with
`npx tsx scripts/segment-corpus.mts --emit-sql`.

Generational writes: chunk rows carry `ingest_version`. Clause-aware ingestion
writes version 2 while the original version 1 stays readable, the Worker selects a
generation through `CHUNK_INGEST_VERSION` in `src/index.ts`, and rollback means
lowering that constant. `UNIQUE (reference_document_id, ingest_version, chunk_index)`
is what makes a second generation possible at all.

### Confidentiality

Both IAA manuals are marked `CONFIDENTIAL` and are the property of PT Indonesia
AirAsia. Any step that sends corpus text to a model provider outside the existing
infrastructure is a compliance decision, not only an engineering one, and needs
approval before it is built. See section 10.

## 10. Dispatch Recommendations

Status: implemented. The evaluation workflow (ETA windows, TAF change groups, minima,
fuel) is enforced by a deterministic engine, and a language model only writes it up.

### The engine is the authority

| Module | Responsibility |
|---|---|
| `src/taf.ts` | Decodes TAF validity and change groups (`FM`, `BECMG`, `TEMPO`, `INTER`, `PROB`), and reports the prevailing conditions and the conditional deteriorations inside one time window. |
| `src/dispatch.ts` | Computes the ETA windows, compares weather against landing and alternate planning minima, applies the `INTER`/`TEMPO` holding-fuel rule, gates on NOTAM, and reduces the findings to `GO` / `NO-GO` / `MARGINAL`. |
| `src/awq.ts` | Translates the AWQ Cloud payloads into the engine contract, treating everything upstream as untrusted and recording every date it had to infer or correct. |

Rules are cited, not asserted: every finding carries the clause identifiers that
justify it (`OM Part A 8.1.2`, `CASR 121.639`, …), and each rule was written against a
clause read from the indexed corpus rather than from memory.

`NO-GO` requires a finding that is both critical and explicitly incompatible with
release. A condition that merely could not be assessed — no minima supplied, no NOTAM
provided, a schedule date that still needs confirming — degrades the verdict to
`MARGINAL`. An unknown is never presented as a violation, and never as a clean result,
which is also why `GO` is unreachable while any check is unverified.

The controls in `src/findings.ts` were carried over rather than dropped when this
engine replaced them: TAF currency and weather-monitoring freshness are now inputs
supplied by `src/awq.ts`, so migrating did not silently remove a check.

### The model explains; it does not decide

`src/explainer.ts` sends the finished assessment to DeepSeek and asks for a written
report. Three constraints are enforced rather than merely requested in prose:

- **The verdict is fixed.** The prompt states the verdict must be reproduced exactly
  and never upgraded or downgraded, and that instruction is covered by a test.
- **Corpus text does not leave the Worker.** `ExplainerInput` has no field for clause
  text: only clause *identifiers* and operational weather values are transmitted, and
  the application shows the excerpt from D1. A test asserts the prompt carries no
  corpus string, including the manual's confidentiality footer.
- **An AI outage degrades the write-up, not the decision.** A missing key, a timeout,
  a malformed response or a provider error produce `explanation.ok === false` with a
  machine-readable reason. The deterministic assessment is stored regardless.

Each call returns the model name and a SHA-256 hash of the exact prompt, so a
recommendation can be reproduced and audited after the fact.

### Provider

The planned internal CIZ-AI gateway was replaced by the DeepSeek API
(`api.deepseek.com`) at the operator's direction. The data-minimisation rule above is
the compensating control that makes that acceptable: the confidential manuals are
never transmitted, and only clause identifiers leave the Worker. Provider and model
are configuration in `src/explainer.ts`, so returning to the internal gateway later is
a configuration change rather than a rewrite.

### Known limits

- Per-aerodrome minima values are **not** in the corpus (the minima tables did not
  survive extraction), so they are entered manually today and are expected to come from
  airport charts later. The corpus supplies the minima *rules*, which are what the
  findings cite.
- `ILS U/S` is not yet decoded into a minima downgrade (OM Part A `Table 8.1-17`);
  only a runway or aerodrome closure is detected from remarks.
- Crosswind and tailwind components are not computed, because runway-in-use is not
  part of the payload. Aircraft `type_code` is still absent, so minima cannot be
  selected by aircraft category.
