// LINKS menu: the D1-backed dropdown list and its admin editor contract.
//
// The list is admin-supplied data that ends up as an href in the navbar, so the
// scheme validation and the role check are the load-bearing assertions here.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`[FAIL] ${name} — ${error.message}`);
  }
}

function statement(database, sql, parameters = []) {
  return {
    bind(...values) { return statement(database, sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

const DEFAULT_LABELS = ['A/C STATUS', 'CGO PLAN', 'DISPATCH BULETIN', 'ADDS (TAF)', 'BMKG TAF', 'REDWATCH', 'FR24', 'VAAC DARWIN', 'JTWC', 'DINS NOTAM'];

async function makeEnv(role = 'admin') {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) { for (const prepared of statements) await prepared.run(); }
  };
  const authHeaders = await seedAuthUser(database, DB, role);
  return { DB, database, authHeaders, env: { DB } };
}

async function rpc(handle, method, args = [], headers = handle.authHeaders) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, args })
  });
  const response = await onRequestPost({ request, env: handle.env });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body, data: body && body.data };
}

function storedRaw(database) {
  const row = database.prepare("SELECT value FROM meta WHERE key = 'EXT_LINKS'").get();
  return row ? row.value : null;
}

// The editor always sends the revision the server handed it — `null` would mean
// "I believe nothing is stored", which the guard treats as a mismatch.
async function savedWith(handle, items) {
  const current = await rpc(handle, 'getExtLinks');
  return rpc(handle, 'setExtLinks', [{ items, expectedRevision: current.data.revision }]);
}

const SAMPLE = {
  items: [
    { type: 'link', label: 'CGO PLAN', url: 'https://docs.google.com/spreadsheets/d/abc/edit' },
    { type: 'divider' },
    { type: 'link', label: 'FR24', url: 'https://www.flightradar24.com/' }
  ]
};

await check('getExtLinks serves the built-in default until an admin saves', async () => {
  const env = await makeEnv();
  const result = await rpc(env, 'getExtLinks');
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.source, 'default');
  const labels = result.data.items.filter(i => i.type !== 'divider').map(i => i.label);
  assert.deepEqual(labels, DEFAULT_LABELS, 'the shipped default matches the menu that used to be hardcoded');
  assert.equal(result.data.items.filter(i => i.type === 'divider').length, 2, 'the two grouping dividers survive');
});

await check('getExtLinks requires a session', async () => {
  const env = await makeEnv('registered');
  const result = await rpc(env, 'getExtLinks', [], {});
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'AUTH_REQUIRED');
});

await check('setExtLinks is admin only', async () => {
  const env = await makeEnv('registered');
  const result = await rpc(env, 'setExtLinks', [SAMPLE]);
  assert.equal(result.status, 403);
  assert.equal(storedRaw(env.database), null, 'nothing was written');
});

await check('setExtLinks stores the list and serves it back', async () => {
  const env = await makeEnv();
  const saved = await savedWith(env, SAMPLE.items);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.source, 'property');
  const read = await rpc(env, 'getExtLinks');
  assert.deepEqual(read.data.items, SAMPLE.items);
  assert.equal(read.data.source, 'property');
  assert.ok(read.data.updatedAt, 'a save stamps the change time');
});

await check('setExtLinks writes an audit entry', async () => {
  const env = await makeEnv();
  await savedWith(env, SAMPLE.items);
  const entry = env.database.prepare("SELECT action, result, change_summary AS summary FROM auth_audit_log WHERE action = 'ext_links_updated'").get();
  assert.ok(entry, 'ext_links_updated was audited');
  assert.equal(entry.result, 'success');
  assert.match(entry.summary, /entries:3/);
});

await check('setExtLinks rejects a javascript: URL', async () => {
  const env = await makeEnv();
  const result = await rpc(env, 'setExtLinks', [{
    items: [{ type: 'link', label: 'Boom', url: 'javascript:alert(document.cookie)' }]
  }]);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'EXT_LINKS_INVALID');
  assert.match(result.body.fields['items.0.url'], /https:\/\//);
  assert.equal(storedRaw(env.database), null);
});

await check('setExtLinks rejects plain http and relative addresses', async () => {
  const env = await makeEnv();
  for (const url of ['http://example.com/', '/app/index.html', 'example.com', '']) {
    const result = await rpc(env, 'setExtLinks', [{ items: [{ type: 'link', label: 'X', url }] }]);
    assert.equal(result.status, 400, `should reject: ${url}`);
  }
  assert.equal(storedRaw(env.database), null);
});

