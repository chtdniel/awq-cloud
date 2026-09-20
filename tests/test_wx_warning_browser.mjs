// Browser evidence for the WX WARNING page (P5–P7).
//
// Runs the shipped page (public/app/index.html) in Chromium against the real
// functions/api/rpc.js over HTTP with a real SQLite database, so what is asserted
// here is the code that actually ships — not a copy:
//   * the WX submenu appears under the WX tab and WX MONITORING still opens from
//     the tab itself,
//   * an empty feed renders the empty state instead of a blank map,
//   * pasting a JTWC warning + a VAAC advisory (the operator's real example)
//     previews, saves, and then draws on the map,
//   * the route of the selected flight is drawn and the ash cloud over it is
//     flagged AFFECTS ROUTE,
//   * buffer chips, hazard filters, COPY SUMMARY and EXPORT .CSV all work.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const authSource = await readFile('functions/api/auth.js', 'utf8');
const { hashPassword, createSession: createSessionImpl } = await import('data:text/javascript;base64,' + Buffer.from(authSource).toString('base64'));

const database = new DatabaseSync(':memory:');
database.exec(await readFile('schema.sql', 'utf8'));
database.exec(await readFile('migrations/013_wx_warnings.sql', 'utf8'));
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
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT, updated_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  INSERT INTO flights (callsign, dep, dest, alt, dof, etd, eta, active_route_id)
    VALUES ('QZ100', 'WIII', 'WADD', 'WADD', '20260920', '2026-09-20T22:00:00.000Z', '2026-09-21T01:00:00.000Z', 'WIIIWADD10');
  INSERT INTO routes (id, dep_airport, arr_airport, waypoint_seq) VALUES
    ('WIIIWADD10', 'WIII', 'WADD', 'WIII DOLTA 0800S11200E WADD');
  INSERT INTO latlong (route_id, waypoint, latitude, longitude, sequence_order) VALUES
    ('WIIIWADD10', 'WIII', 'S 06 07.5', 'E 106 39.3', 1),
    ('WIIIWADD10', 'DOLTA', 'S 08 00.0', 'E 112 00.0', 2),
    ('WIIIWADD10', 'WADD', 'S 08 44.9', 'E 115 10.0', 3);
`);

const DB = {
  prepare: (sql, parameters) => ({
    bind(...values) {
      return {
        async all() { return { results: database.prepare(sql).all(...values) }; },
        async first() { return database.prepare(sql).get(...values) || null; },
        async run() { return database.prepare(sql).run(...values); }
      };
    },
    async all() { return { results: database.prepare(sql).all(...(parameters || [])) }; },
    async first() { return database.prepare(sql).get(...(parameters || [])) || null; },
    async run() { return database.prepare(sql).run(...(parameters || [])); }
  }),
  async batch(statements) { for (const prepared of statements) await prepared.run(); }
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
const sessionHeaders = await createUser('dispatcher@example.com', 'admin');

// The page reads the active Flight Board (Flight_Ui publishes it from the saved
// board state), so the board has to be seeded server-side for the flight to show.
database.prepare('INSERT INTO user_board_state (user_id, row_ids) VALUES (?, ?)')
  .run(database.prepare('SELECT id FROM auth_users').get().id, '[1]');

// The operator's real paste: a JTWC TC warning plus a Darwin VAAC advisory whose
// ash cloud sits over east Java, i.e. across the QZ100 route.
const PASTE = `WTPN31 PGTW 202100
SUBJ/TROPICAL STORM 24W (DUJUAN) WARNING NR 022//
RMKS/
   WARNING POSITION:
   201800Z --- NEAR 31.3N 137.9E
     MOVEMENT PAST SIX HOURS - 020 DEGREES AT 11 KTS
   PRESENT WIND DISTRIBUTION:
   MAX SUSTAINED WINDS - 060 KT, GUSTS 075 KT
   RADIUS OF 034 KT WINDS - 200 NM NORTHEAST QUADRANT
                            170 NM SOUTHEAST QUADRANT
                            160 NM SOUTHWEST QUADRANT
                            200 NM NORTHWEST QUADRANT
   FORECASTS:
   12 HRS, VALID AT:
   210600Z --- 33.5N 139.9E
   MAX SUSTAINED WINDS - 065 KT, GUSTS 080 KT
