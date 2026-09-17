import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const authSource = await readFile(new URL('../functions/api/auth.js', import.meta.url), 'utf8');
const { hashPassword, createSession } = await import('data:text/javascript;base64,' + Buffer.from(authSource).toString('base64'));

function statement(database, sql, parameters = []) {
  return { bind(...values) { return statement(database, sql, values); }, async all() { return { results: database.prepare(sql).all(...parameters) }; }, async first() { return database.prepare(sql).get(...parameters) || null; }, async run() { return database.prepare(sql).run(...parameters); } };
}

function setupDb() {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE notams (id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT, valid_from TEXT, valid_to TEXT, kind TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const DB = { prepare: (sql, parameters) => statement(database, sql, parameters), async batch(statements) { for (const prepared of statements) await prepared.run(); } };
  return { database, DB };
}

async function seedUser(database, DB, role, email = 'tester@example.com') {
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
  const encoded = await hashPassword('correct horse battery staple');
  database.prepare(`INSERT INTO auth_users
    (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(email.toLowerCase(), email, encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, role);
  const userId = database.prepare('SELECT id FROM auth_users WHERE email_normalized = ?').get(email.toLowerCase()).id;
  const session = await createSession({ request: new Request('http://localhost/api/rpc'), env: { DB } }, userId);
  const cookies = session.headers.getSetCookie();
  const sessionCookie = cookies.find(value => value.startsWith('__Host-awq_session=')).split(';', 1)[0];
  const csrfCookie = cookies.find(value => value.startsWith('awq_csrf=')).split(';', 1)[0];
  return { Cookie: `${sessionCookie}; ${csrfCookie}`, 'X-AWQ-CSRF': csrfCookie.split('=')[1] };
}

function addProfileTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY,
      full_name TEXT,
      iaa_id TEXT,
      lic_no TEXT,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_iaa_id ON user_profiles(iaa_id) WHERE iaa_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_lic_no ON user_profiles(lic_no) WHERE lic_no IS NOT NULL;
  `);
}

async function rpcCall(method, args, headers, env) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, args })
  });
  return onRequestPost({ request, env: { DB: env } });
}

async function freshScenario(role = 'readonly') {
  const { database, DB } = setupDb();
  const authHeaders = await seedUser(database, DB, role);
  addProfileTable(database);
  return { database, DB, authHeaders };
}

// Scenario 1: readonly can profileSave with normalization
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  const response = await rpcCall('profileSave', [{ fullName: 'Chris Daniel', iaaId: 'iaa-123', licNo: 'fool-881234' }], authHeaders, DB);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.profile.iaaId, 'IAA-123');
  assert.equal(body.data.profile.licNo, 'FOOL-881234');
  assert.equal(body.data.profile.fullName, 'Chris Daniel');
  database.close();
}

// Scenario 2: Invalid inputs → 400 with fields
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  const cases = [
    [{ iaaId: 'IAA-12a' }, 'iaaId'],
    [{ iaaId: 'IAA-' }, 'iaaId'],
    [{ licNo: 'FOOL-12x' }, 'licNo'],
    [{ iaaId: 'IAA-' + '1'.repeat(21) }, 'iaaId'],
    [{ fullName: '<script>alert(1)</script>' }, 'fullName'],
    [{ fullName: 'x'.repeat(101) }, 'fullName']
  ];
  for (const [fields, expectedField] of cases) {
    const response = await rpcCall('profileSave', [fields], authHeaders, DB);
    assert.equal(response.status, 400, `Expected 400 for ${JSON.stringify(fields)}`);
    const body = await response.json();
    assert.ok(body.fields, `Expected fields for ${JSON.stringify(fields)}`);
    assert.ok(body.fields[expectedField], `Expected ${expectedField} in fields for ${JSON.stringify(fields)}`);
  }
  database.close();
}

// Scenario 3: Clear-to-NULL
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  await rpcCall('profileSave', [{ fullName: 'Test User', iaaId: 'IAA-100', licNo: 'FOOL-200' }], authHeaders, DB);
  const response = await rpcCall('profileSave', [{ fullName: '', iaaId: '', licNo: '' }], authHeaders, DB);
  assert.equal(response.status, 200);
  const row = database.prepare('SELECT full_name, iaa_id, lic_no FROM user_profiles').get();
  assert.equal(row.full_name, null);
  assert.equal(row.iaa_id, null);
  assert.equal(row.lic_no, null);
  database.close();
}

// Scenario 4: Duplicate iaa_id → 409
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  const secondHeaders = await seedUser(database, DB, 'readonly', 'other@example.com');
  const secondUserId = database.prepare('SELECT id FROM auth_users WHERE email_normalized = ?').get('other@example.com').id;
  database.prepare('INSERT INTO user_profiles (user_id, iaa_id, updated_by, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(secondUserId, 'IAA-777', secondUserId);
  const response = await rpcCall('profileSave', [{ iaaId: 'IAA-777' }], authHeaders, DB);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.ok(body.fields);
  assert.ok(body.fields.iaaId);
  database.close();
}

// Scenario 5: readonly cannot adminSaveProfile
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  const response = await rpcCall('adminSaveProfile', ['other@example.com', { fullName: 'Other' }], authHeaders, DB);
  assert.equal(response.status, 403);
  database.close();
}

