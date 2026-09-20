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

// Registry + WAYPOINT database. The marker on the route page is
// "does a latlong row exist whose route_id matches this routes.id", so both
// tables have to be present for the join to be exercised.
async function createScenario(role = 'admin') {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE routes (
      id TEXT PRIMARY KEY, dep_airport TEXT, arr_airport TEXT, dep_rwy TEXT, sid TEXT,
      waypoint_seq TEXT, star TEXT, arr_rwy TEXT, route_string TEXT
    );
    CREATE TABLE latlong (
      id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT, waypoint TEXT,
      latitude TEXT, longitude TEXT, sequence_order INTEGER
    );
    CREATE TABLE flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT NOT NULL, dep TEXT, dest TEXT,
      ac_type TEXT, etd TEXT, eta TEXT, alt TEXT, taf_dep TEXT, taf_arr TEXT, cgo TEXT,
      enr1 TEXT, enr2 TEXT, enr3 TEXT, atc TEXT, remarks TEXT, dof TEXT, active_route_id TEXT
    );
    CREATE TABLE aircraft (id INTEGER PRIMARY KEY AUTOINCREMENT, registration TEXT UNIQUE NOT NULL);

    INSERT INTO routes (id, dep_airport, arr_airport, dep_rwy, sid, waypoint_seq, star, arr_rwy, route_string) VALUES
      ('WIIIWADD01', 'WIII', 'WADD', '07L', 'DOLTA', 'DOLTA A585', 'MAMAD', '09', 'WIII RWY-07L DOLTA DOLTA A585 MAMAD RWY-09 WADD'),
      ('WADDWSSS01', 'WADD', 'WSSS', '09', 'MAMAD', 'MAMAD', 'BITAK', '20C', 'WADD RWY-09 MAMAD MAMAD BITAK RWY-20C WSSS'),
      ('WIIIWMKK01', 'WIII', 'WMKK', '', '', '', '', '', 'WIII RWY-  RWY- WMKK');

    INSERT INTO latlong (route_id, waypoint, latitude, longitude, sequence_order) VALUES
      ('  wiiiwadd01 ', 'DOLTA', 'S 06 00.0', 'E 107 00.0', 1),
      ('WIIIWADD01', 'MAMAD', 'S 08 44.8', 'E 115 10.2', 2),
      ('ORPHAN-ROUTE', 'XXXX', 'N 01 00.0', 'E 100 00.0', 1),
      ('', 'YYYY', 'N 02 00.0', 'E 101 00.0', 1),
      ('   ', 'ZZZZ', 'N 03 00.0', 'E 102 00.0', 1);

    INSERT INTO flights (callsign, dep, dest) VALUES ('QZ646', 'WADD', 'WSSS'), ('QZ647', 'WIII', 'WADD');
  `);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) {
      for (const prepared of statements) await prepared.run();
    }
  };
  const authHeaders = await seedAuthUser(database, DB, role);
  async function rpc(method, args = [], headers = authHeaders) {
    const response = await onRequestPost({
      env: { DB },
      request: new Request('http://localhost/api/rpc', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ method, args })
      })
    });
    return { status: response.status, ...await response.json() };
  }
  return { database, DB, rpc };
}

const scenario = await createScenario('admin');
try {
  const response = await scenario.rpc('getAllRoutes');
  assert.equal(response.status, 200, JSON.stringify(response));
  const byId = Object.fromEntries(response.data.map(route => [route.ID, route]));

  assert.equal(byId.WIIIWADD01.WAYPOINT_COUNT, 2, 'case and surrounding spaces in latlong.route_id must still match');
  assert.equal(byId.WADDWSSS01.WAYPOINT_COUNT, 0, 'a route with no latlong rows is 0, not undefined');
  assert.equal(byId.WIIIWMKK01.WAYPOINT_COUNT, 0);
  assert.equal(
    response.data.reduce((total, route) => total + route.WAYPOINT_COUNT, 0),
    2,
    'orphan and blank route_id rows must not be credited to any registry route'
  );
  assert.equal(byId.WIIIWADD01.WAYPOINT_SEQ, 'DOLTA A585', 'the new count must not disturb existing route fields');

  // Selector route di Flight Board membaca route dari dashboard payload. Angkanya
  // harus sama persis dengan halaman ROUTE — dua sumber, satu kebenaran.
  const dashboard = await scenario.rpc('getFlightDashboardData');
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard));
  const withWaypoints = dashboard.data.flights.find(f => f.FLIGHT === 'QZ647').ROUTES.find(r => r.ID === 'WIIIWADD01');
  const withoutWaypoints = dashboard.data.flights.find(f => f.FLIGHT === 'QZ646').ROUTES.find(r => r.ID === 'WADDWSSS01');
  assert.equal(withWaypoints.WAYPOINT_COUNT, byId.WIIIWADD01.WAYPOINT_COUNT, 'dashboard dan getAllRoutes harus sepakat');
  assert.equal(withoutWaypoints.WAYPOINT_COUNT, 0, 'route tanpa koordinat harus terbaca 0 di selector, bukan undefined');
} finally {
  scenario.database.close();
}

// Non-admin operators read the route page too, so the marker cannot depend on
// an admin-only RPC.
const viewer = await createScenario('readonly');
try {
  const response = await viewer.rpc('getAllRoutes');
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.find(route => route.ID === 'WIIIWADD01').WAYPOINT_COUNT, 2);
} finally {
  viewer.database.close();
}

// Saving a route from the Flight modal repaints the route page from its own
// response payload. If that payload forgets the count, every card would fall
// back to the neutral "unknown" badge right after a save.
const saver = await createScenario('registered');
try {
  const response = await saver.rpc('saveFlightRoute', [{
    ID: 'WIIIWADD01',
    DEP_AIRPORT: 'WIII',
    ARR_AIRPORT: 'WADD',
    DEP_RWY: '07R',
    SID: 'DOLTA',
    WAYPOINT_SEQ: 'DOLTA A585',
    STAR: 'MAMAD',
    ARR_RWY: '09'
  }]);
  assert.equal(response.status, 200, JSON.stringify(response));
  const saved = response.data.allRoutes.find(route => route.ID === 'WIIIWADD01');
  assert.equal(saved.WAYPOINT_COUNT, 2, 'saveFlightRoute must return the same waypoint marker as getAllRoutes');
  assert.equal(saved.DEP_RWY, '07R', 'the save must still persist and echo the edited runway');
  assert.equal(
    response.data.allRoutes.find(route => route.ID === 'WADDWSSS01').WAYPOINT_COUNT,
    0,
    'counting must stay per route, not registry-wide'
  );
} finally {
  saver.database.close();
}

console.log('Route waypoint-registration marker counts per profile, survives save, and is readable by non-admins.');
