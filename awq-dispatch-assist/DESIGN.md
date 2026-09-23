# AWQ Dispatch Assist Design System

## 0. Research Log

- Embedded refs: shortlisted `sentry.md`, `linear.app.md`, and `ibm.md`; picked the operational discipline of `taste-skill.md` with `sentry.md` as the closest data-dense product reference.
- Lazyweb: skipped because this first slice is an internal operational shell with no external visual reference to clone.
- Imagen drafts: skipped because the product surface is functional and does not need marketing imagery or decorative hero art.
- Style direction: dark operations cockpit, adapted from Sentry's technical density without copying its brand colors, copy, or assets.
- Second pass (release 1): the visual world is unchanged and stays incumbent. The work was a **layout and surface change**, not a redesign: the identity, palette, type ramp, motion budget and depth strategy in §1–§8 were preserved, and §11 records what the decision workspace became. The dark cockpit stays because the use scene demands it — a dispatcher reads this at a desk in an operations room, often at night, next to a dark flight board.

## 1. Atmosphere & Identity

AWQ Dispatch Assist feels like a quiet flight operations desk: focused, legible, and calm under pressure. The signature is a thin amber flight-line accent that marks the selected flight on the board while the rest of the interface stays restrained.

Design read: internal aviation operations dashboard for dispatch operators, with a dark technical language and a low-glare control-room surface.

