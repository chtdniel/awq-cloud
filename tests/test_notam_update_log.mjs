import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

// NOTAM dataset update log (migrations/014_notam_update_log.sql).
// Covers what the LAST UPDATE panels on the UPDATE NOTAM and FIR UPDATE pages read:
//   - every dataset write path appends one row (kind, action, account, count, airports)
//   - only rows that were really written are listed (skipped/duplicate rows are not)
//   - getNotamUpdateHistory returns the newest row per dataset kind plus a recent list
//   - a database without the log table still imports, and reports that honestly
//   - the log is pruned per dataset kind, so one busy dataset cannot evict the other
const bundle = await build({ entryPoints: [resolve('functions/api/rpc.js')], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

function makeDb(database) {
  function statement(sql, parameters = []) {
    return {
      bind(...values) { return statement(sql, values); },
      async all() { return { results: database.prepare(sql).all(...parameters) }; },
      async first() { return database.prepare(sql).get(...parameters) || null; },
      async run() { return database.prepare(sql).run(...parameters); }
    };
  }
  return {
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
}

const NOTAM_UPDATE_LOG_DDL = `
  CREATE TABLE notam_update_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, action TEXT NOT NULL,
    actor_user_id INTEGER, actor_email TEXT, actor_name TEXT,
    row_count INTEGER NOT NULL DEFAULT 0, locations TEXT, detail TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

// FIR NOTAM text: the parser takes Location from the Q) line.
const message = (number, scope, description, fir = 'WIIF') => `(${number} NOTAMN
Q) ${fir}/QRTCA/IV/BO/${scope}/000/999/0600S10600E005
A) ${fir} B) 2609010000 C) 2610010000
E) ${description})`;

async function rpc(DB, authHeaders, method, args = []) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ method, args })
  });
  const response = await onRequestPost({ request, env: { DB } });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta (key, value) VALUES ('OCC_ALLOWED_EMAILS', 'tester@example.com');
  CREATE TABLE notams (
    id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT,
    valid_from TEXT, valid_to TEXT, kind TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  ${NOTAM_UPDATE_LOG_DDL};
`);
const DB = makeDb(database);
const authHeaders = await seedAuthUser(database, DB);
// The panel shows the operator behind the update: profile name plus account email.
database.exec(`
  CREATE TABLE user_profiles (user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT, updated_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO user_profiles (user_id, full_name) VALUES (1, 'Test Operator');
`);

const logRows = () => database.prepare('SELECT * FROM notam_update_log ORDER BY id ASC').all();

// ---- 1. Aerodrome import (UPDATE NOTAM page) ----
// A3001/26 is an existing FIR row: the AD import must skip it, and the skipped
// location (WIIF) must not show up in the airports that were written.
database.prepare('INSERT INTO notams (id, location, message, kind) VALUES (?, ?, ?, ?)').run('A3001/26', 'WIIF', message('A3001/26'), 'FIR');

const adMatrix = [
  ['LOCATION', 'NOTAM #', 'TYPE', 'ISSUE', 'VALID FROM', 'VALID TO', 'TEXT'],
  ['WIII', 'A4001/26', '', '', '', '', message('A4001/26', 'A', 'RWY CLOSED')],
  ['WAAA', 'A4002/26', '', '', '', '', message('A4002/26', 'A', 'APRON CLOSED')],
  ['WIII', 'A4003/26', '', '', '', '', message('A4003/26', 'A', 'TWY CLOSED')],
  ['WIIF', 'A3001/26', '', '', '', '', message('A3001/26', 'E', 'FIR ROW - PROTECTED')]
];
const adImport = await rpc(DB, authHeaders, 'saveNotamData', [adMatrix, 'Query ran at UTC TEST']);
assert.equal(adImport.status, 'success');
assert.equal(adImport.rowsInserted, 3);
assert.equal(adImport.rowsSkippedProtected, 1);
assert.equal(adImport.historyLogged, true);
assert.deepEqual(adImport.airports, ['WAAA', 'WIII'], 'skipped FIR row is not reported as a written airport');

