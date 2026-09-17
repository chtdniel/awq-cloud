# AWQ OCC Settings Improvement Execution Plan

Status: ✅ APPROVED 2026-09-18 — executed 2026-09-18; all six acceptance items verified against the deployed surface. See "Execution Result".

## Objective

Make the Settings page easier to understand and safer to operate, while preserving the existing access-control model and admin-only protections.

## Review Improvements (added before execution)

- Use the authenticated D1 session and role as the single authorization source; do not mix the legacy email allowlist with internal login roles.
- Return only masked email previews by default. The raw value must not be rendered into the DOM until the user explicitly reveals it, and copy must be gated by the same action.
- Validate every setting at the RPC boundary as well as in the browser. Invalid email entries and malformed WX AI catalog rows must return a 4xx response with field-level details.
- Make all Settings mutations auditable, including actor, target, result, and a redacted change summary. Add a bounded retention policy and never store passwords or full sensitive payloads.
- Treat stale data as a conflict: send an expected revision/hash with saves so an older editor cannot silently overwrite a newer change.
- Add explicit dirty-state handling for allowlist, admin list, and WX AI editors, including refresh/revert behavior and disabled Save buttons when unchanged or invalid.
- Confirm every user mutation (create, role, enable/disable, reset) with the target account and impact, not only empty-list destructive saves.
- Keep the four Settings areas keyboard navigable and ensure the generated `public/index.html` is rebuilt from `src/` before QA.

## Scope

- Split the page into four sections or tabs: **Access Control**, **Internal Users**, **WX AI**, and **System**.
- Explain the difference between `RESTRICTED`, `AUTHORIZED`, and read-only access.
- Mask registered email lists by default, with an explicit reveal action.
- Require confirmation for access changes and destructive account actions.
- Add an audit log for security-sensitive changes.
- Enable Save actions only when the relevant data has changed.
- Validate email entries per line with actionable error messages.
- Group Reset, Disable, and Change Password under a clearly marked Admin Actions area.

## Execution Phases

### Phase 1: Baseline and information architecture

1. Inventory the current Settings components, data sources, save handlers, and permission checks.
2. Define the tab/section structure and shared status vocabulary.
3. Record the current behavior as a regression baseline before UI changes.

### Phase 2: Access Control UX

1. Add the Access Control section for allowlist and admin-list management.
2. Add concise helper text:
   - `RESTRICTED`: access is governed by an allowlist.
   - `AUTHORIZED`: the current account may perform the displayed action.
   - `READ ONLY`: the account may view data but cannot save changes.
3. Mask email values by default and provide a reveal control that does not alter stored data.
4. Add per-entry email validation, normalization feedback, and clear unsaved-change state.
5. Keep Save disabled until a valid change exists; show success or failure feedback after saving.

### Phase 3: Internal Users and Admin Actions

1. Move internal login accounts into the Internal Users section.
2. Separate routine account information from Admin Actions.
3. Add confirmations for Reset, Disable, and Change Password, stating the account and impact.
4. Keep temporary passwords write-only and never display existing passwords.
5. Preserve role restrictions and prevent unauthorized users from reaching mutation handlers.

### Phase 4: Auditability and backend safeguards

1. Define an audit event shape containing actor, action, target, timestamp, result, and a redacted change summary.
2. Record allowlist, admin-list, role, disable, reset, password-change, and WX AI configuration changes.
3. Enforce authorization server-side for every mutation; do not rely on hidden tabs or disabled buttons.
4. Ensure audit entries never contain passwords, tokens, or full sensitive payloads.
5. Add retention and access rules appropriate for the existing deployment.

### Phase 5: WX AI and System presentation

1. Move WX AI configuration into its own section with the master kill-switch clearly labeled.
2. Keep System information read-only and visually distinguish it from editable settings.
3. Show data source, last refresh time, and configuration status where available.

## Acceptance Criteria

