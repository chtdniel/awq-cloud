# AWQ Report Handoff to Google Sheets PRD

**Status:** Five review findings addressed in the specification; full implementation remains gated on nonproduction transport proof and representative payload validation. This document does not assert those tests have passed.  
**Decision gate:** No production deployment before this document and the workflow are approved.  
**Scope:** Web 2 (`awq-cloud.pages.dev`) to Web 1 (Apps Script report application).

### Confirmed decisions

- Web 1 receives the full TAF and NOTAM text needed for the selected report context from Web 2.
- “Full” means all TAF and NOTAM text relevant to the selected flights, not the entire Web 2 database.
- Web 1 displays the received context and waits for an explicit operator confirmation before generating the sheet.
- The existing Web 2 **CREATE GOOGLE SHEET** button is retained.
- The Web 2 handoff uses a 30-second readiness timeout.
- Each handoff has a persisted report request ID and timestamp for reconciliation.
- Automatic retry after an unknown generation result is blocked. A controlled retry reuses the same report request ID and must return the existing result when available.
- Production requires `OCC_ALLOWED_EMAILS` to be configured and verified; the open-access fallback is local-development-only.

## 1. Executive summary

When an OCC user selects one to four flights in Web 2 and chooses **DOWNLOAD SHEET** on the REPORT page, Web 1 must open in a new tab, receive the exact selected-flight context from Web 2, and create a Google Sheet using the matching CBR template: CBR1 for one flight, CBR2 for two flights, and CBR4 for three or four flights.

The handoff must be explicit, one-time, origin-validated, and independent of Web 1's flight cache. The generated sheet must be traceable to the payload selected by the operator in Web 2.

## 2. Problem statement

### Who has the problem?

OCC/dispatch operators who select active flights in Web 2 and need a formal crew briefing spreadsheet.

### What is the problem?

The current report flow is split between Web 2's local XLSX/Google Drive flow and a separate Apps Script report generator. The two surfaces do not yet share a defined, verified transfer contract, and Web 1 does not reliably receive the exact flight context selected in Web 2.

### Why is it painful?

- An operator may receive a report generated from a different cache or different flight state.
- The operator must repeat selection or rely on an implicit lookup in Web 1.
- A mismatch between selected flights and generated content is operationally significant.

### Evidence available now

- Web 2 already has `selectedFlights`, saved NOTAM analysis, and station-level NO SIG state.
- Web 1 already has `generateBriefingPackage` and CBR1/CBR2/CBR4 template selection logic.
- The missing contract is the secure, observable Web 2 → Web 1 transfer and its acceptance behavior.

🔶 **Assumption:** The operator is authenticated/authorized in Web 1 with access to the configured template spreadsheet.

## 3. Target users and jobs-to-be-done

### Primary user: OCC/dispatch operator

- **Goal:** Generate the correct briefing sheet for the flights already selected.
- **Job:** “When I have selected the flights and reviewed NOTAM status, I want one action to create the matching Google Sheet so I can release or share the briefing without re-entering data.”
- **Needs:** Exact selection preservation, clear progress, clear success link, and actionable error messages.

### Secondary user: supervisor/reviewer

- **Goal:** Trust that the generated sheet corresponds to the operator's selected context.
- **Need:** Stable template mapping and an auditable handoff boundary.

## 4. Strategic context and constraints

### Agreed constraints

- Web 2: `https://awq-cloud.pages.dev/`
- Web 1: the provided Apps Script deployment URL.
- Web 1 report templates are in the configured spreadsheet and are named `CBR1`, `CBR2`, and `CBR4`.
- Supported selection size is one to four flights.
- Production site must not be changed until the PRD, workflow, implementation, and QA evidence are approved.

### Why now

The report generator exists in both code paths, but the cross-application boundary is not yet a formally approved product flow. Defining the contract first reduces the risk of releasing a report that is technically generated but operationally mismatched.

