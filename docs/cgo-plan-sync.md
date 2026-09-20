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
- **Pushing is manual by default** — the cargo desk clicks a menu item in the sheet right after updating the plan, which is the moment the data actually changes. A 15-minute schedule is available for anyone who would rather not think about it, but it is not required.

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

Create the script either **inside the CGO PLAN spreadsheet** (**Extensions → Apps Script**, which needs edit access and adds an on-sheet menu) or as a project at [script.google.com](https://script.google.com). Both run, push, and diagnose identically; only the menu differs.

1. Replace the contents of `Code.gs` with [`integrations/cgo-bridge/Code.gs`](../integrations/cgo-bridge/Code.gs).
2. **Project Settings → Script properties**: add `CGO_BRIDGE_TOKEN` = the shared token, the same value as the Cloudflare secret. The other properties are optional — leave them out rather than creating them empty (Apps Script refuses an empty value).

   | Property | Required | Notes |
   |---|---|---|
   | `CGO_BRIDGE_TOKEN` | yes | must equal the Cloudflare secret |
   | `WORKER_INGEST_URL` | no | defaults to `https://awq.christiandaniel.my.id/api/cgo-ingest` |
   | `CGO_SHEET_ID` | no | only for a standalone project on another sheet |
   | `CGO_SHEET_NAME` | no | defaults to the first tab |

3. Run **`diagnose`** once and authorise when prompted. It must say `Spreadsheet : OK`.
4. Run **`pushCgoPlan`** once. The log must show `Worker answered HTTP 200: {"ok":true,…}`.

### 2. Bookmark the push (so the editor is never needed again)

If the script is **standalone**, one click from the browser toolbar replaces the editor entirely:

1. **Deploy → New deployment → Web app**
   - *Execute as:* **Me**
   - *Who has access:* **Anyone within AirAsia** — this Workspace does not offer *Anyone*, and that is fine: you are the one clicking, not the Worker.
2. Copy the **`/exec`** URL.
3. Bookmark this, with the token filled in:

   ```
   <URL_EXEC>?token=<TOKEN>&action=push
   ```

4. Click it once to verify: a page appears saying **CGO plan pushed** with the row count.

From then on: **click the bookmark → close the tab → Sync CGO Data on the board.**

> After any later edit to `Code.gs`, publish it with **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. Editing the existing deployment keeps the same URL, so the bookmark survives.

### 3. Optional: automatic pushing

Nobody has to click anything if the plan is pushed on a schedule:

- **AWQ Cloud → Turn 15-minute schedule ON** (bound script), or run `installCgoTrigger` from the editor.
- Off again with **Turn schedule OFF** / `removeCgoTrigger`.

Change the interval with `TRIGGER_MINUTES` at the top of `Code.gs` (Apps Script's minimum is 1 minute).

### 4. Configure Cloudflare Pages

Pages → the project → **Settings → Environment variables → Production**:

| Name | Type | Value |
|---|---|---|
| `CGO_BRIDGE_TOKEN` | **Secret** | the shared token |

Then **redeploy** — Pages reads environment variables at deployment time. `CGO_BRIDGE_URL` is no longer used and can be deleted.

> Only **Secrets** can be managed from the dashboard, because this project's plain variables are managed through `wrangler.toml`.

### 5. Verify

- The sheet menu's **Push CGO plan now** reports `CGO plan pushed` with the counts.
- On the board, **Sync CGO Data** shows `[ CGO SYNC ]` with the weights and the snapshot's age.

---

## Security notes

- The shared token travels in the `X-AWQ-CGO-Token` header of a server-to-server POST, so unlike a query parameter it does not land in browser history or referrer logs.
- The ingest endpoint requires that token and nothing else — it accepts no session and no Origin, which is correct for a machine caller. Rotate the token by changing the Apps Script property and the Cloudflare secret together, then redeploy.
- The endpoint validates the grid with the same parser the board uses, and **refuses a push it cannot parse** so the previous good snapshot survives. A broken sheet therefore cannot blank the board.
- The last snapshot lives in `meta` under `CGO_SHEET_SNAPSHOT`. It is operational data, not a secret store.

## Troubleshooting

| Message | Cause |
|---|---|
| Menu: `CGO push FAILED — Set the CGO_BRIDGE_TOKEN script property first.` | property missing in the Apps Script project |
| `HTTP 401 unauthorized` | the Apps Script property and the Cloudflare secret differ |
| `HTTP 503` | the Cloudflare secret is missing, or the deployment predates it — redeploy |
| `HTTP 422 CGO PLAN header not found` | the sheet lost its `FLIGHT NO` or `Confirmed Wt.`/`REVISE` column, or it moved past row 10 |
| `Check setup` reports `Spreadsheet : FAILED` | this account cannot open the sheet |
| No **AWQ Cloud** menu on the sheet | the script is not bound to the spreadsheet, or you have view-only access — see *Standalone project instead* |
| Board: `No CGO PLAN data has been received yet…` | nothing has been pushed — click **Push CGO plan now** |
| Board: `WARNING: that snapshot is over 2 hours old` | nobody has pushed for a while; the schedule is off |

## Code map

| File | Role |
|---|---|
| `integrations/cgo-bridge/Code.gs` | the Apps Script side — reads the sheet, pushes it, installs the trigger |
| `functions/api/cgo-ingest.js` | the authenticated push endpoint; validates and stores the snapshot |
| `shared/cgo.mjs` | header resolution, date/weight parsing, board matching, summary text — pure, no I/O |
| `functions/api/rpc.js` | `handleSyncCgoData` — reads the snapshot, writes `flights.cgo`, returns the board payload |
| `src/Flight_Ui.html` | `window.syncCgoData()` — sends the board ids, shows the summary |
| `tests/test_cgo_sync.mjs` | parsing, matching, the ingest endpoint, and the whole RPC path |
