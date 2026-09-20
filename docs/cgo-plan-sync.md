# CGO Plan sync (Sync CGO Data)

The flight board's **Sync CGO Data** action reads the cargo desk's **CGO PLAN** Google Sheet and writes the weight onto the flights currently on the board. It replaces a stub that only re-read the local `flights` table, which is why the button used to look like it did nothing.

## Why there is an Apps Script bridge

The AirAsia Google Cloud organization enforces `iam.disableServiceAccountKeyCreation`, so the Worker cannot be given a Google service-account key — creation is refused outright, and the only account that could grant an exception is an Organization Policy Admin.

So the sheet is read by a small Apps Script web app (`integrations/cgo-bridge/Code.gs`) that runs **as an account which already has access to the sheet**, and the Worker calls it with a shared token. Consequences worth knowing:

- The sheet is never shared with anyone or anything new.
- No long-lived Google credential exists anywhere.
- The bridge token is the only secret, and it is rotatable.

Payoff: the parsing and matching rules below live in `shared/cgo.mjs` and are independent of how the sheet is fetched. If the organization ever lifts the key policy, only `functions/api/cgo-bridge.js` has to be replaced.

## Sheet layout

Row 1 is the header; column positions are resolved from the header **text**, so reordering or renaming columns does not break the sync:

| FLIGHT NO | Flight Date | Origin | Dest | Dep Time | Arr Time | Confirmed Wt. | REVISE | Revise Time |
|---|---|---|---|---|---|---|---|---|
| QZ320 | 21/09/2026 | SUB | KUL | 5:05 | 8:40 | 2500 | | |

- **FLIGHT NO** — the designator is ignored, so `QZ320` matches board flight `320`.
- **Flight Date** — read day-first (`DD/MM/YYYY`). A month-first value is only accepted when the day cannot be a month (`09/21/2026`), and Google date serials are accepted too.
- **REVISE wins over Confirmed Wt.** whenever it is filled in. Revise Time is ignored.
- The header row is searched for in the first 10 rows, so a title band above the table is fine.
- Values arrive exactly as displayed in the cell (`getDisplayValues()`), which is what the date parser expects.

## What gets written

Only flights that are **on the board** (`window.activeBoardRowIds`) are candidates:

- Matched on flight number first, then the date picks between several board flights sharing that number.
- With a single candidate the row is still written when the date disagrees with the board DOF, and the disagreement is reported — operators reuse a flight number across days.
- A row that matches nothing on the board is **reported, never written**, so a stale or mistyped plan line cannot change a flight nobody looked at.
- With several same-numbered board flights and no date match, the row is reported as ambiguous rather than guessed.
- Duplicate plan lines for the same flight: the later line wins.

After a sync the operator sees a summary (`[ CGO SYNC ]`) listing how many rows matched, what was updated, and every row that could not be placed. The result is also written to `auth_audit_log` as `cgo_sync`.

Sync requires the **registered** tier (it writes) and a valid CSRF token, the same as every other write. A `readonly` account gets a `REGISTERED_REQUIRED` refusal.

---

## One-time setup

### 1. Check that the deployment may be public

Apps Script web apps can be deployed with **Who has access: Anyone**. Some Workspace domains restrict this and only allow "Anyone within &lt;domain&gt;" — and the Worker has no Google identity, so a domain-only deployment cannot be called. Confirm this is available before going further.

### 2. Create the bridge

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Replace the contents of `Code.gs` with [`integrations/cgo-bridge/Code.gs`](../integrations/cgo-bridge/Code.gs).
3. **Project Settings → Script properties → Add script property**:

   | Property | Value |
   |---|---|
   | `CGO_BRIDGE_TOKEN` | a long random string (40+ characters) |
   | `CGO_SHEET_ID` | optional — defaults to the AWQ CGO PLAN sheet |
   | `CGO_SHEET_NAME` | optional — defaults to the first tab |

   Generate the token with, for example, `openssl rand -hex 32`.
4. **Deploy → New deployment → Web app**:
   - **Execute as: Me** — so it reads the sheet with your access.
   - **Who has access: Anyone** — required, as above.
5. **Authorize** when Google prompts (the script needs to read Sheets).
6. Copy the **`/exec` URL**. It must end in `/exec`; the `/dev` URL only works for you while signed in.

### 3. Configure Cloudflare Pages

Pages → the project → **Settings → Environment variables → Production**:

| Name | Type | Value |
|---|---|---|
| `CGO_BRIDGE_URL` | Variable | the `/exec` URL from step 2 |
| `CGO_BRIDGE_TOKEN` | **Secret** | the same token as `CGO_BRIDGE_TOKEN` in the script properties |

Then **redeploy** so the Worker picks the values up. The token must match in both places exactly.

For local development put the same two names in the untracked `.dev.vars`.

### 4. Verify

Open this in a browser, replacing both values:

```
https://script.google.com/macros/s/…/exec?token=YOUR_TOKEN&ping=1
```

A working bridge answers `{"ok":true,"pong":true}`. Drop `&ping=1` to see the actual sheet grid. `{"ok":false,"error":"unauthorized"}` means the token does not match the script property.

---

## Security notes

- The token travels as a **query parameter**, because an Apps Script web app cannot read request headers and a POST body does not survive Google's 302 redirect to `script.googleusercontent.com`. That means it can appear in request logs at either end, so treat it as rotatable and rotate it if it is ever exposed.
- Rotate by changing `CGO_BRIDGE_TOKEN` in the script properties **and** the Cloudflare secret together, then redeploy.
- `CGO_BRIDGE_URL` is validated against `https://script.google.com/…/exec` before any request is made, so a misconfigured variable cannot send the token to an arbitrary host.
- The bridge is read-only: it returns cell values and has no write path.

## Troubleshooting

| Message | Cause |
|---|---|
| `CGO sync is not configured: set the CGO_BRIDGE_URL variable…` | variable missing, or no redeploy after adding it |
| `CGO_BRIDGE_URL must point at script.google.com` / `must be the /exec deployment URL` | the editor URL or `/dev` URL was pasted |
| `set the CGO_BRIDGE_TOKEN secret` | token missing in Cloudflare |
| `The CGO bridge did not return JSON. Check that the Apps Script deployment has "Who has access: Anyone"…` | the deployment is restricted, so Google served a sign-in page |
| `The CGO bridge rejected the token…` | the two `CGO_BRIDGE_TOKEN` values differ |
| `The CGO bridge could not read the sheet: …` | the script's account cannot open the spreadsheet, or `CGO_SHEET_ID`/`CGO_SHEET_NAME` is wrong |
| `CGO PLAN header not found` | the header row lost its `FLIGHT NO` or `Confirmed Wt.`/`REVISE` column, or it moved past row 10 |
| `No flights are on the board` | the board is empty — add the flights to sync first |

## Code map

| File | Role |
|---|---|
| `integrations/cgo-bridge/Code.gs` | the Apps Script web app — reads the sheet as you, token-guarded |
| `functions/api/cgo-bridge.js` | Worker-side client: URL validation, token, error translation |
| `shared/cgo.mjs` | header resolution, date/weight parsing, board matching, summary text — pure, no I/O |
| `functions/api/rpc.js` | `handleSyncCgoData` — reads the sheet, writes `flights.cgo`, returns the board payload |
| `src/Flight_Ui.html` | `window.syncCgoData()` — sends the board ids, shows the summary |
| `tests/test_cgo_sync.mjs` | parsing, matching, bridge client, and the whole RPC path against a stubbed bridge |
