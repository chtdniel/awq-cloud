# AWQ CLOUD INTEGRATION AUDIT

Audit scope: repository inspection only. No source code, configuration, schema, dependency, or deployment changes were made for this audit. No production data or secret values were inspected or included.

Evidence labels:

- **FOUND**: directly evidenced by the current repository.
- **NOT FOUND**: searched repository evidence did not show the capability.
- **UNCERTAIN**: code or documentation is incomplete, stale, or internally inconsistent.

## 1. Executive Summary

AWQ Cloud is a single-repository Cloudflare Pages application, not a TypeScript monorepo. Its production application is a static HTML/JavaScript shell built from `src/` into `public/app/index.html`; backend behavior is implemented as Cloudflare Pages Functions under `functions/`; a separate Cloudflare Worker runs scheduled TAF and WX-warning refreshes. D1 is the only declared Cloudflare storage binding.

Authentication is already implemented in AWQ Cloud. It is a custom D1-backed account/session system using `auth_users`, `auth_sessions`, and `auth_audit_log`, with an HttpOnly `__Host-awq_session` cookie and a readable CSRF cookie. Roles are `admin`, `registered`, and `readonly`. The server performs role checks through the `/api/rpc` dispatcher. The existing `admin` role is therefore reusable for the requested MVP gate.

The requested “active flight” contract does not exist. `flights` has no lifecycle/status column, no active flag, and no date-based active query. The RPC named `getActiveFlightList` selects all rows. The UI’s “active board” is a user-specific selection of `flights.id` values in `user_board_state`, with localStorage as a cache. This must not be silently treated as the product’s active-flight definition.

The canonical flight record contains a useful subset of the target context: ID, callsign, date of flight, origin, destination, one alternate field, ETD/ETA, aircraft/registration value, three enroute-like fields, remarks, ATC state, and an active route ID. It does not contain a flight status, route/EET/flight level/explicit ETOPS-EDTO state, or a separate flight-number field. `enr1`–`enr3` are used as airport/station-like values, but the repository does not establish them as ETOPS/EDTO alternates.

TAF support is reusable but not yet sufficient for immutable assessment inputs. TAFs are fetched from AviationWeather.gov first, with BMKG and BOM regional fallbacks, refreshed on a 30-minute schedule, and stored as station/raw text/`issue_time`. The database does not persist source, parsed validity, retrieval time as a distinct field, or revision/version identifiers. The cron path writes the current retrieval time into `issue_time`; validity is parsed later from raw text.

There is no Operations Manual document store, R2 document layer, Vectorize index, embedding service, citation backend, operational rule lifecycle, operational assessment object, immutable assessment table, or change-hash mechanism. The existing AI path is Gemini plus deterministic heuristics for a WX page; it is not DeepSeek, RAG, or a dispatch decision engine.

Based on repository reality, the MVP should be a module/page inside the existing AWQ Cloud deployment (Option A). That keeps the host-only session cookie, same-origin `/api/rpc` boundary, D1 binding, and existing frontend build path intact. A separate application would require a new authentication/session bridge because the `__Host-` cookie cannot be shared across hosts and the RPC guard rejects cross-origin requests.

## 2. Repository Architecture

### Runtime and packaging

| Area | Finding | Evidence |
|---|---|---|
| Framework | **FOUND**: Cloudflare Pages static site plus Pages Functions; no React/Next/Vite framework found. | `wrangler.toml:1-3`; `build.js:1-49` |
| Language | **FOUND**: JavaScript, inline browser JavaScript, ES modules in `functions/` and `shared/`, CommonJS root build script; SQL migrations. | `package.json:24`; `functions/api/rpc.js:1`; `shared/taf.mjs:1`; `build.js:1` |
| Package manager | **FOUND**: npm, with `package-lock.json` and npm scripts. | `package.json:6-15`; `package-lock.json` |
| Repository shape | **FOUND**: one application repository with multiple deployable surfaces, not a workspace/monorepo. No workspace packages or package directories were found. | `package.json`; top-level directory inventory |
| Frontend source | **FOUND**: `src/Index.html` plus included module HTML files such as `Flight_Ui.html`, `Taf_Ui.html`, `Weather_Warning_Ui.html`, `FIR_Ui.html`, and `Settings_Ui.html`. | `build.js:4-42`; `src/Index.html:1560-1574` |
| Frontend artifact | **FOUND**: `public/app/index.html`; `public/index.html` is a separate landing page. | `build.js:6-8`, `39-55` |
| Backend | **FOUND**: Pages Functions in `functions/api/`, plus `functions/briefing.js` and `functions/briefing-form.js`. | `functions/api/*.js`; `functions/briefing.js:8`; `functions/briefing-form.js:69` |
| Shared code | **FOUND**: `shared/taf.mjs`, `shared/wxtime.mjs`, `shared/routegeom.mjs`, `shared/wxwarning.mjs`, `shared/cgo.mjs`, `shared/waypoint.mjs`, and others. | `shared/` directory |
| Deployment | **FOUND**: Pages project `awq-cloud`; separate Worker `awq-cron`. | `wrangler.toml:1-3`; `workers/cron/wrangler.toml:1-8` |
| Cloudflare binding | **FOUND**: D1 binding `DB` in both Pages and cron Worker configuration. | `wrangler.toml:8-11`; `workers/cron/wrangler.toml:10-13` |
| Environment configuration | **FOUND**: public Google OAuth client ID in `wrangler.toml`; local untracked `.dev.vars` contains environment variable names including auth bootstrap; secret values were not printed. | `wrangler.toml:5-6`; `.dev.vars` names only |

