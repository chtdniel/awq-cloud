import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const database = new DatabaseSync(':memory:');
database.exec(`CREATE TABLE notams (id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT, valid_from TEXT, valid_to TEXT, kind TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
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
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
};
const authHeaders = await seedAuthUser(database, DB);
async function rpc(method, args = []) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST', headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ method, args })
  });
  const response = await onRequestPost({ request, env: { DB } });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}
const message = (number, scope = 'E', description = 'AIRSPACE RESTRICTED') => `(${number} NOTAMN\nQ) WIIF/QRTCA/IV/BO/${scope}/000/999/0600S10600E005\nA) WIIF B) 2609010000 C) 2610010000\nE) ${description})`;
const first = message('A1001/26');
const second = message('A1002/26');
const preview = await rpc('firBulkPreviewNotams', [first + '\n\n' + second]);
assert.equal(preview.validOverwrite, 2, 'standard ICAO headers retain each NOTAM number');
assert.deepEqual(preview.preview.map(row => row['NOTAM #']), ['A1001/26', 'A1002/26']);
assert.equal((await rpc('firBulkPreviewNotams', ['NOTAMs for Location search WIIF\n' + first])).validOverwrite, 1, 'DINS heading retains first ICAO header');
assert.equal((await rpc('firBulkImportNotams', [first + '\n\n' + second, 'overwrite'])).appended, 2);
const replacement = message('A1001/26', 'E', 'UPDATED AIRSPACE RESTRICTED');
const duplicate = await rpc('firBulkPreviewNotams', [replacement]);
assert.equal(duplicate.valid, 0);
assert.equal(duplicate.validOverwrite, 1, 'overwrite allows existing numbers');
assert.equal((await rpc('firBulkImportNotams', [replacement, 'overwrite'])).ok, true);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM notams').get().count, 1);
assert.match(database.prepare('SELECT message FROM notams').get().message, /UPDATED/);
const aerodrome = message('A2001/26', 'A', 'RWY CLSD');
assert.equal((await rpc('firBulkPreviewNotams', [aerodrome])).validOverwrite, 0, 'aerodrome-only scope is rejected');
assert.equal((await rpc('firBulkImportNotams', [aerodrome, 'overwrite'])).ok, false);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM notams').get().count, 1, 'invalid overwrite preserves existing records');
database.prepare('INSERT INTO notams (id, location, message, kind) VALUES (?, ?, ?, ?)').run('A2001/26', 'WIIF', aerodrome, 'FIR');
for (const method of ['getActiveNotams', 'firGetNotamResults', 'firGetNotamEditorData']) {
  const result = await rpc(method);
  assert.equal((result.notams || result.results).length, 1, method + ' excludes legacy mislabeled aerodrome NOTAM');
}
const mixed = message('A1003/26', 'AE');
assert.equal((await rpc('firBulkPreviewNotams', [mixed])).validOverwrite, 1, 'mixed aerodrome/enroute scope retained');
const tsv = 'WIIF\tA1004/26\t"' + message('A1004/26') + '"';
assert.equal((await rpc('firBulkPreviewNotams', [tsv])).validOverwrite, 1, 'headerless TSV keeps first row');
const payload = { rowId: 'A1001/26', Location: 'WIIF', 'NOTAM #': 'A1005/26', Class: 'A', 'Effective Date': '2026-09-01 00:00', 'Expiration Date': '2026-10-01 00:00', 'NOTAM Text': message('A1005/26') };
assert.equal((await rpc('firUpdateNotam', [payload])).ok, true);
assert.ok(database.prepare('SELECT id FROM notams WHERE id = ?').get('A1005/26'), 'editor updates the NOTAM number');
assert.equal(database.prepare('SELECT id FROM notams WHERE id = ?').get('A1001/26'), undefined);
database.prepare('INSERT INTO notams (id, location, message, kind) VALUES (?, ?, ?, ?)').run('A3001/26', 'WIII', message('A3001/26', 'A'), 'AD');
const collision = await rpc('firBulkPreviewNotams', [message('A3001/26')]);
assert.equal(collision.validOverwrite, 0);
assert.match(collision.preview[0].error, /aerodrome dataset/);
assert.equal((await rpc('firBulkImportNotams', [message('A3001/26'), 'overwrite'])).ok, false);
assert.ok(database.prepare('SELECT id FROM notams WHERE id = ?').get('A1005/26'), 'conflicting overwrite preserves FIR data');
assert.equal((await rpc('firSaveNotam', [{ ...payload, rowId: null, 'NOTAM #': 'A3001/26' }])).ok, false);
assert.equal((await rpc('firUpdateNotam', [{ ...payload, rowId: 'A1005/26', 'NOTAM #': 'A3001/26' }])).ok, false);
assert.equal((await rpc('firDeleteNotam', ['A3001/26'])).ok, false);
assert.equal((await rpc('firBulkImportNotams', [message('A1006/26'), 'overwrite'])).ok, true);
assert.equal(database.prepare('SELECT kind FROM notams WHERE id = ?').get('A3001/26').kind, 'AD', 'overwrite preserves aerodrome rows');
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM notams WHERE kind = 'FIR'").get().count, 1);
const lifecycleReplacement = message('A1007/26').replace('NOTAMN', 'NOTAMR A1006/26');
assert.equal((await rpc('firBulkImportNotams', [lifecycleReplacement, 'append'])).ok, true);
const lifecycleResults = await rpc('firGetNotamResults');
assert.equal(lifecycleResults.results.find(row => row['NOTAM #'] === 'A1006/26').lifecycle, 'REPLACED');
database.close();
console.log('FIR RPC import, overwrite, classification and editor regression checks passed.');
