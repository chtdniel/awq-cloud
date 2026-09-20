// Bukti gejala asli: peta halaman FIR tidak menggambar polygon/lingkaran NOTAM area.
// Klien memakai geometri dari payload getActiveNotams, jadi selama payload mengirim
// radiusNm=null + polygon=[] peta hanya menampilkan titik. Test ini menjalankan klien
// sungguhan (public/app/index.html) di Chromium dengan dua FIR NOTAM area:
//   - batas polygon dari daftar koordinat E)  -> 5 titik,
//   - "5NM RADIUS CENTERED ON ..." di E)      -> lingkaran radius 5 NM.
// Marker titik hidup di pane sendiri (notam-points), jadi path di overlay pane
// hanya bisa berasal dari bentuk area — jumlahnya adalah bukti langsung.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
  CREATE TABLE IF NOT EXISTS airport_notes (icao_code TEXT, day_range TEXT, start_time TEXT, end_time TEXT, note_text TEXT, type TEXT);
`);

// Dua NOTAM area yang saling tumpang tindih: kotak 1 derajat (batas polygon dari
// daftar koordinat E)) dan lingkaran 5 NM dari frasa E) yang berada di dalamnya.
// Q) lingkaran menyebut radius of influence 008 sementara E) menyebut 5 NM — popup
// harus melaporkan 5 NM, jadi radius area terbaca dari teks.
const polygonNotam = `(B2376/26 NOTAMN
Q) RPHI/QWELW/IV/BO /W /000/010/1450N12050E008
A) RPHI B) 2501010000 C) 2712312359
E) MIL EXER WILL TAKE PLACE WI:
140000N 1200000E -
150000N 1200000E -
150000N 1210000E -
140000N 1210000E -
140000N 1200000E
(CAVITE AREA).
F) SFC G) 1000FT AMSL)`;
const circleNotam = `(B2824/26 NOTAMN
Q) RPHI/QWELW/IV/BO /W /000/020/1452N12057E008
A) RPHI B) 2501010000 C) 2712312359
E) MIL EXER WILL TAKE PLACE WI:
5NM RADIUS CENTERED ON 145200N 1205700E
(MONTALBAN, RIZAL).
F) SFC G) 2000FT AMSL)`;
database.exec("INSERT INTO firs (id, name, lat, lon) VALUES ('RPHI', 'Manila FIR', 14.5, 121.0)");
const insertNotam = database.prepare('INSERT INTO notams (id, location, message, valid_from, valid_to, kind) VALUES (?, ?, ?, ?, ?, ?)');
insertNotam.run('B2376/26', 'RPHI', polygonNotam, '2025-01-01T00:00:00Z', '2027-12-31T23:59:00Z', 'FIR');
insertNotam.run('B2824/26', 'RPHI', circleNotam, '2025-01-01T00:00:00Z', '2027-12-31T23:59:00Z', 'FIR');

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
const sessionHeaders = await createUser('dispatcher@example.com', 'admin');

const publicDirectory = resolve('public');
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

const browser = await chromium.launch({ headless: true });
let failures = 0;

// stripGeometry reproduces the historical payload (geometry fields empty, teks
// kosong) so the shape assertions are proven sensitive to the geometry, not to
// "some Leaflet path always exists".
async function openFirMap({ stripGeometry = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  if (stripGeometry) {
    await page.route('**/api/rpc', async route => {
      const response = await route.fetch();
      let body = null;
      try { body = await response.json(); } catch { return route.fulfill({ response }); }
      const notams = body && body.data && body.data.notams;
      if (Array.isArray(notams)) notams.forEach(notam => { notam.polygon = []; notam.radiusNm = null; notam.text = ''; });
      return route.fulfill({ status: response.status(), headers: response.headers(), json: body });
    });
  }
  await page.goto(baseUrl + '/app', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.isAdmin !== null, null, { timeout: 20000 });
  await page.evaluate(() => window.switchTab('fir'));
  // Leaflet loads from the CDN the first time the FIR tab opens.
  await page.waitForFunction(() => document.querySelector('#fir-map.leaflet-container'), null, { timeout: 30000 });
  await page.waitForFunction(() => /rendered/.test(document.getElementById('fir-notam-status').textContent), null, { timeout: 20000 });
  return { context, page, pageErrors };
}
const overlayPaths = page => page.evaluate(() => [...document.querySelectorAll('#fir-map .leaflet-overlay-pane path')].map(path => path.getAttribute('d') || ''));
const markerPaths = page => page.evaluate(() => document.querySelectorAll('#fir-map .leaflet-notam-points-pane path').length);
// setView animasi zoom; tunggu tile benar-benar di level tujuan sebelum mengukur bentuk.
const waitForZoom = (page, zoom) => page.waitForFunction(
  level => [...document.querySelectorAll('#fir-map .leaflet-tile-pane img')].some(img => new RegExp('/' + level + '/').test(img.src)),
  zoom, { timeout: 15000 }
);

// Leaflet menghapus popup lama beberapa saat setelah popup baru dibuka (animasi),
// jadi baca popup setelah hanya SATU yang tersisa — kalau tidak, elemen pertama yang
// terbaca masih popup lama.
const readPopup = async page => {
  await page.waitForFunction(() => document.querySelectorAll('#fir-map .leaflet-popup-content').length === 1, null, { timeout: 5000 });
  return (await page.textContent('#fir-map .leaflet-popup-content')).replace(/\s+/g, ' ');
};

// ---------- Scenario 1: dua NOTAM area benar-benar digambar di peta FIR ----------
{
  const { context, page, pageErrors } = await openFirMap();
  try {
    assert.match(await page.textContent('#fir-notam-status'), /NOTAM: 2\/2 rendered/, 'kedua FIR NOTAM ada di layer');
    assert.equal((await overlayPaths(page)).length, 0, 'layer NOTAM awalnya tersembunyi');

    await page.click('#fir-toggle-notams');
    await page.waitForFunction(() => document.querySelectorAll('#fir-map .leaflet-overlay-pane path').length >= 2, null, { timeout: 10000 });
    assert.match(await page.textContent('#fir-notam-status'), /2\/2 rendered, 2 geom/, 'dua NOTAM area menghasilkan geometri, bukan hanya titik');
    assert.equal((await overlayPaths(page)).length, 2, 'satu polygon + satu lingkaran digambar sebagai path Leaflet');
    assert.equal(await markerPaths(page), 2, 'marker titik tetap ada di pane notam-points');

    // Fokus ke NOTAM lingkaran: peta zoom ke area, bentuk digambar ulang, popup terbuka.
    await page.evaluate(() => window.firFocusNotamOnMap({ Location: 'RPHI', 'NOTAM #': 'B2824/26' }));
    await page.waitForSelector('#fir-map .leaflet-popup-content', { timeout: 10000 });
    const circlePopup = await readPopup(page);
    assert.match(circlePopup, /B2824\/26/, 'popup menyebut nomor NOTAM lingkaran');
    assert.match(circlePopup, /Radius 5 NM/, 'popup memakai radius area dari E), bukan radius of influence Q) 008');

    await waitForZoom(page, 8);
    const focused = (await overlayPaths(page)).at(-1);
    const xs = [...focused.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
    const ys = [...focused.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(m => Number(m[2]));
    assert.ok(xs.length >= 3 && ys.length >= 3, 'bentuk fokus punya titik yang cukup untuk sebuah area');
    assert.ok(Math.max(...xs) - Math.min(...xs) > 10 && Math.max(...ys) - Math.min(...ys) > 10, 'lingkaran tergambar dalam ukuran yang terlihat setelah zoom');

    // Fokus ke NOTAM polygon.
    await page.evaluate(() => window.firFocusNotamOnMap({ Location: 'RPHI', 'NOTAM #': 'B2376/26' }));
    await page.waitForFunction(() => /Polygon/.test(document.querySelector('#fir-map .leaflet-popup-content').textContent), null, { timeout: 10000 });
    const polygonPopup = await readPopup(page);
    assert.match(polygonPopup, /B2376\/26/, 'popup menyebut nomor NOTAM polygon');
    assert.match(polygonPopup, /Polygon 5 points/, 'batas area terbaca sebagai polygon 5 titik');

    assert.deepEqual(pageErrors, [], 'tidak ada error JS saat menggambar layer NOTAM');
    console.log('PASS FIR map area geometry (polygon 5 titik + lingkaran radius 5 NM digambar dan dilaporkan di popup)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL FIR map area geometry: ${error.message}`);
  } finally {
    await context.close();
  }
}

