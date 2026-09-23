# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the flight dispatcher on shift.** One person, at a desk in an operations room, usually with several flights open at once and a departure clock running. They already have the AWQ Cloud flight board and the company manuals; what they lack is one place where the weather, minima and NOTAM for *one selected flight* are brought together against the rules, with the sources named. They are experienced readers of a TAF and an AIP chart, so the product optimises for their speed, not for teaching them the domain. Access is restricted to AWQ accounts with `ADMIN` role.

**Supporting: Duty Manager, Flight Operations Manager, and Safety/Compliance reviewers.** They read a finished assessment and its evidence, usually after the fact, and need it to be reproducible and printable.

## Product Purpose

Dispatch Assist turns a selected flight into a traceable, reviewable **assessment outcome**. It computes ETA windows from the flight's own schedule, evaluates the destination and one primary alternate against approved AIP minima and the TAF change groups, applies the company fuel rules that carry a complete citation, and offers an AI assistant that explains the result and answers questions from the indexed manuals.

Success is a dispatcher who can state *why* the outcome is what it is, and a reviewer who can check every number in it months later. The product is explicitly **not** a dispatch release and **not** a compliance certification, and it never says otherwise.

## Positioning

Two things a neighbouring tool could not truthfully copy:

1. **The deterministic engine owns the outcome and the model only writes it up.** The TAF change-group classification, the ETA windows, the minima comparisons and the fuel figures are computed by rules in code; the language model receives the finished result and is forbidden from changing it. So the same inputs always produce the same outcome.
2. **No numeric value reaches an assessment without a human approval against the source PDF.** AIP chart minima are transcribed by AI into a registry as *drafts*, and only an `ADMIN` dispatcher comparing the draft against the chart can approve it. A draft is inert. Unapproved, missing or stale minima produce `REVIEW REQUIRED`, never a silent pass.

A third property follows from the rule-source decision: CASR is not a reference for this product. The rule sources are Operations Manual Part A (IAA/FOP/M/001) and the Flight Dispatch Manual (IAA/FOP/M/008), and the AIP chart is the numeric source.

## Operating Context

- Flights come from the **AWQ Cloud active flight board**, chosen by the dispatcher. The board's `std`/`sta` fields are untrustworthy as dates (they can be stale by weeks) and `dof` is the operator-controlled date of flight.
- **Weather** comes from AWQ Cloud as raw TAF text per role (Departure, Destination, Destination alternate, Enroute alternate N) plus a weather-monitoring block with SIGMET/volcanic-ash/TC advisories already evaluated for route impact.
- **NOTAM** are read from AWQ Cloud's own NOTAM table and **selected manually** by the dispatcher, filtered by aerodrome and validity.
- **Minima** come only from the minima registry, whose source files are AIP approach-chart PDFs in the R2 bucket `awq-dispatch-documents` under the `airport/` prefix. Those PDFs are the only source files; there is no Markdown sidecar and the R2 objects are never rewritten.
- **Rules** are read out of the indexed corpus (OM-A, Flight Dispatch Manual) and every finding cites the clause or table it rests on, including the printed page where the corpus records it.
- The dispatcher works against **Zulu time**; every time on screen is `DDHHMMZ`.
- Assessments are **immutable snapshots**. The printable report is rendered from the stored snapshot, so it matches what was reviewed even after live data moves on.

## Capabilities and Constraints

**In scope for the first release**

- ETA windows: destination `STA ± 1 hr`; primary alternate `STA + diversion ± 1 hr`, or `STA +1 hr` to `+3 hr` with a stated 2-hour default when the feed publishes no diversion time.
- Destination TEMPO/PROB classification per OM-A Table 8.1-20 (continued), page 8.1-47, applied to the destination only.
- The destination alternate TEMPO concession of OM-A 8.1.6 b.iii, with its three conditions and the additional 30 minutes of holding fuel.
- The standard FUEL PADDING criteria of FDM 5.11, page 5.11-16 (10 minutes @ 1500 ft), itemised per matched criterion.
- The minima registry: AI extraction from chart PDFs, ADMIN review and correction, approval with recorded approver and time, full audit history, and supersede-on-replace.
- Manual NOTAM selection with airport and validity filtering.
- Assessment outcomes: `GO`, `NO-GO`, `MARGINAL`, `REVIEW REQUIRED`, `NOTAM REVIEW PENDING`.
- Immutable snapshot per assessment, and a formal printable report.
- A grounded knowledge assistant over the indexed manuals, answering in English or Indonesian.

