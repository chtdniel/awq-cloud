// Settings surface: authorization per role, stale-revision conflicts, legacy
// read-only enforcement, WX AI field validation, and audit trail writes.
//
// The bundle is the real functions/api/rpc.js, so these assertions exercise the
// same guards the deployed Worker runs.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

function statement(database, sql, parameters = []) {
  return {
    bind(...values) { return statement(database, sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

async function makeEnv(role, options = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE user_profiles (
      user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT,
      updated_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) { for (const prepared of statements) await prepared.run(); }
  };
  const authHeaders = await seedAuthUser(database, DB, role);
  if (options.adminEmail) {
    database.prepare('INSERT INTO auth_users (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(String(options.adminEmail).toLowerCase(), options.adminEmail, 'x', 'x', 1, 'PBKDF2-SHA-256', 'admin');
  }
  if (options.meta) {
    const insert = database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(options.meta)) insert.run(key, value);
  }
  return { DB, database, authHeaders };
}

async function rpc(env, method, args = [], headers = env.authHeaders) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, args })
  });
  const response = await onRequestPost({ request, env: { DB: env.DB } });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body, data: body && body.data };
}

function auditRows(env) {
  return env.database.prepare('SELECT action, result, change_summary AS changeSummary FROM auth_audit_log ORDER BY id').all();
}

// ---- Authorization per role ----

// canView means "may open the Settings page". It used to be Boolean(user),
// which let any signed-in account into Settings while every admin RPC replied
// 403 — the page rendered as an empty shell of placeholders.
{
  const registered = await makeEnv('registered');
  const info = await rpc(registered, 'getSettingsAccessInfo');
  assert.equal(info.status, 200);
  assert.equal(info.data.canView, false, 'a registered account must not be told it can open Settings');
  assert.equal(info.data.isAuthorized, true, 'the account itself is authenticated');
  assert.equal(info.data.canEdit, true, 'registered accounts may still change operational data');
  assert.equal(info.data.tier, 'registered');
  assert.equal(info.data.role, 'registered', 'the role must be exposed without the legacy flag');
  registered.database.close();

  const readonlyEnv = await makeEnv('readonly');
  const roInfo = await rpc(readonlyEnv, 'getSettingsAccessInfo');
  assert.equal(roInfo.data.canView, false, 'readonly accounts must not reach Settings either');
  assert.equal(roInfo.data.canEdit, false, 'readonly accounts cannot change operational data');
  readonlyEnv.database.close();

  const adminEnv = await makeEnv('admin');
  const adminInfo = await rpc(adminEnv, 'getSettingsAccessInfo');
  assert.equal(adminInfo.data.canView, true, 'admins keep Settings access');
  assert.equal(adminInfo.data.canEdit, true);
  assert.equal(adminInfo.data.canManageUsers, true);
  adminEnv.database.close();
}
console.log('Settings: canView is admin-only while canEdit follows the write policy.');

const ADMIN_ONLY = ['getSettingsBundle', 'getOccSettings', 'getSettingsAdminList', 'adminListUsers', 'adminListAudit', 'wxAiSetCatalog'];

for (const role of ['registered', 'readonly']) {
  const env = await makeEnv(role);
  for (const method of ADMIN_ONLY) {
    const result = await rpc(env, method, []);
    assert.equal(result.status, 403, `${method} must be 403 for ${role}`);
    assert.equal(result.body.code, 'ADMIN_REQUIRED', `${method} must report ADMIN_REQUIRED for ${role}`);
  }
  // A denied probe must leave evidence, including the actor that attempted it.
  const denied = auditRows(env).filter(row => row.action === 'admin_method_denied');
  assert.equal(denied.length, ADMIN_ONLY.length, 'every denied admin call must be audited');
  assert.ok(denied.every(row => row.result === 'denied'));
  assert.ok(denied.some(row => /adminListAudit/.test(row.changeSummary)), 'the audited summary must name the attempted method');
  env.database.close();
}
console.log('Settings: registered and readonly accounts are refused by every admin-only RPC.');

// CSRF is still required on top of the role check.
{
  const env = await makeEnv('admin');
  const noCsrf = { Cookie: env.authHeaders.Cookie };
  const result = await rpc(env, 'getSettingsBundle', [], noCsrf);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CSRF_INVALID');
  env.database.close();
}
console.log('Settings: admin calls without a CSRF token are rejected.');

// ---- Admin happy path ----

