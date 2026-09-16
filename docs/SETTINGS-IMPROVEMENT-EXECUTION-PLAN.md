# AWQ OCC Settings Improvement Execution Plan

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
