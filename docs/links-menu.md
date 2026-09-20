# LINKS menu

The navbar **LINKS** dropdown is edited from **Settings → LINKS** instead of being hardcoded in `src/Index.html`, so operations can add or change a link without a deploy.

## Where it lives

The list is JSON in the D1 `meta` table under `EXT_LINKS`, with `EXT_LINKS_UPDATED_AT` stamped on each accepted save. No migration is needed — this is the same place `WX_AI_CATALOG` lives.

The shipped default (`EXT_LINKS_DEFAULT` in `functions/api/rpc.js`, mirrored as `DEFAULTS` in the Settings editor) is exactly the list that used to be hardcoded, so nothing changes on the board until an admin saves.

## Entry types

| Type | Fields | Renders as |
|---|---|---|
| `link` | `label`, `url` | a menu entry that opens in a new tab |
| `divider` | — | a separator line that groups the entries around it |

Rules enforced on the server, and mirrored in the browser so a bad row is flagged before the request:

- **Only `https://` addresses.** The URL becomes an `href` in the menu, and `javascript:` parses as a valid URL — so the scheme is checked rather than trusted.
- **Label 1–60 characters**, without `<`, `>` or control characters.
- **Maximum 40 entries.**
- Dividers at the edges and doubled dividers are dropped, so a stray separator cannot render as an empty gap.

The menu is built with DOM nodes and `textContent`, never `innerHTML`, because labels are admin-supplied text.

## Editing

**Settings → LINKS** (admin only) offers `+ Add link`, `+ Add divider`, per-row move up/down and delete, `Reset to default`, `Save` and `Cancel`. Changes are saved with a revision check, so two admins editing at once cannot silently overwrite each other — the second save is refused with a conflict prompt instead. Every accepted save is written to the audit log as `ext_links_updated`.

The revision is a hash of the stored JSON, so re-saving unchanged content keeps the same revision and never raises a false conflict.

The dropdown re-reads the list every time it is opened, so a change appears for other operators without a page reload. A failed read leaves the previous list in place rather than emptying the menu.

## What is not editable

**PUSH CGO PLAN** stays a fixed button in the markup. It is an action, not a link: its URL carries a token the server issues, so letting it be typed into a settings field would let the token be pointed anywhere. See [cgo-plan-sync.md](cgo-plan-sync.md).

## If a saved list becomes unusable

`getExtLinks` validates what it reads. If the stored value is corrupt, or contains something that no longer passes validation (a stored `javascript:` URL, for instance), the **built-in default is served** with `source: fail-safe` and a warning, and the editor is told to save again. A bad stored value can never empty the menu or reach the page as an executable link.

## Code map

| File | Role |
|---|---|
| `functions/api/rpc.js` | `EXT_LINKS_DEFAULT`, `validateExtLinks`, `handleGetExtLinks`, `handleSetExtLinks` |
| `src/Index.html` | `#ext-links-items` container, `renderExternalLinks`, `loadExternalLinks` |
| `src/Settings_Ui.html` | the **LINKS** tab and its row editor |
| `tests/test_ext_links.mjs` | validation, role, revision and fail-safe behaviour |
