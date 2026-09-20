# CGO PLAN bridge (Apps Script)

The AWQ Cloud Worker reads the **CGO PLAN** Google Sheet through this Apps Script web app, because the AirAsia Google Cloud organization enforces `iam.disableServiceAccountKeyCreation` — a service-account key cannot be created, so the Worker has no Google credential of its own.

`Code.gs` runs as **you**, the account that already has access to the sheet, and returns the sheet's displayed cell values as JSON. The Worker authenticates with a shared token, so the sheet is never shared with anyone and no long-lived Google credential exists.

Setup steps: [`docs/cgo-plan-sync.md`](../../docs/cgo-plan-sync.md).

## Shape of the response

```json
{
  "ok": true,
  "sheetName": "Sheet1",
  "rowCount": 42,
  "readAt": "2026-09-21T04:00:00.000Z",
  "values": [["FLIGHT NO", "Flight Date", "..."], ["QZ320", "21/09/2026", "..."]]
}
```

A refusal answers `{"ok": false, "error": "..."}`. Apps Script cannot set an HTTP status code, so callers must read `ok` rather than the status line.

## Notes

- The token travels as a query parameter: an Apps Script web app cannot read request headers, and a POST body does not survive Google's 302 redirect to `script.googleusercontent.com`.
- `?ping=1` (with the token) proves the deployment, token and redirect work without reading the sheet.
- Rotate the token by changing `CGO_BRIDGE_TOKEN` in **both** the script properties and the Cloudflare secret.
- Values come from `getDisplayValues()`, so a date reads as `21/09/2026` rather than a serial number — the Worker's parser expects the displayed form.