// Scenario 6: admin can adminSaveProfile and adminListUsers shows it
{
  const { database, DB, authHeaders } = await freshScenario('admin');
  const secondHeaders = await seedUser(database, DB, 'readonly', 'tester2@example.com');
  const response = await rpcCall('adminSaveProfile', ['tester2@example.com', { fullName: 'Other User', iaaId: 'IAA-900' }], authHeaders, DB);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.profile.fullName, 'Other User');
  assert.equal(body.data.profile.iaaId, 'IAA-900');
  const listResponse = await rpcCall('adminListUsers', [], authHeaders, DB);
  const listBody = await listResponse.json();
  const user = listBody.data.users.find(u => u.email === 'tester2@example.com');
  assert.ok(user, 'User should be in list');
  assert.equal(user.fullName, 'Other User');
  assert.equal(user.iaaId, 'IAA-900');
  assert.equal(user.licNo, null);
  database.close();
}

// Scenario 7: Anonymous → 401
{
  const { database, DB } = setupDb();
  addProfileTable(database);
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'profileSave', args: [{ fullName: 'Test' }] })
  });
  const response = await onRequestPost({ request, env: { DB } });
  assert.equal(response.status, 401);
  database.close();
}

// Scenario 8: Missing CSRF → 403
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  const headersWithoutCsrf = { ...authHeaders };
  delete headersWithoutCsrf['X-AWQ-CSRF'];
  const response = await rpcCall('profileSave', [{ fullName: 'Test' }], headersWithoutCsrf, DB);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'CSRF_INVALID');
  database.close();
}

// Scenario 9: Audit masking
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  await rpcCall('profileSave', [{ fullName: 'Chris Daniel', iaaId: 'IAA-123', licNo: 'FOOL-881234' }], authHeaders, DB);
  const auditRow = database.prepare("SELECT change_summary FROM auth_audit_log WHERE action = 'profile_save'").get();
  assert.ok(auditRow, 'Audit row should exist');
  assert.ok(!auditRow.change_summary.includes('IAA-123'), 'Should not contain full IAA ID');
  assert.ok(!auditRow.change_summary.includes('FOOL-881234'), 'Should not contain full LIC No.');
  assert.ok(!auditRow.change_summary.includes('Chris Daniel'), 'Should not contain full name');
  assert.ok(auditRow.change_summary.includes('iaa:'), 'Should contain iaa: marker');
  assert.ok(auditRow.change_summary.includes('**'), 'Should contain masking');
  database.close();
}

// Scenario 10: authMe includes profile
{
  const { database, DB, authHeaders } = await freshScenario('readonly');
  const beforeResponse = await rpcCall('authMe', [], authHeaders, DB);
  const beforeBody = await beforeResponse.json();
  assert.equal(beforeBody.data.profile, null);
  await rpcCall('profileSave', [{ fullName: 'Test User' }], authHeaders, DB);
  const afterResponse = await rpcCall('authMe', [], authHeaders, DB);
  const afterBody = await afterResponse.json();
  assert.equal(afterBody.data.profile.fullName, 'Test User');
  database.close();
}

// Scenario 11: admin profile save audit is masked too
{
  const { database, DB, authHeaders } = await freshScenario('admin');
  await seedUser(database, DB, 'readonly', 'tester2@example.com');
  await rpcCall('adminSaveProfile', ['tester2@example.com', { fullName: 'Other User', iaaId: 'IAA-900', licNo: 'FOOL-555' }], authHeaders, DB);
  const auditRow = database.prepare("SELECT change_summary FROM auth_audit_log WHERE action = 'admin_profile_save'").get();
  assert.ok(auditRow, 'admin_profile_save audit row should exist');
  assert.ok(!auditRow.change_summary.includes('IAA-900'), 'Should not contain full IAA ID');
  assert.ok(!auditRow.change_summary.includes('FOOL-555'), 'Should not contain full LIC No.');
  assert.ok(!auditRow.change_summary.includes('Other User'), 'Should not contain full name');
  assert.ok(auditRow.change_summary.includes('iaa:'), 'Should contain iaa: marker');
  database.close();
}

// Scenario 12: briefing signature prefill format
{
  const briefingBundle = await build({ entryPoints: ['functions/briefing-form.js'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { dxrPrefillFromProfile } = await import('data:text/javascript;base64,' + Buffer.from(briefingBundle.outputFiles[0].text).toString('base64'));
  assert.equal(dxrPrefillFromProfile({ full_name: 'Chris Daniel', lic_no: 'FOOL-881234' }), 'Chris Daniel (LIC: FOOL-881234)');
  assert.equal(dxrPrefillFromProfile({ full_name: 'Chris Daniel', lic_no: null }), 'Chris Daniel');
  assert.equal(dxrPrefillFromProfile({ full_name: '  Chris Daniel  ', lic_no: '' }), 'Chris Daniel');
  assert.equal(dxrPrefillFromProfile(null), '');
  assert.equal(dxrPrefillFromProfile({ full_name: '' }), '');
}

console.log('User profile feature tests pass.');
