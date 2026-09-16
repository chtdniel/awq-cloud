import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../functions/api/auth.js', import.meta.url), 'utf8');
const { hashPassword, verifyPassword, createSession, getRequestUser, requireCsrf } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email_normalized TEXT UNIQUE, email_display TEXT,
    password_hash TEXT, password_salt TEXT, password_iterations INTEGER, password_algorithm TEXT,
    role TEXT, is_active INTEGER DEFAULT 1, must_change_password INTEGER DEFAULT 0,
    failed_login_count INTEGER DEFAULT 0, locked_until TEXT, created_at TEXT, updated_at TEXT, last_login_at TEXT
  );
  CREATE TABLE auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, token_hash TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT, revoked_at TEXT
  );
`);

function statement(sql, parameters = []) {
  return {
    bind(...values) { return statement(sql, values); },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

const DB = { prepare: statement };
const password = 'correct horse battery staple';
const encoded = await hashPassword(password);
database.prepare(`INSERT INTO auth_users
  (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run('admin@example.com', 'admin@example.com', encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, 'admin');
const userId = database.prepare('SELECT id FROM auth_users').get().id;
assert.equal(await verifyPassword(password, database.prepare('SELECT * FROM auth_users').get()), true);
assert.equal(await verifyPassword('wrong password', database.prepare('SELECT * FROM auth_users').get()), false);

const context = { request: new Request('https://example.test/api/rpc', { headers: { Origin: 'https://example.test' } }), env: { DB } };
const session = await createSession(context, userId);
const cookieHeaders = session.headers.getSetCookie();
const sessionCookie = cookieHeaders.find(value => value.startsWith('__Host-awq_session='));
const csrfCookie = cookieHeaders.find(value => value.startsWith('awq_csrf='));
assert.match(sessionCookie, /^__Host-awq_session=.+; Path=\/; Secure; SameSite=Lax; HttpOnly$/);
assert.match(csrfCookie, /^awq_csrf=.+; Path=\/; Secure; SameSite=Lax$/);

const token = sessionCookie.split(';', 1)[0];
const csrf = csrfCookie.split(';', 1)[0];
const authenticated = { request: new Request('https://example.test/api/rpc', { headers: { Cookie: `${token}; ${csrf}`, 'X-AWQ-CSRF': csrf.split('=')[1], Origin: 'https://example.test' } }), env: { DB } };
assert.equal((await getRequestUser(authenticated)).role, 'admin');
assert.equal(requireCsrf(authenticated), null);
assert.equal(requireCsrf({ ...authenticated, request: new Request(authenticated.request, { headers: { Cookie: `${token}; ${csrf}`, Origin: 'https://example.test' } }) }), 'Invalid CSRF token');
console.log('Password hashing, session cookies, session lookup, and CSRF checks pass.');
