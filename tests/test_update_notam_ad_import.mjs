import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({ entryPoints: [resolve('functions/api/rpc.js')], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta (key, value) VALUES ('OCC_ALLOWED_EMAILS', 'tester@example.com');
  CREATE TABLE notams (
    id TEXT PRIMARY KEY,
    location TEXT,
    q_code TEXT,
    message TEXT,
    valid_from TEXT,
    valid_to TEXT,
    kind TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
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
    try {
      const results = [];
      for (const prepared of statements) results.push(await prepared.run());
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
};
const authHeaders = await seedAuthUser(database, DB);

async function rpc(method, args = [], headers = {}) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      Host: 'localhost',
      'Content-Type': 'application/json',
      ...authHeaders,
      ...headers
    },
    body: JSON.stringify({ method, args })
  });
  const response = await onRequestPost({ request, env: { DB } });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

const message = (number, scope, text) => `(${number} NOTAMN
Q) WIII/QMRLC/IV/NBO/${scope}/000/999/0600S10600E005
A) WIII B) 2609010000 C) 2610010000
E) ${text})`;

database.prepare('INSERT INTO notams (id, location, message, kind) VALUES (?, ?, ?, ?)').run(
  'A3001/26',
  'WIIF',
  message('A3001/26', 'E', 'FIR AIRSPACE RESTRICTED'),
  'FIR'
);
database.prepare('INSERT INTO notams (id, location, message, kind) VALUES (?, ?, ?, ?)').run(
  'A4001/26',
  'WIII',
  message('A4001/26', 'A', 'OLD RWY CLOSED'),
  'AD'
);

const dataMatrix = [
  ['LOCATION', 'NOTAM #', 'TYPE', 'ISSUE', 'VALID FROM', 'VALID TO', 'TEXT'],
  ['WIIF', 'A3001/26', '', '', '', '', message('A3001/26', 'E', 'FIR SHOULD STAY UNCHANGED')],
  ['WIII', 'A4001/26', '', '', '', '', message('A4001/26', 'A', 'UPDATED RWY CLOSED')]
];

const result = await rpc('saveNotamData', [dataMatrix, 'Query ran at UTC TEST']);
assert.equal(result.status, 'success');
assert.equal(result.rowsInserted, 1);
assert.equal(result.rowsSkippedProtected, 1);

const fir = database.prepare('SELECT location, message, kind FROM notams WHERE id = ?').get('A3001/26');
assert.equal(fir.kind, 'FIR');
assert.equal(fir.location, 'WIIF');
assert.match(fir.message, /FIR AIRSPACE RESTRICTED/);

const ad = database.prepare('SELECT location, message, kind FROM notams WHERE id = ?').get('A4001/26');
assert.equal(ad.kind, 'AD');
assert.equal(ad.location, 'WIII');
assert.match(ad.message, /UPDATED RWY CLOSED/);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM notams').get().count, 2);

const access = await rpc('getSettingsAccessInfo');
assert.equal(access.tier, 'registered');
assert.equal(access.user, 'tester@example.com');
const firEmptyImport = await rpc('firBulkImportNotams', ['', 'append']);
assert.equal(firEmptyImport.ok, false);

database.close();
console.log('UPDATE NOTAM AD import preserves FIR rows and refreshes AD rows.');