const adLog = logRows()[0];
assert.equal(adLog.kind, 'AD');
assert.equal(adLog.action, 'IMPORT');
assert.equal(adLog.actor_email, 'tester@example.com');
assert.equal(adLog.actor_name, 'Test Operator');
assert.equal(adLog.row_count, 3);
assert.deepEqual(JSON.parse(adLog.locations), ['WAAA', 'WIII']);
assert.equal(adLog.detail, 'Query ran at UTC TEST');
assert.ok(adLog.created_at, 'history rows carry a UTC timestamp');

// ---- 2. FIR bulk append + overwrite (FIR UPDATE page) ----
const append = await rpc(DB, authHeaders, 'firBulkImportNotams', [message('A1001/26') + '\n\n' + message('A1002/26', 'E', 'SECOND', 'WAAF'), 'append']);
assert.equal(append.ok, true);
assert.equal(append.historyLogged, true);
const appendLog = logRows().at(-1);
assert.equal(appendLog.kind, 'FIR');
assert.equal(appendLog.action, 'APPEND');
assert.equal(appendLog.row_count, 2);
assert.deepEqual(JSON.parse(appendLog.locations), ['WAAF', 'WIIF']);

const overwrite = await rpc(DB, authHeaders, 'firBulkImportNotams', [message('A1001/26', 'E', 'REPLACED', 'WIIF'), 'overwrite']);
assert.equal(overwrite.ok, true);
const overwriteLog = logRows().at(-1);
assert.equal(overwriteLog.action, 'OVERWRITE');
assert.equal(overwriteLog.row_count, 1);
assert.deepEqual(JSON.parse(overwriteLog.locations), ['WIIF']);
assert.match(overwriteLog.detail, /Raw ICAO/);

// ---- 3. FIR NOTAM editor row writes ----
const editorRow = { rowId: null, Location: 'WADD', 'NOTAM #': 'A5001/26', Class: 'A', 'Effective Date': '2026-09-01 00:00', 'Expiration Date': '2026-10-01 00:00', 'NOTAM Text': message('A5001/26', 'E', 'EDITOR ROW', 'WADD') };
assert.equal((await rpc(DB, authHeaders, 'firSaveNotam', [editorRow])).ok, true);
const saveLog = logRows().at(-1);
assert.equal(saveLog.action, 'NEW');
assert.equal(saveLog.row_count, 1);
assert.deepEqual(JSON.parse(saveLog.locations), ['WADD']);
assert.match(saveLog.detail, /A5001\/26/);

assert.equal((await rpc(DB, authHeaders, 'firUpdateNotam', [{ ...editorRow, rowId: 'A5001/26', 'NOTAM #': 'A5002/26' }])).ok, true);
const editLog = logRows().at(-1);
assert.equal(editLog.action, 'EDIT');
assert.deepEqual(JSON.parse(editLog.locations), ['WADD']);
assert.match(editLog.detail, /A5002\/26/);

const deleteResult = await rpc(DB, authHeaders, 'firDeleteNotam', ['A5002/26']);
assert.equal(deleteResult.ok, true);
const deleteLog = logRows().at(-1);
assert.equal(deleteLog.action, 'DELETE');
// The location is read before the DELETE, so the history row still names the FIR.
assert.deepEqual(JSON.parse(deleteLog.locations), ['WADD']);

// Failed writes must not leave a history row behind.
assert.equal((await rpc(DB, authHeaders, 'firDeleteNotam', ['A9999/26'])).ok, false);
assert.equal(logRows().length, 6, 'only successful writes are logged');