Design dials: `DESIGN_VARIANCE 3`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 7`.

The screen is a **single decision column**, read top to bottom in the order the work is done: board, context, weather, minima, verdict. Two consequences are deliberate and load-bearing:

- The outcome summary is a **pinned strip** directly under the header. The assessment is read while its findings are on screen, so the outcome cannot scroll away from the evidence it is drawn from.
- The **inputs sit above the output**. The alternate and minima that determine the outcome are selected before the assessment, not below the badge they produced.
- **Inputs moved into the sidebar and out of the decision column** in release 1. The dispatcher reads the analysis in the main column and reaches for `Flight context` and `Assessment details` when a value needs changing, so selecting an alternate no longer pushes the destination weather off the first screen.

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

### Outcome strip

- Structure: outcome badge, flight identity, ETA windows, and the printable-report action.
- Variants: `GO`, `MARGINAL`, `NO-GO`, `REVIEW REQUIRED`, `NOTAM REVIEW PENDING`.
- Why the vocabulary changed: the earlier `NO_DATA` badge collapsed "nothing was checked" and "nothing could be checked" into one state, and `MARGINAL` was reachable without a rule that stated a threshold. Release 1 uses the five states the product specification names, and each one has a text label and an icon so the colour is reinforcement rather than the message.
- States: hidden until an assessment exists; cleared when the selected flight changes.
- Accessibility: the text half is `role="status" aria-live="polite"`, so a new outcome is announced.
- Motion: none.
- Layout: `position: sticky; top: 0` inside the scroll owner, so it stays under the header at any scroll position and at any viewport, phone included. It floats, so it declares elevation with a shadow and no border.

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

### Minima selection and confirm-before-use

- Structure: a destination approach picker, an alternate picker, and a `Confirm selection` action; each picker is a labelled `<select>` of the **approved** records for one aerodrome. The value is a record id, never a typed number.
- Why a picker and not fields: a minima value is a published chart value with a provenance obligation. Typing a ceiling into a field produced a number with no source and no approval, which is precisely the state the registry exists to prevent. The select's options carry the record's own labels, and a record that is not approved is rendered `disabled` with the reason.
- Confirm-before-use: the pending selection is shown in a summary band carrying the record id, the applied ceiling and visibility, the chart identifier, the page, the AIP cycle, the effective date and the approval state. Selecting from the list does not commit; confirming does. Without this step a mis-click on a long airport list silently changes the assessment.
- Variants: no flight selected (guidance), flight selected with no records (unavailable with the reason), records present, record selected and pending confirmation, confirmed.
- Accessibility: the legend names each group; the summary is a `<dl>`; the confirm action is keyboard reachable and its focus ring is visible.
- Motion: none.

### Change-group disclosure

- Structure: a `<details>` element per conditional group (`TEMPO`, `PROB30 TEMPO`, `INTER`), with the group type and validity in the `<summary>` and the decoded conditions in the body.
- Why a disclosure and not a column: the prevailing conditions are what the dispatcher reads first, and a change group's period is a second-order fact. Printing every group flat pushed the minima comparison below the fold on a laptop.
- The disclosure is a native `<details>`, so it is keyboard operable and announced correctly without scripted ARIA.

### NOTAM review

- Structure: one row per candidate NOTAM with a checkbox, the aerodrome, the validity, and the raw text; nothing is checked on the dispatcher's behalf.
- Why manual: the product specification has the dispatcher select the applicable NOTAM. The list is filtered by aerodrome and by validity overlap, so the filter is a convenience and the selection remains a judgement.
- States: never reviewed (renders `NOTAM REVIEW PENDING` and says in words that this is not a statement that NOTAM is clear), reviewed with a selection, reviewed with a closure finding.
- Accessibility: each checkbox has a label naming its NOTAM id; the pending banner is a live region.

### Assessment result

- Structure: outcome badge, context hash, ETA windows, fuel requirement, findings with citation numbers, written narrative, data-quality disclosure, and the numbered citation list at the end.
- Not a card: the panel is the container, and the findings are the list items. A bordered box inside a bordered panel is a card in a card.
- Citations: each finding carries `[n]` markers assigned by first appearance, and the full list is printed once at the end of the assessment. The number is placed next to the claim rather than in a footnote at the bottom, so a reader can check a source without hunting.
- States: awaiting input, stale (dimmed while a new snapshot is built), resolved, and a notice line for progress or failure.
- Accessibility: `aria-live="polite"` on the result, so a new outcome is announced; `Accept` and `Reject` are `disabled` until an assessment exists.
- Rule: **a failed or in-flight re-assess never overwrites a rendered outcome.** Progress and errors are written to the notice line; the previous outcome is dimmed, not destroyed.
- Rule: **the rendered assessment is read from the saved snapshot, not from live state**, because the printable report is rendered from that same snapshot. Rendering one from live state and the other from the snapshot is how a report stops matching the assessment it claims to reproduce.

### Minima registry

- Structure: an aerodrome list with approved/draft counts, then records grouped by chart with my minima values, a status chip, the extractor's source fragment, and the confidence; an inspect panel for field-by-field correction, approval and rejection with a note; and the record's audit history.
- Why the extractor's source fragment is on the row: chart text is flattened, so a value can sit beside the wrong row label. Measured on the real charts, three models read the same RVR note three different ways. The fragment is the claim the reviewer checks, so it belongs next to the value and not in a log.
- Why a draft is inert: a draft's option is `disabled` in every picker, and the row states that it cannot be used. This is a visual expression of a storage rule (only `approved` rows are read by an assessment), repeated in the interface so the reason is never a surprise.

### Status band

- Structure: text label, an inline SVG icon, and the semantic status color.
- Variants: current, stale, unavailable, error, pending review, blocked.
- States: default and focus when actionable.
- Accessibility: status text is explicit and announced through `aria-live` only for changes; the icon is `aria-hidden` because the label already carries the meaning.
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
| Aircraft `type_code` remains unavailable | Flight context panel | No authoritative fleet type catalog is populated | Load approved aircraft master mapping |
| Section titles are extracted heuristically and can absorb a trailing table caption | Assessment report, assistant citations | The clause number is the authoritative citation key; the title is supplementary | Add a per-document title allowlist when the manuals are next revised |
| Engineering metadata is shown in the operator's decision panel (`prompt` hash, model name, `similarity 0.842`, `FOUND BY EXACT TOKENS + SEMANTIC`) | Assessment result, assistant citations | Auditability was the intent and the printable report is the correct home for it | Move to a collapsed audit disclosure on screen |
| Clause citations are inert text (`References: OM Part A 8.1.2`) | Findings | The assistant is the only surface that holds clause text today | Make each reference open its retrieved excerpt inline |
| No favicon file exists; the mark is inlined as an SVG data URI | Document head | Avoids a second request and a 404, at the cost of a long `href` | Extract to `public/favicon.svg` if the mark changes |
| `--accent-primary` and `--status-warning` are the same value `#e6a93a`, so one amber means both "act" and "caution" | Palette, `MARGINAL` badge, warning chips | The accent is the brand line and the status ramp was built alongside it | Give warning a distinguishably deeper amber and demote all but one primary per state |
| The flight board stays above the analysis after a flight is selected, so on a phone it fills the first screen before the destination weather appears | Decision workspace | The board is the entry point and a dispatcher routinely switches flights, so keeping it open is defensible; collapsing it changes the panel order the product specifies | Collapse the board to a one-line summary once a flight is selected, with an expand control, and re-check the panel order requirement |
| `POST /api/reference-ingest` and `POST /api/reference-index` have no UI control | Reference manuals | They were not part of the release-1 surface, and adding one introduces a destructive admin action with no confirmation design yet | Add an explicit, confirmation-gated admin control when the corpus is next revised |
| Extraction latency is unproven: the Workers AI conversion was measured at 0.2-1s per chart, yet two production runs still hit the 120s budget, which places the variable cost in the DeepSeek call | Minima registry | The transcription is correct and a draft is inert, so latency has no safety consequence; one chart per request means a slow chart cannot fail the others, and a retry is a visible per-chart action rather than a silent loss | Move the conversion and the model call into a Queue consumer, write the drafts from the consumer, and poll a status endpoint from the registry view |

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
exposes only a `pdf.metadata` on/off switch and emits no page markers, and R2 holdsonly the three source PDFs with no page map. Filling it would mean re-extracting all
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

