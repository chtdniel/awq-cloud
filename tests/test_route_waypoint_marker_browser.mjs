import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// Halaman ROUTE menandai tiap profil dengan status waypoint-nya di database
// (tabel latlong), dan — untuk admin — menyediakan pintasan ke WAYPOINT MANAGER
// yang Route ID-nya sudah terisi. Test ini menjalankan klien sungguhan
// (public/index.html) di Chromium supaya rantainya terbukti sampai DOM + DB:
// penanda per profil, KPI cakupan, filter "NO WAYPOINTS", satu klik = satu aksi,
// lalu alur lengkap gap -> pintasan -> isi koordinat -> SAVE -> penanda berubah.
// Non-admin harus tetap melihat penandanya tanpa tombol yang pasti ditolak.

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

// Tiga profil: satu sudah punya koordinat, satu belum, dan satu lagi pasangan
// kota yang sama dengan yang belum (Primary/Alternate) supaya selector route
// Flight bisa diuji memuat kedua keadaan sekaligus. Baris pertama sengaja
// ditulis dengan huruf kecil + spasi di route_id-nya — WAYPOINT MANAGER diketik
// manual, jadi normalisasi itu bagian dari perilaku yang diuji.
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
// Sesi yang dipaksa ke setiap request /api/rpc — pengganti login lewat UI.
let sessionHeaders = adminHeaders;

