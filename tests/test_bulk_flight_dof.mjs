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
    CREATE TABLE aircraft (id INTEGER PRIMARY KEY AUTOINCREMENT, registration TEXT UNIQUE NOT NULL);
    INSERT INTO flights (callsign, dep, dest, dof) VALUES ('QZ123', 'WIII', 'WADD', '20260914');
  `);
  const DB = {
    prepare: (sql, parameters) => statement(database, sql, parameters),
    async batch(statements) {
      for (const prepared of statements) await prepared.run();
    }
  };
  return { database, DB };
}

async function updateDof(rawDof) {
  const { database, DB } = createScenario();
  const authHeaders = await seedAuthUser(database, DB, 'admin');
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
      ...authHeaders
    },
    body: JSON.stringify({ method: 'bulkUpdateFlightDof', args: [[1], rawDof] })
  });
  const response = await onRequestPost({ request, env: { DB } });
  const storedDof = database.prepare('SELECT dof FROM flights WHERE id = 1').get().dof;
  database.close();
  return { response, storedDof };
}

const browserDate = await updateDof('2026-09-15');
assert.equal(browserDate.response.status, 200);
assert.equal(browserDate.storedDof, '20260915');

const compactDate = await updateDof('20260916');
assert.equal(compactDate.response.status, 200);
assert.equal(compactDate.storedDof, '20260916');

const invalidDate = await updateDof('15/09/2026');
assert.equal(invalidDate.response.status, 400);
assert.equal(invalidDate.storedDof, '20260914');

console.log('Bulk flight DOF accepts browser and compact dates, stores YYYYMMDD, and rejects invalid input.');