## 10. The deterministic assessment

Status: implemented. The evaluation workflow (ETA windows, TAF change groups, minima,
fuel) is enforced by a deterministic engine, and a language model only writes it up.

### The engine is the authority

| Module | Responsibility |
|---|---|
| `src/taf.ts` | Decodes TAF validity and change groups (`FM`, `BECMG`, `TEMPO`, `INTER`, `PROB`), and reports the prevailing conditions and the conditional deteriorations inside one time window. |
| `src/dispatch.ts` | Computes the ETA windows, classifies the destination change groups against OM Part A Table 8.1-20 (continued), compares weather against the approved landing minima and the alternate planning minima, applies the destination-alternate TEMPO holding rule and the standard fuel padding, and reduces the findings to an outcome. |
| `src/minima.ts` | The minima types and the two company minima rules: the alternate planning minima of OM Part A Table 8.1-5, and the "higher of the chart's published alternate minima or the company minima" note beneath it. |
| `src/minima-registry.ts` | The minima registry: approved-only reads for the engine, draft insertion for extraction, ADMIN correction and approval with a full audit history. |
| `src/awq.ts` | Translates the AWQ Cloud payloads into the engine contract, treating everything upstream as untrusted and recording every date it had to infer or correct. |

Rules are cited, not asserted: every finding carries the clause, table or chart
reference that justifies it, and each rule was written against a clause read from the
indexed corpus rather than from memory. **No reference in this product points at CASR**
— the agreed sources are Operations Manual Part A (`IAA/FOP/M/001`) and the Flight
Dispatch Manual (`IAA/FOP/M/008`), with the AIP chart supplying numeric minima values.

### The outcome vocabulary is deliberate

| Outcome | Reached when |
|---|---|
| `NO-GO` | A finding is both critical and explicitly incompatible with the rule. |
| `REVIEW REQUIRED` | A required minima value, a required citation, a NOTAM selection, an alternate selection, or a readable TAF is missing. Also used where the manual states no threshold, because a synthetic middle band would be invented policy. |
| `NOTAM REVIEW PENDING` | The only outstanding item is that no NOTAM has been reviewed. Reported as its own outcome so it can never be read as "NOTAM clean". |
| `MARGINAL` | A finding is marked as a condition the manual states, such as a conditional deterioration that reaches below the minima. |
| `GO` | Every required check was evaluated and none produced a finding. |

The order of those tests is the safety property: missing data outranks a pending NOTAM
review, which outranks a sourced marginal condition. A `GO` is unreachable while any
check is unverified, and an unknown is never presented as a violation.

### The model explains; it does not decide

`src/explainer.ts` sends the finished assessment to DeepSeek and asks for a written
report. Three constraints are enforced rather than merely requested in prose:

- **The outcome is fixed.** The prompt states the outcome must be reproduced exactly
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

The same gateway is used for minima extraction (`src/minima-extraction.ts`) and for
query planning (`src/query-plan.ts`). Model choice is configuration in each module.

### Extraction runs in a Queue, not on the request path

Measured against the real charts, a chart costs 81 to 130 seconds end to end. On the
request path that exceeded the budget four times out of seven, and every loss reached
the dispatcher as a failed click. The work therefore moved to a Queue consumer:

| | On the request path | In a Queue consumer |
|---|---:|---:|
| Wall-clock budget | One response | 15 minutes |
| YPKG charts extracted in one run | 3 of 7 | **7 of 7** |
| Average per chart | 121s (timeouts) | 138s |
| Failure shape | A lost click | A job row with a reason |

`max_batch_size: 1` is deliberate: each message is a whole chart, so one message per
invocation keeps a slow chart from holding up a batch and makes a retry mean exactly
one chart. The consumer acknowledges a *recorded* failure — a job row that says what
happened is a completed attempt — and only calls `retry()` when the job row itself
could not be updated, because that is the one case where the status is genuinely
unknown.

`airport_minima_extraction_jobs` is the client's view of the work. It is separate from
the registry on purpose: a job records an attempt, and the registry records values, so
a failed attempt cannot be mistaken for a reviewable record. The consumer writes
drafts through the same `insertDrafts` path the request used, so completing a job still
cannot approve anything.