- A user can identify their access state without interpreting internal implementation terms.
- The page is navigable through the four logical sections without losing unsaved edits.
- Email lists are not exposed until the user explicitly reveals them.
- Invalid email entries are identified before a save request is sent.
- Save is unavailable when there is no valid change.
- Sensitive admin actions require an explicit confirmation and produce an audit event.
- Existing passwords are never shown, returned, or written to the audit log.
- Unauthorized users cannot mutate data through direct requests.
- Existing authorized workflows continue to work.

## Testing and Manual QA

- Unit-test email parsing, normalization, validation, dirty-state detection, and status mapping.
- Test each role: admin, registered user, and unregistered/read-only user.
- Test keyboard navigation, focus order, labels, confirmation dialogs, and responsive layout.
- Verify refresh, revert, save success, save failure, and stale-data handling.
- Verify audit events for every listed security-sensitive action and confirm sensitive values are redacted.
- Manually exercise the full Settings workflow in the deployed AWQ OCC surface using a non-production test account.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Users misunderstand access status | Use plain-language status text plus a consistent legend. |
| Tab separation hides important warnings | Keep global authorization and unsaved-change indicators visible. |
| UI checks are bypassed | Repeat authorization checks in backend mutation handlers. |
| Audit log exposes sensitive data | Use allowlisted event fields and redaction tests. |
| Existing workflows regress | Capture baseline behavior and run role-based regression QA. |

## Suggested Delivery Order

1. Information architecture and status copy.
2. Dirty-state, validation, and save feedback.
3. Admin action grouping and confirmations.
4. Email masking and accessibility polish.
5. Server-side audit events and security tests.
6. Final role-based manual QA and release review.

## Execution Result (2026-09-18)

Approved by the product owner in-session. Scope additions confirmed: audit log read/retention, accessible Role & Reset Password modals, browser-side WX AI row validation, and Settings authorization tests.

### Delivered

| Item | Where |
|---|---|
| Four tabs (Access Control / Internal Users / WX AI / System); Access Control now explains role-based access | `src/Settings_Ui.html` |
| `OCC_ALLOWED_EMAILS` and `SETTINGS_ADMIN_EMAILS` demoted to read-only legacy, with the reason stated in the UI | `src/Settings_Ui.html`, `functions/api/rpc.js` (`legacySettingsResponse`) |
| Legacy writes refused with `409 LEGACY_SETTING_READ_ONLY` and audited as `legacy_settings_write_denied` | `functions/api/rpc.js` |
| Revision stamp (FNV-1a) on every settings value; `expectedRevision` required on WX AI saves, `409 STALE_REVISION` on conflict, shared stale-revision dialog in the UI | `functions/api/rpc.js`, `src/Settings_Ui.html` |
| Audit trail: retention 180 days / 5000 rows, opportunistic pruning, `adminListAudit` reader, read-only Audit Log panel in Internal Users | `functions/api/rpc.js`, `src/Settings_Ui.html` |
| Denied admin RPC attempts audited as `admin_method_denied` with the actor and tier | `functions/api/rpc.js` |
| `window.prompt` removed for Change Role and Reset Password; both are accessible modals with focus management, Escape, and server field errors | `src/Settings_Ui.html` |
| WX AI rows validated in the browser before Save, with per-row messages and disabled Save | `src/Settings_Ui.html` |
| Per-field WX AI validation on the server (`400 WX_CATALOG_INVALID`, `fields['rowN.field']`) | `functions/api/rpc.js` |
| System tab: D1 data source, timezone, last refresh, configuration status, legacy fields behind a toggle | `src/Settings_Ui.html` |
| WX AI change stamp: `meta.WX_AI_CATALOG_UPDATED_AT` written only on an accepted save, returned by `wxAiGetCatalog`, and shown as "Terakhir diubah: … (N menit lalu)" in the WX AI tab | `functions/api/rpc.js`, `src/Settings_Ui.html` |
| Settings authorization/conflict/validation tests, wired into `npm test` | `tests/test_settings_rpc.mjs` |

