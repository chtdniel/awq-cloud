// Sync CGO Data: sheet parsing, board matching, the Apps Script bridge client,
// and the full RPC path against a stubbed bridge.
//
// The real functions/api/rpc.js is bundled, so these assertions run the same
// guards the deployed Worker runs — including the tier and CSRF rules that apply
// because the sync writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { matchCgoEntries, normalizeCgoValue, normalizeFlightNo, parseCgoSheet, parseSheetDate, summarizeCgoSync } from '../shared/cgo.mjs';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

// functions/api/*.js is ESM for Cloudflare Pages Functions, but this package is
// "type": "commonjs", so Node would read it as CommonJS. Load it the same way
// rpc_auth_fixture.mjs loads auth.js — possible because cgo-bridge.js has no
// relative imports of its own.
const bridgeSource = await readFile(new URL('../functions/api/cgo-bridge.js', import.meta.url), 'utf8');
const { readBridgeValues, sanitizeBridgeUrl } = await import(
  'data:text/javascript;base64,' + Buffer.from(bridgeSource).toString('base64')
);

const bridgeBundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bridgeBundle.outputFiles[0].text).toString('base64'));

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

// ---- Apps Script bridge client ----

const BRIDGE_URL = 'https://script.google.com/macros/s/AKfycbTestBridgeDeploymentId/exec';

function bridgeResponse(payload, { asHtml = false } = {}) {
  return new Response(asHtml ? '<!DOCTYPE html><html>Sign in</html>' : JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': asHtml ? 'text/html' : 'application/json' }
  });
}

check('sanitizeBridgeUrl only accepts an https script.google.com /exec URL', () => {
  assert.equal(sanitizeBridgeUrl(BRIDGE_URL).hostname, 'script.google.com');
  assert.throws(() => sanitizeBridgeUrl(''), /CGO_BRIDGE_URL variable/);
  assert.throws(() => sanitizeBridgeUrl('not a url'), /not a valid URL/);
  assert.throws(() => sanitizeBridgeUrl('http://script.google.com/macros/s/x/exec'), /must be an https URL/);
  assert.throws(() => sanitizeBridgeUrl('https://evil.example.com/macros/s/x/exec'), /must point at script\.google\.com/);
  assert.throws(() => sanitizeBridgeUrl('https://script.google.com/macros/s/x/dev'), /\/exec deployment URL/);
});

await checkAsync('readBridgeValues sends the token and returns the sheet grid', async () => {
  const seen = [];
  const result = await readBridgeValues({ CGO_BRIDGE_URL: BRIDGE_URL, CGO_BRIDGE_TOKEN: 'tok_123' }, {
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return bridgeResponse({ ok: true, sheetName: 'CGO', readAt: '2026-09-21T00:00:00.000Z', values: [HEADER, ['QZ320', '21/09/2026', 'SUB', 'KUL', '5:05', '8:40', '2500', '', '']] });
    }
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.includes('token=tok_123'), 'the token is sent');
  assert.equal(seen[0].options.redirect, 'follow');
  assert.equal(result.sheetName, 'CGO');
  assert.equal(result.values.length, 2);
});

await checkAsync('readBridgeValues explains a missing bridge URL', async () => {
  await assert.rejects(readBridgeValues({}, { fetchImpl: async () => bridgeResponse({ ok: true }) }), /CGO_BRIDGE_URL variable/);
});

await checkAsync('readBridgeValues explains a missing token', async () => {
  await assert.rejects(
    readBridgeValues({ CGO_BRIDGE_URL: BRIDGE_URL }, { fetchImpl: async () => bridgeResponse({ ok: true }) }),
    /CGO_BRIDGE_TOKEN secret/
  );
});

await checkAsync('readBridgeValues explains a deployment that is not public', async () => {
  await assert.rejects(
    readBridgeValues({ CGO_BRIDGE_URL: BRIDGE_URL, CGO_BRIDGE_TOKEN: 'tok' }, { fetchImpl: async () => bridgeResponse({}, { asHtml: true }) }),
    /did not return JSON.*Who has access: Anyone/s
  );
});

await checkAsync('readBridgeValues names the token mismatch', async () => {
  await assert.rejects(
    readBridgeValues({ CGO_BRIDGE_URL: BRIDGE_URL, CGO_BRIDGE_TOKEN: 'wrong' }, { fetchImpl: async () => bridgeResponse({ ok: false, error: 'unauthorized' }) }),
    /CGO_BRIDGE_TOKEN must match CGO_BRIDGE_TOKEN in the Apps Script project properties/
  );
});

await checkAsync('readBridgeValues relays a bridge-side read failure', async () => {
  await assert.rejects(
    readBridgeValues({ CGO_BRIDGE_URL: BRIDGE_URL, CGO_BRIDGE_TOKEN: 'tok' }, { fetchImpl: async () => bridgeResponse({ ok: false, error: 'No item with the given ID could be found' }) }),
    /could not read the sheet: No item with the given ID/
  );
});