## 5. Solution overview

### User-visible flow

1. Operator selects one to four flights in Web 2.
2. Operator opens the REPORT page and chooses **DOWNLOAD SHEET**.
3. Web 2 opens Web 1's `REPORT` page in a new tab.
4. Web 1 announces readiness to the opener by echoing back the nonce Web 2 supplied in the URL fragment.
5. Web 2 validates the origin, nonce, and the sender iframe's relationship to the opened Web 1 tab, then pins the iframe peer and its exact origin (see the implementation plan's iframe-aware transport contract).
6. Web 2 sends an immutable copy of the exact report context to that validated iframe peer with a restricted `postMessage` target origin, not to the outer tab.
7. Web 1 validates the payload, records it in `REPORT_AUDIT`, and acknowledges receipt to Web 2.
8. Web 1 displays the received context and waits for operator confirmation.
9. Operator confirms the report in Web 1.
10. Web 1 generates the appropriate CBR spreadsheet.
11. Web 1 shows an **OPEN GOOGLE SHEET** link.

### Sequence contract

```text
Web 2                         Web 1 REPORT                  Google Sheets
  |                                |                              |
  |-- open page + nonce ---------->|                              |
  |<-- AWQ_REPORT_READY -----------|                              |
  |-- AWQ_REPORT_CONTEXT --------->|                              |
  |<-- AWQ_REPORT_ACCEPTED --------|                              |
  |                                |-- show preview + confirm ----|
  |                                |-- generate CBR sheet -->|
  |                                |<-- spreadsheet URL -----------|
  |<-- visible transfer status ----|                              |
```

### Payload v1

```js
{
  version: 1,
  reportRequestId: "uuid",
  requestedAt: "ISO-8601 timestamp",
  flights: [/* exact selected flight objects from Web 2 */],
  tafContext: [/* full TAF text for the selected report context */],
  notamContext: [/* full selected NOTAM text and station metadata */],
  savedNotamAnalysis: {/* selected NOTAM state for traceability */},
  noSigStationMap: {/* station-level NO SIG state from Web 2 */}
}
```

The payload must preserve selection order and all fields needed by the Web 1 generator, including flight number, DOF, route, times, registration, alternate, enroute stations, flight-board TAF values, full TAF text, and full selected NOTAM text. Web 1 must not replace these values by reading its own flight/report cache.

The TAF/NOTAM context is limited to stations and records relevant to the selected flights. It must not include the entire Web 2 database.

## 6. Template mapping

| Selected flights | Web 1 template | Expected result |
|---:|---|---|
| 1 | `CBR1` | One-flight crew briefing sheet |
| 2 | `CBR2` | Two-flight crew briefing sheet |
| 3 | `CBR4` | Four-slot template with three populated flights |
| 4 | `CBR4` | Four-flight crew briefing sheet |

Selections outside one to four are rejected before generation.

## 7. Success metrics

### Primary metric

**Context fidelity:** 100% of successful report generations use the same flight identifiers and ordering selected in Web 2.

### Secondary metrics

- Successful handoff rate after clicking **DOWNLOAD SHEET**.
- Report generation success rate by selection size: 1, 2, 3, and 4 flights.
- Time from click to visible Google Sheet link.
- Rate of actionable failure messages for popup blocked, timeout, invalid payload, and authorization failure.
- Reconciliation coverage: every report request received by Web 1 has a report request ID, timestamp, status, and resulting Sheet URL or error.

