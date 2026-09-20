import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// The ROUTE page marks every profile with its waypoint state in the database
// (latlong table) and — for admins — offers a shortcut into WAYPOINT MANAGER with
// the Route ID already filled in. This test drives the real client
// (public/app/index.html) in Chromium so the chain is proven down to DOM + DB:
// per-profile marker, coverage KPI, "NO WAYPOINTS" filter, one click = one action,
// then the full flow gap -> shortcut -> enter coordinates -> SAVE -> marker flips.
// A non-admin must still see the markers, without a button that is certain to fail.

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const authSource = await readFile('functions/api/auth.js', 'utf8');
const { hashPassword, createSession: createSessionImpl } = await import('data:text/javascript;base64,' + Buffer.from(authSource).toString('base64'));

const database = new DatabaseSync(':memory:');
database.exec(await readFile('schema.sql', 'utf8'));
database.exec(`
  CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email_normalized TEXT UNIQUE, email_display TEXT,
    password_hash TEXT, password_salt TEXT, password_iterations INTEGER, password_algorithm TEXT,
    role TEXT, is_active INTEGER DEFAULT 1, must_change_password INTEGER DEFAULT 0,
    failed_login_count INTEGER DEFAULT 0, locked_until TEXT, created_at TEXT, updated_at TEXT, last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, token_hash TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT, revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, action TEXT,
    target_user_id INTEGER, request_id TEXT, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    change_summary TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS airport_notes (icao_code TEXT, day_range TEXT, start_time TEXT, end_time TEXT, note_text TEXT, type TEXT);
`);

// Three profiles: one already has coordinates, one has none, and one shares the
// city pair of the one that has none (Primary/Alternate) so the Flight route
// selector can be exercised on both states at once. The first row is deliberately
// written with lowercase letters and padding in route_id — WAYPOINT MANAGER is
// typed by hand, so that normalization is part of the behaviour under test.
database.exec(`
  INSERT INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES
    ('WIIIWADD01', 'WIII', 'WADD', '07L', 'DOLTA', 'DOLTA A585', 'MAMAD', '09', 'WIII RWY-07L DOLTA DOLTA A585 MAMAD RWY-09 WADD'),
    ('WADDWSSS01', 'WADD', 'WSSS', '09', 'MAMAD', 'MAMAD', 'BITAK', '20C', 'WADD RWY-09 MAMAD MAMAD BITAK RWY-20C WSSS'),
    ('WADDWSSS10', 'WADD', 'WSSS', '09', 'MAMAD', 'MAMAD', 'BITAK', '20C', 'WADD RWY-09 MAMAD MAMAD BITAK RWY-20C WSSS');
  INSERT INTO latlong (route_id, waypoint, latitude, longitude, sequence_order) VALUES
    ('  wiiiwadd01 ', 'DOLTA', 'S 06 00.0', 'E 107 00.0', 1),
    ('WIIIWADD01', 'MAMAD', 'S 08 44.8', 'E 115 10.2', 2),
    ('WADDWSSS10', 'SBR02', 'S 08 45.0', 'E 115 20.0', 1),
    ('WADDWSSS10', 'BITAK', 'S 02 30.0', 'E 106 00.0', 2),
    ('WADDWSSS9', 'TYPO', 'S 09 00.0', 'E 116 00.0', 1);
  INSERT INTO flights (id, callsign, dep, dest, dof) VALUES (1, 'QZ646', 'WADD', 'WSSS', '20260920');
`);

