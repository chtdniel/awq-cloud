// Sync CGO Data: sheet parsing, board matching, the push ingest endpoint, and
// the full RPC path.
//
// The sheet reaches the Worker by push (the Workspace blocks anonymous Apps
// Script web apps), so the sync reads a snapshot stored in the `meta` table.
// Both the real functions/api/rpc.js and functions/api/cgo-ingest.js are
// bundled, so these assertions run the same guards the deployed Worker runs.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { CGO_SNAPSHOT_KEY, matchCgoEntries, normalizeCgoValue, normalizeFlightNo, parseCgoSheet, parseSheetDate, summarizeCgoSync } from '../shared/cgo.mjs';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

async function bundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const { onRequestPost } = await bundle('functions/api/rpc.js');
const { onRequestPost: onCgoIngest } = await bundle('functions/api/cgo-ingest.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`[FAIL] ${name} — ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`[FAIL] ${name} — ${error.message}`);
  }
}

// ---- Sheet layout given by the cargo desk ----

const HEADER = ['FLIGHT NO', 'Flight Date', 'Origin', 'Dest', 'Dep Time', 'Arr Time', 'Confirmed Wt.', 'REVISE', 'Revise Time'];

// ---- Flight-number normalization ----

check('normalizeFlightNo drops the airline designator from both sides', () => {
  assert.equal(normalizeFlightNo('QZ320'), '320');
  assert.equal(normalizeFlightNo('320'), '320');
  assert.equal(normalizeFlightNo('qz 320'), '320');
  assert.equal(normalizeFlightNo('QZ-320'), '320');
  assert.equal(normalizeFlightNo('QZ247D'), '247D');
  assert.equal(normalizeFlightNo('  801 '), '801');
  assert.equal(normalizeFlightNo(''), '');
  assert.equal(normalizeFlightNo(null), '');
});

check('normalizeFlightNo only strips a designator that leads into a digit', () => {
  assert.equal(normalizeFlightNo('FD320'), '320');
  assert.equal(normalizeFlightNo('320D'), '320D');
  assert.equal(normalizeFlightNo('ABC'), 'ABC');
  assert.equal(normalizeFlightNo('QZ'), 'QZ');
});

// ---- Sheet dates ----

check('parseSheetDate reads the day-first sheet format', () => {
  assert.equal(parseSheetDate('21/09/2026'), '20260921');
  assert.equal(parseSheetDate('01/02/2026'), '20260201');
  assert.equal(parseSheetDate(' 21/09/2026 '), '20260921');
});

check('parseSheetDate resolves the unambiguous month-first case', () => {
  assert.equal(parseSheetDate('09/21/2026'), '20260921');
});

check('parseSheetDate accepts ISO, compact and Google serial numbers', () => {
  assert.equal(parseSheetDate('2026-09-21'), '20260921');
  assert.equal(parseSheetDate('20260921'), '20260921');
  // 21 Sep 2026 is serial 46286 counting from the Sheets epoch 1899-12-30.
  assert.equal(parseSheetDate('46286'), '20260921');
});

check('parseSheetDate rejects impossible and unreadable dates instead of guessing', () => {
  assert.equal(parseSheetDate('31/02/2026'), null);
  assert.equal(parseSheetDate('not a date'), null);
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate(null), null);
});

// ---- Weight values ----

check('normalizeCgoValue strips a thousands separator but keeps decimals', () => {
  assert.equal(normalizeCgoValue('2,500'), '2500');
  assert.equal(normalizeCgoValue('12.5'), '12.5');
  assert.equal(normalizeCgoValue(' 2500 '), '2500');
  assert.equal(normalizeCgoValue(''), '');
});

// ---- Sheet parsing ----