Also measured: the `deepseek-chat` model produced minima values that contradicted both
other models on the same chart, so the API accepts a model only from an allow-list
(`deepseek-flash`, `deepseek-reasoner`) rather than a free-text identifier. The value
reaches a provider as a model name, and an arbitrary string is an arbitrary outbound
request.

### Chart text is the limit, and it is a real limit

The models disagree about the same minima table, and the disagreement is the reason the
human approval step exists. On `YPPH RNP RWY 24`, the hardest chart measured:

| | `deepseek-flash` | `deepseek-reasoner` |
|---|---:|---:|
| Records produced | 32 | 22 |
| Records carrying a value | 16 | **22** |
| Records carrying **both** ceiling and visibility | 4 | **22** |

The difference is one reading rule. The chart prints `560 (502-1.9)`: 560 ft, with the
parenthesised group carrying the visibility in metres. `deepseek-flash` reported the
height and left the visibility null, saying the printed unit could not be read;
`deepseek-reasoner` read the notation and produced 502 m. The prompt now states the
notation explicitly, as a reading rule for how the chart formats its values rather than
a licence to infer anything.

Neither model is authoritative. `deepseek-reasoner` divided the circling minima between
category pairs (`760/1440 ft` with `693/1193 m`) on a chart whose extracted text has no
column alignment, which is a structured guess rather than a transcription. Every
extracted row therefore still quotes its source fragment, and the reviewer still
compares it against the PDF before approving. The measured disagreement is the argument
for that control, not a problem the control fails to solve.

A second consequence worth knowing when reviewing: the two models label the same
approach differently — `RNP RWY 24 LNAV` versus `LNAV` — so a re-extraction with a
different model adds slots rather than replacing them. The dedup key is
(chart, approach, runway, category, kind) and therefore does not treat the two as the
same value, which is correct: they are different claims about the same chart, and both
should be visible until one is approved and the other superseded.

### Known limits

- `ILS U/S` is not decoded into a minima downgrade (OM Part A `Table 8.1-17`); only a
  runway or aerodrome closure is detected from a selected NOTAM.
- Crosswind and tailwind components are not computed, because runway-in-use is not part
  of the payload. Aircraft `type_code` is still absent, so a minima record cannot be
  selected by the aircraft type automatically — the dispatcher picks the category.
- The alternate's weather is matched by station, and the AWQ Cloud payload carries a
  forecast for the alternate the flight plan nominated plus the en-route alternates.
  Selecting an alternate the payload has no forecast for produces an explicit
  unavailable state rather than a comparison against another station's weather.
- Different extraction models label approaches differently, so re-extracting a chart
  with a second model adds registry slots rather than replacing the first model's. Both
  are visible for review; approving one supersedes only records sharing its slot key.

## 11. The minima registry and release 1

### Why the registry exists

The minima *rules* live in the corpus. The minima *values* do not: the AIP approach
charts are the numeric source, they exist as PDFs in R2 under `airport/`, and the PRD
forbids both a Markdown sidecar and any guessed value. So the values have to be
transcribed into structured records, and a transcribed number that reaches a safety
comparison without a human having checked it against the chart is the failure mode this
whole feature exists to prevent.

Measured behaviour of the extraction, on the real YPPH charts:

| Model | Draft rows from `ILS-Z RWY 21 - PAGE 2` | Agreement |
|---|---:|---|
| `deepseek-flash` | 16 | correctly read `DA 143 (100) RA102` at 300 RVR, `DA 193 (150)` at 450 RVR, and the 75 RVR CAT IIIb line |
| `deepseek-reasoner` | 16 | same decision heights, but attached the `CAT A-C 350 / CAT D 400` RVR note to a different minima line |
| `deepseek-chat` | 12 | produced 143 / 75 RVR pairs that contradict the other two |

All three returned `null` for the CAT IIIb decision height rather than inventing one,
and all three set confidence to `low` with a written explanation of the ambiguity. That
is the behaviour the prompt asks for, and it is also the evidence for the design
decision that follows: **the models disagree, so the approval step is load-bearing and
the interface must make the disagreement cheap to resolve.**

Two consequences, both implemented:

1. Every extracted row carries the **exact chart fragment** the extractor says the
   values came from, stored in `airport_minima.source_text`, included in the content
   hash, and printed on the record row. The reviewer checks the number against the
   chart; the fragment is the claim they check.