function statement(sql, parameters = []) {
  return {
    bind(...values) { return statement(sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return { meta: { changes: database.prepare(sql).run(...parameters).changes } }; }
  };
}
const DB = {
  prepare: statement,
  async batch(statements) {
    database.exec('BEGIN');
    try { const results = []; for (const prepared of statements) results.push(await prepared.run()); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }
};

async function createUser(email, role) {
  const encoded = await hashPassword('correct horse battery staple');
  database.prepare(`INSERT INTO auth_users
    (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(email.toLowerCase(), email, encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, role);
  const userId = database.prepare('SELECT id FROM auth_users WHERE email_normalized = ?').get(email.toLowerCase()).id;
  const session = await createSessionImpl({ request: new Request('http://localhost/api/rpc'), env: { DB } }, userId);
  const cookies = session.headers.getSetCookie();
  const sessionCookie = cookies.find(value => value.startsWith('__Host-awq_session=')).split(';', 1)[0];
  const csrfCookie = cookies.find(value => value.startsWith('awq_csrf=')).split(';', 1)[0];
  return { Cookie: `${sessionCookie}; ${csrfCookie}`, 'X-AWQ-CSRF': csrfCookie.split('=')[1] };
}

const adminHeaders = await createUser('dispatcher@example.com', 'admin');
const viewerHeaders = await createUser('viewer@example.com', 'readonly');
// Session forced onto every /api/rpc request — stands in for logging in via the UI.
let sessionHeaders = adminHeaders;

const publicDirectory = resolve('public');
// charset=utf-8 is deliberate: public/app/index.html carries a <meta charset> now, and
// this keeps the harness faithful to Cloudflare Pages, which also sends it. Without
// it the em-dashes/arrows in the UI read as mojibake and text assertions mislead.
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
async function asset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname === '/app' ? '/app/index.html' : pathname));
  if (!filename.startsWith(publicDirectory + '\\') && !filename.startsWith(publicDirectory + '/')) return new Response('Forbidden', { status: 403 });
  try { return new Response(await readFile(filename), { headers: { 'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = 'http://' + incoming.headers.host + incoming.url;
    let response;
    if (incoming.url === '/api/rpc') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const headers = new Headers(incoming.headers);
      for (const [name, value] of Object.entries(sessionHeaders)) headers.set(name, value);
      response = await onRequestPost({ request: new Request(url, { method: 'POST', headers, body }), env: { DB, ASSETS: { fetch: asset } } });
    } else {
      response = await asset(new Request(url));
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

async function waitForValue(fn, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
// Per-route count is normalized like the server does it: route_id in WAYPOINT
// MANAGER is typed by hand, so seeded rows may carry padding or lowercase.
const latlongCount = routeId => database.prepare('SELECT COUNT(*) AS n FROM latlong WHERE UPPER(TRIM(route_id)) = ?').get(routeId).n;

const browser = await chromium.launch({ headless: true });
let failures = 0;

async function openRoutePage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // confirm backs the route delete button and the waypoint SAVE dialog. It is
  // replaced by a spy so a single click that produces more than one dialog
  // (accumulated listeners) is visible, and so nothing is really deleted.
  await context.addInitScript(() => {
    window.__confirmCalls = [];
    window.confirm = message => { window.__confirmCalls.push(String(message)); return false; };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(baseUrl + '/app', { waitUntil: 'domcontentloaded' });
  // applySettingsAccessGate writes window.isAdmin once the session resolves, so its
  // non-null value marks boot complete and the access state already known.
  await page.waitForFunction(() => window.isAdmin !== null, null, { timeout: 20000 });
  await page.evaluate(() => window.switchTab('route'));
  await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-card').length === 3, null, { timeout: 10000 });
  return { context, page, pageErrors };
}

// ---------- Scenario 1: admin, from the marker all the way to a filled gap ----------
{
  const { context, page, pageErrors } = await openRoutePage();
  try {
    const cards = await page.evaluate(() => [...document.querySelectorAll('#route-manager-tbody .route-card')].map(card => ({
      id: card.querySelector('.route-id-cell').textContent.trim(),
      badge: card.querySelector('.wp-badge').textContent.trim(),
      badgeClass: card.querySelector('.wp-badge').className,
      label: card.querySelector('.wp-badge').getAttribute('aria-label'),
      actionLabel: card.querySelector('.route-wp-btn') ? card.querySelector('.route-wp-btn').getAttribute('aria-label') : null
    })));
    const registered = cards.find(card => card.id === 'WIIIWADD01');
    const missing = cards.find(card => card.id === 'WADDWSSS01');
    assert.equal(registered.badge, '2 WP', 'a profile with coordinates must show the waypoint count');
    assert.match(registered.badgeClass, /wp-badge-ok/);
    assert.match(registered.label, /2 waypoints registered/);
    assert.equal(missing.badge, 'NO WP', 'a profile without coordinates must be marked as not registered');
    assert.match(missing.badgeClass, /wp-badge-gap/);
    assert.equal(registered.actionLabel, null, 'a route that already has coordinates needs no shortcut');
    assert.match(missing.actionLabel || '', /WADDWSSS01/, 'the shortcut is admin-only and only on routes without coordinates');

    assert.equal((await page.textContent('#route-kpi-wp')).trim(), '2/3', 'coverage KPI = profiles with waypoints / total profiles');
    assert.match(await page.getAttribute('#route-kpi-wp-card', 'class'), /warn/, 'partial coverage must not use the safe colour');

    // Gap filter: only the profile without coordinates is left, then ALL restores.
    await page.click('#route-filter-wp-gap');
    await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-card').length === 1, null, { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('#route-manager-tbody .route-id-cell')].map(el => el.textContent.trim())),
      ['WADDWSSS01'],
      'the NO WAYPOINTS filter leaves only profiles that have no coordinates'
    );
    assert.equal(await page.textContent('#route-kpi-wp'), '2/3', 'coverage KPI comes from the registry, not from the filtered result');
    assert.equal((await page.textContent('#route-total-count')).trim(), '1', 'the counter at the top right follows the filtered result');
    assert.equal((await page.textContent('#route-kpi-total')).trim(), '3', 'KPIs keep describing the registry instead of shrinking with the filter');

    // The two re-renders above used to stack click listeners on tbody. A single
    // delete click has to produce exactly one confirmation dialog.
    await page.click('#route-filter-chips .filter-chip');
    await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-card').length === 3, null, { timeout: 5000 });
    await page.click('#route-manager-tbody .route-card .route-delete-btn');
    await page.waitForFunction(() => window.__confirmCalls.length > 0, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert.equal(
      (await page.evaluate(() => window.__confirmCalls)).length,
      1,
      'one delete click = one dialog; listeners must not accumulate on every re-render'
    );

    // The route selector in the Flight modal is fed by the dashboard payload. Since
    // the FIR map draws the route from the LATLONG table, a profile without
    // coordinates has to read as a warning at the point of selection — not be
    // discovered later on the map. Wait for the dashboard payload first:
    // openRouteModal reads window.allDbFlights instead of calling RPC itself.
    await page.waitForFunction(() => Array.isArray(window.allDbFlights) && window.allDbFlights.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => window.openRouteModal(1));
    await page.waitForFunction(() => document.querySelectorAll('#route-selector option').length >= 2, null, { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('#route-selector option')].map(option => option.textContent.trim())),
      ['WADDWSSS01 (Alternate) · NO WP', 'WADDWSSS10 (Primary) · 2 WP', '+ Add Alternate Route'],
      'route selector labels must carry the coordinate state, primary stays recognizable from the ID suffix, and the add-route option survives'
    );
    await page.evaluate(() => window.closeRouteModal());
    await page.waitForTimeout(200);

    // Late access fallback: if the registry was painted while the admin state was
    // still unknown (boot incomplete), the button must not wait for a page refresh —
    // occ:accessResolved has to trigger a repaint from cache.
    await page.evaluate(() => { window.isAdmin = null; window.filterRouteTable(); });
    assert.equal(await page.locator('#route-manager-tbody .route-wp-btn').count(), 0, 'unknown access state = no admin action (fails closed)');
    await page.evaluate(() => {
      window.isAdmin = true;
      window.dispatchEvent(new CustomEvent('occ:accessResolved', { detail: { isAdmin: true } }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-wp-btn').length === 1, null, { timeout: 5000 });

    // ---- Core shortcut flow: gap -> WAYPOINT MANAGER -> SAVE -> marker flips ----
    await page.click('#route-manager-tbody .route-card .route-wp-btn');
    await page.waitForFunction(() => document.getElementById('view-waypoint').classList.contains('active'), null, { timeout: 5000 });
    assert.equal(await page.inputValue('#ll-routeId'), 'WADDWSSS01', 'the Route ID must already be filled in inside WAYPOINT MANAGER');
    assert.equal(await page.inputValue('#ll-search'), 'WADDWSSS01', 'the waypoint list is filtered to this route so the context is obvious');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'll-paste', 'focus lands straight in the paste box');

    // Orphan rows (a Route ID with no profile, a typo for instance) must not vanish
    // silently: the FIR map never reads them and the ROUTE page never counts them.
    assert.equal((await page.textContent('#ll-orphan-btn')).trim(), 'UNTRACKED (1)', 'the number of orphan rows has to be visible');
    assert.match(await page.textContent('#ll-list-status'), /UNTRACKED/, 'the list status mentions orphan rows');
    await page.fill('#ll-search', 'WADDWSSS9');
    await page.waitForFunction(() => document.querySelector('#ll-list .ll-orphan') !== null, null, { timeout: 5000 });
    assert.match(await page.textContent('#ll-list'), /UNTRACKED/, 'an orphan row is tagged in the list');
    await page.click('#ll-orphan-btn');
    await page.waitForFunction(() => document.querySelectorAll('#ll-list .ll-item').length === 1, null, { timeout: 5000 });
    assert.match(await page.textContent('#ll-list'), /WADDWSSS9/, 'the UNTRACKED filter leaves only orphan rows');
    await page.click('#ll-orphan-btn');
    await page.fill('#ll-search', 'WADDWSSS01');
    await page.waitForTimeout(150);

    await page.selectOption('#ll-mode', 'merge');
    await page.fill('#ll-paste', 'SBR02 S 08 45.0 E 115 20.0\nBITAK S 02 30.0 E 106 00.0');
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('#ll-save-btn');
    await waitForValue(() => latlongCount('WADDWSSS01') === 2, 'two latlong rows stored for WADDWSSS01');
    assert.equal(latlongCount('WADDWSSS01'), 2, 'DB side effect: coordinates were stored for the route filled in through the shortcut');
    assert.equal(latlongCount('WIIIWADD01'), 2, 'MERGE mode must not touch any other route');

    // Typo in the Route ID: the coordinates are still stored (a workflow may load
    // them first), but the operator has to be told now that the route is not in the
    // registry and that its coordinates will never show up on the FIR map.
    await page.fill('#ll-routeId', 'WADDWSSS99');
    await page.fill('#ll-paste', 'ZZZZ N 1 01.0 E 1 01.0');
    await page.click('#ll-save-btn');
    await page.waitForFunction(() => {
      const el = document.querySelector('.ll-toast');
      return el && /not in the ROUTE registry/.test(el.textContent);
    }, null, { timeout: 8000 });
    assert.equal(latlongCount('WADDWSSS99'), 1, 'DB side effect: the row is stored even though the Route ID is unknown');
    await page.waitForFunction(() => {
      const btn = document.getElementById('ll-orphan-btn');
      return btn && btn.textContent.trim() === 'UNTRACKED (2)';
    }, null, { timeout: 8000 });

    // Back to the registry: the gap marker has to change and the button disappear.
    await page.evaluate(() => window.switchTab('route'));
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll('#route-manager-tbody .route-card')]
        .find(el => el.querySelector('.route-id-cell').textContent.trim() === 'WADDWSSS01');
      return card && card.querySelector('.wp-badge').textContent.trim() === '2 WP';
    }, null, { timeout: 10000 });
    const afterFill = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#route-manager-tbody .route-card')]
        .find(el => el.querySelector('.route-id-cell').textContent.trim() === 'WADDWSSS01');
      return {
        action: !!card.querySelector('.route-wp-btn'),
        coverage: document.getElementById('route-kpi-wp').textContent.trim(),
        cardClass: document.getElementById('route-kpi-wp-card').className
      };
    });
    assert.equal(afterFill.action, false, 'once the gap is filled the shortcut is gone');
    assert.equal(afterFill.coverage, '3/3', 'coverage rises after the coordinates are stored');
    assert.match(afterFill.cardClass, /safe/, 'full coverage turns safe-coloured');

    assert.deepEqual(pageErrors, [], 'no JS error is allowed on the route or waypoint page');
    console.log('PASS route waypoint marker (badge, KPI, gap filter, one click one action, shortcut until the gap is filled)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL route waypoint marker: ${error.message}`);
  } finally {
    await context.close();
  }
}

// ---------- Scenario 2: a non-admin keeps the markers, without the admin action ----------
{
  sessionHeaders = viewerHeaders;
  const { context, page, pageErrors } = await openRoutePage();
  try {
    const viewer = await page.evaluate(() => ({
      badges: document.querySelectorAll('#route-manager-tbody .wp-badge').length,
      gapActions: document.querySelectorAll('#route-manager-tbody .route-wp-btn').length
    }));
    assert.equal(viewer.badges, 3, 'waypoint markers stay informative for a non-admin');
    assert.equal(viewer.gapActions, 0, 'a non-admin must not be given a button that is certain to fail');

    // The shortcut must not punch through the WAYPOINT tab gate either.
    await page.evaluate(() => window.openWaypointsForRoute('WADDWSSS01'));
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => document.getElementById('view-waypoint').classList.contains('active')),
      false,
      'switchTab refuses WAYPOINT MANAGER for a non-admin'
    );
    assert.equal(await page.inputValue('#ll-routeId'), '', 'a refused access must not fill in the waypoint field either');
    assert.deepEqual(pageErrors, [], 'no JS error is allowed for a non-admin');
    console.log('PASS route waypoint marker for a non-admin (markers visible, admin action closed)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL route waypoint marker (non-admin): ${error.message}`);
  } finally {
    await context.close();
  }
}

await browser.close();
server.close();
database.close();
if (failures) process.exit(1);