// ---------- Scenario 2: klik di area tumpang tindih ----------
// Leaflet hanya mengirim klik ke path paling atas, jadi tanpa popup gabungan NOTAM
// yang tertutup tidak bisa dipilih dari areanya. Di sini titik uji dicari dari
// geometri yang benar-benar digambar (isPointInFill pada path SVG), bukan ditebak.
const findClickPoints = page => page.evaluate(() => {
  const svg = document.querySelector('#fir-map .leaflet-overlay-pane svg');
  const paths = [...svg.querySelectorAll('path')];
  const map = document.getElementById('fir-map').getBoundingClientRect();
  const ctm = svg.getScreenCTM().inverse();
  const markers = [...document.querySelectorAll('#fir-map .leaflet-notam-points-pane path')].map(path => {
    const b = path.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  const farFromMarkers = (x, y) => markers.every(marker => Math.hypot(marker.x - x, marker.y - y) >= 14);
  const result = { shared: null, solo: paths.map(() => null), empty: null, markers };
  for (let x = map.left + 4; x < map.right - 4; x += 4) {
    for (let y = map.top + 4; y < map.bottom - 4; y += 4) {
      if (!farFromMarkers(x, y)) continue;
      const user = new DOMPoint(x, y).matrixTransform(ctm);
      const inside = paths.map((path, index) => { try { return path.isPointInFill(user) ? index : -1; } catch (e) { return -1; } }).filter(index => index >= 0);
      if (!inside.length) { if (!result.empty) result.empty = { x, y }; continue; }
      if (inside.length > 1) { if (!result.shared) result.shared = { x, y }; continue; }
      if (!result.solo[inside[0]]) result.solo[inside[0]] = { x, y };
    }
  }
  return result;
});

{
  const { context, page, pageErrors } = await openFirMap();
  try {
    // Peta diarahkan ke area NOTAM (zoom 8) lalu layer di-toggle off/on supaya bentuk
    // "fokus" dibersihkan — hanya dua polygon layer yang tersisa untuk diuji.
    await page.evaluate(() => window.firFocusNotamOnMap({ Location: 'RPHI', 'NOTAM #': 'B2376/26' }));
    await waitForZoom(page, 8);
    await page.click('#fir-toggle-notams');
    await page.click('#fir-toggle-notams');
    await page.waitForFunction(() => document.querySelectorAll('#fir-map .leaflet-overlay-pane path').length === 2, null, { timeout: 10000 });

    const points = await findClickPoints(page);
    assert.ok(points.shared, 'ada titik yang tertutup dua polygon sekaligus');
    assert.ok(points.solo[0] && points.solo[1], 'setiap polygon punya bagian yang tidak tertutup');
    assert.ok(points.empty, 'ada titik kosong untuk menutup popup');

    const popupText = () => readPopup(page);
    const clickAt = async point => {
      // Tutup popup lama dulu: popup 340px bisa menutupi target klik berikutnya.
      await page.mouse.click(points.empty.x, points.empty.y);
      await page.waitForFunction(() => !document.querySelector('#fir-map .leaflet-popup-content'), null, { timeout: 5000 });
      await page.mouse.click(point.x, point.y);
      await page.waitForSelector('#fir-map .leaflet-popup-content', { timeout: 5000 });
      return popupText();
    };

    // (a) Titik tumpang tindih -> daftar pilihan berisi KEDUA NOTAM.
    const shared = await clickAt(points.shared);
    assert.match(shared, /2 NOTAM di titik ini/, 'klik di tumpang tindih menampilkan daftar, bukan satu popup detail');
    assert.match(shared, /B2376\/26/, 'daftar memuat NOTAM polygon yang tertutup');
    assert.match(shared, /B2824\/26/, 'daftar memuat NOTAM lingkaran yang menutupi');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#fir-map .leaflet-popup-content .fir-notam-pick').length), 2, 'dua tombol pilihan');

    // (b) Pilih NOTAM yang tertutup dari daftar -> popup detail + bentuknya disorot.
    const coveredIndex = await page.evaluate(() => [...document.querySelectorAll('.fir-notam-pick')].findIndex(btn => btn.textContent.includes('B2376/26')));
    assert.ok(coveredIndex >= 0, 'NOTAM polygon ada di daftar');
    await page.evaluate(index => document.querySelectorAll('.fir-notam-pick')[index].click(), coveredIndex);
    const covered = await readPopup(page);
    assert.match(covered, /B2376\/26/, 'popup detail NOTAM yang dipilih dari daftar');
    assert.match(covered, /Polygon 5 points/, 'popup detail NOTAM yang dipilih dari daftar');
    assert.equal((await overlayPaths(page)).length, 3, 'bentuk NOTAM terpilih disorot di layer shape');

    // (c) Bagian yang tidak tertutup tetap membuka popup detail langsung.
    const soloTexts = [];
    for (const index of [0, 1]) soloTexts.push(await clickAt(points.solo[index]));
    assert.match(soloTexts.join(' | '), /B2376\/26/, 'area eksklusif polygon membuka detailnya langsung');
    assert.match(soloTexts.join(' | '), /B2824\/26/, 'area eksklusif lingkaran membuka detailnya langsung');
    assert.ok(!/NOTAM di titik ini/.test(soloTexts.join(' | ')), 'area tanpa tumpangan tidak memunculkan daftar');

    // (d) Marker tetap jalur presisi: marker lingkaran ada DI DALAM polygon, kliknya
    // harus membuka NOTAM lingkaran, bukan polygon yang menutupinya.
    for (let index = 0; index < points.markers.length; index++) {
      const text = await clickAt(points.markers[index]);
      assert.match(text, index === 0 ? /B2376\/26/ : /B2824\/26/, 'klik marker ' + index + ' membuka NOTAM pemilik marker');
    }

    assert.deepEqual(pageErrors, [], 'tidak ada error JS pada klik tumpang tindih');
    console.log('PASS FIR map overlap click (daftar NOTAM di titik tumpang tindih, pilih dari daftar, marker tetap presisi)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL FIR map overlap click: ${error.message}`);
  } finally {
    await context.close();
  }
}

// ---------- Scenario 3: kontrol — payload tanpa geometri memang tidak menggambar apa pun ----------
{
  const { context, page, pageErrors } = await openFirMap({ stripGeometry: true });
  try {
    await page.click('#fir-toggle-notams');
    await page.waitForTimeout(500);
    assert.match(await page.textContent('#fir-notam-status'), /2\/2 rendered, 0 geom/, 'payload tanpa geometri tidak menghasilkan bentuk');
    assert.equal((await overlayPaths(page)).length, 0, 'tidak ada path area tanpa geometri (kontrol asertsi)');
    assert.equal(await markerPaths(page), 2, 'marker titik tetap muncul dari lat/lon');
    assert.deepEqual(pageErrors, [], 'tidak ada error JS pada payload tanpa geometri');
    console.log('PASS FIR map area geometry control (payload tanpa geometri = 0 path area)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL FIR map area geometry control: ${error.message}`);
  } finally {
    await context.close();
  }
}

await browser.close();
server.close();
database.close();
if (failures) process.exit(1);
