# AWQ Dispatch Assist Design System

## 0. Research Log

- Embedded refs: shortlisted `sentry.md`, `linear.app.md`, and `ibm.md`; picked the operational discipline of `taste-skill.md` with `sentry.md` as the closest data-dense product reference.
- Lazyweb: skipped because this first slice is an internal operational shell with no external visual reference to clone.
- Imagen drafts: skipped because the product surface is functional and does not need marketing imagery or decorative hero art.
- Style direction: dark operations cockpit, adapted from Sentry's technical density without copying its brand colors, copy, or assets.

## 1. Atmosphere & Identity

AWQ Dispatch Assist feels like a quiet flight operations desk: focused, legible, and calm under pressure. The signature is a thin amber flight-line accent that marks the selected operational context while the rest of the interface stays restrained.

Design read: internal aviation operations dashboard for dispatch operators, with a dark technical language and a low-glare control-room surface.

Design dials: `DESIGN_VARIANCE 3`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 7`.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|---|---|---:|---|
| Surface primary | `--surface-primary` | `#11161d` | Application canvas |
| Surface secondary | `--surface-secondary` | `#171e27` | Workspace panels |
| Surface elevated | `--surface-elevated` | `#202a35` | Menus and selected context |
| Text primary | `--text-primary` | `#f2f5f7` | Headings and values |
| Text secondary | `--text-secondary` | `#aab6c2` | Supporting information |
| Text tertiary | `--text-tertiary` | `#71808d` | Hints and unavailable values |
| Border default | `--border-default` | `#30404d` | Panel and control outlines |
| Border subtle | `--border-subtle` | `#24313c` | Internal separation |
| Accent primary | `--accent-primary` | `#e6a93a` | Selection, primary action, focus |
| Accent hover | `--accent-hover` | `#f1bd5a` | Hover state |
| Status success | `--status-success` | `#5ec28b` | Available or current |
| Status warning | `--status-warning` | `#e6a93a` | Attention or stale data |
| Status error | `--status-error` | `#e47777` | Failed requests |
| Status info | `--status-info` | `#78b7d8` | Informational state |

The page stays dark. Status colors are semantic and are not decorative accents.

## 3. Typography

| Level | Size | Weight | Line height | Usage |
|---|---:|---:|---:|---|
| Display | 32px | 700 | 1.1 | Page title |
| H1 | 24px | 700 | 1.2 | Workspace title |
| H2 | 16px | 700 | 1.3 | Panel heading |
| Body | 14px | 400 | 1.5 | Operational copy |
| Body small | 12px | 400 | 1.4 | Supporting text |
| Label | 11px | 700 | 1.3 | Uppercase field labels |
| Data | 14px | 600 | 1.3 | Callsigns, codes, times |

Primary: `ui-sans-serif`, `system-ui`, `Segoe UI`, sans-serif. Data: `ui-monospace`, `SFMono-Regular`, `Consolas`, monospace. No remote font dependency in the first slice.

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

The app uses a fixed header and a single scroll owner: `.workspace-scroll`. The shell is bounded by `100dvb`; the main grid uses `minmax(0, 1fr)` and `min-inline-size: 0` so long operational values cannot create horizontal overflow.

Breakpoints: `sm 640px`, `md 768px`, `lg 1024px`, `xl 1280px`.

## 5. Components

### App shell

- Structure: fixed header, scrollable workspace, responsive two-pane grid.
- Variants: desktop two-pane, mobile stacked.
- States: normal, loading, unavailable, error.
- Accessibility: landmark header and main, visible focus, keyboard order follows reading order.
- Motion: no automatic motion; focus and pressed states use color and transform only.
- Layout: `scroll-body-shell`; `.workspace-scroll` owns vertical scroll.

### Flight board row

- Structure: semantic button with callsign, route, schedule, and board state.
- Variants: selected, available, unavailable.
- States: default, hover, active, focus, disabled.
- Accessibility: button label contains callsign and route; selected state uses `aria-pressed`.
- Motion: 120ms color and transform feedback.
- Layout: row inside the board list; board list does not create a second page scrollbar.

### Context panel

- Structure: heading, status band, grouped operational fields, empty values.
- Variants: no flight selected, flight selected, stale context, request error.
- States: loading skeleton, empty, error, resolved.
- Accessibility: field labels remain visible; unavailable values use text, never color alone.
- Motion: none beyond status transitions.
- Layout: panel in the detail region; content reflows to one column below `768px`.

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

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA target.
- Body text contrast minimum 4.5:1.
- Every interactive element is keyboard reachable and has a visible focus state.
- No operational value is communicated by color alone.
- Primary content reflows to one column at 375px with no horizontal scroll.
- Reduced motion is respected.

### Accepted Debt

| Item | Location | Why accepted | Exit |
|---|---|---|---|
| SSO and live flight data are not connected | First shell | AWQ Cloud authorization/API contract is not deployed yet | Implement the approved SSO and read-only API contract |
| Aircraft `type_code` remains unavailable | Context panel | No authoritative fleet type catalog is populated | Load approved aircraft master mapping |
| `--text-tertiary` measures 3.58–4.47:1, below the 4.5:1 target | Field labels, panel counts, document metadata | Token predates the contrast check; changing it shifts the whole palette | Retune the token and re-verify all three surfaces |
| Section titles are extracted heuristically and can absorb a trailing table caption | Assessment report, assistant citations | The clause number is the authoritative citation key; the title is supplementary | Add a per-document title allowlist when the manuals are next revised |

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