await check('setExtLinks rejects a missing or oversized label and angle brackets', async () => {
  const env = await makeEnv();
  const missing = await rpc(env, 'setExtLinks', [{ items: [{ type: 'link', label: '  ', url: 'https://example.com/' }] }]);
  assert.equal(missing.status, 400);
  assert.match(missing.body.fields['items.0.label'], /1-60 characters/);
  const long = await rpc(env, 'setExtLinks', [{ items: [{ type: 'link', label: 'x'.repeat(61), url: 'https://example.com/' }] }]);
  assert.equal(long.status, 400);
  const injected = await rpc(env, 'setExtLinks', [{ items: [{ type: 'link', label: '<img src=x>', url: 'https://example.com/' }] }]);
  assert.equal(injected.status, 400);
  assert.equal(storedRaw(env.database), null);
});

await check('setExtLinks drops edge and doubled dividers', async () => {
  const env = await makeEnv();
  const result = await rpc(env, 'setExtLinks', [{
    items: [
      { type: 'divider' },
      { type: 'link', label: 'A', url: 'https://a.example.com/' },
      { type: 'divider' },
      { type: 'divider' },
      { type: 'link', label: 'B', url: 'https://b.example.com/' },
      { type: 'divider' }
    ]
  }]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.items.map(i => i.type), ['link', 'divider', 'link']);
});

await check('setExtLinks caps the number of entries', async () => {
  const env = await makeEnv();
  const items = Array.from({ length: 41 }, (_, i) => ({ type: 'link', label: 'L' + i, url: 'https://example.com/' + i }));
  const result = await rpc(env, 'setExtLinks', [{ items }]);
  assert.equal(result.status, 400);
  assert.match(result.body.fields.items, /Maximum 40 entries/);
});

await check('setExtLinks refuses a body that is not a list', async () => {
  const env = await makeEnv();
  for (const args of [[], [{}], [null], ['nope']]) {
    const result = await rpc(env, 'setExtLinks', args);
    assert.equal(result.status, 400, `should reject: ${JSON.stringify(args)}`);
  }
});

await check('setExtLinks rejects a stale revision instead of overwriting', async () => {
  const env = await makeEnv();
  const first = await savedWith(env, SAMPLE.items);
  const staleRevision = first.data.revision;
  // Another admin saves something different in the meantime.
  const second = await savedWith(env, [{ type: 'link', label: 'FR24', url: 'https://www.flightradar24.com/' }]);
  assert.equal(second.status, 200);
  assert.notEqual(second.data.revision, staleRevision, 'changed content produces a new revision');
  const stale = await rpc(env, 'setExtLinks', [{ items: SAMPLE.items, expectedRevision: staleRevision }]);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_REVISION');
  assert.equal(stale.body.currentRevision, second.data.revision);
});

await check('setExtLinks is idempotent when the content has not changed', async () => {
  // The revision is a hash of the stored JSON, so re-saving identical content
  // keeps the same revision and cannot raise a false conflict.
  const env = await makeEnv();
  const first = await savedWith(env, SAMPLE.items);
  const again = await rpc(env, 'setExtLinks', [{ items: SAMPLE.items, expectedRevision: first.data.revision }]);
  assert.equal(again.status, 200);
  assert.equal(again.data.revision, first.data.revision);
});

await check('setExtLinks treats a client that sends no revision at all as permissive', async () => {
  const env = await makeEnv();
  const result = await rpc(env, 'setExtLinks', [{ items: SAMPLE.items }]);
  assert.equal(result.status, 200, 'an older client that omits the revision still saves');
});

await check('getExtLinks falls back to the default when the stored value is unusable', async () => {
  const env = await makeEnv();
  env.database.prepare("INSERT INTO meta (key, value) VALUES ('EXT_LINKS', ?)").run('{not json');
  const result = await rpc(env, 'getExtLinks');
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true, 'a corrupt value must not break the menu');
  assert.equal(result.data.source, 'fail-safe');
  assert.deepEqual(result.data.items.filter(i => i.type !== 'divider').map(i => i.label), DEFAULT_LABELS);
  assert.match(result.data.warning, /not valid/);
});

await check('getExtLinks falls back to the default when the stored value fails validation', async () => {
  const env = await makeEnv();
  env.database.prepare("INSERT INTO meta (key, value) VALUES ('EXT_LINKS', ?)")
    .run(JSON.stringify({ items: [{ type: 'link', label: 'Boom', url: 'javascript:alert(1)' }] }));
  const result = await rpc(env, 'getExtLinks');
  assert.equal(result.data.source, 'fail-safe', 'a stored javascript: URL is never served to the menu');
});

console.log(failures ? `\nLINKS menu: ${failures} pemeriksaan GAGAL` : '\nLINKS menu: semua pemeriksaan lolos');
process.exit(failures ? 1 : 0);
