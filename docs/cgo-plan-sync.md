# CGO Plan sync (Sync CGO Data)

The flight board's **Sync CGO Data** action reads the cargo desk's **CGO PLAN** Google Sheet and writes the weight onto the flights currently on the board. It replaces a stub that only re-read the local `flights` table, which is why the button used to look like it did nothing.

## Why the Apps Script pushes instead of the Worker pulling

The AirAsia Workspace does **not** offer `Who has access: Anyone` for Apps Script web apps — only *Only myself* and *Anyone within AirAsia*. The Worker has no Google identity, so it can never call such a deployment, and the AirAsia Google Cloud organization also blocks service-account key creation (`iam.disableServiceAccountKeyCreation`). Both outbound routes are closed.

Inbound calls are blocked, but **outbound** ones are not. So the direction is reversed:

```
Apps Script  (time-driven trigger, runs as christiandaniel@airasia.com)
   reads the CGO PLAN sheet
        │  POST /api/cgo-ingest   + X-AWQ-CGO-Token
        ▼
Worker  ──►  stores the grid in the `meta` table (CGO_SHEET_SNAPSHOT)
                        │
   board "Sync CGO Data" ──► matches + writes flights.cgo  (instant, from D1)
```

Consequences worth knowing:

- No admin approval, no new OAuth scope, no service-account key, no public deployment.
- The sheet is never shared with anyone or anything.
- The board's sync is instant and keeps working even if Google is unreachable at that moment.
- The weights are as fresh as the last push (every 15 minutes by default). Run `pushCgoPlan()` by hand whenever you need it sooner.

## Sheet layout

Row 1 is the header; column positions are resolved from the header **text**, so reordering or renaming columns does not break the sync:

| FLIGHT NO | Flight Date | Origin | Dest | Dep Time | Arr Time | Confirmed Wt. | REVISE | Revise Time |
|---|---|---|---|---|---|---|---|---|
| QZ320 | 21/09/2026 | SUB | KUL | 5:05 | 8:40 | 2500 | | |

- **FLIGHT NO** — the designator is ignored, so `QZ320` matches board flight `320`.
- **Flight Date** — read day-first (`DD/MM/YYYY`). A month-first value is only accepted when the day cannot be a month (`09/21/2026`), and Google date serials are accepted too.
- **REVISE wins over Confirmed Wt.** whenever it is filled in. Revise Time is ignored.
- The header row is searched for in the first 10 rows, so a title band above the table is fine.
- Values arrive as displayed in the cell (`getDisplayValues()`), which is what the date parser expects.

## What gets written

Only flights that are **on the board** (`window.activeBoardRowIds`) are candidates:

- Matched on flight number first, then the date picks between several board flights sharing that number.
- With a single candidate the row is still written when the date disagrees with the board DOF, and the disagreement is reported — operators reuse a flight number across days.
- A row that matches nothing on the board is **reported, never written**, so a stale or mistyped plan line cannot change a flight nobody looked at.
- With several same-numbered board flights and no date match, the row is reported as ambiguous rather than guessed.
- Duplicate plan lines for the same flight: the later line wins.

The operator sees a `[ CGO SYNC ]` summary with the snapshot's age, how many rows matched, what was updated, and every row that could not be placed. The result is also written to `auth_audit_log` as `cgo_sync`.

Sync requires the **registered** tier (it writes) and a valid CSRF token. A `readonly` account gets a `REGISTERED_REQUIRED` refusal.

---

## One-time setup

### 1. Configure the Apps Script

1. Open the Apps Script project that belongs to **christiandaniel@airasia.com** (the account that can open the CGO PLAN sheet).
2. Replace the contents of `Code.gs` with [`integrations/cgo-bridge/Code.gs`](../integrations/cgo-bridge/Code.gs).
3. **Project Settings → Script properties**:

   | Property | Value |
   |---|---|
   | `CGO_BRIDGE_TOKEN` | the shared token — the same value as the Cloudflare secret |
   | `WORKER_INGEST_URL` | optional; defaults to `https://awq.christiandaniel.my.id/api/cgo-ingest` |
   | `CGO_SHEET_ID` | optional; defaults to the AWQ CGO PLAN sheet |
   | `CGO_SHEET_NAME` | optional; defaults to the first tab |

