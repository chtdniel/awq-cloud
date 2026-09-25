import assert from 'node:assert/strict';
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

function statement(database, sql, parameters = []) {
  return {
    bind(...values) { return statement(database, sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}

function createScenario() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT NOT NULL, dep TEXT, dest TEXT,
      ac_type TEXT, etd TEXT, eta TEXT, alt TEXT, taf_dep TEXT, taf_arr TEXT, cgo TEXT,
      enr1 TEXT, enr2 TEXT, enr3 TEXT, atc TEXT, remarks TEXT, dof TEXT, active_route_id TEXT
    );
    CREATE TABLE routes (
      id TEXT PRIMARY KEY, dep_airport TEXT, arr_airport TEXT, dep_rwy TEXT, sid TEXT,
      waypoint_seq TEXT, star TEXT, arr_rwy TEXT, route_string TEXT
    );
    CREATE TABLE latlong (
      id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT, waypoint TEXT,
      latitude TEXT, longitude TEXT, sequence_order INTEGER
    );
    CREATE TABLE aircraft (id INTEGER PRIMARY KEY AUTOINCREMENT, registration TEXT UNIQUE NOT NULL);
    INSERT INTO aircraft (registration) VALUES ('PK-AZS');
  `);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) {
      for (const prepared of statements) await prepared.run();
    }
  };
  return { database, DB };
}

async function rpc(DB, authHeaders, method, args) {
  const response = await onRequestPost({
    env: { DB },
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ method, args })
    })
  });
  return { status: response.status, body: await response.json() };
}

const { database, DB } = createScenario();
try {
  const authHeaders = await seedAuthUser(database, DB, 'registered');
  const added = await rpc(DB, authHeaders, 'addNewFlightToDb', [{
    FLT_NO: '819',
    DOF: '2026-09-25',
    DEP: 'WADD',
    ARR: 'WIII',
    STD: '08:20',
    STA: '10:10',
    REG: 'PK-AZS',
    ALT: 'WILL',
    ATC: '0',
    TAF_DEP: '',
    TAF_ARR: '',
    CGO: '',
    REMARK: ''
  }]);

  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.data.addedRowId, 1);
  const row = database.prepare('SELECT callsign, dof, etd, eta FROM flights WHERE callsign = ?').get('819');
  assert.deepEqual({ ...row }, { callsign: '819', dof: '20260925', etd: '08:20', eta: '10:10' });
  assert.equal(added.body.data.flights.find(f => f.FLIGHT === '819').STD, '08:20');

  const invalid = await rpc(DB, authHeaders, 'addNewFlightToDb', [{
    FLT_NO: '820',
    DOF: '25/09/2026',
    DEP: 'WADD',
    ARR: 'WIII',
    STD: '25:20',
    STA: '10:10'
  }]);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /DOF invalid|STD invalid/);

  const invalidCalendar = await rpc(DB, authHeaders, 'addNewFlightToDb', [{
    FLT_NO: '821',
    DOF: '2026-02-31',
    DEP: 'WADD',
    ARR: 'WIII',
    STD: '08:20',
    STA: '10:10'
  }]);
  assert.equal(invalidCalendar.status, 400);
  assert.match(invalidCalendar.body.error, /DOF invalid/);

  const duplicate = await rpc(DB, authHeaders, 'addNewFlightToDb', [{
    FLT_NO: '819',
    DOF: '20260925',
    DEP: 'WADD',
    ARR: 'WIII',
    STD: '08:20',
    STA: '10:10'
  }]);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE_FLIGHT');

  const inlineInvalidTime = await rpc(DB, authHeaders, 'saveFlightEdit', [1, 4, '2026Z']);
  assert.equal(inlineInvalidTime.status, 400);
  assert.match(inlineInvalidTime.body.error, /STD invalid/);
  assert.equal(database.prepare('SELECT etd FROM flights WHERE id = 1').get().etd, '08:20');

  const inlineInvalidDof = await rpc(DB, authHeaders, 'saveFlightEdit', [1, 16, '20260231']);
  assert.equal(inlineInvalidDof.status, 400);
  assert.match(inlineInvalidDof.body.error, /DOF invalid/);
  assert.equal(database.prepare('SELECT dof FROM flights WHERE id = 1').get().dof, '20260925');
} finally {
  database.close();
}

console.log('Manual flight injection accepts browser date/time input and stores normalized flight rows.');
