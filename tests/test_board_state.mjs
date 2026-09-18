import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// Flight Board aktif disimpan per akun (user_board_state), bukan lagi hanya di
// localStorage browser. Test ini menjaga kontrak RPC-nya: isolasi antar user,
// urutan yang dipertahankan, dan validasi payload.

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const authSource = await import('node:fs/promises').then(fs => fs.readFile(new URL('../functions/api/auth.js', import.meta.url), 'utf8'));
const { hashPassword, createSession } = await import('data:text/javascript;base64,' + Buffer.from(authSource).toString('base64'));

function statement(database, sql, parameters = []) {
  return { bind(...values) { return statement(database, sql, values); }, async all() { return { results: database.prepare(sql).all(...parameters) }; }, async first() { return database.prepare(sql).get(...parameters) || null; }, async run() { return database.prepare(sql).run(...parameters); } };
}

function setupDb() {
  const database = new DatabaseSync(':memory:');
  const DB = { prepare: (sql, parameters) => statement(database, sql, parameters), async batch(statements) { for (const prepared of statements) await prepared.run(); } };
  return { database, DB };
}

function addAuthTables(database) {
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
  `);
}

function addBoardTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_board_state (
      user_id INTEGER PRIMARY KEY,
      row_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function seedUser(database, DB, role, email) {
  addAuthTables(database);
  const encoded = await hashPassword('correct horse battery staple');
  database.prepare(`INSERT INTO auth_users
    (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(email.toLowerCase(), email, encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, role);
  const userId = database.prepare('SELECT id FROM auth_users WHERE email_normalized = ?').get(email.toLowerCase()).id;
  const session = await createSession({ request: new Request('http://localhost/api/rpc'), env: { DB } }, userId);
  const cookies = session.headers.getSetCookie();
  const sessionCookie = cookies.find(value => value.startsWith('__Host-awq_session=')).split(';', 1)[0];
  const csrfCookie = cookies.find(value => value.startsWith('awq_csrf=')).split(';', 1)[0];
  return { userId, headers: { Cookie: `${sessionCookie}; ${csrfCookie}`, 'X-AWQ-CSRF': csrfCookie.split('=')[1] } };
}

async function rpcCall(method, args, headers, env) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, args })
  });
  return onRequestPost({ request, env: { DB: env } });
}

async function freshScenario(role = 'readonly', email = 'pilot@example.com') {
  const { database, DB } = setupDb();
  const { userId, headers } = await seedUser(database, DB, role, email);
  addBoardTable(database);
  return { database, DB, userId, headers };
}

// Scenario 1: akun tanpa state → present false, bukan error. Klien memakai ini
// untuk membedakan "belum pernah menyimpan" dari "board sengaja dikosongkan".
{
  const { database, DB, headers } = await freshScenario();
  const response = await rpcCall('getBoardState', [], headers, DB);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.rowIds, []);
  assert.equal(body.data.present, false);
  database.close();
}

// Scenario 2: save lalu get — urutan dipertahankan (urutan = urutan strip board)
{
  const { database, DB, headers } = await freshScenario();
  const saved = await rpcCall('saveBoardState', [[9, 3, 14]], headers, DB);
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.deepEqual(savedBody.data.rowIds, [9, 3, 14]);
  assert.equal(savedBody.data.present, true);
  assert.ok(savedBody.data.updatedAt, 'updatedAt harus diisi supaya klien bisa membandingkan');

  const got = await rpcCall('getBoardState', [], headers, DB);
  const gotBody = await got.json();
  assert.deepEqual(gotBody.data.rowIds, [9, 3, 14], 'urutan board tidak boleh di-sort');
  assert.equal(gotBody.data.present, true);
  database.close();
}

// Scenario 3: duplikat dibuang tanpa mengubah urutan kemunculan pertama
{
  const { database, DB, headers } = await freshScenario();
  const response = await rpcCall('saveBoardState', [[5, 5, '5', 2, 5, 2]], headers, DB);
  const body = await response.json();
  assert.deepEqual(body.data.rowIds, [5, 2]);
  database.close();
}

// Scenario 4: board kosong adalah nilai yang sah (operator menghapus semua
// flight) dan harus tetap `present` supaya tidak dihidupkan lagi dari cache.
{
  const { database, DB, headers } = await freshScenario();
  await rpcCall('saveBoardState', [[1, 2]], headers, DB);
  const response = await rpcCall('saveBoardState', [[]], headers, DB);
  const body = await response.json();
  assert.deepEqual(body.data.rowIds, []);
  const got = await rpcCall('getBoardState', [], headers, DB);
  const gotBody = await got.json();
  assert.equal(gotBody.data.present, true, 'board kosong yang disengaja tetap present');
  assert.deepEqual(gotBody.data.rowIds, []);
  database.close();
}