2. **A draft is inert everywhere.** The engine reads only `status = 'approved'`, the
   picker renders a non-approved record as `disabled` with the reason, and approving a
   record requires a stated value — a record with neither a ceiling nor a visibility
   cannot be approved, because an approved empty record reads as usable minima while
   comparing nothing.

### Registry data model

`airport_minima` holds one row per minima value with its provenance: AIS authority,
country, ICAO, chart identifier, chart page, runway, approach, approach type, aircraft
category, kind (`landing` or `alternate`), ceiling and visibility with the value type,
AIP cycle, effective dates, the R2 object key and PDF hash, the extracting model, its
confidence and its source fragment, the review notes, the approval identity and time,
and a content hash over the fields a reviewer verifies.

`airport_minima_audit` records every change with the value before and after: extracted,
corrected, approved, rejected, superseded. Correcting an approved record returns it to
`draft` and clears the approver stamp, because the value that was approved is no longer
the value on the record. Approving a record supersedes any other approved record for the
same chart slot, so the engine never has two competing values to choose between.

The assessment snapshot stores the record id and content hash of every minima value it
applied, so a stored outcome remains traceable to the exact approved revision it used
even after the record is later corrected.

### What release 1 changed structurally

The decision workspace was one column in the order the work is done. It is now two
panels: the analysis column, and a sidebar with `Flight context` and `Assessment
details`. The reason is measured rather than stylistic — the minima and alternate
inputs sat between the weather comparison and the assessment, so on a 1440×1000 laptop
the fuel recommendation and the minima section were both below the fold, and a
dispatcher changing the alternate scrolled the destination weather off screen to do it.

Breakpoints and behaviour:

| Viewport | Layout |
|---|---|
| ≥1024px | Analysis column plus a collapsible sidebar. Collapsing the sidebar widens the analysis column rather than leaving a gutter. |
| 768–1023px | The sidebar becomes an overlay drawer with a scrim; the analysis stays the main area. Escape, the scrim and the close control all dismiss it, and the drawer is `inert` while closed so its controls are not reachable by keyboard behind the scrim. |
| <768px | Single-column analysis. The sidebar is a full-screen drawer, and the outcome summary stays pinned while the page scrolls. |

The outcome summary lives outside every view, pinned under the header, so it cannot be
scrolled away while the evidence it summarises is on screen.

### Reflow: the defect that was measured rather than seen

The first build of the two-panel layout scrolled the whole document sideways by 461px
at 390px wide and 349px at 834px. Both had one cause, and it is worth recording because
the symptom does not point at it: `.primary-nav` is a horizontal scroll container
(`overflow-x: auto`), and a scroll container's automatic minimum size is its **content**
width, not zero. As a flex item it therefore refused to shrink, so the header measured
851px inside a 390px viewport and dragged the document's scroll width with it. The fix
is `min-inline-size: 0` on the header and the nav, applied in both the tablet and phone
blocks.

A second, smaller cause was the outcome strip: a 320px flex basis on
`.outcome-strip-main` could not fit beside a 323px action row, so on a phone the strip's
row is now allowed to take the full width and the actions wrap beneath it.

Measured after the fix, with a real ADMIN session against production:

| Viewport | Document scroll width | Element overflow |
|---|---:|---|
| 1440×1000 | 1440 (= client) | 0px |
| 834×1112 | 834 (= client) | 0px |
| 390×844 | 390 (= client) | 0px |

No console errors on any of the three, desktop and mobile drawer states both captured.
The counter-check is part of the method: after the fix the diagnostic found no element
past the right edge, starting left of the viewport, or wider than it — a previous pass
had reported "no element overflows" while the document still scrolled, because it only
checked the right edge and missed a drawer parked off-canvas by a transform.

### What the release-1 verification found

The verification is reported in full rather than summarised, because three of the
findings were defects that a passing test suite did not catch:

| Finding | How it surfaced | Resolution |
|---|---|---|
| The report's disclaimer said it was not an airworthiness determination but never used the words "dispatch release" | A smoke assertion looking for the phrase the PRD uses | The rendered report now states "This is an assessment outcome and not a dispatch release" |
| CASR Part 121 was still listed as an indexed reference manual, in the library view and in every report | A smoke assertion on the **rendered** text rather than the HTML, which is where the leak was visible | One shared exclusion (`src/reference-corpus.ts`) applied to retrieval, the snapshot and the library list; the CASR rows stay in D1 so the ingestion history remains readable |
| The document scrolled sideways on tablet and phone | Measuring `scrollWidth - clientWidth` per viewport instead of eyeballing a screenshot | The `min-inline-size: 0` fix above |

Each of those was found by asserting on what a reader sees, not on what the server
returned, which is the reason the smoke test renders the report and measures the layout
rather than only checking status codes.
