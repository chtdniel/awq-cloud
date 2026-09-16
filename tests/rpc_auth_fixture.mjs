import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../functions/api/auth.js', import.meta.url), 'utf8');
const { hashPassword, createSession } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

export async function seedAuthUser(database, DB, role = 'registered') {
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
    CREATE TABLE auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, action TEXT,
      target_user_id INTEGER, request_id TEXT, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const encoded = await hashPassword('correct horse battery staple');
  database.prepare(`INSERT INTO auth_users
    (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run('tester@example.com', 'tester@example.com', encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, role);
  const userId = database.prepare('SELECT id FROM auth_users').get().id;
  const session = await createSession({ request: new Request('http://localhost/api/rpc'), env: { DB } }, userId);
  const cookies = session.headers.getSetCookie();
  const sessionCookie = cookies.find(value => value.startsWith('__Host-awq_session=')).split(';', 1)[0];
  const csrfCookie = cookies.find(value => value.startsWith('awq_csrf=')).split(';', 1)[0];
  return { Cookie: `${sessionCookie}; ${csrfCookie}`, 'X-AWQ-CSRF': csrfCookie.split('=')[1] };
}