REMARKS:
MINIMUM CENTRAL PRESSURE AT 201800Z IS 976 MB.//
NNNN

-----------------

FVAU02 ADRM 201550
VA ADVISORY
DTG: 20260920/1550Z
VAAC: DARWIN
VOLCANO: SEMERU 263300
PSN: S0806 E11255
AREA: INDONESIA
ADVISORY NR: 2026/1078
EST VA CLD: SFC/FL150 S0808 E11253 - S0803 E11253 - S0755
E11319 - S0805 E11325 - S0817 E11318 MOV E 15KT
NXT ADVISORY: NO LATER THAN 20260920/2150Z=`;

const publicDirectory = resolve('public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
async function asset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname === '/app' ? '/app/index.html' : pathname));
  if (!filename.startsWith(publicDirectory + '\\') && !filename.startsWith(publicDirectory + '/')) return new Response('Forbidden', { status: 403 });
  try { return new Response(await readFile(filename), { headers: { 'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
}

const rpcCalls = [];
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = 'http://' + incoming.headers.host + incoming.url;
    let response;
    if (incoming.url === '/api/rpc') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      try { rpcCalls.push(JSON.parse(body)); } catch { /* non-JSON probe */ }
      const headers = new Headers(incoming.headers);
      for (const [name, value] of Object.entries(sessionHeaders)) headers.set(name, value);
      response = await onRequestPost({ request: new Request(url, { method: 'POST', headers, body }), env: { DB } });
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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('dialog', dialog => dialog.accept());

// The active Flight Board is read from Flight_Ui's globals; seed it so the page
// lists the flight this test cares about.
await page.addInitScript(() => { window.activeBoardRowIds = [1]; });

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('OK   ' + label); }
  catch (error) { failures++; console.log('FAIL ' + label + ' -> ' + error.message); }
}

await page.goto(baseUrl + '/app', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.isAdmin !== null, null, { timeout: 20000 });

await check('the WX submenu exists under the WX tab and lists both WX pages', async () => {
  await page.click('#nav-weather-toggle');
  await page.waitForFunction(() => document.getElementById('wx-submenu').classList.contains('show'), null, { timeout: 5000 });
  const items = await page.$$eval('#wx-submenu .dropdown-item', nodes => nodes.map(node => node.textContent.trim()));
  assert.deepEqual(items, ['WX MONITORING', 'WX WARNING']);
  assert.equal(await page.getAttribute('#nav-weather-toggle', 'aria-expanded'), 'true');
});

await check('the WX tab itself still opens WX MONITORING', async () => {
  await page.click('#nav-weather');
  await page.waitForFunction(() => document.getElementById('view-weather').classList.contains('active'), null, { timeout: 10000 });
  const expanded = await page.getAttribute('#nav-weather-toggle', 'aria-expanded');
  assert.equal(expanded, 'false', 'selecting a submenu entry must close the menu');
});

await check('the WX WARNING entry opens the new page and loads Leaflet', async () => {
  await page.click('#nav-weather-toggle');
  await page.click('#wx-submenu .dropdown-item[data-tab="wx-warning"]');
  await page.waitForFunction(() => document.getElementById('view-wx-warning').classList.contains('active'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#wxw-map.leaflet-container'), null, { timeout: 30000 });
  const active = await page.$eval('#nav-weather', node => node.classList.contains('active'));
  assert.equal(active, true, 'the WX parent tab carries the active state for its child page');
});

await check('the map is laid out in its own coordinate space (Leaflet CSS applied)', async () => {
  const diag = await page.evaluate(() => {
    const map = document.getElementById('wxw-map');
    const svg = map.querySelector('svg.leaflet-zoom-animated');
    const tile = map.querySelector('img.leaflet-tile');
    return {
      box: { w: Math.round(map.getBoundingClientRect().width), h: Math.round(map.getBoundingClientRect().height) },
      position: getComputedStyle(map).position,
      overflow: getComputedStyle(map).overflow,
      // Leaflet pads the SVG pane by 10% on each side, so its viewport is 1.2x
      // the container. Anything else means the pane and the container disagree,
      // which scales every layer.
      svgWidth: svg ? Number(svg.getAttribute('width')) : null,
      svgHeight: svg ? Number(svg.getAttribute('height')) : null,
      tile: tile ? { w: Math.round(tile.getBoundingClientRect().width), natural: tile.naturalWidth } : null,
      leafletCss: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .filter(link => /leaflet/.test(link.href))
        .map(link => ({ href: link.href, loaded: !!link.sheet }))
    };
  });
  const detail = JSON.stringify(diag);
  assert.equal(diag.leafletCss.length, 1, 'Leaflet stylesheet link missing: ' + detail);
  assert.equal(diag.leafletCss[0].loaded, true, 'Leaflet stylesheet never loaded: ' + detail);
  assert.equal(diag.position, 'relative', 'the map container needs Leaflet\'s positioning: ' + detail);
  assert.ok(diag.svgWidth && diag.svgHeight, 'the SVG renderer must report the container size: ' + detail);
  assert.ok(Math.abs(diag.svgWidth - diag.box.w * 1.2) <= 4 && Math.abs(diag.svgHeight - diag.box.h * 1.2) <= 4,
    'the SVG pane must be the container plus Leaflet\'s 10% padding: ' + detail);
  if (diag.tile && diag.tile.natural) {
    assert.ok(Math.abs(diag.tile.w - diag.tile.natural) <= 1, 'tiles must render 1:1, not magnified: ' + detail);
  }
});

await check('an empty feed shows the map notice, keeps the route, and flags the feed age', async () => {
  await page.waitForFunction(() => document.getElementById('wxw-feed-badge').textContent.trim().length > 0, null, { timeout: 15000 });
  const badge = (await page.textContent('#wxw-feed-badge')).trim();
  assert.match(badge, /NEVER SYNCED|OLD/);
  await page.waitForFunction(() => document.getElementById('wxw-map-wrap').classList.contains('is-empty'), null, { timeout: 20000 });
  const notice = await page.textContent('#wxw-map-empty');
  assert.match(notice, /No active TC \/ VA warnings/);
  assert.match(notice, /Route of the selected flight is shown/, 'the route must stay visible under the notice');
  assert.match(await page.textContent('#wxw-list'), /No active TC \/ VA warnings in D1/);
  const routePaths = await page.$$eval('#wxw-map .leaflet-overlay-pane path', nodes => nodes.length);
  assert.ok(routePaths >= 1, 'the selected flight route must be drawn even with an empty feed');
});

await check('the flight dropdown lists the active board flight', async () => {
  await page.waitForFunction(() => {
    const options = [...document.querySelectorAll('#wxw-flight option')];
    return options.some(option => /QZ100/.test(option.textContent));
  }, null, { timeout: 20000 });
  const options = await page.$$eval('#wxw-flight option', nodes => nodes.map(node => node.textContent.trim()));
  assert.equal(options.length, 1, 'options: ' + JSON.stringify(options));
  assert.match(options[0], /QZ100\s+WIII→WADD/, 'option text: ' + options[0]);
});

await check('PARSE PREVIEW reports both pasted products as READY', async () => {
  await page.fill('#wxw-manual-text', PASTE);
  await page.click('text=PARSE PREVIEW');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-manual-report .wxw-report-row').length === 2, null, { timeout: 15000 });
  const report = await page.$$eval('#wxw-manual-report .wxw-report-row', nodes => nodes.map(node => node.textContent));
  assert.match(report[0], /WTPN31 PGTW 202100 • TC • READY/);
  assert.match(report[0], /TROPICAL STORM 24W \(DUJUAN\) WARNING NR 022/);
  assert.match(report[1], /FVAU02 ADRM 201550 • VA • READY/);
  assert.match(report[1], /SEMERU 263300/);
  const saveDisabled = await page.$eval('#wxw-manual-save', node => node.disabled);
  assert.equal(saveDisabled, false, 'SAVE must be enabled once products parse');
});

await check('preview geometry is drawn but not stored yet', async () => {
  await page.waitForFunction(() => /PREVIEW/.test(document.body.innerHTML), null, { timeout: 10000 });
  const stored = database.prepare('SELECT COUNT(*) AS n FROM wx_warnings').get().n;
  assert.equal(stored, 0, 'a preview must not write to D1');
});

await check('SAVE stores the products and the page renders them', async () => {
  await page.click('#wxw-manual-save');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-list .wxw-item').length >= 2, null, { timeout: 20000 });
  const stored = database.prepare('SELECT COUNT(*) AS n FROM wx_warnings WHERE is_manual = 1').get().n;
  assert.equal(stored, 2);
  assert.equal((await page.textContent('#wxw-kpi-manual')).trim(), '2');
  assert.equal((await page.textContent('#wxw-kpi-tc')).trim(), '1');
  assert.equal((await page.textContent('#wxw-kpi-va')).trim(), '1');
  const titles = await page.$$eval('#wxw-list .wxw-item-title', nodes => nodes.map(node => node.textContent));
  assert.ok(titles.some(title => /DUJUAN/.test(title)));
  assert.ok(titles.some(title => /SEMERU/.test(title)));
  const badges = await page.$$eval('#wxw-list .wxw-badge', nodes => nodes.map(node => node.textContent.trim()));
  assert.ok(badges.filter(text => text === 'MANUAL').length === 2, 'operator pastes must be badged MANUAL');
});

await check('the route is drawn from the selected flight and the ash cloud is flagged AFFECTS ROUTE', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#wxw-map .leaflet-overlay-pane path').length >= 5, null, { timeout: 20000 });
  // Vector sizes are asserted, not eyeballed: a scale bug (Leaflet pane and
  // container disagreeing) makes every layer huge while still "looking drawn".
  const layers = await page.evaluate(() => [...document.querySelectorAll('#wxw-map .leaflet-overlay-pane path')].map(path => {
    const box = path.getBoundingClientRect();
    return { fill: path.getAttribute('fill'), dash: path.getAttribute('stroke-dasharray'), w: Math.round(box.width), h: Math.round(box.height) };
  }));
  const routeLine = layers.find(layer => layer.dash === '4 4');
  assert.ok(routeLine && routeLine.w > 200, 'the route polyline must span the map: ' + JSON.stringify(layers));
  const routeDots = layers.filter(layer => layer.fill === '#0E7A4B' || layer.fill === '#C8102E');
  assert.equal(routeDots.length, 2);
  routeDots.forEach(dot => assert.ok(dot.w >= 10 && dot.w <= 16, 'waypoint markers must stay pixel-sized: ' + JSON.stringify(dot)));
  const ashPolygon = layers.find(layer => layer.fill === '#F59E0B' && layer.w > 20);
  assert.ok(ashPolygon, 'the ash polygon must be drawn: ' + JSON.stringify(layers));
  const hitBadge = await page.$eval('#wxw-list', node => {
    const items = [...node.querySelectorAll('.wxw-item')];
    const ash = items.find(item => /SEMERU/.test(item.textContent));
    return ash ? { hit: ash.classList.contains('hit'), text: ash.textContent } : null;
  });
  assert.ok(hitBadge, 'the ash advisory must be listed');
  assert.match(hitBadge.text, /AFFECTS ROUTE \+\d+ NM/);
  assert.ok(Number((await page.textContent('#wxw-kpi-hit')).trim()) >= 1);
  const routeCalls = rpcCalls.filter(call => call.method === 'getWxWarningData');
  assert.ok(routeCalls.length >= 1, 'the page must ask the server for the warning + route payload');
});

await check('the corridor buffer chip changes the corridor and re-asks the server', async () => {
  const before = rpcCalls.filter(call => call.method === 'getWxWarningData').length;
  await page.click('#wxw-buffer [data-buffer="100"]');
  await page.waitForFunction(() => /CORRIDOR 100 NM/.test(document.getElementById('wxw-last-update').textContent), null, { timeout: 15000 });
  const after = rpcCalls.filter(call => call.method === 'getWxWarningData');
  assert.ok(after.length > before, 'changing the buffer must trigger a refetch');
  assert.equal(after[after.length - 1].args[1], 100);
  const pressed = await page.getAttribute('#wxw-buffer [data-buffer="100"]', 'aria-pressed');
  assert.equal(pressed, 'true');
});

await check('hazard filters narrow the list without touching the map data', async () => {
  await page.click('#wxw-filter [data-filter="VA"]');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-list .wxw-item').length === 1, null, { timeout: 10000 });
  const remaining = await page.textContent('#wxw-list');
  assert.match(remaining, /SEMERU/);
  await page.click('#wxw-filter [data-filter="HIT"]');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-list .wxw-item').length >= 1, null, { timeout: 10000 });
  const hitOnly = await page.$$eval('#wxw-list .wxw-item', nodes => nodes.map(node => /SEMERU/.test(node.textContent)));
  assert.ok(hitOnly.every(Boolean), 'the ROUTE filter must only keep route-affecting warnings');
  await page.click('#wxw-filter [data-filter="ALL"]');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-list .wxw-item').length === 2, null, { timeout: 10000 });
});

await check('COPY SUMMARY produces the structured briefing text', async () => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await page.click('text=COPY SUMMARY');
  await page.waitForFunction(() => /copied|blocked/i.test(document.getElementById('wxw-copy-status').textContent), null, { timeout: 10000 });
  const status = await page.textContent('#wxw-copy-status');
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  assert.match(text, /AWQ CLOUD BRIEFING - WX WARNING SUMMARY/);
  assert.match(text, /AFFECTS ROUTE/);
  assert.match(text, /ROUTE FIXES: WIII DOLTA WADD/);
  assert.match(text, /SOURCES: JTWC TC warnings/);
  assert.ok(status.length > 0);
});

await check('EXPORT .CSV downloads a table with the route impact column', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('text=EXPORT .CSV')
  ]);
  assert.match(download.suggestedFilename(), /^wx-warning-\d+\.csv$/);
  const path = await download.path();
  const csv = await readFile(path, 'utf8');
  assert.match(csv, /kind,source,title/);
  assert.match(csv, /affects_route/);
  assert.match(csv, /VA,MANUAL,VA SEMERU 263300/);
  assert.match(csv, /,YES,/) ;
});

await check('deleting a manual entry removes it everywhere', async () => {
  await page.click('#wxw-filter [data-filter="ALL"]');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-list .wxw-item').length === 2, null, { timeout: 10000 });
  await page.click('#wxw-list .wxw-item [data-delete]');
  await page.waitForFunction(() => document.querySelectorAll('#wxw-list .wxw-item').length === 1, null, { timeout: 15000 });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM wx_warnings WHERE is_manual = 1').get().n, 1);
});

await check('the page produced no uncaught errors', async () => {
  assert.deepEqual(pageErrors, []);
});

await mkdir('test-results', { recursive: true });
// Evidence shots are captured without growing the viewport: an element/full-page
// capture resizes the document internally, and Leaflet's pane projection then
// goes stale for the frame being captured (the geometry assertions above are what
// prove the map is correct; these images are for the reviewer's eye).
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: 'test-results/wx-warning-page.png' });
await page.locator('#wxw-map').screenshot({ path: 'test-results/wx-warning-map.png' });
await page.evaluate(() => document.getElementById('wxw-manual-text').scrollIntoView({ block: 'center' }));
await page.screenshot({ path: 'test-results/wx-warning-manual.png' });
console.log('Screenshots: test-results/wx-warning-page.png, wx-warning-map.png, wx-warning-manual.png');

await context.close();
await browser.close();
server.close();
database.close();
if (failures) {
  console.error(failures + ' WX WARNING browser check(s) failed.');
  process.exit(1);
}
console.log('WX WARNING browser evidence passed.');
