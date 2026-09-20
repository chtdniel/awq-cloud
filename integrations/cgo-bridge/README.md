# CGO PLAN sync (Apps Script side)

The AirAsia Workspace allows Apps Script web apps to be shared only with *Only myself* or *Anyone within AirAsia* — never *Anyone*, and the AirAsia Google Cloud organization blocks service-account key creation too. The AWQ Cloud Worker has no Google identity, so it cannot call in; but outbound `UrlFetchApp` is unrestricted.

So this script does the work: it reads the CGO PLAN sheet as **you**, and pushes the grid to the Worker. The board then syncs from that snapshot.

Setup steps: [`docs/cgo-plan-sync.md`](../../docs/cgo-plan-sync.md).

## Functions

| Function | What it does |
|---|---|
| `pushCgoPlan()` | Reads the sheet and POSTs it to the Worker. Run by hand any time the board needs the newest plan. |
| `installCgoTrigger()` | Creates the 15-minute schedule (replacing any earlier one) and pushes once immediately. |
| `removeCgoTrigger()` | Deletes the schedule. |
| `diagnose()` | Reports the executing account, the sheet it can open, and whether the trigger exists. |
| `doGet(e)` | Manual browser check inside the domain only. **The Worker does not call this.** |

## Script properties

| Property | Required | Notes |
|---|---|---|
| `CGO_BRIDGE_TOKEN` | yes | the shared token; must equal the Cloudflare secret of the same name |
| `WORKER_INGEST_URL` | no | defaults to `https://awq.christiandaniel.my.id/api/cgo-ingest` |
| `CGO_SHEET_ID` | no | defaults to the AWQ CGO PLAN sheet |
| `CGO_SHEET_NAME` | no | defaults to the first tab |

## What the Worker answers

`{"ok":true,"receivedAt":"…","sheetName":"…","rowCount":…,"entryCount":…,"headerRow":1}`

A refusal carries `ok:false` with an `error`. Look for these in the Apps Script log:

| Log line | Meaning |
|---|---|
| `HTTP 200 {"ok":true,…}` | stored — the board can sync |
| `HTTP 401 unauthorized` | the token here and in Cloudflare differ |
| `HTTP 503` | `CGO_BRIDGE_TOKEN` is missing in Cloudflare Pages, or the deployment predates it |
| `HTTP 422 …header not found` | the sheet's header row changed; the previous snapshot was kept |

## Notes

- `getDisplayValues()` is used, so a date reads as `21/09/2026` rather than a serial number — the Worker's parser expects the displayed form.
- The push is refused by the Worker if the grid cannot be parsed, so a broken sheet never replaces a good snapshot.
- The trigger runs as the account that created it, so `diagnose()` must report `Spreadsheet : OK` for the schedule to work.