Important directories only:

```text
src/                 frontend source modules
public/              Pages static output and assets
functions/           Pages Functions routes
functions/api/       RPC, auth, cron, ingest, XLSX endpoints
shared/              reusable server/shared parsers and domain helpers
migrations/          D1 migrations
workers/cron/        scheduled TAF/WX Worker
tests/               Node and browser tests
docs/                design, security, deployment, and audit documentation
archive/             legacy Apps Script and seed material; not current runtime source
```

## 3. Authentication & Authorization

### Current login and session

**FOUND.** Login is custom email/password authentication in `functions/api/rpc.js`, using password hashing and session lifecycle helpers in `functions/api/auth.js`.

- `handleAuthLogin` normalizes email, reads `auth_users`, verifies PBKDF2-SHA-256, applies failed-login counting/temporary lockout, creates a session, and returns the user role. `functions/api/rpc.js:3495-3514`.
- Password hashing uses Web Crypto PBKDF2-SHA-256 with a random salt and 100,000 iterations. `functions/api/auth.js:1`, `45-70`.
- Sessions store only a SHA-256 token hash in D1. `functions/api/auth.js:84-95`, `104-112`.
- The browser receives `__Host-awq_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, plus `awq_csrf`. `functions/api/auth.js:3-4`, `72-81`, `104-112`.
- Session verification joins `auth_sessions` to `auth_users`, rejects revoked/expired/inactive sessions, and returns user ID, email, role, and session ID. `functions/api/auth.js:84-95`.
- Session TTL is 12 hours. `functions/api/auth.js:2`, `104-108`.

### Request verification and role checks

**FOUND.** The current application uses a same-origin RPC boundary:

- Browser calls `POST /api/rpc` with `credentials: 'same-origin'`. `public/cloudflare-shim.js:366-380`.
- Non-auth RPC calls receive the CSRF header from the readable CSRF cookie. `public/cloudflare-shim.js:40-47`, `366-370`.
- `rpcGuard` requires an `Origin` header equal to the request origin. `functions/api/rpc.js:68-76`.
- Non-auth methods require a valid session. `functions/api/rpc.js:78-115`.
- `ADMIN_ONLY_METHODS` and `REGISTERED_WRITE_METHODS` are explicit server-side policy sets. `functions/api/rpc.js:24-66`, `91-110`.
- `getAccess` maps the session role to `tier`, `role`, `canView`, `canEdit`, and `canManageUsers`. `functions/api/rpc.js:3932-3970`.
- `authMe` returns the current access state through the same RPC dispatcher. `functions/api/rpc.js:119-124`.

### Roles and ADMIN reuse

**FOUND.** Possible roles are exactly `admin`, `registered`, and `readonly`, constrained in D1. `migrations/008_auth_users.sql:1-16`; `functions/api/rpc.js:3591-3595`.

For Dispatch Assistance MVP, the required gate can reuse the existing session and `role === 'admin'` check. However, the gate must be enforced server-side for every Dispatch Assistance operation; hiding a page/button in the browser is not sufficient. The current backend pattern to reuse is `getRequestUser(context)` plus an explicit `user.role !== 'admin'` denial.

### Cross-application reuse

**FOUND for same-origin module; NOT FOUND for independent host.** The host-only `__Host-awq_session` cookie has no `Domain` attribute and therefore cannot be shared with a different host. The RPC guard also rejects cross-origin browser calls. `functions/api/auth.js:72-77`; `functions/api/rpc.js:68-76`.

An application mounted as a page/path on the same AWQ Cloud host can reuse the session. A separate host would need a deliberate SSO/session exchange or a server-side gateway; no such contract exists today.

## 4. User Model

### Account schema

**FOUND.** The canonical account table is `auth_users`, not `users`:

```text
auth_users.id                   integer primary key
auth_users.email_normalized     unique normalized email
auth_users.email_display        display email
auth_users.password_hash/salt   password credential material
auth_users.password_iterations  PBKDF2 parameter
auth_users.password_algorithm   algorithm label
auth_users.role                 admin | registered | readonly
auth_users.is_active            0/1
auth_users.must_change_password 0/1
auth_users.failed_login_count
auth_users.locked_until
auth_users.created_at/updated_at
auth_users.last_login_at
```

Evidence: `migrations/008_auth_users.sql:1-17`.

### Profile schema

**FOUND.** Optional profile data is in a one-to-one `user_profiles` table:

```text
user_profiles.user_id
user_profiles.full_name
user_profiles.iaa_id
user_profiles.lic_no
user_profiles.updated_by
user_profiles.created_at/updated_at
```

Evidence: `migrations/011_user_profiles.sql:1-15`; read path `functions/api/rpc.js:3936-3948`.

No organization, tier separate from role, permissions table, or dispatch-specific identity model was found. Do not duplicate this model in Dispatch Assistance.

## 5. Flight Domain Model

### Canonical storage

**FOUND.** The canonical flight table is D1 `flights`. `schema.sql:4-24`.

| Target field | Current field | Status |
|---|---|---|
| flight ID | `flights.id` | FOUND |
| flight number/callsign | `flights.callsign` | FOUND; no separate flight-number field |
| flight date | `flights.dof` | FOUND as text, normally `YYYYMMDD` |
| origin | `flights.dep` | FOUND |
| destination | `flights.dest` | FOUND |
| destination alternates | `flights.alt` | FOUND as one text field only |
| STD | `flights.etd` | FOUND; accepts multiple legacy formats |
| STA | `flights.eta` | FOUND; accepts multiple legacy formats |
| ETD/ETA | `etd`/`eta` | FOUND; there is no separate estimate/revision model |
| aircraft type/registration | `flights.ac_type` | FOUND as one overloaded field; `aircraft` table separately stores registrations and nullable `ac_type` |
| route | `flights.active_route_id`, related `routes.route_string`/`waypoint_seq` | PARTIAL |
| EET | no field found | NOT FOUND |
| flight level | no field found | NOT FOUND; `CRZ FL` appears in archived/legacy UI material, not current D1 schema |
| status | no field found | NOT FOUND |
| enroute values | `enr1`, `enr2`, `enr3` | FOUND but semantics are not formally defined |
| operational update timestamp | `created_at` only | PARTIAL; no `flights.updated_at` or revision ID |

The dashboard mapper exposes these fields as `FLIGHT`, `DEP`, `ARR`, `STD`, `STA`, `REG`, `ALT`, `ENR1`–`ENR3`, `DOF`, and `ACTIVE_ROUTE_ID`. `functions/api/rpc.js:363-419`.

### Service/API access

- Full dashboard load: `handleGetFlightDashboardData` reads all flights and routes, validates basic callsign/ICAO shape, and returns a UI-specific shape. `functions/api/rpc.js:363-423`.
- Explicit flight detail: `handleGetSelectedFlightsData` accepts optional numeric row IDs and returns flight rows, routes, latlong, and mapped FIR labels. `functions/api/rpc.js:2044-2137`.
- Flight writes: `saveFlightEdit`, `saveFlightRoute`, `setActiveFlightRoute`, `addNewFlightToDb`, bulk DOF/TAF/CGO updates, and `saveFlightEnr` are RPC methods. Dispatcher mapping: `functions/api/rpc.js:152-168`, `327-344`.
- Frontend source of current board data: `src/Flight_Ui.html:2013-2053`.

### Caches and user-selected board

**FOUND.** `user_board_state` stores an ordered JSON array of `flights.id` values per account. `migrations/012_user_board_state.sql:1-14`; handlers `functions/api/rpc.js:457-510`. The browser also caches the board under `occ_active_board` and protects it with an owner stamp. `src/Flight_Ui.html:963-1151`.

This is a working-set selection, not a flight lifecycle state or operational truth. Dispatch Assistance must use `flight_id` and re-read the canonical D1 flight record server-side.

## 6. Definition of Active Flight

### Result: **NOT FOUND / UNCERTAIN**

The repository does not implement the requested lifecycle concept of an active flight.

Evidence:

- `flights` has no `status`, `is_active`, `active_from`, `active_to`, or equivalent field. `schema.sql:4-24`.
- `handleGetActiveFlightList` selects `SELECT * FROM flights ORDER BY id ASC` with no status, date, time, or current-time predicate. `functions/api/rpc.js:2139-2156`.
- `handleGetActiveFlightDataForWarning` also selects all flights. `functions/api/rpc.js:1458-1462`.
- `/api/cron` collects stations from all `flights` rows using `dep`, `dest`, and `alt`; it does not filter active flights. `functions/api/cron.js:13-20`.
- The operational-readiness message says “active flights” but groups by the most common non-empty DOF; that is a display/readiness heuristic, not a canonical active query. `functions/api/rpc.js:1780-1795`.
- The browser’s “active board” is the per-user list of selected row IDs. `src/Flight_Ui.html:2093-2108`; `migrations/012_user_board_state.sql:9-14`.
- Frontend triage labels are `ready`, `monitor`, and `attention`, based on route, ATC, NOTAM, timezone, and remarks. They are not lifecycle states. `src/Flight_Ui.html:1304-1375`.

No flight date/time rule, status enum, or existing endpoint/query can be documented as the authoritative active-flight definition. Dispatch Assistance must remain blocked from calling every row “active” until the product owner defines the source-of-record semantics and AWQ Cloud exposes them.

## 7. Alternate Handling

### Destination alternates

**FOUND, limited.** The current schema has exactly one `alt TEXT` column. `schema.sql:4-24`. Current UI and server paths treat it as one ICAO/station-like value:

- dashboard mapper: `ALT: row.alt`. `functions/api/rpc.js:394-414`;
- weather warning mapping: `const altApt = String(row.alt || '')`. `functions/api/rpc.js:1489-1516`;
- briefing station construction includes `f.alt` as one candidate. `functions/briefing-form.js:130-167`.

Multiple destination alternates are **NOT FOUND** as a normalized array, relation, JSON column, or separate table. A value containing multiple tokens may be possible in free text, but the current server code does not establish or validate that contract. Dispatch Assistance must not split it heuristically without an approved migration/contract.

### Enroute alternates

`enr1`, `enr2`, and `enr3` are real columns used by briefing, FIR mapping, NOTAM matching, and TAF station ordering. Evidence: `schema.sql:15-18`; `functions/api/rpc.js:2071-2079`; `functions/briefing-form.js:130-165`.

They are **not proven to be enroute alternates**. They are currently treated as additional four-letter station/airport values. Their role should remain `UNKNOWN` until domain ownership confirms it.

## 8. ETOPS / EDTO Support

### Result: **NOT IMPLEMENTED / NOT FOUND**

Repository-wide search found no current implementation of ETOPS, EDTO, ERA, or en-route alternate terminology in the active source. There is no explicit boolean, status, threshold, approval, diversion-time, or rule field.

The presence of `enr1`–`enr3` is not enough to infer ETOPS/EDTO. Existing code uses those fields for generic additional stations and FIR/TAF/report enrichment, not an ETOPS/EDTO decision. `functions/api/rpc.js:2069-2079`; `functions/briefing-form.js:130-167`.

The Dispatch Assistance weather scope therefore cannot conditionally include enroute alternates until a real ETOPS/EDTO field or approved equivalent is added to the upstream contract.

## 9. TAF / Weather Architecture

### Sources and retrieval

**FOUND.** `shared/taf.mjs` defines three external sources:

1. AviationWeather.gov ADDS TAF raw endpoint, attempted first. `shared/taf.mjs:41-55`.
2. BMKG aviation TAF endpoint for missing Indonesian stations. `shared/taf.mjs:56-76`.
3. BOM aviation endpoint for missing Australian stations. `shared/taf.mjs:56-84`.

The parser accepts raw TAF blocks, resolves issue/validity dates around the retrieval date, chooses the newest valid non-NIL forecast, and returns raw text. `shared/taf.mjs:8-39`.

### Storage

`tafs` currently contains:

```text
id            integer primary key
station       text
raw_text      text
issue_time    datetime
created_at    datetime
```

Evidence: `schema.sql:163-170`.

There is a unique station index, so the normal current schema supports one row per station. Both scheduled refresh paths use `ON CONFLICT(station) DO UPDATE`. `functions/api/cron.js:29-41`; `workers/cron/index.js:56-69`.

### Required target fields versus current support

| Required field | Current support | Finding |
|---|---|---|
| station | `tafs.station` | FOUND |
| raw TAF | `tafs.raw_text` | FOUND; raw text is preserved in current row |
| issued time | `tafs.issue_time` | UNCERTAIN: refresh paths write current time, not necessarily the TAF’s encoded issue time |
| validity period | encoded in raw TAF and parsed at runtime | PARTIAL; no stored `valid_from`/`valid_to` |
| retrieval timestamp | `created_at` plus overwrite behavior; cron returns `timestamp` | PARTIAL; no explicit `retrieved_at` column and updates do not preserve a historical retrieval record |
| source | no column; source selection is internal to fetch code | NOT FOUND |
| parsed/normalized TAF | no persisted parsed field | NOT FOUND; `parseTafValidity` handles only a validity window at runtime |
| refresh mechanism | 30-minute cron schedule and manual fetch RPC | FOUND |
| station matching | SQL union of `dep`, `dest`, `alt`, four-letter validation | FOUND but excludes `enr1`–`enr3` in refresh collection |

The Pages cron endpoint uses `SELECT DISTINCT dep ... UNION ... dest ... alt`; `functions/api/cron.js:13-20`. The separate cron Worker repeats the same scope; `workers/cron/index.js:40-54`.

### Existing flight-weather aggregation

`handleGetActiveFlightDataForWarning` joins every flight with newest TAF rows and returns departure, arrival, and one alternate weather plus coverage labels. `functions/api/rpc.js:1458-1543`.

It does not accept a `flight_id`, does not include `enr1`–`enr3`, and the code calls the result “active” while reading all flight rows. It is therefore reusable as a reference implementation, not as the final Dispatch Assistance flight-weather contract.

### TAF states and fail-closed behavior

Existing UI/server vocabulary includes missing, coverage `IN`/`OUT`/`UNKNOWN`, and page freshness labels. `shared/wxtime.mjs:163-176`; `src/Taf_Ui.html:29-35`. The target states `VALID`, `STALE`, `EXPIRED`, `INVALID`, `PARTIAL_PARSE`, and `PARSE_ERROR` are not implemented as a canonical data model. The existing WX heuristic returns `NO_DATA` for missing TAF but also returns `CLEAR` based on pattern heuristics when no danger/warning token is found. `functions/api/rpc.js:1549-1593`. This is not sufficient for the target `INDETERMINATE` semantics.

## 10. Existing API Surface

The application primarily exposes a method-dispatch API rather than separate REST resources.

| Capability | Method/route | Auth | Input/output evidence |
|---|---|---|---|
| Current user | `POST /api/rpc`, `method: authMe` | RPC origin guard; auth method exception; no session required | Returns access/tier/role/profile. `functions/api/rpc.js:119-124`, `3932-3970` |
| Login/logout | `POST /api/rpc`, `authLogin`/`authLogout` | Origin guard; auth methods | `functions/api/rpc.js:119-128`, `3495-3523` |
| All dashboard flights | `POST /api/rpc`, `getFlightDashboardData` | authenticated read | Reads all flights and maps UI fields. `functions/api/rpc.js:56-65`, `363-423` |
| Named active list | `POST /api/rpc`, `getActiveFlightList` / `getFlightSummary` | authenticated read | Returns all rows; no active predicate. `functions/api/rpc.js:230-232`, `2139-2156` |
| User board selection | `POST /api/rpc`, `getBoardState` | authenticated read | Returns user-owned row IDs and updated timestamp. `functions/api/rpc.js:131-134`, `457-510` |
| Flight detail | `POST /api/rpc`, `getSelectedFlightsData` | authenticated read | Optional numeric row IDs; returns flights, routes, latlong, FIR labels. `functions/api/rpc.js:227-232`, `2044-2137` |
| TAF registry | `POST /api/rpc`, `getTafData` | authenticated read | Returns station/raw/TIMESTAMP from D1. `functions/api/rpc.js:58-65`, `1188-1200` |
| TAF retrieval | `POST /api/rpc`, `fetchLatestTafFromApi` | authenticated read | Takes station list, calls `fetchLatestTafs`, returns raw map. `functions/api/rpc.js:1246-1255` |
| Flight weather aggregate | `POST /api/rpc`, `getActiveFlightDataForWarning` | authenticated read | All flights, DEP/ARR/one ALT TAF; stringified JSON output. `functions/api/rpc.js:1458-1543` |
| Weather warning/AI | `POST /api/rpc`, `analyzeWxWithManual` | authenticated read | Heuristic or Gemini WX assessment; no Dispatch assessment object. `functions/api/rpc.js:1595-1755` |
| Public API probe | `GET /api` | no auth in function | Returns first 10 flight rows. `functions/api/index.js:1-17` |
| TAF refresh | `/api/cron` Pages Function | no auth check in handler | Fetches all dep/dest/alt stations and writes D1. `functions/api/cron.js:7-53` |
| Server-to-server CGO ingest | `POST /api/cgo-ingest` | shared `X-AWQ-CGO-Token` | Constant-time token check, bounded JSON grid, stores snapshot in `meta`. `functions/api/cgo-ingest.js:39-99` |

There is no dedicated REST endpoint for current user, active flights, flight detail, or per-flight weather. The existing RPC methods are sufficient for a same-application prototype only where their scope is acceptable. A proper Dispatch Assistance contract needs explicit flight IDs and an upstream active definition.

## 11. Database & Cloudflare Services

### Database technology

**FOUND:** Cloudflare D1/SQLite. `wrangler.toml:8-11`; `schema.sql`.

Relevant tables:

| Concern | Table(s) | Finding |
|---|---|---|
| Users | `auth_users` | FOUND |
| Roles | role check constraint on `auth_users` | FOUND; no roles table |
| Sessions | `auth_sessions` | FOUND |
| Auth audit | `auth_audit_log` | FOUND |
| Profiles | `user_profiles` | FOUND |
| Flights | `flights` | FOUND |
| Routes | `routes`, `latlong` | FOUND |
| Aircraft | `aircraft` | FOUND |
| TAF | `tafs` | FOUND |
| General weather | no generic weather table; `wx_warnings` is warning/advisory storage | PARTIAL |
| Assessment | no assessment table | NOT FOUND |
| Documents/chunks/citations/rules | no relevant tables | NOT FOUND |
| Change/version records for flights/TAFs | no dedicated table | NOT FOUND |

### Declared Cloudflare services

| Service | Finding | Evidence |
|---|---|---|
| Pages | FOUND | `wrangler.toml:1-3` |
| Workers | FOUND: separate cron Worker | `workers/cron/wrangler.toml` |
| D1 | FOUND: `DB` | root and cron `wrangler.toml` |
| R2 | NOT FOUND in bindings/config/source | repository search |
| KV | NOT FOUND in bindings/config/source | repository search |
| Vectorize | NOT FOUND | repository search |
| Queues | NOT FOUND | repository search |
| Durable Objects | NOT FOUND | repository search |
| Cron Triggers | FOUND on `awq-cron` | `workers/cron/wrangler.toml:5-8` |
| Cache API | FOUND for Gemini response cache; not a KV data store | `functions/api/rpc.js:1663-1698` |

## 12. Shared Types / Reusable Components

**FOUND:** reusable behavior exists in `shared/`, but **NOT FOUND:** TypeScript interfaces or canonical domain types named `User`, `Flight`, `Weather`, `TAF`, `Airport`, or `Alternate`. A repository-wide search found no TypeScript source or domain interface declarations.

Reusable components include:

- `shared/taf.mjs`: TAF fetch and raw parsing.
- `shared/wxtime.mjs`: flight time normalization, TAF validity overlap, newest-row selection.
- `shared/routegeom.mjs`: route resolution.
- `shared/wxwarning.mjs`: warning product parsing and persistence helpers.
- `shared/cgo.mjs`: cargo snapshot parsing/matching.
- `functions/api/auth.js`: session/user verification and auth helpers.

Dispatch Assistance should reuse `getRequestUser`, `shared/taf.mjs`, and `shared/wxtime.mjs` behavior where semantics remain valid, but should introduce a documented shared contract/type layer only after the upstream fields and active-flight meaning are agreed. It should not create a duplicate user or flight source of truth.

## 13. Existing AI Infrastructure

### Current provider and behavior

**FOUND:** Gemini only. `handleAnalyzeWxWithManual` reads `GEMINI_API_KEY`, defaults the model to `gemini-1.5-flash` if the request does not supply one, sends a structured prompt, caches responses with the Cloudflare Cache API, rate-limits through D1 `meta`, and falls back to heuristic rules on missing key, quota, API error, or malformed output. `functions/api/rpc.js:1595-1629`, `1663-1755`.

The heuristic engine recognizes tokens such as `TSRA`, `FG`, `VA`, `TS`, `CB`, `RA`, and gusts, and returns `DANGER`, `WARNING`, `CLEAR`, or `NO_DATA`. `functions/api/rpc.js:1549-1593`.

### Reuse and conflicts with target architecture

- DeepSeek integration: **NOT FOUND**.
- OpenAI/Claude/Gemini abstraction: **NOT FOUND**; Gemini is directly called in `rpc.js`.
- RAG/document retrieval: **NOT FOUND**.
- R2 documents: **NOT FOUND**.
- Vectorize/embeddings/reranking: **NOT FOUND**.
- Backend citation generation/validation: **NOT FOUND**.
- Configurable operational rule store/lifecycle: **NOT FOUND**. `getWxRules` returns an empty default structure, `functions/api/rpc.js:245-250`.

The existing Gemini/heuristic path can be reused only as a degraded explanation or weather-assistance component after its output contract is changed. It is not suitable as the authority for TAF parsing, threshold comparison, citation generation, or final dispatch verdicts. Its current hard-coded manual excerpt and `CLEAR` fallback also do not provide the requested approved-source action semantics. `functions/api/rpc.js:1631-1642`.

## 14. Gap Analysis

| Requirement | Existing Support | Existing Location | Gap | Recommended Approach |
|---|---|---|---|---|
| SSO/session reuse | **FOUND** for same-host module | `functions/api/auth.js`; `public/cloudflare-shim.js` | Host-only cookie and same-origin guard prevent direct cross-host reuse | Put MVP module under same Pages host/path; reuse `getRequestUser` |
| ADMIN authorization | **FOUND** server-side role | `functions/api/rpc.js:24-66`, `95-110`, `3932-3970` | Dispatch page/operation policy does not exist | Add a future explicit Dispatch policy using existing role, after approval |
| Active flight API | **PARTIAL** misleading RPC names | `functions/api/rpc.js:2139-2156` | No lifecycle/status/date definition; list returns all rows | **NEW CONTRACT REQUIRED** after product defines “active” |
| Flight context | **PARTIAL** | `schema.sql:4-24`; `getSelectedFlightsData` | Missing normalized target fields and snapshot contract | Map existing fields; leave missing fields nullable; bind every request to `flight_id` |
| Multiple alternates | **NOT FOUND** | `flights.alt` only | One free-text field; no array/relation | **NEW CONTRACT REQUIRED** for normalized alternates; no heuristic splitting |
| Route | **PARTIAL** | `active_route_id`; `routes`; `latlong` | No route snapshot or guaranteed route per flight | Reuse route lookup; define immutable snapshot at assessment time later |
| EET | **NOT FOUND** | no flight schema field | Cannot calculate target context from source field | Add upstream field/contract only if operationally required |
| Flight level | **NOT FOUND** in current D1 | no `flights` field | No canonical value | Add upstream field/contract if required; do not use archive-only fields |
| Estimated times | **FOUND/PARTIAL** | `etd`, `eta`; `shared/wxtime.mjs` | Legacy formats and no revision model | Reuse parser; normalize in a boundary response |
| ETOPS/EDTO | **NOT FOUND** | no active source implementation | Enroute fields do not prove ETOPS/EDTO | **NEW CONTRACT REQUIRED** for explicit state/context |
| Enroute alternates | **UNCERTAIN** | `enr1`–`enr3` | Semantics not established; cron excludes them | Do not include as ETOPS data until source semantics are confirmed |
| Raw TAF | **FOUND** | `tafs.raw_text`; `getTafData` | No immutable versioning | Reuse raw text; snapshot it per future assessment |
| TAF timestamps | **PARTIAL** | `issue_time`, `created_at` | `issue_time` is overwritten with retrieval time by cron; no source/retrieved-at split | **NEW CONTRACT REQUIRED** for issued/valid/retrieved/source metadata |
| Weather retrieval | **FOUND/PARTIAL** | `shared/taf.mjs`; `/api/cron`; `fetchLatestTafFromApi` | No per-flight scoped bundle and no enroute scope | **NEW CONTRACT REQUIRED** for `flight_id` weather bundle |
| Shared types | **NOT FOUND** | JS object shapes only | Duplicate ad hoc shapes | Create one approved contract/type layer when fields are settled |
| Change detection | **NOT FOUND/PARTIAL** | `briefing_reports` IDs; NOTAM `updated_at`; settings revisions | No flight/TAF hashes or versions | Future `flight_context_hash`/`taf_bundle_hash` at assessment boundary |
| Cloudflare services | **FOUND D1/Pages/Worker/Cron** | `wrangler.toml`; `workers/cron/wrangler.toml` | R2/Vectorize/Queues/DO/KV absent | Add only when document/RAG/assessment design is approved |
| Audit foundation | **PARTIAL** | `auth_audit_log`; `notam_update_log`; `briefing_reports` | No operational assessment audit/snapshot/citation records | **NEW CONTRACT REQUIRED** for append-only assessment records |
| Documents/OM retrieval | **NOT FOUND** | no document tables/files/index | No approved-source corpus or retrieval layer | Future R2+D1 metadata+Vectorize design; do not hard-code hierarchy |
| Citations | **NOT FOUND** | no citation IDs/chunks | LLM cannot be grounded to backend citations | Backend-owned citation package required before LLM synthesis |
| Deterministic rule engine | **PARTIAL/NOT SUFFICIENT** | `evaluateTafLegRuleBased` | Heuristics are not approved rule/version lifecycle | Future versioned rule engine with `COMPLIANT` etc. |
| Immutable assessments | **NOT FOUND** | no assessment table | Current data is live/updatable | Future append-only assessment schema and snapshot flow |

## 15. Recommended Integration Architecture

### Recommendation: Option A — module/page inside AWQ Cloud

This is the best fit for the current repository because:

1. Authentication is host-bound and already available in the Pages Functions runtime.
2. All current application data is in the same D1 binding.
3. Existing UI is a single shell built from HTML modules, so a Dispatch page fits the current frontend model.
4. The existing same-origin `/api/rpc` and CSRF flow can be reused without introducing CORS or a token exchange.
5. A separate application would immediately require a new cross-host trust boundary, SSO/session exchange, or server-to-server gateway, none of which exists.

### Boundary recommendation

Keep AWQ Cloud as the upstream System of Record. Dispatch Assistance should be a read-oriented, ADMIN-only module that consumes explicit upstream contracts and owns future assessment/document/rule data only where the approved architecture assigns ownership.

Do not duplicate `auth_users`, `auth_sessions`, or the canonical `flights` table. Do not let a browser-supplied flight object become authoritative; the backend must re-read by `flight_id` and capture an assessment snapshot later.

Option B, a separate application in the same repository, could become useful once a clear API contract is established, but the current repository has no monorepo/package boundary and no independent deployment contract. Option C is the weakest current fit because it would need new public APIs, CORS policy, service authentication, and session bridging.

## 16. Proposed Integration Contract

The following is the minimum contract for a same-host MVP. Existing RPC methods should be reused where their scope is safe; new interfaces are marked explicitly.

### Existing interfaces to reuse

```text
POST /api/rpc
{ method: "authMe", args: [] }
```

Use the returned `role`/`tier` and enforce `admin` server-side.

```text
POST /api/rpc
{ method: "getSelectedFlightsData", args: [[flight_id]] }
```

Use only with an explicit single ID for a selected context. The response currently contains the raw flight row mapped to UI keys plus routes, latlong, and FIR labels. It must not be treated as an active-flight query.

```text
POST /api/rpc
{ method: "getTafData", args: [] }
```

Reusable for the current station registry, but it lacks the target source/issued/valid/retrieved metadata.

```text
POST /api/rpc
{ method: "fetchLatestTafFromApi", args: [["WIII", "WADD"]] }
```

Reusable for controlled station refresh, but its response is raw station-to-TAF text and is not an immutable bundle.

### New contracts required

#### 1. Canonical active-flight selection

```text
NEW CONTRACT REQUIRED
GET/POST active flights
Response: [{ flight_id, ...minimal canonical flight fields... }]
```

The contract must document whether active means a stored status, date/time window, operational board membership, or another source-defined state. Until then, no Dispatch module should label all rows or all board rows as active.

#### 2. Explicit flight context

```text
NEW CONTRACT REQUIRED
GET/POST flight context by flight_id
```

Minimum current fields that can be populated without inventing values:

```text
flight_id       flights.id
flight_number   null unless callsign is explicitly accepted as the same domain field
callsign        flights.callsign
flight_date     flights.dof
origin          flights.dep
destination     flights.dest
alternates      one current `alt` value only, or nullable until normalized
std             flights.etd
sta             flights.eta
aircraft_type   nullable/ambiguous because ac_type is overloaded
registration    nullable unless a separate mapping is confirmed
route           active route lookup where present
eet             null
flight_level    null
etops_edto      null/not implemented
enroute_alternates null/not implemented
```

The response must carry the source `flight_id` and must not silently reuse a prior selected context.

#### 3. Per-flight weather bundle

```text
NEW CONTRACT REQUIRED
GET/POST flight weather by flight_id and assessment time
```

The server should derive stations from the canonical flight record. Normal scope is origin, destination, and normalized destination alternates. Enroute stations may be added only when an explicit ETOPS/EDTO state is present. The response should include, at minimum, station, raw TAF, encoded/parsed issue time, validity, retrieval time, source, and data status.

#### 4. Admin authorization boundary

```text
NEW CONTRACT REQUIRED
All Dispatch Assistance read/assessment methods require current session role=admin.
```

This can be implemented inside the current `/api/rpc` policy model or as same-host Pages Function handlers. It must be a server-side check, not a page-only check.

#### 5. Future operational assessment persistence

```text
NEW CONTRACT REQUIRED
Create immutable assessment
Read assessment by assessment_id
List assessment history by flight_id
```

This is outside the current audit-only scope and should wait for the active-flight, TAF metadata, approved-document, rule-version, citation, and LLM policy decisions.

## 17. Security Considerations

### Positive existing controls

- Session token is random and only its hash is stored. `functions/api/auth.js:104-112`.
- Session cookie is HttpOnly, Secure, SameSite=Lax, Path=/, and host-only. `functions/api/auth.js:72-77`.
- CSRF double-submit check exists for state-changing RPCs. `functions/api/auth.js:97-101`; `functions/api/rpc.js:91-94`.
- Origin equality is checked for RPC requests. `functions/api/rpc.js:68-76`.
- Role checks are server-side and explicit. `functions/api/rpc.js:95-110`.
- Auth actions and admin denials are auditable through D1. `functions/api/auth.js:123-129`; `functions/api/rpc.js:95-103`.
- Server-to-server CGO ingest uses a separate header token with constant-time comparison and body/row/column limits. `functions/api/cgo-ingest.js:14-24`, `39-71`.

### Integration risks

1. **Separate-host session sharing is unsafe/unavailable by default.** The `__Host-` cookie cannot be scoped to a sibling host, and cross-origin RPC is rejected. Keep MVP same-host or design a formal SSO bridge.
2. **Current public data paths need review.** `functions/api/index.js` returns flight rows without an auth check. `/api/cron` has no request authentication in its handler. These paths must not be used as the Dispatch contract without a security decision.
3. **Cron exposure.** The Pages `/api/cron` route can trigger external TAF retrieval and D1 writes if reachable. The separate Worker’s `fetch` handler also accepts `job=tafs`/`job=wx-warnings` without an application-level secret. `workers/cron/index.js:25-31`.
4. **Unprotected HTML briefing routes.** `functions/briefing.js:8-36` and `functions/briefing-form.js:69-100` query flight data from URL parameters; the form uses `getRequestUser` only for profile prefill at `functions/briefing-form.js:216-229`, not as an overall route gate. Do not assume these are suitable data APIs.
5. **Client-only page gates are insufficient.** `src/Index.html:1620-1635` hides Settings/Waypoint UI based on browser state, but the secure behavior comes from RPC role checks. Dispatch must follow the server pattern.
6. **CSRF/origin assumptions differ by route.** The current browser RPC flow is same-origin and cookie-based; a separate app calling it from another origin would fail the Origin check and would not carry the host-only session.
7. **Bootstrap secret lifecycle.** `authBootstrap` checks `AUTH_BOOTSTRAP_SECRET` and the absence of an active admin, but the endpoint is an auth-method exception and does not show an explicit rate limit or constant-time comparison. `functions/api/rpc.js:127`, `3597-3607`. Treat this as a deployment/security review item.
8. **Documentation is stale relative to code.** `docs/internal-auth-plan-review.md:20-31` describes an older Cloudflare Access header path, while current `rpcGuard` only validates request Origin and current auth uses D1 sessions. The report should rely on active code, not that stale description.

No credentials, password hashes, session tokens, or production rows were included in this audit.

## 18. Technical Risks

1. **Wrong active-flight population.** Reusing `getActiveFlightList` would include every database row and violate the requested active-only behavior.
2. **Context leakage.** Existing UI board state is per-user and mutable. A future assessment must carry explicit `flight_id` and a snapshot; it must not depend on whichever board selection happens to be in browser state.
3. **Alternate ambiguity.** One free-text `alt` cannot reliably represent multiple destination alternates; `enr1`–`enr3` cannot be assumed to be ETOPS/EDTO alternates.
4. **TAF timestamp ambiguity.** `issue_time` is written with current refresh time by cron even though the raw TAF contains an encoded issue group. This can produce incorrect freshness/version semantics.
5. **TAF replacement destroys history.** Current station rows are upserted and manual save deletes/replaces the table. This conflicts with immutable assessment snapshots and “new operational data available” detection.
6. **No provenance.** TAF source, parser version, document revision, rule version, and citation IDs are not stored in a shared evidence package.
7. **AI policy mismatch.** Current Gemini output uses `DANGER/WARNING/CLEAR/NO_DATA` and hard-coded action prose, not the requested deterministic assessment results and source-directed-action rules.
8. **No approved knowledge corpus.** There is no Operations Manual ingestion/revision lifecycle, R2 object inventory, chunk table, embedding index, or citation validator.
9. **No change detector.** Flights have `created_at` but no update timestamp/revision; TAFs have no immutable version. Hash comparison cannot be implemented reliably from current data alone.
10. **Multiple data access shapes.** RPC, direct HTML routes, cron, legacy Apps Script artifacts, and UI-shaped object mappers coexist. A Dispatch contract must choose one server boundary and avoid archive/legacy shapes.

## 19. Open Questions

These questions cannot be answered from the repository without operational/product input:

1. What exactly makes a flight “active”: a stored lifecycle status, DOF/date/time window, operational board membership, or another upstream system state?
2. Is `callsign` also the intended flight-number field, or is a separate number required?
3. Is `ac_type` a registration, aircraft type, or overloaded legacy field in current production data?
4. What do `enr1`–`enr3` mean operationally: route stations, enroute alternates, or manual TAF/NOTAM stations?
5. Can one `alt` value contain multiple alternates in real source data, and if so, what is the approved delimiter/normalization rule?
6. Where should canonical EET and flight level come from if they are not in D1?
7. What explicit upstream field or rule establishes ETOPS/EDTO active state?
8. Is `tafs.issue_time` intended to mean encoded TAF issue time or repository retrieval time? The current cron implementation suggests retrieval time.
9. Should TAF retrieval preserve every source/version, or only the latest current row plus an immutable snapshot at assessment time?
10. Which approved documents are in scope first, and what revision/authority metadata is required?
11. Who approves extracted rules and activates/retires them?
12. Should Dispatch Assistance remain inside `/app` as a new tab, use a same-host path, or use a same-host separate static entry point?
13. Should Dispatch Assistance read via existing RPC methods or should a versioned internal API be introduced under the same host?
14. Are `/api`, `/api/cron`, `/briefing`, and `/briefing-form` intentionally public, or should their exposure be reviewed before integrating operational decision support?
15. Is Gemini still permitted, or must the new module use configurable DeepSeek from the beginning? The current repository contains no DeepSeek implementation.

## 20. Recommended Next Implementation Step

Do not implement Dispatch Assistance yet. First obtain human decisions for the active-flight definition, alternate/enroute semantics, ETOPS/EDTO source field, TAF timestamp/provenance semantics, and same-host module placement.

After those decisions, the smallest safe next step is a read-only, ADMIN-only integration proof inside the existing AWQ Cloud host:

1. Reuse `authMe`/`getRequestUser` and verify the server-side ADMIN gate.
2. Define and document the canonical active-flight query before exposing a Dispatch selector.
3. Return one explicit `flight_id` with only fields that exist in D1; leave unavailable target fields null.
4. Retrieve a scoped weather bundle for origin/destination/currently supported alternate data, explicitly reporting missing/ambiguous fields.
5. Do not add documents, rules, LLM synthesis, assessment persistence, migrations, or deployment changes until the contract is approved.

The audit is complete at this point. No source-code implementation was started.
