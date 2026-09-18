import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// Bug yang direproduksi: login dengan profil sama di browser LAIN, Flight Board
// aktif tidak ikut termuat dan mulai dari nol. Sebabnya board hanya hidup di
// localStorage; sekarang server (user_board_state) yang jadi sumber kebenaran.
//
// Test ini menjalankan klien sungguhan (public/index.html) di Chromium dengan
// tiap skenario memakai profil browser bersih (localStorage kosong). Tiap
// skenario sengaja punya DUA asersi independen — DOM dan efek samping
// (cache lokal atau baris DB) — supaya tidak bisa lulus palsu kalau hidrasi
// ternyata gagal dan klien diam-diam turun ke mode localStorage-only.

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const authSource = await readFile('functions/api/auth.js', 'utf8');
const { hashPassword, createSession: createSessionImpl } = await import('data:text/javascript;base64,' + Buffer.from(authSource).toString('base64'));

const USER_A = 'pilot.a@example.com';
const USER_B = 'pilot.b@example.com';

// ---- Fixture DB: skema produksi + auth, supaya user_board_state ikut teruji ----
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

function statement(sql, parameters = []) {
  return {
    bind(...values) { return statement(sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
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

database.prepare('INSERT INTO flights (id, callsign, dep, dest, ac_type, etd, eta, dof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(1, 'QZ646', 'WIII', 'WSSS', 'PK-AZK', '0300', '0600', '2026-09-14');
database.prepare('INSERT INTO flights (id, callsign, dep, dest, ac_type, etd, eta, dof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(2, 'QZ647', 'WSSS', 'WIII', 'PK-AZL', '0700', '1000', '2026-09-14');
database.prepare('INSERT INTO flights (id, callsign, dep, dest, ac_type, etd, eta, dof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(3, 'QZ648', 'WIII', 'WADD', 'PK-AZM', '1100', '1300', '2026-09-14');

async function createUser(email, role = 'admin') {
  const encoded = await hashPassword('correct horse battery staple');
  database.prepare(`INSERT INTO auth_users
    (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(email.toLowerCase(), email, encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, role);
  const userId = database.prepare('SELECT id FROM auth_users WHERE email_normalized = ?').get(email.toLowerCase()).id;
  const session = await createSessionImpl({ request: new Request('http://localhost/api/rpc'), env: { DB } }, userId);
  const cookies = session.headers.getSetCookie();
  const sessionCookie = cookies.find(value => value.startsWith('__Host-awq_session=')).split(';', 1)[0];
  const csrfCookie = cookies.find(value => value.startsWith('awq_csrf=')).split(';', 1)[0];
  return { userId, headers: { Cookie: `${sessionCookie}; ${csrfCookie}`, 'X-AWQ-CSRF': csrfCookie.split('=')[1] } };
}

const userA = await createUser(USER_A);
const userB = await createUser(USER_B);

// Sesi yang dipaksa ke setiap request /api/rpc — pengganti login lewat UI.
let sessionHeaders = userA.headers;
const rpcMethods = [];
let getBoardStateCalls = 0;
let saveBoardStateCalls = 0;

const publicDirectory = resolve('public');
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
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
      const parsed = JSON.parse(body);
      rpcMethods.push(parsed.method);
      if (parsed.method === 'getBoardState') getBoardStateCalls += 1;
      if (parsed.method === 'saveBoardState') saveBoardStateCalls += 1;
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

function setServerBoard(email, rowIds) {
  const userId = database.prepare('SELECT id FROM auth_users WHERE email_normalized = ?').get(email.toLowerCase()).id;
  database.prepare('DELETE FROM user_board_state WHERE user_id = ?').run(userId);
  if (rowIds !== null) {
    database.prepare('INSERT INTO user_board_state (user_id, row_ids, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(userId, JSON.stringify(rowIds));
  }
}
function serverBoard(email) {
  const row = database.prepare(`SELECT s.row_ids FROM user_board_state s
    JOIN auth_users u ON u.id = s.user_id WHERE u.email_normalized = ?`).get(email.toLowerCase());
  return row ? JSON.parse(row.row_ids) : null;
}
async function waitForValue(fn, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout menunggu ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const browser = await chromium.launch({ headless: true });
let failures = 0;

// Satu skenario = satu profil browser bersih. `seed` menulis localStorage
// sebelum skrip halaman jalan (meniru browser lama yang masih punya cache).
async function scenario(name, { seed, expectStrips, expectRowIds, expectServerRowIds, expectCache, expectCacheOwner }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.__boardRenders = 0;
    window.addEventListener('occ:boardChanged', () => { window.__boardRenders += 1; });
  });
  if (seed) await context.addInitScript(seed);

  const page = await context.newPage();
  const pageErrors = [];
  const warnings = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text()); });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    // Penanda deterministik: render pertama di halaman ini terjadi SETELAH
    // hidrasi (initFlightData menunggu hydrateBoardState sebelum renderBoard).
    await page.waitForFunction(() => window.__boardRenders >= 1, null, { timeout: 20000 });
    if (expectStrips === 0) {
      await page.waitForFunction(() => document.getElementById('flight-tbody').textContent.includes('BOARD IS CURRENTLY EMPTY'), null, { timeout: 10000 });
    } else {
      await page.waitForFunction(expected => document.querySelectorAll('#flight-tbody .flight-strip').length === expected, expectStrips, { timeout: 10000 });
    }

    const dom = await page.evaluate(() => {
      const strips = [...document.querySelectorAll('#flight-tbody .flight-strip')];
      return {
        rowIds: strips.map(strip => Number(strip.dataset.rowIdx)),
        callsigns: strips.map(strip => (strip.querySelector('.data-flt-no') || {}).value || ''),
        cache: localStorage.getItem('occ_active_board'),
        cacheOwner: localStorage.getItem('occ_active_board_owner')
      };
    });

    if (expectRowIds) assert.deepEqual(dom.rowIds, expectRowIds, `${name}: urutan/id strip board`);
    if (expectCache !== undefined) assert.equal(dom.cache, expectCache, `${name}: cache localStorage`);
    // Stamp ditulis lewat safeStorage (JSON.stringify), jadi nilai mentahnya
    // adalah string ber-quote — bandingkan dalam bentuk JSON.
    if (expectCacheOwner !== undefined) assert.equal(dom.cacheOwner, JSON.stringify(expectCacheOwner), `${name}: stamp pemilik cache`);
    if (expectServerRowIds !== undefined) {
      const row = await waitForValue(() => {
        const value = serverBoard(USER_A);
        return value !== null && JSON.stringify(value) === JSON.stringify(expectServerRowIds) ? value : null;
      }, `${name}: baris server ${JSON.stringify(expectServerRowIds)}`);
      assert.deepEqual(row, expectServerRowIds, `${name}: baris server`);
    }
    assert.deepEqual(pageErrors, [], `${name}: tidak boleh ada JS error`);
    assert.ok(!warnings.some(text => text.includes('Server board state unavailable')), `${name}: hidrasi server harus berhasil, warnings: ${warnings.join(' | ')}`);

    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await context.close();
  }
}

// Skenario 1 — BUG YANG DILAPORKAN. Browser baru, localStorage kosong, server
// sudah punya board. Dulu: board kosong dan operator memilih ulang dari nol.
// row_ids sengaja tidak terurut supaya urutan server ikut terjaga.
setServerBoard(USER_A, [2, 1]);
sessionHeaders = userA.headers;
await scenario('browser baru + localStorage kosong memuat board dari server', {
  expectStrips: 2,
  expectRowIds: [2, 1],
  expectCache: '[2,1]',
  expectCacheOwner: USER_A
});

// Skenario 2 — migrasi dari versi localStorage-only: server belum punya baris,
// board lama di browser harus diadopsi lalu didorong ke atas (tidak hilang).
setServerBoard(USER_A, null);
await scenario('board lokal lama diadopsi dan disimpan ke server', {
  seed: () => { localStorage.setItem('occ_active_board', JSON.stringify([3])); },
  expectStrips: 1,
  expectRowIds: [3],
  expectServerRowIds: [3]
});

// Skenario 3 — server sengaja kosong (present) dan cache browser masih berisi
// flight: board harus tetap kosong, tidak dihidupkan lagi dari cache.
setServerBoard(USER_A, []);
await scenario('board kosong di server tidak dihidupkan dari cache', {
  seed: () => {
    localStorage.setItem('occ_active_board', JSON.stringify([1, 2, 3]));
    localStorage.setItem('occ_active_board_owner', JSON.stringify('pilot.a@example.com'));
  },
  expectStrips: 0,
  expectCache: '[]'
});

// Skenario 4 — PC bersama: cache milik operator LAIN tidak boleh diwarisi.
// Efek sampingnya membuktikan hidrasi berhasil: baris server user A dibuat '[]'.
setServerBoard(USER_A, null);
await scenario('cache milik akun lain pada PC yang sama tidak diwarisi', {
  seed: () => {
    localStorage.setItem('occ_active_board', JSON.stringify([1, 2, 3]));
    localStorage.setItem('occ_active_board_owner', JSON.stringify('operator.lain@example.com'));
  },
  expectStrips: 0,
  expectServerRowIds: []
});

// Skenario 5b — stamp pemilik ada tapi tidak terbaca. Harus fail-CLOSED:
// cache diabaikan, bukan diterima sebagai "tidak ada stamp" (instalasi lama).
setServerBoard(USER_A, null);
await scenario('stamp pemilik korup membuat cache diabaikan', {
  seed: () => {
    localStorage.setItem('occ_active_board', JSON.stringify([1, 2, 3]));
    localStorage.setItem('occ_active_board_owner', 'bukan-json');
  },
  expectStrips: 0,
  expectServerRowIds: []
});

// Skenario 5 — server menang atas cache lokal yang basi.
setServerBoard(USER_A, [3]);
await scenario('state server menang atas cache lokal yang basi', {
  seed: () => {
    localStorage.setItem('occ_active_board', JSON.stringify([1, 2]));
    localStorage.setItem('occ_active_board_owner', JSON.stringify('pilot.a@example.com'));
  },
  expectStrips: 1,
  expectRowIds: [3],
  expectCache: '[3]'
});

// Skenario 6 — build/perilaku board per akun tidak bocor antar akun di server.
setServerBoard(USER_A, [1]);
setServerBoard(USER_B, [2, 3]);
sessionHeaders = userB.headers;
await scenario('akun lain memuat board miliknya sendiri', {
  expectStrips: 2,
  expectRowIds: [2, 3],
  expectCache: '[2,3]',
  expectCacheOwner: USER_B
});
assert.deepEqual(serverBoard(USER_A), [1], 'board user A tidak boleh berubah');

console.log(`\nRPC terpanggil: getBoardState ${getBoardStateCalls}x, saveBoardState ${saveBoardStateCalls}x (total ${rpcMethods.length} panggilan)`);
await browser.close();
server.close();
database.close();

if (failures) {
  console.error(`\n${failures} skenario gagal.`);
  process.exit(1);
}
console.log('Semua skenario Flight Board per akun lulus.');
