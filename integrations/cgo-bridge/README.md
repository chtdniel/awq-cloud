# CGO PLAN sync (Apps Script side)

The AirAsia Workspace allows Apps Script web apps to be shared only with *Only myself* or *Anyone within AirAsia* — never *Anyone* — and the AirAsia Google Cloud organization blocks service-account key creation. The AWQ Cloud Worker has no Google identity, so it cannot call in; but outbound `UrlFetchApp` is unrestricted.

So this script does the work: it reads the CGO PLAN sheet as **you** and pushes the grid to the Worker. The board then syncs from that snapshot.

Setup steps: [`docs/cgo-plan-sync.md`](../../docs/cgo-plan-sync.md).

## Bound to the sheet (normal use)

Create it from inside the spreadsheet — **Extensions → Apps Script** — so an **AWQ Cloud** menu appears on the sheet:

| Menu item | What it does |
|---|---|
| Push CGO plan now | Reads the sheet and POSTs it to the Worker |
| Check setup | Which account, which sheet it can open, whether a schedule is active |
| Turn 15-minute schedule ON | Optional automatic push |
| Turn schedule OFF | Back to pushing by hand |

Pushing by hand is the intended default: the cargo desk clicks the menu right after updating the plan, which is the moment the data actually changes. The schedule exists only for people who would rather not think about it.

> The menu needs **edit access** to the spreadsheet — `Extensions → Apps Script` is not offered to viewers. Without edit access, use the standalone option below.

## Standalone

The same file also works from a project created at [script.google.com](https://script.google.com). There is no menu there, so run `pushCgoPlan` from the editor, and set `CGO_SHEET_ID` unless you are reading the AWQ default sheet.

## Script properties

| Property | Required | Notes |
|---|---|---|
| `CGO_BRIDGE_TOKEN` | yes | the shared token; must equal the Cloudflare secret of the same name |
| `WORKER_INGEST_URL` | no | defaults to `https://awq.christiandaniel.my.id/api/cgo-ingest` |
| `CGO_SHEET_ID` | no | only needed for a standalone project pointing at another sheet |
| `CGO_SHEET_NAME` | no | defaults to the first tab |

## Functions

| Function | Notes |
|---|---|
| `onOpen()` | Builds the menu. Simple trigger — needs no authorization. |
| `pushCgoPlan()` | Reads the sheet and pushes it. Returns `{ok, status, detail}`. |
| `installCgoTrigger()` / `removeCgoTrigger()` | The optional 15-minute schedule. |
| `diagnose()` | The full setup report. |
| `doGet(e)` | Manual browser check if a web-app deployment exists. **The Worker does not call this.** |

## What the Worker answers

`{"ok":true,"receivedAt":"…","sheetName":"…","rowCount":…,"entryCount":…,"headerRow":1}`

A refusal carries `ok:false` with an `error`:

| Answer | Meaning |
|---|---|
| `200 {"ok":true,…}` | stored — the board can sync |
| `401 unauthorized` | the token here and in Cloudflare differ |
| `503` | `CGO_BRIDGE_TOKEN` is missing in Cloudflare Pages, or the deployment predates it |
| `422 …header not found` | the sheet's header row changed; the previous snapshot was kept |

## Notes

- `getDisplayValues()` is used, so a date reads as `21/09/2026` rather than a serial number — the Worker's parser expects the displayed form.
- The Worker refuses a push it cannot parse, so a broken sheet never replaces a good snapshot.
- A schedule runs as the account that created it, so `diagnose()` must report `Spreadsheet : OK` for it to work.
