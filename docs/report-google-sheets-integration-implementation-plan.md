# AWQ Report Handoff Implementation Plan

> ## ⛔ RENCANA DIHENTIKAN — 2026-09-20
>
> Implementasi Report Handoff tidak dilanjutkan. Dokumen ini disimpan sebagai catatan historis.
> **Tidak ada langkah lanjutan yang diharapkan** — jangan kerjakan Gate D, jangan deploy ke produksi,
> jangan regenerasi `public/index.html` untuk fitur ini.
>
> Catatan penting: kode di `archive/Report_Handoff.gs`, `archive/Report.html`, `src/Notam_Ui.html`, dan
> `src/Report_Ui.html` **sudah live di deployment staging** (bukan produksi). Salah satunya memuat fix
> `reportFindBlockingRequest_` yang belum pernah direview untuk produksi — lihat
> `docs/report-gate-c-qa-evidence.md` §6.3 dan §8.
>
> *(Dokumen ini memuat beberapa karakter non-ASCII yang ter-mojibake dari sesi sebelumnya; tidak diperbaiki
> agar isi teknisnya tidak berubah.)*

**Status:** Revised specification; full implementation gated by the nonproduction transport proof and fixture validation in §8. No runtime proof is claimed by this document.  
**Production rule:** No deployment or production edit until local implementation, QA, and explicit release approval are complete.  
**Source PRD:** `docs/report-google-sheets-integration-prd.md`

## 1. Current-state/path inventory

| Path | Trigger | Backend | Status after this plan |
|---|---|---|---|
| Create report | `compileFinalCbr()` | Apps Script `generateBriefingPackage` | Retain as existing legacy/report flow |
| Create Google Sheet | `createReportGoogleSheet()` | `public/report-google-sheets.js` → Worker XLSX + Google Drive token upload | Retain as separate flow |
| Download Sheet | `openReportWeb1()` | Web 1 Apps Script handoff | Extend and harden |
| Dead XLSX download | `downloadReportXlsx()` | Worker `generateReportXlsx` | Do not use for the new flow; remove only after references are verified |

The Worker path lives in `public/report-google-sheets.js`, `functions/api/briefing-xlsx.js`, and `functions/briefing.js`. The new Web 1 handoff must not reuse its OAuth/token/upload path. The current local draft already wires the DOWNLOAD SHEET button to `openReportWeb1()`; the remaining work is to extend that handoff, not replace an active XLSX button.

## 2. Implementation outcome

Implement a two-surface report workflow:

```text
Web 2 REPORT
  └─ DOWNLOAD SHEET
      └─ Web 1 REPORT opens
          └─ nonce + origin-validated postMessage
              └─ preview exact context
                  └─ operator confirms
                      └─ idempotent Apps Script generation
                          └─ Google Sheet URL + REPORT_AUDIT record
```

The current local draft is incomplete: it auto-generates on context receipt, sends only flight objects plus NOTAM IDs, hardcodes scattered origin checks, and does not persist an idempotency/audit record. The implementation must replace those behaviors with the approved contract below.

## 3. Final payload contract

Web 2 sends one structured payload. It must not put report data, nonce, or source origin in the URL query. The navigation URL uses only `?page=report`; one-time control values are passed in the URL fragment so they are not sent as HTTP referrer/server query data:

```text
...?page=report#nonce=<nonce>&sourceOrigin=<encoded-approved-origin>
```

```js
{
  version: 1,
  reportRequestId: "UUID",
  requestedAt: "2026-09-19T00:00:00.000Z",
  flights: [
    {
      rowIdx, FLIGHT, DOF, DEP, ARR, STD, STA, REG, ALT,
      ENR1, ENR2, ENR3, TAF_DEP, TAF_ARR
    }
  ],
  tafContext: [
    {
      station: "WIII",
      roles: ["DEP"],
      flights: ["QZ646"],
      text: "full raw TAF text",
      issueTime: "..."
    }
  ],
  notamContext: [
    {
      id: "A0001/26",
      station: "WIII",
      flights: ["QZ646"],
      text: "full raw NOTAM text",
      status: "IMPACTED",
      selected: true
    }
  ],
  savedNotamAnalysis: {},
  noSigStationMap: {}
}
```

Rules:

- `flights` contains one to four exact selected Web 2 flight objects, in selection order.
- `tafContext` includes every relevant station for the selected flights: DEP, ARR, ALT, and ENR stations. It must carry the full available text from Web 2, including empty/unavailable state without silently replacing it with a Web 1 lookup.
- `notamContext` includes all selected NOTAMs relevant to the selected flights, with full raw text and station/flight association. It does not include the entire Web 2 NOTAM database.
- `savedNotamAnalysis` remains as traceability and selection metadata; it is not the authoritative source for NOTAM text.
- `noSigStationMap` is preserved exactly and is used only when the relevant station has no selected NOTAM.
- `savedNotamAnalysis` has the fixed shape `{ [flightNumber]: [notamId, ...] }`; `notamContext` is the authoritative text and is cross-checked against this selection map.
- `version !== 1` is rejected with a visible unsupported-version message; no silent downgrade is allowed.
- Size limits measured 2026-09-19 against real seeded TAF/NOTAM data (`tests/measure_payload_size.mjs`; 22 TAFs, 829 NOTAMs): typical four-flight case (3 NOTAM/flight) ~7.8 KiB, heavy (5/flight, longest NOTAMs) ~33.4 KiB, worst (10/flight) ~56.1 KiB. The provisional 40 KiB total was too tight, so lock the total at **64 KiB** and keep **8 KiB per TAF/NOTAM text value** (observed maxima: TAF 293 B, NOTAM 2.95 KiB — ~2.7x per-text headroom). Oversized data is rejected with an actionable message and never truncated; if real operational data legitimately exceeds a limit, the limit is raised rather than the data truncated.
- The payload is validated at both browser boundaries and again in Apps Script.
- Message envelopes (both sent via `postMessage` with a restricted target origin):
  ```text
  AWQ_REPORT_READY    { type: 'AWQ_REPORT_READY',   nonce: '<fragment nonce>' }
  AWQ_REPORT_CONTEXT  { type: 'AWQ_REPORT_CONTEXT', nonce: '<fragment nonce>', payload: <v1 payload> }
  AWQ_REPORT_ACCEPTED { type: 'AWQ_REPORT_ACCEPTED', nonce: '<fragment nonce>', reportRequestId: '<id>', status: '<current audit status>', ok: true }
  AWQ_REPORT_REJECTED { type: 'AWQ_REPORT_REJECTED', nonce: '<fragment nonce>', reportRequestId: '<id>', reason: '<message>' }
  ```
- `sourceOrigin` in the URL fragment is advisory only. Web 1 must validate the context's `event.origin` against its own allowlist and never treat the fragment value as authoritative; it may additionally cross-check that the fragment value equals `event.origin` and reject a mismatch.

### Iframe-aware transport contract (proof required)

- Web 2 retains `reportWeb1Window`, the top-level popup returned by `window.open()`. The Apps Script REPORT iframe is a different window. Do not require an iframe message's source to equal the top-level popup.
- Candidate direct-frame binding: on READY, require a non-null source, an exact configured Web 1 origin, the pending cryptographically random nonce, and `event.source.top === reportWeb1Window`. Access exceptions or a missing relationship fail closed. Pin that validated `event.source` as `reportPeer` and its exact origin as `reportPeerOrigin` for this handoff. Send CONTEXT to `reportPeer.postMessage(message, reportPeerOrigin)`, not to the outer popup. Accept subsequent receipts only from this pinned pair with the matching nonce and request ID.
- Web 1 resolves the launching Web 2 window through `window.top.opener` in a guarded access, validates the fragment's proposed origin against its own exact allowlist, and sends READY only to that origin. CONTEXT must have `event.source === expectedWeb2Window`, the approved origin, and the nonce. Never fall back to accepting an arbitrary source, wildcard target origin, or opaque `null` origin.
- Read the fragment asynchronously using `google.script.url.getLocation(location => { /* validate location.hash, then send READY */ })`. Do not read it in `doGet`, treat `getLocation` as synchronous, or substitute the iframe's `window.location.hash` for the outer web-app URL.
- This candidate is not a claim that the deployed wrapper exposes these relationships. Before full implementation, prove READY → CONTEXT → ACCEPTED and rejection of a different popup/iframe in a real nonproduction Apps Script deployment on all three browsers. Record actual origins, window relationships, browser versions, and evidence without payloads or nonces. If any relationship is unavailable, stop at this gate and review a replacement transport; do not weaken validation.
- One nonce binds one immutable request, not one network delivery. Exact duplicate CONTEXT messages may recover a lost receipt within the same pinned session, but must not reset the preview or generate. Retire the session after ACCEPTED, explicit rejection, or a pre-send timeout; ignore late messages from retired sessions. After a lost receipt, keep the pending session and request until receipt/status recovery; a closed tab requires same-request recovery in Web 1, not a new generation request.

## 4. State machines

### Web 2

| State | Entry | Exit |
|---|---|---|
| `IDLE` | Report page ready | Click DOWNLOAD SHEET |
| `WAITING_READY` | Web 1 tab opened | Matching READY received or 30-second timeout |
| `WAITING_ACCEPTED` | Context sent | ACCEPTED/REJECTED received or receipt timeout |
| `TRANSFERRED` | ACCEPTED received (payload validated and recorded) | Web 1 takes over (preview, then confirm) |
| `READY_TIMEOUT` | 30 seconds without valid READY and no CONTEXT sent | Retire session; operator may start a new request ID/nonce |
| `RECEIPT_UNKNOWN` | CONTEXT sent but no receipt within 45 seconds | Operator may resend identical CONTEXT once in the pinned session; otherwise check status in Web 1 with the same request ID |
| `REJECTED` | Valid REJECTED receipt | Show reason; no automatic new request or generation |