### Verification

- `npm test` → 15/15 pass (includes the new `tests/test_settings_rpc.mjs`).
- `node tests/test_settings_access_browser.mjs` → 6/6 scenarios pass (admin, registered, readonly, re-activation, blocked switchTab). Kept out of `npm test` because it drives a real browser, matching the repo convention for browser QA.
- `node build.js` → `public/index.html` rebuilt from `src/` and verified to contain the new panels.
- Deployed and exercised against production: legacy write refused with `409 LEGACY_SETTING_READ_ONLY` plus two `legacy_settings_write_denied` audit entries; a registered account sees only the locked notice, the navbar keeps SETTINGS hidden, and no admin RPC is issued.
- Revision conflict exercised end to end against the deployed surface (see the manual QA result below).
- Not covered by automated tests: live WX AI model calls and a manual keyboard/AT walkthrough in the deployed surface.

### Defects found during deployed QA

The manual pass as a non-admin account surfaced three real defects that neither the unit tests nor code review had caught. All are fixed, and each has a regression guard.

| Defect | Impact | Fix |
|---|---|---|
| `getAccess().canView` returned `Boolean(user)` ("has an account") while the navbar gate read it as "may open Settings" | Any signed-in account was let into Settings; the page then rendered an empty shell because every admin RPC answered `403 ADMIN_REQUIRED` | `canView: tier === 'admin'`, plus a `role` field so callers need not interpret `tier` |
| Two independent writers set panel visibility (the navbar gate and the Settings module), and the admin shell was visible by default in the HTML | A non-admin could see the locked notice and the live WX AI editor at the same time; a slow or blocked script painted the admin layout | `setAccessPanels()` is the only writer; `switchTab` no longer touches the DOM; the admin shell and tab strip start hidden (fail-closed) |
| The in-flight guard in `settingsRefreshAll()` returned early once the first check resolved | When authorization resolved before the view was activated, the locked notice never appeared at all | The resolved result is cached and re-applied on every later call, so a repeat activation always repaints |

Lesson recorded for future UI work: authorization UI must be verified by opening the page **as an account that fails the check**, not only as an admin. An empty shell and a correct denial look identical to the admin performing the test.

### Manual QA result — revision conflict (the last open item)

Two admins, two windows, one live database.

| Probe | Result |
|---|---|
| Save from an editor holding the current revision | `200` — accepted |
| Save from an editor holding an out-of-date revision | `409 STALE_REVISION` — refused, catalog untouched |
| RPC called with `expectedRevision: "sengaja-salah"` | `409` — the guard is not bypassable by sending garbage |
| Real UI path: the stale window pressed Save | Dialog **"Perubahan lebih baru terdeteksi"** appeared and the request returned `409`; the newer window's data was never overwritten |

One earlier attempt appeared to fail. It did not: the JSON body captured from the second window already contained the first window's new model, proving that window had reloaded after the first save, so it held a current revision and its save was legitimate. This is why the change stamp was added — without a visible "last changed" value there was no way to tell a stale editor from a current one, and the same confusion will otherwise recur.

No defect was found in the conflict path. The revision guard held on both the direct-RPC and the UI paths.

### Scope decision recorded

`test@gmail.com` is deliberately kept as an active `registered` account for manual QA. It is not a leftover: do not propose disabling it in future reviews. If it ever needs to be narrowed, `readonly` is the preferred role, because the non-admin UI paths (including the locked Settings notice) can be exercised without write access to operational data.

### Known follow-ups

- The revision stamp is a change detector, not a security control: it assumes an authorised writer.
- `getAccess()` still exposes `canEdit` for registered accounts; that is intentional (they may write operational data) and is not a Settings permission.
- An empty catalog and a never-saved catalog still hash to the same revision value; `updatedAt` (`null` before the first save) is what distinguishes them, so read the stamp rather than inferring from the hash.