// ---- 4. History contract read by both panels ----
const history = await rpc(DB, authHeaders, 'getNotamUpdateHistory');
assert.equal(history.ok, true);
assert.equal(history.latest.AD.action, 'IMPORT');
assert.deepEqual(history.latest.AD.user, { name: 'Test Operator', email: 'tester@example.com' });
assert.deepEqual(history.latest.AD.locations, ['WAAA', 'WIII']);
assert.equal(history.latest.FIR.action, 'DELETE');
// Each page reads its own dataset only: the aerodrome page must not list FIR writes.
assert.deepEqual(history.recent.AD.map(row => row.action), ['IMPORT']);
assert.deepEqual(history.recent.FIR.map(row => row.action), ['DELETE', 'EDIT', 'NEW', 'OVERWRITE', 'APPEND'], 'recent is newest first');

// ---- 5. Pruning: each dataset keeps its newest rows only ----
// Seed an old aerodrome backlog; the panels only ever read the newest 10 per kind,
// so the write path trims what it no longer needs.
database.exec(`
  WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 250)
  INSERT INTO notam_update_log (kind, action, actor_email, actor_name, row_count, locations, detail, created_at)
  SELECT 'AD', 'IMPORT', 'qa-old@example.com', 'Old Operator', 1, '[]', 'old row', '2020-01-01 00:00:00' FROM seq
`);
assert.equal(database.prepare("SELECT COUNT(*) AS c FROM notam_update_log WHERE actor_email = 'qa-old@example.com'").get().c, 250);

const prunedImport = await rpc(DB, authHeaders, 'saveNotamData', [adMatrix, 'Query ran at UTC PRUNE']);
assert.equal(prunedImport.status, 'success');
assert.equal(prunedImport.historyLogged, true);

const adIds = database.prepare("SELECT id FROM notam_update_log WHERE kind = 'AD' ORDER BY id").all().map(row => row.id);
const newestId = database.prepare('SELECT MAX(id) AS id FROM notam_update_log').get().id;
assert.equal(adIds.length, 200, 'aerodrome history is capped at 200 rows');
assert.equal(adIds.at(-1), newestId, 'the row just written always survives the prune');
assert.ok(adIds[0] > 1, 'the oldest rows are the ones dropped');
assert.deepEqual(adIds, Array.from({ length: adIds.length }, (_, index) => adIds[0] + index), 'the kept rows are the newest, contiguous tail');
assert.equal(database.prepare("SELECT COUNT(*) AS c FROM notam_update_log WHERE kind = 'FIR'").get().c, 5, 'an aerodrome prune never touches the FIR history');
assert.equal((await rpc(DB, authHeaders, 'getNotamUpdateHistory')).latest.AD.detail, 'Query ran at UTC PRUNE');

// ---- 6. Pre-migration database: import keeps working, panel says "unavailable" ----
const legacyDatabase = new DatabaseSync(':memory:');
legacyDatabase.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta (key, value) VALUES ('OCC_ALLOWED_EMAILS', 'tester@example.com');
  CREATE TABLE notams (id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT, valid_from TEXT, valid_to TEXT, kind TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
const legacyDB = makeDb(legacyDatabase);
const legacyHeaders = await seedAuthUser(legacyDatabase, legacyDB);
legacyDatabase.exec('CREATE TABLE user_profiles (user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT, updated_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
const legacyImport = await rpc(legacyDB, legacyHeaders, 'saveNotamData', [adMatrix, 'Query ran at UTC LEGACY']);
assert.equal(legacyImport.status, 'success', 'a missing history table must not fail the import');
// Nothing is protected in this database, so all four pasted rows are written.
assert.equal(legacyImport.rowsInserted, 4);
assert.equal(legacyImport.historyLogged, false, 'the response reports the unrecorded history');
const legacyHistory = await rpc(legacyDB, legacyHeaders, 'getNotamUpdateHistory');
assert.equal(legacyHistory.ok, false);
assert.equal(legacyHistory.latest.AD, null);
assert.deepEqual(legacyHistory.recent, { AD: [], FIR: [] });

legacyDatabase.close();
database.close();
console.log('NOTAM update log records all dataset writes, reports the written airports, and degrades safely without the table.');