Web 2 must retain the existing **CREATE GOOGLE SHEET** button as a separate action. The new DOWNLOAD SHEET flow must not reuse its token/upload implementation.

### Web 1

| State | Entry | Exit |
|---|---|---|
| `WAITING_CONTEXT` | Direct open or initial load | Valid context received or 30-second ready window ends |
| `PREVIEW_READY` | Payload validated | Operator confirms or leaves page |
| `GENERATING` | Operator confirms | Success, known failure, or unknown result |
| `UNKNOWN_RESULT` | Generation response times out/loses connection | CHECK REPORT STATUS returns final state |
| `COMPLETE` | Audit status `SUCCEEDED` | Open Sheet link |
| `FAILED` | Proven pre-create failure | Explicit same-payload/same-ID retry if backend returns retryable; changed data needs a new preview/request |
| `RECONCILIATION_REQUIRED` | Creation attempted or partial Sheet exists, outcome incomplete | Status lookup/admin reconciliation only; never create again |

Generation must never start during `PREVIEW_READY` before confirmation. `PREVIEW_READY` is entered only after the payload is validated and the audit `RECEIVED`/`AWAITING_CONFIRMATION` rows are written; Web 1 then sends `AWQ_REPORT_ACCEPTED` to Web 2.

## 5. Audit and idempotency design

Create or reuse a dedicated `REPORT_AUDIT` sheet in the configured source spreadsheet with this header:

```text
REQUEST_ID | REQUESTED_AT | UPDATED_AT | PREVIEW_EXPIRES_AT | OPERATOR | FLIGHTS_JSON | PAYLOAD_HASH | TEMPLATE | STATUS | SPREADSHEET_ID | SPREADSHEET_URL | ERROR
```

If `REPORT_AUDIT` does not exist, create it with the exact header. If it exists with a different header, fail with an actionable migration/configuration error; do not silently overwrite or migrate unknown data.

Allowed statuses:

```text
RECEIVED
AWAITING_CONFIRMATION
GENERATING
CREATE_ATTEMPTED
CREATED
SUCCEEDED
FAILED
UNKNOWN
EXPIRED
```

Rules:

1. Web 2 creates `reportRequestId` once when the handoff begins.
2. Under the same `ScriptLock` used by confirmation, Web 1 authorizes the operator, validates and hashes the full payload, and checks the existing request before writing anything. For a new ID, persist `RECEIVED` with immutable identity/hash and server-calculated `PREVIEW_EXPIRES_AT`, then `AWAITING_CONFIRMATION`. Same ID/operator/hash returns the existing status without appending initial rows, replacing the hash, extending expiry, or resetting UI. Different operator is unauthorized; different hash is `REQUEST_CONFLICT`. If interrupted between the two initial rows, the same matching receipt may complete `RECEIVED` → `AWAITING_CONFIRMATION` once, using the original expiry. Expired receipts return `EXPIRED`; they do not revive the preview.
3. Confirmation runs one `ScriptLock` critical section: authorize and validate/hash → inspect request and same-flight unresolved requests → write `GENERATING` → finish pre-create validation → persist and flush `CREATE_ATTEMPTED` → invoke creation once → immediately persist and flush `CREATED` with Sheet ID/URL → format/populate → flush Sheet writes → write and flush `SUCCEEDED` → release in `finally`. Never call creation if writing its intent fails. A concurrent caller returns `BUSY` or the existing status. Confirm requires the original operator/hash and unexpired preview (or a retryable pre-create failure); no receipt may regress this state.
4. Before creating a spreadsheet, the backend checks for any `SUCCEEDED` record with the same request ID and returns its URL. A created-but-not-succeeded record (a row with a `SPREADSHEET_ID` but status not `SUCCEEDED`) is treated as evidence the Sheet already exists and is reconciled, never re-created.
5. Absence of `SPREADSHEET_ID` is never proof that creation did not happen. Only an observed failure before the create invocation, with no durable `CREATE_ATTEMPTED` history, may be written as retryable `FAILED`. Any exception/timeout during or after the invocation becomes `UNKNOWN` (preserving a known ID), or remains at the last durable marker if the process is killed. A crash after Sheet creation but before ID persistence must block retry, just like a known partial Sheet. These writes are not an atomic transaction across Drive and the audit spreadsheet.
6. A controlled retry with the same request ID never creates a second Sheet when a successful or created record exists.
7. `CHECK REPORT STATUS` reads the audit record by request ID and returns the current status and URL/error without creating a Sheet.
8. `GENERATING`, `CREATE_ATTEMPTED`, `CREATED`, and `UNKNOWN` are unresolved and block a replacement request for the same operator and flight set even with no Sheet ID. Apply this check during both receipt and confirmation under the shared lock. The flight-set key is the sorted unique tuples `(FLIGHT, DOF, DEP, ARR, STD)` from validated flights; exclude mutable row indexes and selection order. Return `RECONCILIATION_REQUIRED` with the prior request ID, not a new success. An available partial URL is labelled incomplete, never an operationally ready report. The preserved legacy button is outside this deduplication boundary and must not be suggested as a workaround.
9. `AWAITING_CONFIRMATION` expires after 15 minutes using immutable server `PREVIEW_EXPIRES_AT`, not the most recent event timestamp. Same-ID retries do not extend it. Expiry is lazy on receipt/status/confirmation; it never expires an in-progress generation into a retryable state. Changed input or an expired preview needs a new request after the unresolved-request check.
10. Reconciliation is an administrator procedure, not automatic regeneration: inspect the request history and execution outcome, identify any Sheet created (include request ID in its creation-time name for investigation), and verify ownership/content. A matching Sheet may be associated with the request and marked `SUCCEEDED` only after content/format verification. A name search returning no results or an elapsed timeout is not sufficient proof of non-creation. If non-creation cannot be positively established, leave the request blocked. Document admin identity, time and evidence reference in `ERROR` without raw payload text. No user-facing reconciliation RPC or automatic recreation is introduced in this release.