4. Run **`diagnose`** once and read the log. It must end with `Spreadsheet : OK`. If it says `FAILED`, the account signed in to this Apps Script project cannot open the sheet — the trigger would fail the same way; sign in with the right account or share the sheet with the one shown on the `Account signed in` line.
5. Run **`installCgoTrigger`** once. Authorise when Google prompts, then read the log — it installs the 15-minute schedule *and* pushes immediately, so the log shows the Worker's answer straight away. A healthy answer is `HTTP 200 {"ok":true,...}`.

> A web app **deployment is not needed at all** for the push to work. The trigger calls the function directly. Any existing web-app deployment can be left alone or deleted.

### 2. Configure Cloudflare Pages

Pages → the project → **Settings → Environment variables → Production**:

| Name | Type | Value |
|---|---|---|
| `CGO_BRIDGE_TOKEN` | **Secret** | the shared token |

Then **redeploy** — Pages reads environment variables at deployment time. `CGO_BRIDGE_URL` is no longer used and can be deleted.

> Only **Secrets** can be managed from the dashboard, because this project's plain variables are managed through `wrangler.toml`.

### 3. Verify

- In the Apps Script log, `installCgoTrigger` ends with `HTTP 200 {"ok":true,"rowCount":…,"entryCount":…}`.
- On the board, **Sync CGO Data** shows `[ CGO SYNC ]` with the weights.

---

## Security notes

- The shared token travels in the `X-AWQ-CGO-Token` header of a server-to-server POST, so unlike a query parameter it does not land in browser history or referrer logs.
- The ingest endpoint requires that token and nothing else — it accepts no session and no Origin, which is correct for a machine caller. Rotate the token by changing the Apps Script property and the Cloudflare secret together, then redeploy.
- The endpoint validates the grid with the same parser the board uses, and **refuses a push it cannot parse** so the previous good snapshot survives. A broken sheet therefore cannot blank the board.
- The last snapshot lives in `meta` under `CGO_SHEET_SNAPSHOT`. It is operational data, not a secret store.

## Troubleshooting

| Message | Cause |
|---|---|
| Apps Script log: `STOP: set the CGO_BRIDGE_TOKEN script property` | property missing in the Apps Script project |
| Apps Script log: `Worker answered HTTP 401 unauthorized` | the Apps Script property and the Cloudflare secret differ |
| Apps Script log: `Worker answered HTTP 503` | the Cloudflare secret is missing, or the deployment predates it — redeploy |
| Apps Script log: `Worker answered HTTP 422 CGO PLAN header not found` | the sheet lost its `FLIGHT NO` or `Confirmed Wt.`/`REVISE` column, or it moved past row 10 |
| Apps Script log: `Spreadsheet : FAILED` (from `diagnose`) | the script's account cannot open the sheet |
| Board: `No CGO PLAN data has been received yet…` | no push has succeeded — run `installCgoTrigger` or `pushCgoPlan` |
| Board: `WARNING: that snapshot is over 2 hours old` | the trigger is not firing — re-run `installCgoTrigger` |

## Code map

| File | Role |
|---|---|
| `integrations/cgo-bridge/Code.gs` | the Apps Script side — reads the sheet, pushes it, installs the trigger |
| `functions/api/cgo-ingest.js` | the authenticated push endpoint; validates and stores the snapshot |
| `shared/cgo.mjs` | header resolution, date/weight parsing, board matching, summary text — pure, no I/O |
| `functions/api/rpc.js` | `handleSyncCgoData` — reads the snapshot, writes `flights.cgo`, returns the board payload |
| `src/Flight_Ui.html` | `window.syncCgoData()` — sends the board ids, shows the summary |
| `tests/test_cgo_sync.mjs` | parsing, matching, the ingest endpoint, and the whole RPC path |