const publicDirectory = resolve('public');
// charset=utf-8 disengaja: public/index.html tidak punya <meta charset>, jadi
// halaman ini bergantung pada header server (Cloudflare Pages mengirimnya).
// Tanpa itu em-dash/panah di UI terbaca mojibake dan asersi teks jadi menyesatkan.
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
async function asset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname));
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
    if (Date.now() - start > timeout) throw new Error(`timeout menunggu ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
// Hitungan per route dinormalisasi seperti di server: route_id di WAYPOINT
// MANAGER diketik manual, jadi baris seed-nya bisa berspasi/huruf kecil.
const latlongCount = routeId => database.prepare('SELECT COUNT(*) AS n FROM latlong WHERE UPPER(TRIM(route_id)) = ?').get(routeId).n;

const browser = await chromium.launch({ headless: true });
let failures = 0;

async function openRoutePage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // confirm dipakai tombol delete route dan dialog SAVE waypoint. Diganti spy
  // supaya satu klik yang menghasilkan lebih dari satu dialog (listener
  // menumpuk) bisa terlihat, dan supaya tidak ada data yang terhapus.
  await context.addInitScript(() => {
    window.__confirmCalls = [];
    window.confirm = message => { window.__confirmCalls.push(String(message)); return false; };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  // applySettingsAccessGate menulis window.isAdmin setelah sesi terselesaikan,
  // jadi nilainya menandai boot selesai sekaligus status akses sudah diketahui.
  await page.waitForFunction(() => window.isAdmin !== null, null, { timeout: 20000 });
  await page.evaluate(() => window.switchTab('route'));
  await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-card').length === 3, null, { timeout: 10000 });
  return { context, page, pageErrors };
}

// ---------- Skenario 1: admin, lengkap dari penanda sampai gap terisi ----------
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
    assert.equal(registered.badge, '2 WP', 'profil dengan koordinat harus menampilkan jumlah waypoint');
    assert.match(registered.badgeClass, /wp-badge-ok/);
    assert.match(registered.label, /2 waypoints registered/);
    assert.equal(missing.badge, 'NO WP', 'profil tanpa koordinat harus ditandai belum terdaftar');
    assert.match(missing.badgeClass, /wp-badge-gap/);
    assert.equal(registered.actionLabel, null, 'route yang sudah punya koordinat tidak perlu tombol pintasan');
    assert.match(missing.actionLabel || '', /WADDWSSS01/, 'pintasan hanya untuk admin dan hanya pada route yang belum punya koordinat');

    assert.equal((await page.textContent('#route-kpi-wp')).trim(), '2/3', 'KPI cakupan = profil ber-waypoint / total profil');
    assert.match(await page.getAttribute('#route-kpi-wp-card', 'class'), /warn/, 'cakupan belum penuh tidak boleh berwarna aman');

    // Filter gap: hanya profil tanpa koordinat yang tersisa, lalu ALL memulihkan.
    await page.click('#route-filter-wp-gap');
    await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-card').length === 1, null, { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('#route-manager-tbody .route-id-cell')].map(el => el.textContent.trim())),
      ['WADDWSSS01'],
      'filter NO WAYPOINTS hanya menyisakan profil yang belum punya koordinat'
    );
    assert.equal(await page.textContent('#route-kpi-wp'), '2/3', 'KPI cakupan dihitung dari registry, bukan dari hasil filter');
    assert.equal((await page.textContent('#route-total-count')).trim(), '1', 'counter kanan atas mengikuti hasil filter');
    assert.equal((await page.textContent('#route-kpi-total')).trim(), '3', 'KPI tetap menggambarkan registry, tidak ikut menyusut saat difilter');

    // Dua re-render di atas dulu menumpuk listener klik di tbody. Satu klik
    // delete harus menghasilkan tepat satu dialog konfirmasi.
    await page.click('#route-filter-chips .filter-chip');
    await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-card').length === 3, null, { timeout: 5000 });
    await page.click('#route-manager-tbody .route-card .route-delete-btn');
    await page.waitForFunction(() => window.__confirmCalls.length > 0, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert.equal(
      (await page.evaluate(() => window.__confirmCalls)).length,
      1,
      'satu klik delete = satu dialog; listener tidak boleh menumpuk tiap re-render'
    );

    // Selector route di modal Flight memakai payload dashboard. Karena peta FIR
    // menggambar rute dari tabel LATLONG, profil tanpa koordinat harus terbaca
    // sebagai peringatan di titik pemilihan — bukan baru ketahuan di peta.
    // Tunggu payload dashboard benar-benar termuat: openRouteModal membaca
    // window.allDbFlights, bukan memanggil RPC sendiri.
    await page.waitForFunction(() => Array.isArray(window.allDbFlights) && window.allDbFlights.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => window.openRouteModal(1));
    await page.waitForFunction(() => document.querySelectorAll('#route-selector option').length >= 2, null, { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('#route-selector option')].map(option => option.textContent.trim())),
      ['WADDWSSS01 (Alternate) · NO WP', 'WADDWSSS10 (Primary) · 2 WP', '+ Add Alternate Route'],
      'label selector route harus membawa status koordinat, primary tetap dikenali dari akhiran ID, dan opsi tambah route tetap ada'
    );
    await page.evaluate(() => window.closeRouteModal());
    await page.waitForTimeout(200);

    // Fallback akses telat: kalau registry sempat digambar selagi status admin
    // belum diketahui (boot belum selesai), tombolnya tidak boleh menunggu
    // refresh halaman — occ:accessResolved harus memicu gambar ulang dari cache.
    await page.evaluate(() => { window.isAdmin = null; window.filterRouteTable(); });
    assert.equal(await page.locator('#route-manager-tbody .route-wp-btn').count(), 0, 'status akses belum diketahui = tidak ada aksi admin (gagal-tertutup)');
    await page.evaluate(() => {
      window.isAdmin = true;
      window.dispatchEvent(new CustomEvent('occ:accessResolved', { detail: { isAdmin: true } }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#route-manager-tbody .route-wp-btn').length === 1, null, { timeout: 5000 });

    // ---- Alur inti pintasan: gap -> WAYPOINT MANAGER -> SAVE -> penanda berubah ----
    await page.click('#route-manager-tbody .route-card .route-wp-btn');
    await page.waitForFunction(() => document.getElementById('view-waypoint').classList.contains('active'), null, { timeout: 5000 });
    assert.equal(await page.inputValue('#ll-routeId'), 'WADDWSSS01', 'Route ID harus sudah terisi di WAYPOINT MANAGER');
    assert.equal(await page.inputValue('#ll-search'), 'WADDWSSS01', 'daftar waypoint difilter ke route ini supaya konteksnya jelas');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'll-paste', 'fokus langsung ke kotak paste');

    // Baris yatim (Route ID tanpa profil, mis. salah ketik) tidak boleh hilang
    // diam-diam: dia tidak dipakai peta FIR dan tidak dihitung di halaman ROUTE.
    assert.equal((await page.textContent('#ll-orphan-btn')).trim(), 'UNTRACKED (1)', 'jumlah baris yatim harus terlihat');
    assert.match(await page.textContent('#ll-list-status'), /UNTRACKED/, 'status daftar menyebut baris yatim');
    await page.fill('#ll-search', 'WADDWSSS9');
    await page.waitForFunction(() => document.querySelector('#ll-list .ll-orphan') !== null, null, { timeout: 5000 });
    assert.match(await page.textContent('#ll-list'), /UNTRACKED/, 'baris yatim ditandai di daftar');
    await page.click('#ll-orphan-btn');
    await page.waitForFunction(() => document.querySelectorAll('#ll-list .ll-item').length === 1, null, { timeout: 5000 });
    assert.match(await page.textContent('#ll-list'), /WADDWSSS9/, 'filter UNTRACKED menyisakan hanya baris yatim');
    await page.click('#ll-orphan-btn');
    await page.fill('#ll-search', 'WADDWSSS01');
    await page.waitForTimeout(150);

    await page.selectOption('#ll-mode', 'merge');
    await page.fill('#ll-paste', 'SBR02 S 08 45.0 E 115 20.0\nBITAK S 02 30.0 E 106 00.0');
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('#ll-save-btn');
    await waitForValue(() => latlongCount('WADDWSSS01') === 2, 'dua baris latlong tersimpan untuk WADDWSSS01');
    assert.equal(latlongCount('WADDWSSS01'), 2, 'efek samping DB: koordinat tersimpan untuk route yang diisi lewat pintasan');
    assert.equal(latlongCount('WIIIWADD01'), 2, 'mode MERGE tidak boleh menyentuh route lain');

    // Salah ketik Route ID: koordinatnya tetap tersimpan (alur kerja boleh mengisi
    // lebih dulu), tapi operator harus diberi tahu sekarang bahwa route itu belum
    // ada di registry dan koordinatnya tidak akan muncul di peta FIR.
    await page.fill('#ll-routeId', 'WADDWSSS99');
    await page.fill('#ll-paste', 'ZZZZ N 1 01.0 E 1 01.0');
    await page.click('#ll-save-btn');
    await page.waitForFunction(() => {
      const el = document.querySelector('.ll-toast');
      return el && /not in the ROUTE registry/.test(el.textContent);
    }, null, { timeout: 8000 });
    assert.equal(latlongCount('WADDWSSS99'), 1, 'efek samping DB: baris tersimpan walau Route ID belum dikenal');
    await page.waitForFunction(() => {
      const btn = document.getElementById('ll-orphan-btn');
      return btn && btn.textContent.trim() === 'UNTRACKED (2)';
    }, null, { timeout: 8000 });

    // Kembali ke registry: penanda gap harus berubah, tombolnya hilang.
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
    assert.equal(afterFill.action, false, 'setelah gap terisi, pintasannya hilang');
    assert.equal(afterFill.coverage, '3/3', 'cakupan ikut naik setelah koordinat tersimpan');
    assert.match(afterFill.cardClass, /safe/, 'cakupan penuh jadi hijau');

    assert.deepEqual(pageErrors, [], 'tidak boleh ada JS error di halaman route maupun waypoint');
    console.log('PASS penanda waypoint route (badge, KPI, filter gap, satu klik satu aksi, pintasan sampai gap terisi)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL penanda waypoint route: ${error.message}`);
  } finally {
    await context.close();
  }
}