### Legal transitions and read rules

| Existing state | Permitted next state / response |
|---|---|
| Absent | `RECEIVED` → `AWAITING_CONFIRMATION`, after successful validation/authorization |
| `RECEIVED` | Matching receipt completes awaiting once, or expires; conflicting input rejected |
| `AWAITING_CONFIRMATION` | `GENERATING` on explicit confirm; `EXPIRED` at preview deadline |
| `GENERATING` | `FAILED` only for proven pre-create failure; otherwise `CREATE_ATTEMPTED` or conservative `UNKNOWN` |
| `CREATE_ATTEMPTED` | `CREATED` when ID is known; `UNKNOWN` on uncertain failure; never automatic retry |
| `CREATED` | `SUCCEEDED` after complete output; `UNKNOWN` on failure, retaining ID |
| `FAILED` | `GENERATING` on explicit identical retry before expiry, only with no create-attempt history; otherwise `EXPIRED` |
| `UNKNOWN` | Admin-verified existing output → `SUCCEEDED`; proven non-creation → `EXPIRED` with evidence (new request required); otherwise blocked |
| `SUCCEEDED` / `EXPIRED` | Terminal; receipts/confirm do not reset state |

Every mutation, including lazy expiry and administrative resolution, uses the shared lock and flushes before release. Status lookup either returns a consistent audit snapshot or `BUSY`; failure to obtain the lock is not `NOT_FOUND`. Each appended row carries forward immutable identity, expiry, and any known Sheet ID. Any historical create-attempt marker vetoes ordinary retry regardless of a later malformed `FAILED` row. Conflicting identity/hash/Sheet IDs fail closed for manual reconciliation. `UNKNOWN_RESULT` is a browser state, not proof that the server wrote `UNKNOWN`. Receipt and status responses include current status, `retryable`, expiry and any known URL; only `SUCCEEDED` is a completed report. A missing record after CONTEXT was sent permits re-receipt of the same request, never a new ID or automatic confirm.

The audit record is for metadata and reconciliation only. `FLIGHTS_JSON` contains flight identifiers and route metadata, never raw TAF/NOTAM text. `PAYLOAD_HASH` stores a SHA-256 fingerprint of the full validated payload (canonical, stable-key serialization) so the confirmed data can be proven identical to the displayed data without persisting raw text. The operator value is always populated server-side from `Session.getActiveUser().getEmail()` and is never accepted from the payload. `REPORT_AUDIT` is append-only: each status transition writes a new row keyed by `REQUEST_ID`. `getReportStatus` returns the latest row's status, except that any `SUCCEEDED` row for the request ID is terminal and wins (returning its URL); a row that has a `SPREADSHEET_ID` but is not `SUCCEEDED` is treated as created-and-needs-reconciliation, never as absent.

Production gate: `OCC_ALLOWED_EMAILS` must be configured and verified before production deployment. The existing empty-allowlist open-access fallback may remain for local development only and must be rejected by a deployment checklist. `Session.getActiveUser().getEmail()` can return an empty string (consumer accounts, or a deployment that does not run as the accessing user); an empty email must be treated as unauthorized (fail closed), never as the script owner. The script owner is `Session.getEffectiveUser()`, a separate concept, and must never be used as the operator.