check('parseCgoSheet resolves columns from the real header', () => {
  const plan = parseCgoSheet([
    HEADER,
    ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']
  ]);
  assert.equal(plan.error, undefined);
  assert.equal(plan.headerRow, 1);
  assert.equal(plan.columns.flight, 0);
  assert.equal(plan.columns.date, 1);
  assert.equal(plan.columns.confirmed, 6);
  assert.equal(plan.columns.revise, 7);
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(plan.entries[0], {
    flightNo: '320', date: '20260921', value: '2500', source: 'Confirmed Wt.', sheetRow: 2
  });
});

check('parseCgoSheet uses REVISE when it is filled in', () => {
  const plan = parseCgoSheet([
    HEADER,
    ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '1950', '14:00'],
    ['QZ321', '21/09/2026', 'KUL', 'SUB', '10:00', '12:00', '1800', '', '']
  ]);
  assert.equal(plan.entries[0].value, '1950');
  assert.equal(plan.entries[0].source, 'REVISE');
  assert.equal(plan.entries[1].value, '1800');
  assert.equal(plan.entries[1].source, 'Confirmed Wt.');
});

check('parseCgoSheet skips a title band above the header', () => {
  const plan = parseCgoSheet([
    ['CGO PLAN', '', ''],
    ['', '', ''],
    HEADER,
    ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']
  ]);
  assert.equal(plan.headerRow, 3);
  assert.equal(plan.entries.length, 1);
});

check('parseCgoSheet survives reordered and renamed columns', () => {
  const plan = parseCgoSheet([
    ['Flight Date', 'Origin', 'Flight No', 'Revise', 'Confirmed Wt.', 'Revise Time'],
    ['21/09/2026', 'SUB', 'QZ320', '1950', '2500', '14:00']
  ]);
  assert.equal(plan.columns.flight, 2);
  assert.equal(plan.columns.revise, 3);
  assert.equal(plan.entries[0].flightNo, '320');
  assert.equal(plan.entries[0].value, '1950');
});

check('parseCgoSheet counts rows it cannot use', () => {
  const plan = parseCgoSheet([
    HEADER,
    ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['QZ322', '21/09/2026', 'KUL', 'SUB', '10:00', '12:00', '', '', '']
  ]);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.blankRows, 1);
  assert.equal(plan.rowsWithoutWeight, 1);
});

check('parseCgoSheet reports a missing header instead of throwing', () => {
  const plan = parseCgoSheet([['something', 'else'], ['a', 'b']]);
  assert.match(plan.error, /CGO PLAN header not found/);
});

// ---- Board matching ----

const board = [
  { rowIdx: 1, FLIGHT: '320', DOF: '20260921', CGO: '' },
  { rowIdx: 2, FLIGHT: '321', DOF: '20260921', CGO: '1800' },
  { rowIdx: 3, FLIGHT: '646', DOF: '20260917', CGO: null }
];