// ---------- Skenario 2: non-admin tetap melihat penanda, tanpa aksi admin ----------
{
  sessionHeaders = viewerHeaders;
  const { context, page, pageErrors } = await openRoutePage();
  try {
    const viewer = await page.evaluate(() => ({
      badges: document.querySelectorAll('#route-manager-tbody .wp-badge').length,
      gapActions: document.querySelectorAll('#route-manager-tbody .route-wp-btn').length
    }));
    assert.equal(viewer.badges, 3, 'penanda waypoint tetap informatif untuk non-admin');
    assert.equal(viewer.gapActions, 0, 'non-admin tidak boleh diberi tombol yang pasti ditolak');

    // Pintasan juga tidak boleh menembus gate tab WAYPOINT.
    await page.evaluate(() => window.openWaypointsForRoute('WADDWSSS01'));
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => document.getElementById('view-waypoint').classList.contains('active')),
      false,
      'switchTab menolak WAYPOINT MANAGER untuk non-admin'
    );
    assert.equal(await page.inputValue('#ll-routeId'), '', 'penolakan akses tidak boleh ikut mengisi field waypoint');
    assert.deepEqual(pageErrors, [], 'tidak boleh ada JS error untuk non-admin');
    console.log('PASS penanda waypoint route untuk non-admin (penanda tampil, aksi admin tertutup)');
  } catch (error) {
    failures += 1;
    console.error(`FAIL penanda waypoint route non-admin: ${error.message}`);
  } finally {
    await context.close();
  }
}

await browser.close();
server.close();
database.close();
if (failures) process.exit(1);