The audit record is the reconciliation source of truth. The report request ID should be visible in Web 1's preview/result UI.

### Access and identity model

- Operator authorization is `OCC_ALLOWED_EMAILS` membership, evaluated from `Session.getActiveUser().getEmail()`; an empty email is rejected (fail closed).
- Every operator who may run the handoff must have edit access to the configured template spreadsheet and to `REPORT_AUDIT`, or the script must run under an identity that does (deployment mode **Execute as: User accessing the web app**, with per-user authorization).
- The resulting briefing Sheet is created by the running identity; ownership and sharing of the created Sheet must be stated before release. At minimum, the confirming operator can view it, and the audit row records the creator.
- Only the operator who initiated a request (matching `OPERATOR`) may confirm or status-check it. Supervisors/admins may read the audit but must not re-run another operator's request unless that is explicitly configured.

### Time limits

- Handoff readiness window (Web 2 waits for `AWQ_REPORT_READY`): 30 seconds (agreed).
- Receipt window (Web 2 waits for `AWQ_REPORT_ACCEPTED`/`AWQ_REPORT_REJECTED` after `AWQ_REPORT_CONTEXT`): 45 seconds (raised from 10 s after a measured ~34 s Apps Script cold start on the first receipt RPC in the test deployment; overridable via `window.__REPORT_RECEIPT_TIMEOUT_MS` for fast boundary tests).
- Preview TTL (`AWAITING_CONFIRMATION` to `EXPIRED`): 15 minutes from first server receipt.
- Lock acquisition budget: `tryLock(5000)` (5 seconds); failure returns `BUSY` with no creation or state reset. This is a wait-to-acquire budget, not a lock lifetime.
- Browser confirmation-response deadline: 6 minutes from sending confirm. On deadline or connection loss, show `UNKNOWN_RESULT` and CHECK REPORT STATUS; do not cancel, declare failure, release the server lock, or retry generation. A late validated success for the same request may complete the UI.
- Apps Script currently documents a 6-minute per-execution runtime limit. This is a platform ceiling, not a `ScriptLock` hold guarantee or proof that no Sheet was created. Lock cleanup does not undo external side effects. Server termination leaves the last durable audit marker for reconciliation.

### Audit retention and lookup scale

`REPORT_AUDIT` is append-only and would otherwise grow without bound (~6 rows per request, so 500 data rows ≈ 83 requests). Two mechanisms keep each RPC cheap as it grows:

- **Lookup.** Per-request reads use `TextFinder` with an exact match on `REQUEST_ID`; the unresolved-request scan uses one anchored-regex `TextFinder` over the unresolved statuses. Neither loads the whole sheet into the script, so an RPC costs roughly the number of rows it actually needs rather than the sheet size.
- **Retention.** When the sheet exceeds `REPORT_AUDIT_MAX_ROWS` (script property, default **500**), `reportTrimAudit_()` removes **settled requests as whole units** — a request is settled only when its *latest* row is terminal (`SUCCEEDED`/`EXPIRED`) **and** that row is older than `REPORT_AUDIT_TRIM_MIN_AGE_MS` (script property, default **24 h**). Requests whose latest status is unresolved are never removed (they are still needed for reconciliation), and recent requests are never removed, because deleting a `SUCCEEDED` record would let a stale retry with the same request ID create a duplicate Sheet. Trimming deletes whole requests (never a partial trail), runs at most once every 6 hours, and is fail-safe: if nothing is eligible the sheet simply stays larger.
- **Admin.** `resetReportAudit(keepRows, ignoreAge)` performs the same trim on demand and can be run from the Apps Script editor; it holds the shared lock and never removes unresolved requests.

Both thresholds are script properties, so they can be tuned without a code change.