{
  const env = await makeEnv('admin', { meta: { OCC_ALLOWED_EMAILS: 'Legacy@Example.com, ops@example.com' } });
  const bundleResult = await rpc(env, 'getSettingsBundle');
  assert.equal(bundleResult.status, 200);
  assert.equal(bundleResult.data.settings.isLegacy, true);
  assert.equal(bundleResult.data.settings.readOnly, true);
  // The legacy read used to answer with a hard-coded isAuthorized/isOpen that
  // implied an allowlist which is no longer consulted.
  assert.equal('isAuthorized' in bundleResult.data.settings, false, 'legacy read must not claim authorization');
  assert.equal('isOpen' in bundleResult.data.settings, false, 'legacy read must not claim an allowlist mode');
  assert.equal(bundleResult.data.settings.accountRole, 'admin', 'the session role is the stated authority');
  // Legacy entries keep their stored casing but are ordered case-insensitively.
  assert.deepEqual(bundleResult.data.settings.allowed, ['Legacy@Example.com', 'ops@example.com']);
  assert.ok(bundleResult.data.settings.revision, 'the allowlist read must carry a revision');
  assert.equal(bundleResult.data.admins.readOnly, true);
  assert.ok(bundleResult.data.system.dataSource.includes('D1'), 'system panel must name the D1 source');
  assert.ok(bundleResult.data.system.timezone, 'system panel must report the timezone');
  assert.equal(typeof bundleResult.data.wx.revision, 'string', 'even an unset catalog must expose a revision to echo back');
  env.database.close();
}
console.log('Settings bundle exposes legacy data as read-only with a revision.');

// ---- Legacy writes are refused (and audited) ----

for (const method of ['setOccAllowedEmails', 'setSettingsAdminEmails']) {
  const env = await makeEnv('admin', { adminEmail: 'second@example.com' });
  const result = await rpc(env, method, ['attacker@example.com']);
  assert.equal(result.status, 409, `${method} must refuse the legacy write`);
  assert.equal(result.body.code, 'LEGACY_SETTING_READ_ONLY');
  const rows = auditRows(env).filter(row => row.action === 'legacy_settings_write_denied');
  assert.equal(rows.length, 1, `${method} refusal must be audited`);
  env.database.close();
}
console.log('Settings: legacy allowlist writes are refused with code LEGACY_SETTING_READ_ONLY and audited.');

// ---- Legacy write payload validation still reports 4xx through the dispatcher ----

{
  const env = await makeEnv('admin');
  const result = await rpc(env, 'setOccAllowedEmails', ['not-an-email']);
  assert.equal(result.status, 409, 'legacy writes never reach validation, so they stay denied');
  assert.equal(result.body.code, 'LEGACY_SETTING_READ_ONLY');
  env.database.close();
}
console.log('Settings: a malformed legacy write is still denied rather than partially applied.');

// ---- Stale revision: WX AI catalog ----

