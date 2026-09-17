import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
export const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text + String.fromCharCode(10) + '//# sourceURL=waypoint-rpc-test.mjs').toString('base64'));

export async function createWaypointFixture(role = 'admin') {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE latlong (id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT, waypoint TEXT, latitude TEXT, longitude TEXT, sequence_order INTEGER)');
  function statement(sql, values = []) {
    return {
      bind(...parameters) { return statement(sql, parameters); },
      async all() { return { results: database.prepare(sql).all(...values) }; },
      async first() { return database.prepare(sql).get(...values) || null; },
      async run() { return { meta: { changes: database.prepare(sql).run(...values).changes } }; }
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
  const authHeaders = await seedAuthUser(database, DB, role);
  // change_summary already comes from rpc_auth_fixture (migration 009 shape).
  async function rpc(method, args = [], headers = authHeaders) {
    const response = await onRequestPost({ env: { DB }, request: new Request('http://localhost/api/rpc', {
      method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ method, args })
    }) });
    return { status: response.status, ...await response.json() };
  }
  return { database, DB, authHeaders, rpc };
}