🔵 **Open question:** Baseline values and target thresholds must be supplied before launch approval (tracked in the implementation plan's Definition of Done).

### Guardrails

- Do not silently substitute flights from Web 1.
- Do not generate a report if the payload is invalid or outside the supported selection size.
- Do not accept messages from an unapproved origin or unrelated window.
- Do not expose access tokens or report payloads in URLs or logs.

## 8. User stories and acceptance criteria

### Story 1: Transfer the selected context

As an OCC operator, I want Web 1 to receive the exact Web 2 selection so that the generated report matches my current work.

Acceptance criteria:

- [ ] Clicking **DOWNLOAD SHEET** with one to four selected flights opens Web 1's REPORT page.
- [ ] The payload contains the exact selected flight objects in the same order.
- [ ] The payload contains full TAF context, full selected NOTAM text, current saved NOTAM analysis, and NO SIG map.
- [ ] Web 1 does not query its own flight list to replace the received flights.
- [ ] The handoff generation path does not fetch external TAF data or read Web 1's local TAF/NOTAM sheets.
- [ ] The UI shows that transfer succeeded or failed.

### Story 2: Secure the handoff

As the system owner, I want the cross-origin transfer constrained so that unrelated pages cannot inject report context.

Acceptance criteria:

- [ ] Web 2 accepts readiness only from the approved Web 1 origin(s), expected window, and matching nonce.
- [ ] Web 1 accepts context only from an approved Web 2 origin, expected opener, and matching nonce.
- [ ] The nonce is unique per handoff and is not reused after successful transfer.
- [ ] The payload includes a unique `reportRequestId` and `requestedAt` timestamp.
- [ ] Directly opening Web 1 without a valid opener/payload cannot generate. An authenticated operator may enter their request ID to check status only; this recovery route never creates a Sheet.
- [ ] No payload is placed in the query string.

### Story 3: Generate the matching sheet

As an OCC operator, I want Web 1 to create the correct CBR template automatically.

Acceptance criteria:

- [ ] One flight selects CBR1.
- [ ] Two flights select CBR2.
- [ ] Three or four flights select CBR4.
- [ ] Web 1 shows the received flights, TAF/NOTAM counts, and report context before generation.
- [ ] Generation does not start until the operator confirms in Web 1.
- [ ] The generated sheet contains the received flight fields and selected NOTAM/NO SIG context.
- [ ] On success, Web 1 shows a valid Google Sheets link.
- [ ] Only a proven pre-create failure without a persisted create-intent marker allows explicit identical-request retry before preview expiry. Uncertain or post-create failures require reconciliation, even if the audit has no Sheet ID.
- [ ] The operator identity is captured server-side and is never trusted from the payload.
- [ ] If the result is unknown, automatic retry is blocked to prevent duplicate sheets.
- [ ] A controlled retry reuses the same `reportRequestId` and returns the existing Sheet URL when the first attempt already succeeded.
- [ ] Web 1 persists request ID, timestamp, operator/session context where available, status, and Sheet URL/error for reconciliation.

### Story 4: Handle operational failures

Acceptance criteria:

- [ ] Popup blocked: Web 2 explains how to allow the report tab.
- [ ] Web 1 does not respond: Web 2 reports a timeout without claiming success.
- [ ] Invalid payload: Web 1 rejects generation and explains the required selection size/data.
- [ ] Unauthorized Apps Script call: Web 1 displays the authorization failure.
- [ ] Duplicate readiness/context messages do not create duplicate sheets.
- [ ] Receipt registration is idempotent: same request ID/operator/full-payload hash returns current status without resetting state or expiry. A different operator/hash is rejected, including during a concurrent confirmation.
- [ ] READY timeout before CONTEXT is sent allows a new handoff ID/nonce. A receipt timeout after send retains the same immutable request; at most one operator-triggered identical resend is allowed before status-only recovery.
- [ ] No new request for the same operator/flight set can bypass an unresolved generation, with or without a known Sheet ID. Partial Sheets are explicitly labelled incomplete, not successful reports.
- [ ] Readiness (30 seconds), receipt (45 seconds), preview expiry (15 minutes), lock acquisition (5 seconds), and browser confirmation-response deadline (6 minutes) are separate. Browser timeout never establishes server failure or permits regeneration.

## 9. Out of scope for this release

- Rebuilding the flight board or NOTAM analysis workflow.
- Supporting more than four flights in one report.
- Deprecating or merging the existing **CREATE GOOGLE SHEET** (Worker XLSX/Drive) flow with the new Web 1 handoff.
- Replacing the Google Sheets template design.
- Adding a new identity provider or authorization model.
- Deploying changes to production before approval of this PRD and QA evidence.
- Automatic background retries that could create duplicate spreadsheets.

## 10. Dependencies and risks

### Dependencies

- Apps Script deployment must include the REPORT-only route/page.
- Web 1 must have access to the configured template spreadsheet.
- The Web 1 handoff path must accept the v1 payload fields without flight-cache lookup, via a dedicated handoff generator boundary rather than by extending the legacy `generateBriefingPackage`.
- Browser popup and cross-origin `postMessage` behavior must be supported in the target operator browsers.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Apps Script redirect changes the effective origin | Allow only the documented Apps Script origins and verify the actual deployed origin during QA |
| Web 1 data differs from Web 2 | Transfer all data required for the report, not only flight identifiers; resolve the open question before implementation approval |
| Popup blocked | Open synchronously from the user click and show a clear recovery message |
| Duplicate sheet creation | Durable pre-create intent, immutable/idempotent receipt, shared-lock state transitions, and blocking unresolved same-operator/flight-set replacement requests even without a Sheet ID |
| Unauthorized report generation | Keep Apps Script authorization checks and show failure without fallback generation |
| Apps Script HTML runs in an iframe and the fragment is not server-visible | Prove bidirectional pinned-iframe routing, opener identity and asynchronous client-side fragment read on Chrome, Edge and Firefox; no wildcard/source-check fallback |

## 11. Rollout and approval gates

### Gate A: PRD approval

- Resolve all 🔵 open questions that affect data fidelity or user behavior.
- Confirm the payload contract and error behavior.
- Confirm the Web 1 preview and confirmation content.

### Gate B0: Transport and fixture proof

- Use an explicitly approved nonproduction Apps Script environment and synthetic data; do not edit the production site or deployment.
- Prove READY → CONTEXT → ACCEPTED reaches the intended iframe and returns to Web 2 on Chrome, Edge and Firefox. Verify rejection of unrelated popups/frames, callback-based fragment reading, and lost-receipt recovery. A top-level HTML mock is not sufficient evidence.
- Validate representative four-flight payload sizes and record final byte limits. If the transport cannot satisfy the security contract, return to design review rather than bypassing source/origin checks.
- This proof is a prerequisite experiment, not authorization to begin full implementation or deployment.

### Gate B: Full local implementation (after B0 passes)

- Implement only in a local branch/worktree.
- Add protocol and template-mapping tests.
- Verify Web 1 and Web 2 independently.

### Gate C: Staging/manual QA

- Test 1/2/3/4-flight selections.
- Test popup blocked, invalid payload, origin mismatch, nonce mismatch, timeout, and authorization failure.
- Verify spreadsheet template and data fidelity manually.

### Gate D: Production approval

- Review diff and QA evidence.
- Obtain explicit approval to deploy Web 1 and Web 2 changes.
- Deploy and perform a limited smoke test.

## 12. Resolved decisions and remaining questions

### Resolved

1. TAF/NOTAM scope is the complete relevant context for the selected flights only.
2. Web 1 preview shows selected flights, CBR template, TAF count, NOTAM count, and NO SIG stations.
3. Web 1 waits for explicit confirmation before generating.
4. Web 2 readiness timeout is 30 seconds.
5. A report request ID and timestamp are persisted for reconciliation.
6. The existing Web 2 **CREATE GOOGLE SHEET** button remains.
7. Automatic retry is blocked after an unknown result; a controlled retry reuses the same request ID.
8. Audit records are stored in a dedicated `REPORT_AUDIT` sheet.
9. Web 1 provides **CHECK REPORT STATUS** for an unknown result instead of direct regeneration.
10. Supported browsers are current Chrome, Edge, and Mozilla Firefox on OCC workstations.

### Review resolution and remaining evidence

The five follow-up findings have explicit design rules in implementation-plan §§3–5 and regression scenarios in §7:

1. Missing Sheet ID is not proof of non-creation. Persist create intent before invocation, reconcile uncertainty, and block replacement IDs.
2. Use the validated iframe peer in both directions and read the fragment through the asynchronous URL callback; the real deployment proof remains pending.
3. Receipt registration is immutable and idempotent under the shared lock; replays cannot regress state or extend expiry.
4. Distinguish pre-send READY timeout from post-send receipt uncertainty, preserving request identity after send.
5. Separate lock acquisition, browser waiting, preview TTL and platform execution limits; no timeout establishes safe regeneration.

Remaining evidence before full implementation: Gate B0 transport proof on all three browsers, representative payload measurements, and verification of operator/template/audit permissions in the chosen test deployment. These are not checked off by editing this document. Before production, verify output ownership/sharing, collect complete QA and supply metric baselines/targets.

## 13. Definition of ready

### Ready for full local implementation

Implementation in a local branch/worktree may begin when:

- [x] Product decisions have been approved.
- [x] The payload schema is approved.
- [x] CBR mapping and selection limits are approved.
- [x] Security acceptance criteria are approved.
- [x] Failure and retry behavior are approved.
- [x] Gate B0 bidirectional iframe transport, source rejection, receipt recovery and fragment callback proof is recorded for Chrome, Edge, and Firefox (Chromium + WebKit automated; Firefox manual).
- [x] Duplication safety, immutable receipt/payload identity, replay handling, and distinct timeout rules are specified.
- [x] Operator identity and template/audit permissions are verified in the chosen nonproduction deployment (DIAGNOSTIC: `activeUser: chtdniel@gmail.com`, `isAuthorized: true`, `CBR1`/`CBR2`/`CBR4` present, `REPORT_AUDIT` auto-created on first receipt).
- [x] Payload size limits are validated against representative four-flight fixtures (real seeded data: 40 KiB total found insufficient at 10 NOTAM/flight ~56 KiB; locked at 64 KiB total / 8 KiB per text).
- [x] Exact `REPORT_AUDIT` schema and status transitions are defined.
- [x] Browser test matrix is defined for Chrome, Edge, and Mozilla Firefox.

All readiness prerequisites above are satisfied and backed by runtime evidence in the test deployment (2026-09-19): Gate B0 transport proof, operator/template verification, payload-size validation, and a full receipt → confirm → Sheet → status `SUCCEEDED` run. Full local implementation (Gate B) is complete; production deployment remains gated on the checklist below.

### Ready for production deployment

> ⛔ **RENCANA DIHENTIKAN 2026-09-20.** Pekerjaan Report Handoff tidak dilanjutkan, sehingga checklist ini
> tidak akan dipenuhi dan fitur ini tidak akan di-deploy ke produksi. Semua kotak di bawah tetap `[ ]`
> secara sengaja — jangan menandainya selesai. Bukti QA staging yang sudah terkumpul tetap tersimpan di
> `docs/report-gate-c-qa-evidence.md`, termasuk satu bug produk yang ditemukan dan diperbaiki
> (`reportFindBlockingRequest_`) yang fix-nya **belum pernah direview untuk produksi**.

Production may be deployed only after:

- [ ] Browser test matrix (Chrome, Edge, Firefox) passes protocol and manual QA.
- [ ] QA evidence is reviewed and approved.
- [ ] Production approval gates are accepted.
- [ ] Success-metric baselines and target thresholds are supplied.

**Status penutup:** Gate A–C terlewati dengan bukti runtime; penghentian terjadi **sebelum** Gate D.
`public/index.html` tidak pernah diregenerasi, jadi fitur ini tidak ada di shell produksi dan produksi
tidak tersentuh.