**Out of scope, deliberately**

- Fuel burn rate per aircraft and any conversion of fuel time to kilograms.
- Runway-in-use, wind-component and crosswind/tailwind computation.
- Secondary alternates (the payload does not carry one).
- Automatic alternate nomination: the dispatcher selects the alternate.
- The TAF3 exemption.
- CASR as a rule source.
- Any `TEMPO`-without-alternate holding figure. No company rule stating one was found, so the product does not state one.

**Hard constraints**

- Every finding carries at least one clause, table or chart reference. A rule without a complete citation produces `REVIEW REQUIRED` rather than a finding.
- A missing ceiling or visibility from a chart is stored as unknown and marked for review. Values are never interpolated or guessed.
- `MARGINAL` is only produced from a threshold a source states. Where no threshold exists, the outcome is `REVIEW REQUIRED`.
- An unsuitable alternate never produces `NO-GO` on its own; it states why and asks for another selection.
- No secret is exposed in client code, logs, snapshots or reports.

## Brand Commitments

- The product name is **Dispatch Assist**, and it belongs to the AWQ Cloud operations family. The interface is a dark operations cockpit; the AWQ amber is the single accent.
- The product vocabulary is fixed: **Assessment outcome** (never "verdict" as a user-facing label, never "dispatch release"), and the outcome strings above are spelled exactly as written.
- The UI and the report are written in **English**. The knowledge assistant follows the dispatcher's own message language (English or Indonesian) by default.

## Evidence on Hand

- **Live AWQ Cloud payloads** captured from the production flight board and flight-weather endpoints; the shapes are pinned by `test/awq.spec.ts`.
- **The AIP chart PDFs**: 17 approach charts for YPPH and 6 for YPKG in R2 under `airport/`, read as the minima source. Their numeric content has not yet been transcribed and approved at the time of writing, which is exactly the state the registry's draft workflow exists for.
- **The indexed rule corpus**: Operations Manual Part A (1,641 clauses) and Flight Dispatch Manual (581 clauses), retrieved from D1 by `src/retrieval.ts`. Tables in the corpus are damaged by extraction (columns run together, some tables absent entirely); a rule that depends on a table's geometry is read from the closest intact text and cited with the page, and where the table is unusable the product says so instead of reconstructing it.
- **No fabricated data**: there are no invented flights, minima values, NOTAM, clauses or performance figures anywhere in the product. Airports, charts and clause numbers shown on screen come from the sources named above.

## Product Principles

1. **The rule is the product.** Every claim is traceable; if it cannot be cited, it is a `REVIEW REQUIRED`, not a finding.
2. **The engine decides, the model explains.** No model output can change an outcome, and no model call is on the critical path to producing one.
3. **Unknown is never a pass and never a violation.** Missing minima, an unread TAF and an unreviewed NOTAM each have their own visible state.
4. **A human approves every number.** AI may transcribe; only a dispatcher comparing it against the chart may activate it, and the approval is recorded.
5. **Density with legibility.** A dispatcher under time pressure gets a scannable answer first and the evidence one disclosure away, never a wall of equal-weight text.

## Accessibility & Inclusion

- WCAG 2.2 AA target: body text at or above 4.5:1 against its surface, no functional text below 11px, visible focus on every interactive element, and touch targets at 44px below 768px.
- Status is never communicated by colour alone: every status carries a text label and an icon.
- The primary action is keyboard reachable in reading order, and `prefers-reduced-motion` removes non-essential transitions.