check('matchCgoEntries writes a matched flight', () => {
  const plan = parseCgoSheet([HEADER, ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']]);
  const match = matchCgoEntries(plan.entries, board);
  assert.equal(match.updates.length, 1);
  assert.equal(match.updates[0].rowIdx, 1);
  assert.equal(match.updates[0].previous, '');
  assert.equal(match.updates[0].value, '2500');
  assert.equal(match.updates[0].changed, true);
  assert.equal(match.unmatched.length, 0);
});

check('matchCgoEntries marks an identical weight as unchanged', () => {
  const plan = parseCgoSheet([HEADER, ['QZ321', '21/09/2026', 'KUL', 'SUB', '10:00', '12:00', '1800', '', '']]);
  const match = matchCgoEntries(plan.entries, board);
  assert.equal(match.updates.length, 1);
  assert.equal(match.updates[0].changed, false);
});

check('matchCgoEntries never touches a flight that is not on the board', () => {
  const plan = parseCgoSheet([HEADER, ['QZ999', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']]);
  const match = matchCgoEntries(plan.entries, board);
  assert.equal(match.updates.length, 0);
  assert.equal(match.unmatched.length, 1);
  assert.equal(match.unmatched[0].flightNo, '999');
});

check('matchCgoEntries reports a date that disagrees with the board DOF but still writes', () => {
  const plan = parseCgoSheet([HEADER, ['QZ646', '18/09/2026', 'WADD', 'WATO', '3:25', '4:40', '900', '', '']]);
  const match = matchCgoEntries(plan.entries, board);
  assert.equal(match.updates.length, 1);
  assert.equal(match.updates[0].rowIdx, 3);
  assert.equal(match.dateMismatches.length, 1);
  assert.equal(match.dateMismatches[0].boardDof, '20260917');
});

check('matchCgoEntries refuses to guess between same-numbered board flights', () => {
  const duplicates = [
    { rowIdx: 7, FLIGHT: '320', DOF: '20260921', CGO: '' },
    { rowIdx: 8, FLIGHT: '320', DOF: '20260922', CGO: '' }
  ];
  const plan = parseCgoSheet([HEADER, ['QZ320', '23/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']]);
  const match = matchCgoEntries(plan.entries, duplicates);
  assert.equal(match.updates.length, 0);
  assert.equal(match.ambiguous.length, 1);
  assert.deepEqual(match.ambiguous[0].candidateRowIds, [7, 8]);
});

check('matchCgoEntries picks the right day when the board holds two flights with that number', () => {
  const duplicates = [
    { rowIdx: 7, FLIGHT: '320', DOF: '20260921', CGO: '' },
    { rowIdx: 8, FLIGHT: '320', DOF: '20260922', CGO: '' }
  ];
  const plan = parseCgoSheet([HEADER, ['QZ320', '22/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']]);
  const match = matchCgoEntries(plan.entries, duplicates);
  assert.equal(match.updates.length, 1);
  assert.equal(match.updates[0].rowIdx, 8);
  assert.equal(match.dateMismatches.length, 0);
});

check('matchCgoEntries lets the later plan line win and counts the duplicate', () => {
  const plan = parseCgoSheet([
    HEADER,
    ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', ''],
    ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2600', '', '']
  ]);
  const match = matchCgoEntries(plan.entries, board);
  assert.equal(match.updates.length, 1);
  assert.equal(match.updates[0].value, '2600');
  assert.equal(match.duplicates, 1);
});

check('summarizeCgoSync explains an unmatched flight to the operator', () => {
  const plan = parseCgoSheet([HEADER, ['QZ999', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']]);
  const lines = summarizeCgoSync(plan, matchCgoEntries(plan.entries, board)).join('\n');
  assert.match(lines, /Matched 0 of 1/);
  assert.match(lines, /Not on the board: 1 \(999\)/);
});

check('summarizeCgoSync states the snapshot age and warns when it is old', () => {
  const plan = parseCgoSheet([HEADER, ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']]);
  const match = matchCgoEntries(plan.entries, board);
  const fresh = summarizeCgoSync(plan, match, { sheetName: 'CGO PLAN', ageMinutes: 3 }).join('\n');
  assert.match(fresh, /"CGO PLAN" was read 3 minute\(s\) ago\./);
  assert.doesNotMatch(fresh, /WARNING/);
  const stale = summarizeCgoSync(plan, match, { sheetName: 'CGO PLAN', ageMinutes: 400 }).join('\n');
  assert.match(stale, /WARNING: that snapshot is over 2 hours old/);
});

// ---- Ingest endpoint ----

function statement(database, sql, parameters = []) {
  return {
    bind(...values) { return statement(database, sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

const SHEET = [
  HEADER,
  ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', ''],
  ['QZ321', '21/09/2026', 'KUL', 'SUB', '10:00', '12:00', '1800', '', ''],
  ['QZ646', '18/09/2026', 'WADD', 'WATO', '3:25', '4:40', '900', '950', '12:00'],
  ['QZ999', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '700', '', '']
];

const BRIDGE_URL = 'https://script.google.com/macros/s/AKfycbTestDeploymentId/exec';

async function makeEnv(role, { withMeta = true } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT NOT NULL, dep TEXT, dest TEXT, ac_type TEXT,
      etd DATETIME, eta DATETIME, alt TEXT, taf_dep TEXT, taf_arr TEXT, cgo TEXT,
      enr1 TEXT, enr2 TEXT, enr3 TEXT, atc TEXT, remarks TEXT, dof TEXT, active_route_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE aircraft (registration TEXT PRIMARY KEY);
    CREATE TABLE routes (id TEXT PRIMARY KEY, dep_airport TEXT, arr_airport TEXT, dep_rwy TEXT,
      sid TEXT, waypoint_seq TEXT, star TEXT, arr_rwy TEXT, route_string TEXT);
    CREATE TABLE latlong (id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT, waypoint TEXT,
      latitude REAL, longitude REAL, sequence_order INTEGER);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) { for (const prepared of statements) await prepared.run(); }
  };
  const authHeaders = await seedAuthUser(database, DB, role);
  const insert = database.prepare('INSERT INTO flights (callsign, dep, dest, dof, cgo, etd, eta) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('320', 'WADD', 'WMKK', '20260921', null, '2026-09-21T05:05:00.000Z', '2026-09-21T08:40:00.000Z');
  insert.run('321', 'WMKK', 'WADD', '20260921', '1800', '2026-09-21T10:00:00.000Z', '2026-09-21T12:00:00.000Z');
  insert.run('646', 'WADD', 'WATO', '20260917', null, '2026-09-17T03:25:00.000Z', '2026-09-17T04:40:00.000Z');

  return {
    DB,
    database,
    authHeaders,
    env: { DB, CGO_BRIDGE_TOKEN: 'tok_123', CGO_BRIDGE_URL: BRIDGE_URL }
  };
}

async function ingest(env, body, token = 'tok_123') {
  const request = new Request('http://localhost/api/cgo-ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AWQ-CGO-Token': token },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const response = await onCgoIngest({ request, env });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

function storedSnapshot(database) {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(CGO_SNAPSHOT_KEY);
  return row ? JSON.parse(row.value) : null;
}

function pushPayload(values = SHEET, extra = {}) {
  return { sheetId: 'sheet-1', sheetName: 'CGO PLAN', pushedAt: new Date().toISOString(), values, ...extra };
}

await checkAsync('ingest stores a valid push', async () => {
  const env = await makeEnv('registered');
  const result = await ingest(env.env, pushPayload());
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.rowCount, 5);
  assert.equal(result.body.entryCount, 4);
  const snapshot = storedSnapshot(env.database);
  assert.equal(snapshot.sheetName, 'CGO PLAN');
  assert.equal(snapshot.entryCount, 4);
  assert.equal(snapshot.values.length, 5);
});

await checkAsync('ingest refuses a wrong token', async () => {
  const env = await makeEnv('registered');
  const result = await ingest(env.env, pushPayload(), 'wrong');
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'unauthorized');
  assert.equal(storedSnapshot(env.database), null);
});

await checkAsync('ingest refuses when the shared secret is not configured', async () => {
  const env = await makeEnv('registered');
  const result = await ingest({ DB: env.DB }, pushPayload());
  assert.equal(result.status, 503);
  assert.match(result.body.error, /CGO_BRIDGE_TOKEN is not configured/);
});

await checkAsync('ingest refuses a body that is not JSON', async () => {
  const env = await makeEnv('registered');
  const result = await ingest(env.env, '<html>nope</html>');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /not JSON/);
});

await checkAsync('ingest refuses a body without a grid', async () => {
  const env = await makeEnv('registered');
  const result = await ingest(env.env, { sheetName: 'CGO PLAN' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /body\.values/);
});

await checkAsync('ingest refuses a sheet whose header moved, keeping the previous snapshot', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  const before = storedSnapshot(env.database);
  const result = await ingest(env.env, pushPayload([['notes only'], ['nothing here']]));
  assert.equal(result.status, 422);
  assert.match(result.body.error, /CGO PLAN header not found/);
  assert.deepEqual(storedSnapshot(env.database), before, 'the good snapshot survived');
});

await checkAsync('ingest refuses an oversized payload', async () => {
  const env = await makeEnv('registered');
  const result = await ingest(env.env, { values: [[ 'x'.repeat(1024 * 1024 + 10) ]] });
  assert.equal(result.status, 413);
  assert.match(result.body.error, /payload too large/);
});

await checkAsync('ingest drops non-array rows and stringifies cells', async () => {
  const env = await makeEnv('registered');
  const result = await ingest(env.env, pushPayload([HEADER, 'not a row', [1, 2, null, undefined, '', '', 2500, '', '']]));
  assert.equal(result.status, 200);
  assert.equal(result.body.rowCount, 2, 'the stray string row is dropped');
  const snapshot = storedSnapshot(env.database);
  assert.deepEqual(snapshot.values[1].slice(0, 3), ['1', '2', '']);
});

// ---- Push link for the LINKS menu ----

await checkAsync('getCgoPushUrl returns the token-bearing push URL to a signed-in session', async () => {
  const env = await makeEnv('readonly');
  const result = await rpc(env, 'getCgoPushUrl');
  assert.equal(result.status, 200);
  const url = new URL(result.data.url);
  assert.equal(url.hostname, 'script.google.com');
  assert.ok(url.pathname.endsWith('/exec'));
  assert.equal(url.searchParams.get('action'), 'push');
  assert.equal(url.searchParams.get('token'), 'tok_123');
});

await checkAsync('getCgoPushUrl refuses an anonymous caller, so the token never reaches the public page', async () => {
  const env = await makeEnv('registered');
  const result = await rpc(env, 'getCgoPushUrl', [], {});
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'AUTH_REQUIRED');
});

await checkAsync('getCgoPushUrl refuses a host that is not script.google.com', async () => {
  const env = await makeEnv('registered');
  env.env.CGO_BRIDGE_URL = 'https://evil.example.com/macros/s/x/exec';
  const result = await rpc(env, 'getCgoPushUrl');
  assert.equal(result.status, 503);
  assert.match(result.body.error, /must be the https:\/\/script\.google\.com/);
});

await checkAsync('getCgoPushUrl refuses a /dev URL and a non-URL', async () => {
  const env = await makeEnv('registered');
  env.env.CGO_BRIDGE_URL = 'https://script.google.com/macros/s/x/dev';
  const dev = await rpc(env, 'getCgoPushUrl');
  assert.equal(dev.status, 503);
  env.env.CGO_BRIDGE_URL = 'not a url';
  const broken = await rpc(env, 'getCgoPushUrl');
  assert.equal(broken.status, 503);
  assert.match(broken.body.error, /not a valid URL/);
});

await checkAsync('getCgoPushUrl explains a missing bridge URL or token', async () => {
  const env = await makeEnv('registered');
  env.env.CGO_BRIDGE_URL = '';
  const noUrl = await rpc(env, 'getCgoPushUrl');
  assert.equal(noUrl.status, 503);
  assert.match(noUrl.body.error, /set CGO_BRIDGE_URL/);
  env.env.CGO_BRIDGE_URL = BRIDGE_URL;
  env.env.CGO_BRIDGE_TOKEN = '';
  const noToken = await rpc(env, 'getCgoPushUrl');
  assert.equal(noToken.status, 503);
  assert.match(noToken.body.error, /CGO_BRIDGE_TOKEN secret/);
});

// ---- RPC path ----

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

await checkAsync('syncCgoData writes the plan weight onto the board flights', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  // The board holds flights 1 (320), 2 (321) and 3 (646). Flight 4 is not on the
  // board — its plan line (QZ999) must stay untouched.
  const result = await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  assert.equal(result.status, 200);
  const rows = env.database.prepare('SELECT id, callsign, cgo FROM flights ORDER BY id').all();
  assert.deepEqual(rows.map(row => [row.callsign, row.cgo]), [['320', '2500'], ['321', '1800'], ['646', '950']]);
  assert.equal(result.data.cgoSync.matched, 3);
  assert.equal(result.data.cgoSync.updated, 2, '321 was already 1800');
  assert.equal(result.data.cgoSync.unmatchedCount, 1);
  assert.equal(result.data.cgoSync.dateMismatchCount, 1);
  assert.equal(result.data.cgoSync.sheetName, 'CGO PLAN');
  assert.equal(result.data.cgoSync.updatedFlights.find(update => update.flight === '646').source, 'REVISE');
});

await checkAsync('syncCgoData leaves a flight alone when it is not on the board', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  const result = await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(result.status, 200);
  assert.equal(env.database.prepare('SELECT cgo FROM flights WHERE callsign = ?').get('321').cgo, '1800', 'flight 321 was not on the board');
  assert.equal(env.database.prepare('SELECT cgo FROM flights WHERE callsign = ?').get('646').cgo, null);
});

await checkAsync('syncCgoData refreshes the board payload the frontend re-renders from', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  const result = await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  assert.ok(Array.isArray(result.data.flights));
  assert.equal(result.data.flights.find(flight => flight.FLIGHT === '320').CGO, '2500');
  assert.ok(Array.isArray(result.data.cgoSync.summary) && result.data.cgoSync.summary.length > 0);
});

await checkAsync('syncCgoData tells the operator to push when no snapshot has arrived', async () => {
  const env = await makeEnv('registered');
  const result = await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'NO_SNAPSHOT');
  assert.match(result.body.error, /pushCgoPlan\(\)/);
});

await checkAsync('syncCgoData reports an unreadable snapshot instead of writing junk', async () => {
  const env = await makeEnv('registered');
  env.database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(CGO_SNAPSHOT_KEY, '{not json');
  const result = await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'SNAPSHOT_CORRUPT');
});

await checkAsync('syncCgoData warns the operator about a stale snapshot', async () => {
  const env = await makeEnv('registered');
  const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  await ingest(env.env, pushPayload(SHEET, { pushedAt: old }));
  const result = await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(result.status, 200);
  assert.ok(result.data.cgoSync.snapshotAgeMinutes >= 299);
  assert.ok(result.data.cgoSync.summary.some(line => /WARNING: that snapshot is over 2 hours old/.test(line)));
});

await checkAsync('syncCgoData refuses an empty board with an actionable message', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  const result = await rpc(env, 'syncCgoData', [[]]);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'BOARD_EMPTY');
  assert.match(result.body.error, /No flights are on the board/);
});

await checkAsync('syncCgoData requires the registered tier because it writes', async () => {
  const env = await makeEnv('readonly');
  await ingest(env.env, pushPayload());
  const result = await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'REGISTERED_REQUIRED');
  assert.equal(env.database.prepare('SELECT cgo FROM flights WHERE id = 1').get().cgo, null);
});

await checkAsync('syncCgoData requires a CSRF token', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  const { 'X-AWQ-CSRF': _csrf, ...withoutCsrf } = env.authHeaders;
  const result = await rpc(env, 'syncCgoData', [[1]], withoutCsrf);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CSRF_INVALID');
});

await checkAsync('syncCgoData records an audit entry for the sync', async () => {
  const env = await makeEnv('registered');
  await ingest(env.env, pushPayload());
  await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  const entry = env.database.prepare("SELECT action, result, change_summary AS summary FROM auth_audit_log WHERE action = 'cgo_sync'").get();
  assert.ok(entry, 'cgo_sync was audited');
  assert.equal(entry.result, 'success');
  assert.match(entry.summary, /"updated":2/);
});

console.log(failures ? `\nCGO sync: ${failures} pemeriksaan GAGAL` : '\nCGO sync: semua pemeriksaan lolos');
process.exit(failures ? 1 : 0);
