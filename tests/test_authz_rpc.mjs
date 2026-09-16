import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

function statement(database, sql, parameters = []) {
  return { bind(...values) { return statement(database, sql, values); }, async all() { return { results: database.prepare(sql).all(...parameters) }; }, async first() { return database.prepare(sql).get(...parameters) || null; }, async run() { return database.prepare(sql).run(...parameters); } };
}

async function scenario(role) {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE notams (id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT, valid_from TEXT, valid_to TEXT, kind TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const DB = { prepare: (sql, parameters) => statement(database, sql, parameters), async batch(statements) { for (const prepared of statements) await prepared.run(); } };
  const authHeaders = await seedAuthUser(database, DB, role);
  const request = new Request('http://localhost/api/rpc', { method: 'POST', headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify({ method: 'firBulkImportNotams', args: ['(A1001/26 NOTAMN\nQ) WIIF/QRTCA/IV/BO/E/000/999/0600S10600E005\nA) WIIF B) 2609010000 C) 2610010000\nE) AIRSPACE RESTRICTED)', 'append'] }) });
  const response = await onRequestPost({ request, env: { DB } });
  database.close();
  return response.status;
}

assert.equal(await scenario('readonly'), 403);
assert.equal(await scenario('registered'), 200);
console.log('RPC role policy rejects readonly FIR writes and permits registered FIR writes.');