{
  const env = await makeEnv('admin');
  const first = await rpc(env, 'wxAiGetCatalog');
  assert.equal(first.status, 200);
  assert.equal(typeof first.data.revision, 'string', 'an unset catalog still yields a revision sentinel');
  assert.equal(first.data.updatedAt, null, 'a catalog never saved has no change timestamp');

  const catalogA = [{ id: 'kl-hy3', provider: 'custom', model: 'kl/hy3', label: 'CIZ-AI hy3' }];
  const created = await rpc(env, 'wxAiSetCatalog', [{ enabled: true, catalog: catalogA, expectedRevision: first.data.revision }]);
  assert.equal(created.status, 200, 'create with the rendered revision must succeed');
  assert.ok(created.data.revision, 'the saved catalog must return its new revision');
  assert.notEqual(created.data.revision, first.data.revision, 'creating the catalog must change the revision');
  // The timestamp only advances on an accepted save, so it also tells an editor
  // whether the copy in front of them predates someone else's change.
  assert.ok(created.data.updatedAt, 'an accepted save must stamp the change time');
  assert.ok(!Number.isNaN(Date.parse(created.data.updatedAt)), 'the timestamp must be a parseable ISO date');
  const afterCreate = await rpc(env, 'wxAiGetCatalog');
  assert.equal(afterCreate.data.updatedAt, created.data.updatedAt, 'the stamp must be readable back');

  // A second editor still holding the pre-change revision must be refused.
  const stale = await rpc(env, 'wxAiSetCatalog', [{ enabled: false, catalog: catalogA, expectedRevision: first.data.revision }]);
  assert.equal(stale.status, 409, 'a stale editor must not overwrite a newer catalog');
  assert.equal(stale.body.code, 'STALE_REVISION');
  assert.equal(stale.body.currentRevision, created.data.revision);
  const afterStale = await rpc(env, 'wxAiGetCatalog');
  assert.equal(afterStale.data.updatedAt, created.data.updatedAt, 'a refused save must not advance the change stamp');
  assert.equal(afterStale.data.revision, created.data.revision, 'a refused save must not change the revision');

  // An editor that rendered "created by someone else" is equally stale.
  const alsoStale = await rpc(env, 'wxAiSetCatalog', [{ enabled: false, catalog: catalogA, expectedRevision: null }]);
  assert.equal(alsoStale.status, 409, 'a null revision must not bypass the conflict check');

  // Omitting the field stays permissive so older clients keep working.
  const noRevision = await rpc(env, 'wxAiSetCatalog', [{ enabled: true, catalog: catalogA }]);
  assert.equal(noRevision.status, 200, 'a client that does not send a revision is still accepted');

  const fresh = await rpc(env, 'wxAiSetCatalog', [{ enabled: false, catalog: catalogA, expectedRevision: created.data.revision }]);
  assert.equal(fresh.status, 200, 'reloading the revision must let the edit through');
  assert.notEqual(fresh.data.revision, created.data.revision, 'a content change must change the revision');

  const saved = auditRows(env).filter(row => row.action === 'wx_ai_catalog_updated');
  assert.equal(saved.length, 3, 'only accepted saves are audited as updates');
  assert.ok(saved.every(row => !/password|token/i.test(row.changeSummary || '')), 'audit summaries must stay redacted');
  env.database.close();
}
console.log('Settings: WX AI saves enforce the rendered revision and reject stale editors with 409.');

// ---- WX AI catalog validation returns field-level 4xx ----

{
  const env = await makeEnv('admin');
  const badId = await rpc(env, 'wxAiSetCatalog', [{ enabled: true, catalog: [{ id: 'Bad Id!', provider: 'custom', model: 'm', label: 'L' }] }]);
  assert.equal(badId.status, 400);
  assert.equal(badId.body.code, 'WX_CATALOG_INVALID');
  assert.ok(badId.body.fields['row0.id'], 'the offending row and field must be reported');

  const duplicate = await rpc(env, 'wxAiSetCatalog', [{ enabled: true, catalog: [
    { id: 'kl-hy3', provider: 'custom', model: 'kl/hy3', label: 'A' },
    { id: 'kl-hy3', provider: 'custom', model: 'kl/hy3', label: 'B' }
  ] }]);
  assert.equal(duplicate.status, 400);
  assert.ok(duplicate.body.fields['row1.id'], 'a duplicate model id must be attributed to the later row');

  const tooMany = await rpc(env, 'wxAiSetCatalog', [{ enabled: true, catalog: new Array(51).fill({ id: 'x-y', provider: 'custom', model: 'm', label: 'l' }) }]);
  assert.equal(tooMany.status, 400);
  assert.ok(tooMany.body.fields.catalog, 'an oversized catalog must be reported as a catalog-level error');
  env.database.close();
}
console.log('Settings: malformed WX AI rows return 400 WX_CATALOG_INVALID with per-field details.');

// ---- Audit log reader: admin only, bounded, redacted ----

{
  const env = await makeEnv('admin');
  await rpc(env, 'adminCreateUser', ['new.user@example.com', 'registered', 'temporary-password-123']);
  const listed = await rpc(env, 'adminListAudit');
  assert.equal(listed.status, 200);
  assert.ok(listed.data.entries.length >= 1, 'the created user must appear in the audit log');
  assert.equal(listed.data.retention.maxAgeDays, 180);
  assert.equal(listed.data.retention.maxRows, 5000);
  assert.ok(/never contain passwords/i.test(listed.data.retention.redaction));
  const created = listed.data.entries.find(entry => entry.action === 'user_created');
  assert.ok(created, 'user_created must be listed');
  assert.ok(created.actorEmail, 'the audit entry must resolve the acting account');
  assert.ok(!/temporary-password-123/.test(JSON.stringify(listed.data.entries)), 'temporary passwords must never be stored in or returned by the audit log');
  env.database.close();
}
console.log('Settings: adminListAudit exposes a bounded, redacted audit view to admins only.');

console.log('All Settings RPC checks passed.');