await checkAsync('readBridgeValues rejects a response that carries no grid', async () => {
  await assert.rejects(
    readBridgeValues({ CGO_BRIDGE_URL: BRIDGE_URL, CGO_BRIDGE_TOKEN: 'tok' }, { fetchImpl: async () => bridgeResponse({ ok: true }) }),
    /returned no sheet values/
  );
});

// ---- RPC path ----

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

async function makeEnv(role, { sheetValues = SHEET, bridge = null } = {}) {
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

  const calls = [];
  const fetchImpl = bridge || (async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return bridgeResponse({ ok: true, sheetName: 'CGO PLAN', readAt: '2026-09-21T00:00:00.000Z', values: sheetValues });
  });

  return {
    DB,
    database,
    authHeaders,
    calls,
    fetchImpl,
    env: { DB, CGO_BRIDGE_URL: BRIDGE_URL, CGO_BRIDGE_TOKEN: 'tok_123' }
  };
}

async function rpc(handle, method, args = [], headers = handle.authHeaders, fetchImpl = handle.fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const request = new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ method, args })
    });
    const response = await onRequestPost({ request, env: handle.env });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body, data: body && body.data };
  } finally {
    globalThis.fetch = original;
  }
}

await checkAsync('syncCgoData writes the plan weight onto the board flights', async () => {
  const env = await makeEnv('registered');
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
  const result = await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(result.status, 200);
  assert.equal(env.database.prepare('SELECT cgo FROM flights WHERE callsign = ?').get('321').cgo, '1800', 'flight 321 was not on the board');
  assert.equal(env.database.prepare('SELECT cgo FROM flights WHERE callsign = ?').get('646').cgo, null);
});

await checkAsync('syncCgoData refreshes the board payload the frontend re-renders from', async () => {
  const env = await makeEnv('registered');
  const result = await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  assert.ok(Array.isArray(result.data.flights));
  assert.equal(result.data.flights.find(flight => flight.FLIGHT === '320').CGO, '2500');
  assert.ok(Array.isArray(result.data.cgoSync.summary) && result.data.cgoSync.summary.length > 0);
});

await checkAsync('syncCgoData refuses an empty board with an actionable message', async () => {
  const env = await makeEnv('registered');
  const result = await rpc(env, 'syncCgoData', [[]]);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'BOARD_EMPTY');
  assert.match(result.body.error, /No flights are on the board/);
});

await checkAsync('syncCgoData reports a sheet whose header moved rather than writing nothing', async () => {
  const env = await makeEnv('registered', { sheetValues: [['notes only'], ['nothing here']] });
  const result = await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'SHEET_LAYOUT');
});

await checkAsync('syncCgoData requires the registered tier because it writes', async () => {
  const env = await makeEnv('readonly');
  const result = await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'REGISTERED_REQUIRED');
  assert.equal(env.database.prepare('SELECT cgo FROM flights WHERE id = 1').get().cgo, null);
});

await checkAsync('syncCgoData requires a CSRF token', async () => {
  const env = await makeEnv('registered');
  const { 'X-AWQ-CSRF': _csrf, ...withoutCsrf } = env.authHeaders;
  const result = await rpc(env, 'syncCgoData', [[1]], withoutCsrf);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CSRF_INVALID');
});

await checkAsync('syncCgoData surfaces an unconfigured bridge as an actionable error', async () => {
  const env = await makeEnv('registered');
  env.env.CGO_BRIDGE_URL = '';
  const result = await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(result.status, 500);
  assert.match(result.body.error, /CGO_BRIDGE_URL variable/);
});

await checkAsync('syncCgoData reads the sheet through the bridge', async () => {
  const env = await makeEnv('registered');
  await rpc(env, 'syncCgoData', [[1]]);
  assert.equal(env.calls.length, 1, 'exactly one bridge call');
  assert.ok(env.calls[0].url.startsWith(BRIDGE_URL), 'calls the configured bridge');
  assert.ok(env.calls[0].url.includes('token=tok_123'), 'authenticates with the secret');
});

await checkAsync('syncCgoData records an audit entry for the sync', async () => {
  const env = await makeEnv('registered');
  await rpc(env, 'syncCgoData', [[1, 2, 3]]);
  const entry = env.database.prepare("SELECT action, result, change_summary AS summary FROM auth_audit_log WHERE action = 'cgo_sync'").get();
  assert.ok(entry, 'cgo_sync was audited');
  assert.equal(entry.result, 'success');
  assert.match(entry.summary, /"updated":2/);
});

console.log(failures ? `\nCGO sync: ${failures} pemeriksaan GAGAL` : '\nCGO sync: semua pemeriksaan lolos');
process.exit(failures ? 1 : 0);
