import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';
const database = new DatabaseSync(':memory:');
function statement(sql, args = []) {
  return { bind(...values) { return statement(sql, values); }, async all() { return {results: database.prepare(sql).all(...args)}; }, async first() { return database.prepare(sql).get(...args); }, async run() { return database.prepare(sql).run(...args); } };
}
const DB = { prepare: statement };
const headers = await seedAuthUser(database, DB);
const bundle = await build({entryPoints:['functions/api/rpc.js'], bundle:true, platform:'node', format:'esm', write:false});
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).includes('aviationweather.gov') ? Promise.resolve(new Response(null, {status:204})) : realFetch(url, options);
try {
  const response = await onRequestPost({ env:{DB}, request:new Request('http://localhost/api/rpc', {method:'POST', headers:{Origin:'http://localhost', 'Content-Type':'application/json', ...headers}, body:JSON.stringify({method:'fetchLatestTafFromApi', args:[['WIII','WATO','YPPH','YSSY','WMKK']]})}) });
  const result = await response.json();
  assert.equal(response.status, 200);
  for(const station of ['WIII','WATO','YPPH','YSSY']) {
    assert.match(result.data[station] || '', new RegExp('^TAF (?:AMD |COR )?' + station + ' '));
    assert.ok(!result.data[station].includes('<'));
    assert.ok(!result.data[station].includes('METAR'));
    console.log(station, result.data[station]);
  }
  assert.equal(result.data.WMKK, undefined);
  console.log('PASS: authenticated TAF RPC with simulated empty ADDS and LIVE BMKG/BOM responses.');
} finally {globalThis.fetch=realFetch; database.close();}
