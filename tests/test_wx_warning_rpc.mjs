// WX WARNING RPC integration tests.
//
// Runs the real functions/api/rpc.js against a real SQLite database (node:sqlite)
// with the real migration applied, so this covers what unit tests cannot:
//   * the 30-column INSERT ... ON CONFLICT against migrations/013_wx_warnings.sql
//   * dedupe of a re-pasted product and the shared/manual row split
//   * the route resolved from flights/routes/latlong plus the per-warning
//     "affects route" flags at different corridor buffers
//   * tier + CSRF gating on the manual write/delete methods
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({
  entryPoints: ['functions/api/rpc.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { onRequestPost } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

const MIGRATION = readFileSync('migrations/013_wx_warnings.sql', 'utf8');

const JTWC_DUJUAN = `WTPN31 PGTW 202100
SUBJ/TROPICAL STORM 24W (DUJUAN) WARNING NR 022//
RMKS/
   WARNING POSITION:
   201800Z --- NEAR 31.3N 137.9E
     MOVEMENT PAST SIX HOURS - 020 DEGREES AT 11 KTS
   PRESENT WIND DISTRIBUTION:
   MAX SUSTAINED WINDS - 060 KT, GUSTS 075 KT
   RADIUS OF 034 KT WINDS - 200 NM NORTHEAST QUADRANT
                            170 NM SOUTHEAST QUADRANT
                            160 NM SOUTHWEST QUADRANT
                            200 NM NORTHWEST QUADRANT
   FORECASTS:
   12 HRS, VALID AT:
   210600Z --- 33.5N 139.9E
   MAX SUSTAINED WINDS - 065 KT, GUSTS 080 KT
REMARKS:
MINIMUM CENTRAL PRESSURE AT 201800Z IS 976 MB.//
NNNN`;

// Darwin VAAC ash cloud over east Java; the flight route below crosses it.
const VAA_SEMERU = `FVAU02 ADRM 201550
VA ADVISORY
DTG: 20260920/1550Z
VAAC: DARWIN
VOLCANO: SEMERU 263300
PSN: S0806 E11255
AREA: INDONESIA
ADVISORY NR: 2026/1078
EST VA CLD: SFC/FL150 S0808 E11253 - S0803 E11253 - S0755
E11319 - S0805 E11325 - S0817 E11318 MOV E 15KT
NXT ADVISORY: NO LATER THAN 20260920/2150Z=`;

const BLOB = `${JTWC_DUJUAN}\n\n-----------------\n\n${VAA_SEMERU}\n`;

function statement(database, sql, parameters = []) {
  return {
    bind(...values) { return statement(database, sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

// seedAuthUser creates the auth tables with plain CREATE TABLE, so it can only
// run once per database: seed on scenario creation and reuse the session/CSRF
// headers for every call in that scenario.
async function createScenario(role = 'registered') {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT NOT NULL, dep TEXT, dest TEXT,
      ac_type TEXT, etd TEXT, eta TEXT, alt TEXT, dof TEXT, active_route_id TEXT
    );
    CREATE TABLE routes (
      id TEXT PRIMARY KEY, dep_airport TEXT, arr_airport TEXT, dep_rwy TEXT, sid TEXT,
      waypoint_seq TEXT, star TEXT, arr_rwy TEXT, route_string TEXT
    );
    CREATE TABLE latlong (
      id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT, waypoint TEXT, latitude TEXT,
      longitude TEXT, sequence_order INTEGER
    );
    CREATE TABLE user_profiles (
      user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT, updated_at TEXT
    );
    -- Jakarta -> Denpasar: crosses the Semeru ash cloud.
    INSERT INTO flights (callsign, dep, dest, alt, dof, etd, eta, active_route_id)
      VALUES ('QZ100', 'WIII', 'WADD', 'WADD', '20260920', '2026-09-20T22:00:00.000Z', '2026-09-21T01:00:00.000Z', 'WIIIWADD10');
    -- Jakarta -> Kota Kinabalu: stays well north of Java.
    INSERT INTO flights (callsign, dep, dest, alt, dof, etd, eta, active_route_id)
      VALUES ('QZ200', 'WIII', 'WBKK', '', '20260920', '2026-09-20T22:00:00.000Z', '2026-09-21T00:30:00.000Z', 'WIIIWBKK10');
    INSERT INTO routes (id, dep_airport, arr_airport, waypoint_seq) VALUES
      ('WIIIWADD10', 'WIII', 'WADD', 'WIII DOLTA 0800S11200E WADD'),
      ('WIIIWBKK10', 'WIII', 'WBKK', 'WIII 0000N10800E WBKK');
    INSERT INTO latlong (route_id, waypoint, latitude, longitude, sequence_order) VALUES
      ('WIIIWADD10', 'WIII', 'S 06 07.5', 'E 106 39.3', 1),
      ('WIIIWADD10', 'DOLTA', 'S 08 00.0', 'E 112 00.0', 2),
      ('WIIIWADD10', 'WADD', 'S 08 44.9', 'E 115 10.0', 3),
      ('WIIIWBKK10', 'WIII', 'S 06 07.5', 'E 106 39.3', 1),
      ('WIIIWBKK10', 'WBKK', 'N 05 56.2', 'E 116 03.1', 2);
  `);
  database.exec(MIGRATION);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) {
      for (const prepared of statements) await prepared.run();
    }
  };
  const authHeaders = await seedAuthUser(database, DB, role);
  return { database, DB, role, authHeaders };
}

async function callRpc(scenario, method, args, { headers = {} } = {}) {
  const response = await onRequestPost({
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        ...scenario.authHeaders,
        ...headers
      },
      body: JSON.stringify({ method, args })
    }),
    env: { DB: scenario.DB }
  });
  return { status: response.status, body: await response.json() };
}

function rowCount(database, where = '1=1') {
  return database.prepare(`SELECT COUNT(*) AS n FROM wx_warnings WHERE ${where}`).get().n;
}

test('getWxWarningData on a fresh database reports an empty, stale overlay', async () => {
  const scenario = await createScenario();
  const { status, body } = await callRpc(scenario, 'getWxWarningData', [1, 50]);
  assert.equal(status, 200);
  assert.deepEqual(body.data.warnings, []);
  assert.equal(body.data.fetchedAt, null);
  assert.equal(body.data.stale, true);
  assert.deepEqual(body.data.counts, { TC: 0, VA: 0, manual: 0, affecting: 0 });
  assert.equal(body.data.route.callsign, 'QZ100');
  assert.equal(body.data.route.coords.length, 3);
  scenario.database.close();
});

test('parseWxWarningManual reports both pasted products with mappable geometry', async () => {
  const scenario = await createScenario();
  const { status, body } = await callRpc(scenario, 'parseWxWarningManual', [BLOB]);
  assert.equal(status, 200);
  const [tc, va] = body.data.products;
  assert.equal(tc.kind, 'TC');
  assert.equal(tc.ok, true);
  assert.equal(tc.warning.title, 'TROPICAL STORM 24W (DUJUAN) WARNING NR 022');
  assert.equal(tc.warning.track.length, 2);
  assert.equal(va.kind, 'VA');
  assert.equal(va.warning.volcano.name, 'SEMERU');
  assert.equal(va.warning.geojson.length, 1);
  assert.equal(va.warning.geojson[0].geometry.type, 'Polygon');
  assert.equal(rowCount(scenario.database), 0, 'a preview must not persist anything');
  scenario.database.close();
});

test('parseWxWarningManual refuses empty and unrecognised input', async () => {
  const scenario = await createScenario();
  const empty = await callRpc(scenario, 'parseWxWarningManual', ['   ']);
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Paste at least one product/);

  const junk = await callRpc(scenario, 'parseWxWarningManual', ['just some notes, no product here']);
  assert.equal(junk.status, 200);
  assert.equal(junk.body.data.ok, false);
  assert.match(junk.body.data.products[0].reason, /Unrecognised/);
  scenario.database.close();
});

test('saveWxWarningManual stores shared rows, and a re-paste updates them in place', async () => {
  const scenario = await createScenario();
  const first = await callRpc(scenario, 'saveWxWarningManual', [BLOB]);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.saved, 2);
  assert.equal(first.body.data.skipped, 0);
  assert.equal(first.body.data.by, 'tester@example.com');
  assert.equal(rowCount(scenario.database, "is_manual = 1 AND source = 'MANUAL'"), 2);

  // Same text again: identity is the product fingerprint, so this updates.
  const again = await callRpc(scenario, 'saveWxWarningManual', [`${BLOB}\n\n`]);
  assert.equal(again.status, 200);
  assert.equal(rowCount(scenario.database), 2, 're-pasting the same products must not clone rows');

  const stored = await callRpc(scenario, 'getWxWarningData', [null, 50]);
  assert.equal(stored.body.data.warnings.length, 2);
  assert.ok(stored.body.data.warnings.every(warning => warning.isManual && warning.source === 'MANUAL'));
  assert.ok(stored.body.data.warnings.some(warning => warning.parseNotes.includes('OPERATOR PASTE')));
  assert.equal(stored.body.data.counts.manual, 2);
  assert.equal(stored.body.data.stale, true, 'manual rows alone never make the feed "fresh"');
  scenario.database.close();
});

test('saveWxWarningManual refuses an unparseable paste instead of storing a half-hazard', async () => {
  const scenario = await createScenario();
  const { status, body } = await callRpc(scenario, 'saveWxWarningManual', ['WTPN31 PGTW 202100\nno position here']);
  assert.equal(status, 400);
  assert.equal(body.code, 'WX_WARNING_UNPARSED');
  assert.equal(rowCount(scenario.database), 0);
  scenario.database.close();
});

test('route hits follow the selected flight and the corridor buffer', async () => {
  const scenario = await createScenario();
  await callRpc(scenario, 'saveWxWarningManual', [BLOB]);

  // QZ100 flies straight across the ash cloud; QZ200 heads north to Borneo.
  const crossing = await callRpc(scenario, 'getWxWarningData', [1, 50]);
  const vaRow = crossing.body.data.warnings.find(warning => warning.kind === 'VA');
  assert.equal(crossing.body.data.hits[String(vaRow.id)].hit, true);
  assert.ok(crossing.body.data.hits[String(vaRow.id)].nm <= 10);
  assert.equal(crossing.body.data.counts.affecting >= 1, true);

  const northbound = await callRpc(scenario, 'getWxWarningData', [2, 50]);
  assert.equal(northbound.body.data.route.callsign, 'QZ200');
  const vaNorth = northbound.body.data.warnings.find(warning => warning.kind === 'VA');
  assert.equal(northbound.body.data.hits[String(vaNorth.id)].hit, false);
  assert.ok(northbound.body.data.hits[String(vaNorth.id)].nm > 300);

  // The buffer is clamped to a sane range rather than trusting the client.
  const huge = await callRpc(scenario, 'getWxWarningData', [2, 100000]);
  assert.equal(huge.body.data.bufferNm, 200);
  scenario.database.close();
});

test('a stale route id falls back to DEP/ARR; an unroutable flight reports the absence', async () => {
  const scenario = await createScenario();
  await callRpc(scenario, 'saveWxWarningManual', [VAA_SEMERU]);

  // Stale ACTIVE_ROUTE_ID: the DEP/ARR pair still resolves the route, which is
  // the documented FIR behaviour and what the map must draw.
  scenario.database.prepare("UPDATE flights SET active_route_id = 'NOPE' WHERE id = 2").run();
  const fallback = await callRpc(scenario, 'getWxWarningData', [2, 50]);
  assert.equal(fallback.body.data.route.routeId, 'WIIIWBKK10');
  assert.equal(fallback.body.data.route.coords.length, 3, 'WIII, the inline fix and WBKK');

  // No route exists for this city pair: report NO ROUTE rather than "clear".
  scenario.database.prepare("UPDATE flights SET dest = 'VVTS' WHERE id = 2").run();
  const { body } = await callRpc(scenario, 'getWxWarningData', [2, 50]);
  assert.deepEqual(body.data.route.coords, []);
  const [warning] = body.data.warnings;
  assert.deepEqual(body.data.hits[String(warning.id)], { nm: null, hit: false, reason: 'NO ROUTE' });
  scenario.database.close();
});

test('manual entries can be deleted one by one or cleared, and only manual ones', async () => {
  const scenario = await createScenario();
  await callRpc(scenario, 'saveWxWarningManual', [BLOB]);
  // An ingested row that must survive the cleanup paths below.
  scenario.database.prepare(`INSERT INTO wx_warnings
    (source, external_id, kind, title, dtg, fetched_at, is_manual, polygons_json, track_json, parse_notes)
    VALUES ('JTWC', 'WTPN31:022:x', 'TC', 'INGESTED STORM', '2026-09-20T21:00:00.000Z', '2026-09-20T21:05:00.000Z', 0, '[]', '[]', '[]')`).run();

  const ids = scenario.database.prepare('SELECT id FROM wx_warnings WHERE is_manual = 1 ORDER BY id').all().map(row => row.id);
  const one = await callRpc(scenario, 'deleteWxWarningManual', [ids[0]]);
  assert.equal(one.status, 200);
  assert.equal(one.body.data.deleted, 1);
  assert.equal(rowCount(scenario.database, 'is_manual = 1'), 1);

  const missing = await callRpc(scenario, 'deleteWxWarningManual', [ids[0]]);
  assert.equal(missing.status, 404);

  const invalid = await callRpc(scenario, 'deleteWxWarningManual', ['abc']);
  assert.equal(invalid.status, 400);

  const cleared = await callRpc(scenario, 'deleteWxWarningManual', ['ALL']);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.scope, 'ALL');
  assert.equal(rowCount(scenario.database, 'is_manual = 1'), 0);
  assert.equal(rowCount(scenario.database, "source = 'JTWC'"), 1, 'ingested rows must survive a manual clear');
  scenario.database.close();
});

test('manual writes are gated: registered tier and CSRF are required', async () => {
  const scenario = await createScenario('viewer');
  const denied = await callRpc(scenario, 'saveWxWarningManual', [BLOB], { role: 'viewer' });
  assert.equal(denied.status, 403);
  assert.equal(rowCount(scenario.database), 0);

  const noCsrf = await callRpc(scenario, 'saveWxWarningManual', [BLOB], { headers: { 'X-AWQ-CSRF': 'bogus' } });
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.body.error, /CSRF/);
  assert.equal(rowCount(scenario.database), 0);
  scenario.database.close();
});

test('the audit trail records who pasted and who deleted', async () => {
  const scenario = await createScenario();
  await callRpc(scenario, 'saveWxWarningManual', [VAA_SEMERU]);
  await callRpc(scenario, 'deleteWxWarningManual', ['ALL']);
  const actions = scenario.database.prepare('SELECT action, result FROM auth_audit_log ORDER BY id').all().map(row => row.action);
  assert.ok(actions.includes('wx_warning_manual_save'));
  assert.ok(actions.includes('wx_warning_manual_clear'));
  scenario.database.close();
});