The 45-second receipt deadline and 15-minute preview TTL are explicit implementation defaults, separate from the agreed 30-second readiness window. Validate them in staging; any change must update both documents and boundary tests. Technical references: [URL callback API](https://developers.google.com/apps-script/guides/html/reference/url), [Lock API](https://developers.google.com/apps-script/reference/lock/lock), [execution quotas](https://developers.google.com/apps-script/guides/services/quotas), [cross-origin window access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

## 6. Changes by file

### Web 2 source

`src/Report_Ui.html`

- Keep the existing CREATE GOOGLE SHEET control unchanged. The two sheet-producing controls (`CREATE GOOGLE SHEET` and `DOWNLOAD SHEET`) are intentionally distinct and are not merged in this release; deprecating the Worker XLSX/Drive path is tracked separately and out of scope here.
- Extend the existing `openReportWeb1()` handoff with the approved state machine; do not route this button back to the Worker XLSX path.
- Build the final payload with `reportRequestId`, timestamp, full `tafContext`, full relevant `notamContext`, flight objects, analysis, and NO SIG map.
- Add the 30-second READY timeout and clear recovery message.
- When `window.open()` returns null (popup blocked), clear the pending transfer and show the allow-pop-ups message; never claim the transfer succeeded.
- Send the immutable context only after the §3 iframe-aware binding succeeds. Allow one operator-triggered identical resend after receipt timeout; duplicate READY must not trigger additional sends.
- Use one centralized, config-driven exact-origin allowlist and the pinned iframe peer described in §3; never trust `sourceOrigin` from the fragment by itself.
- On READY timeout, use a new `reportRequestId` and nonce for the next handoff. An unknown generation result reuses the existing request ID and uses CHECK REPORT STATUS.
- Do not log raw TAF/NOTAM text or payload data.

`src/Notam_Ui.html`

- Preserve the most recent `analyzeNotams` response in a private or namespaced Web 2 state object.
- Expose a narrow helper that returns only relevant station records and selected NOTAMs for the current selected flights.
- Preserve each NOTAM's station, ID, full `rawText`, status, and associated flights.
- Detect selected IDs missing from the last analysis and block handoff with a refresh instruction instead of allowing Web 1 to reconstruct them.

`src/Taf_Ui.html`

- Expose a narrow helper over `localTafData` that returns full raw TAF text and issue time for relevant stations.
- Apply explicit precedence: registry full TAF is authoritative; `issueTime` resolves staleness between two full TAF values; flight-board DEP/ARR summary is fallback only.
- Return explicit unavailable/empty state so Web 1 does not silently source a different forecast.

`public/index.html`

- Regenerate from `src/` only after source changes are complete.
- Verify the generated report block matches source; do not hand-edit the generated file.

### Web 1 Apps Script

`archive/Code.gs`

- Keep `?page=report` routing to the report-only page (query string, server-visible). Do not read the URL fragment in `doGet` or any server-side code; the fragment is never sent to the server.
- Add exactly these authorized server functions: `recordReportReceived(payload)` (returns a receipt after writing `RECEIVED` and `PAYLOAD_HASH`), `confirmReport(payload)`, and `getReportStatus(reportRequestId)`.
- Require `requireAuthorized()` in every function.

`archive/Report.html`

- Implement the §3 iframe-aware transport symmetrically, including actual iframe return routing and fail-closed behavior when opener/window relationships are inaccessible.
- Validate nonce and payload. Exact duplicate delivery belongs to the same session/request; it is not a second confirmation or permission to replace data.
- Read nonce/source origin in the `google.script.url.getLocation(location => ...)` callback before READY; do not use server parameters or the iframe's own hash.
- Send ACCEPTED only after the backend receipt succeeds with `AWAITING_CONFIRMATION` or returns an already-existing state. Render that current state; never reopen preview for an in-progress/completed/expired request. Send REJECTED with a safe reason for validation/conflict failures. `BUSY` permits same-request receipt recovery, not a new request.
- Render preview fields: selected flights, CBR template, TAF count, NOTAM count, NO SIG stations, request ID, and timestamp.
- Show a confirmation button; do not generate on receipt.
- Show **CHECK REPORT STATUS** for `UNKNOWN_RESULT` and reconciliation states. Direct authenticated access supports request-ID entry for status only; without the original validated payload and unexpired preview it cannot confirm or generate. Web 2 displays the pending request ID for this recovery without persisting/logging raw report text.
- Avoid rendering raw payload text as HTML; use text nodes or escaped content.
- Do not generate on receipt; only `confirmReport()` can generate.

`archive/Report_Backend.gs`

- Add a dedicated handoff generator boundary that accepts the approved context payload, not just a flight array plus NOTAM IDs.
- Use `tafContext` and `notamContext` as the only TAF/NOTAM source for the handoff path. Do not call `fetchBulkTafData()`, `UrlFetchApp`, or local TAF/NOTAM lookups for this path.
- Keep CBR1/CBR2/CBR4 mapping.
- Add `REPORT_AUDIT` creation/header validation, whole-transaction locking, idempotency check, two-phase status writes (persist `SPREADSHEET_ID` immediately after creation), `PAYLOAD_HASH` computation and verification, expiry handling, reconciliation, and status lookup.
- Keep authorization checks before reading/writing the source spreadsheet or creating a new spreadsheet.

`archive/Report_Handoff.gs`

- Dedicated Gate B backend (kept separate from the legacy `generateBriefingPackage` flow). Contains the `REPORT_AUDIT` schema + header validation, `PAYLOAD_HASH` (SHA-256 over canonical, stable-key JSON), shared `ScriptLock` via `tryLock(5000)`, lazy preview expiry, append-only status transitions, flight-set blocking, and the three RPC entry points `recordReportReceived` / `confirmReport` / `getReportStatus`.
- Dedicated handoff generator boundary `reportGenerateSheet_()`: builds the CBR Sheet from `tafContext`/`notamContext` only (no local TAF/NOTAM lookups), writes two-phase (`CREATE_ATTEMPTED` → `CREATED` → `SUCCEEDED`), and includes the request ID in the created Sheet name for reconciliation.
- Read-only `reportHandoffDiagnostic()` (defined in `Code.gs`) supports the PRD §13 operator-identity / template-access prerequisite.

The existing legacy `generateBriefingPackage(flightsArray, savedNotamAnalysis, noSigMap)` may remain for CREATE REPORT, but it must not be called by the new Web 1 handoff.

## 7. Test plan

### Contract and unit tests

- Payload with one, two, three, and four flights.
- Selection order preserved.
- Full TAF and NOTAM text preserved byte-for-byte through the transfer fixture.
- Relevant station filtering excludes unrelated Web 2 records.
- Invalid selection size, missing flight fields, stale NOTAM selection, invalid request ID, and oversized text are rejected.
- CBR mapping returns CBR1/CBR2/CBR4 correctly.
- Existing `SUCCEEDED` audit record returns its URL without creating a new spreadsheet.
- A created-but-not-succeeded row (has `SPREADSHEET_ID`, no `SUCCEEDED`) returns its URL and never creates a second Sheet.
- Inject failures before intent persistence, after intent but before create, during create, after successful create but before ID persistence, during formatting, and after success before response. Only proven pre-invocation failures without create intent are retryable; every ambiguous case blocks same-ID and replacement-ID creation, including missing Sheet ID.
- Concurrent/replayed receipt returns the original state/hash/expiry; changed hash or operator is rejected. Race receipt with confirm and verify no regression from generation/success to preview.
- `PAYLOAD_HASH` mismatch between the received and confirmed payload is rejected with a re-handoff instruction.
- `CHECK REPORT STATUS` returns each audit state correctly.
- No network call or local TAF/NOTAM lookup occurs during handoff generation.
- Full TAF precedence is registry full text → newest full issue time → board summary fallback.
- Server-side operator capture works and unauthorized users are rejected before Sheet creation; the captured operator equals the logged-in user and is not the script owner (deployment mode is **Execute as: User accessing the web app**).
- Double-confirm/concurrent-confirm produces one Sheet and one `SUCCEEDED` audit row.
- Missing `REPORT_AUDIT` is created once under lock; existing invalid headers fail without destructive overwrite.
- Enforce the final measured UTF-8 byte limits at all boundaries; test limit−1, limit, and limit+1, including multibyte characters; no truncation occurs.
- Size limits are measured from real seeded data (`tests/measure_payload_size.mjs`): typical ~7.8 KiB, heavy ~33.4 KiB, worst (10 NOTAM/flight) ~56.1 KiB. Enforce the locked **64 KiB total / 8 KiB per-text** limits at all boundaries; test limit-1, limit, and limit+1, including multibyte characters; no truncation occurs.

### Browser protocol tests

- Valid READY + matching nonce transfers exactly one payload.
- Wrong origin, wrong source window, wrong nonce, and malformed message are ignored.
- 30-second readiness timeout produces failure state.
- Web 1 displays preview and does not call generation before confirmation.
- Confirm calls generation once.
- Unknown result exposes CHECK REPORT STATUS and does not auto-retry.
- Status check returns the existing URL after simulated successful server completion.
- Preview abandonment transitions to `EXPIRED` after the configured TTL.
- READY timeout before any CONTEXT permits a new ID/nonce; receipt timeout after send and unknown generation result preserve the existing request ID. Late messages from retired sessions are ignored.
- `version !== 1`, empty TAF context, stale NOTAM selection, and malformed saved analysis are rejected or preserved explicitly.
- Web 2 receives `AWQ_REPORT_ACCEPTED` only after validation and audit write; `AWQ_REPORT_REJECTED` is shown with its reason.
- Lost receipt permits one explicit identical resend in the pinned session, then status recovery in Web 1 with the same request ID. Duplicate delivery does not extend expiry or re-enable confirm. If the original tab is unavailable, the operator opens Web 1's authenticated status-recovery UI and enters the request ID; no new payload or generation occurs there.
- Test lock BUSY at 5 seconds, receipt unknown at 45 seconds, readiness timeout at 30 seconds, preview expiry at 15 minutes, and browser unknown at 6 minutes independently. Simulate late server success after browser timeout without duplicate creation.

### Browser matrix

- Current Chrome: handoff, confirmation, success, popup blocked, timeout.
- Current Edge: same matrix.
- Current Mozilla Firefox: same matrix, including opener/postMessage behavior.
- All three browsers: nonproduction proof of the Apps Script iframe opener-identity check and client-side fragment read.

### Manual QA evidence

For each browser and selection size, capture:

- Web 2 selected flight list.
- Web 1 preview and template mapping.
- TAF/NOTAM/NO SIG counts.
- Request ID and audit status.
- Resulting Sheet URL and sample generated content.

## 8. Execution order

1. Gate B0: in an explicitly approved nonproduction deployment with synthetic data, prove the §3 bidirectional pinned-iframe contract, fragment callback, rejection and receipt-recovery cases on Chrome, Edge, and Firefox. Validate representative payload sizes and operator permissions. Record deployment reference, browser versions, measured sizes and evidence paths. Do not start full implementation while this gate is unproven; a top-level mock cannot satisfy it.
2. Finalize payload builder, handshake, receipt (ACK), and timeout state machine.
3. Define and implement the Apps Script RPC contract and audit/idempotency backend.
4. Implement Web 1 preview/confirmation/status-check UI against those RPCs.
5. Update the browser handoff test fixture for preview-before-confirmation, receipt, and status-check.
6. Run syntax checks and targeted unit tests.
7. Run Chrome/Edge/Firefox manual QA locally or in an approved staging deployment.
8. Review diff and QA evidence.
9. Request explicit production deployment approval.

### Evidence status for the five review findings

| Finding | Specification resolution | Required verification | Current evidence |
|---|---|---|---|
| Unknown creation without Sheet ID | §5 durable create intent and replacement-request block | Fault injection after create/before audit ID write | PASS (protocol tests, 2026-09-19): simulated create failure after `CREATE_ATTEMPTED` → `UNKNOWN`, then `RECONCILIATION_REQUIRED`; create-attempt history vetoes retry even when the latest row reads `FAILED`. |
| Iframe transport / fragment API | §3 pinned child peer and callback | Real Apps Script bidirectional browser proof (B0) | PASS (Chromium + WebKit, 2026-09-19): READY→CONTEXT→ACCEPTED via `n-…-0lu-script.googleusercontent.com` content iframe; `sourceTopMatchesPopup=true`; fragment read via `google.script.url.getLocation` callback. Firefox PASS (manual, real Firefox, 2026-09-19). |
| Receipt replay / race | §5 immutable registration under shared lock | Duplicate receipt racing confirmation | PASS (protocol tests): duplicate receipt appends nothing and preserves hash/expiry; a changed hash is `REQUEST_CONFLICT`; double confirm returns the same URL with a single generation. |
| Timeout identity | §4 READY_TIMEOUT vs RECEIPT_UNKNOWN | Lost receipt and late-message tests | Partial: lost-receipt recovery PASS (local, 2026-09-19) — Web 2 shows the receipt timeout (45 s default, overridable) + same request ID, no new ID. A real cold-start late ACCEPTED was observed and handled in the test deployment. READY-timeout/late-message cases not run. |
| Lock vs runtime deadlines | §5 separate budgets | BUSY and late-success tests | PASS (protocol tests): unavailable lock → `BUSY` with no state change; a real cold start measured ~34 s so the receipt window was raised to 45 s, and the late ACCEPTED was handled without duplicate creation. |

Gate B verification (2026-09-19, nonproduction deployment): all five findings now carry executable proof — transport, iframe binding and fragment callback proven in the real Apps Script environment (Chromium + WebKit automated, Firefox manual); the audit/idempotency state machine proven by `tests/test_report_handoff_protocol.mjs` (16 checks); and an end-to-end run in the test deployment completed receipt → confirm → Sheet creation → status `SUCCEEDED`. Production was not touched. The production-readiness checklist in PRD §13 remains authoritative.

## 9. Definition of done

- The approved PRD decisions are implemented with no unresolved data-source ambiguity.
- Web 1 generates only after confirmation.
- Full relevant TAF/NOTAM text comes from Web 2 payload.
- Duplicate Sheets are prevented by request ID and audit lookup.
- Status-check reconciles unknown results.
- Audit rows exist for every received/confirmed generation request with final status, operator, timestamp, and URL/error metadata.
- CBR mapping is correct for 1–4 flights.
- Chrome, Edge, and Firefox pass the protocol and manual QA matrix.
- `public/index.html` is reproducibly generated from `src/` with no unrelated diff.
- Production deployment is blocked unless `OCC_ALLOWED_EMAILS` is configured and verified.
- Production remains unchanged until explicit release approval.
- Success-metric baselines and target thresholds (PRD §7 🔵) are supplied and recorded before production approval.
- A SHA-256 payload fingerprint proves the confirmed data equals the displayed data; mismatch is rejected.
- Sheet identity is persisted immediately after creation; pre- and post-creation failures reconcile without duplicates.
- Web 2 confirms receipt via `AWQ_REPORT_ACCEPTED`, and lost receipts reuse the same request ID.
- Payload size limits and every time limit are validated and stated separately.