// Scenario 5: payload tidak valid → 400 dengan field rowIds
{
  const { database, DB, headers } = await freshScenario();
  const cases = [
    ['bukan array', 'garbage'],
    ['null', null],
    ['angka', 7],
    ['objek', { rowIds: [1] }],
    ['id nol', [0]],
    ['id negatif', [-3]],
    ['id pecahan', [1.5]],
    ['id string non-numerik', ['abc']],
    ['terlalu banyak', Array.from({ length: 501 }, (_, i) => i + 1)]
  ];
  for (const [label, payload] of cases) {
    const response = await rpcCall('saveBoardState', [payload], headers, DB);
    assert.equal(response.status, 400, `Expected 400 untuk ${label}`);
    const body = await response.json();
    assert.equal(body.code, 'VALIDATION_ERROR', `Expected VALIDATION_ERROR untuk ${label}`);
    assert.ok(body.fields && body.fields.rowIds, `Expected fields.rowIds untuk ${label}`);
  }
  // Batas atas itu sendiri masih boleh.
  const atCap = await rpcCall('saveBoardState', [Array.from({ length: 500 }, (_, i) => i + 1)], headers, DB);
  assert.equal(atCap.status, 200);
  database.close();
}

// Scenario 6: isolasi antar akun — board satu operator bukan milik operator lain
{
  const { database, DB, headers } = await freshScenario('readonly', 'first@example.com');
  const second = await seedUser(database, DB, 'readonly', 'second@example.com');
  await rpcCall('saveBoardState', [[11, 22]], headers, DB);

  const secondRead = await rpcCall('getBoardState', [], second.headers, DB);
  const secondBody = await secondRead.json();
  assert.deepEqual(secondBody.data.rowIds, [], 'akun lain tidak boleh melihat board ini');
  assert.equal(secondBody.data.present, false);

  await rpcCall('saveBoardState', [[33]], second.headers, DB);
  const firstRead = await rpcCall('getBoardState', [], headers, DB);
  const firstBody = await firstRead.json();
  assert.deepEqual(firstBody.data.rowIds, [11, 22], 'board akun pertama tidak boleh tertimpa');
  database.close();
}

// Scenario 7: tier readonly tetap boleh menyimpan board-nya sendiri (data milik
// user, bukan REGISTERED_WRITE_METHODS)
{
  const { database, DB, headers } = await freshScenario('readonly');
  const response = await rpcCall('saveBoardState', [[4, 8]], headers, DB);
  assert.equal(response.status, 200);
  database.close();
}

// Scenario 8: anonymous → 401 untuk baca maupun tulis
{
  const { database, DB } = setupDb();
  addBoardTable(database);
  for (const [method, args] of [['getBoardState', []], ['saveBoardState', [[1]]]]) {
    const request = new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args })
    });
    const response = await onRequestPost({ request, env: { DB } });
    assert.equal(response.status, 401, `${method} harus 401 tanpa sesi`);
  }
  database.close();
}

// Scenario 9: tulis tanpa CSRF → 403 (baca tidak butuh CSRF)
{
  const { database, DB, headers } = await freshScenario();
  const withoutCsrf = { Cookie: headers.Cookie };
  const response = await rpcCall('saveBoardState', [[1]], withoutCsrf, DB);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'CSRF_INVALID');

  const readResponse = await rpcCall('getBoardState', [], withoutCsrf, DB);
  assert.equal(readResponse.status, 200, 'baca tidak boleh menuntut CSRF');
  database.close();
}

// Scenario 10: row_ids korup di DB tidak boleh menjatuhkan board jadi 500
{
  const { database, DB, userId, headers } = await freshScenario();
  database.prepare('INSERT INTO user_board_state (user_id, row_ids, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(userId, '{bukan json');
  const response = await rpcCall('getBoardState', [], headers, DB);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.rowIds, []);
  assert.equal(body.data.present, true, 'baris tetap ada, isinya saja yang tidak terbaca');
  database.close();
}

// Scenario 11: nilai korup di dalam JSON juga disaring keluar
{
  const { database, DB, userId, headers } = await freshScenario();
  database.prepare('INSERT INTO user_board_state (user_id, row_ids, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(userId, JSON.stringify([7, -1, 'x', 0, 2.5, 9]));
  const response = await rpcCall('getBoardState', [], headers, DB);
  const body = await response.json();
  assert.deepEqual(body.data.rowIds, [7, 9]);
  database.close();
}

console.log('Board state (Flight Board aktif per akun) tests pass.');
