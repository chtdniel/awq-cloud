import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLatestTafs, parseTafs, tafStationsFromFlights } from '../shared/taf.mjs';
const now = new Date('2026-09-15T18:30:00Z');
const taf = (st, time = '151700', extra = '') => `TAF ${extra}${st} ${time}Z 1518/1700 08010KT CAVOK`;
test('selects newest report, amendment, and excludes METAR and expired forecasts', () => {
  const html = `<td>${taf('WIII')}</td><td>${taf('WIII', '151100')}</td><td>${taf('WIII', '151700', 'AMD ')}</td><p>METAR YPPH 151800Z 08010KT CAVOK</p>`;
  assert.equal(parseTafs(html, ['WIII', 'YPPH'], now).WIII, taf('WIII', '151700', 'AMD ') + '=');
  assert.deepEqual(parseTafs('TAF WIII 141100Z 1412/1512 08010KT CAVOK', ['WIII'], now), {});
  assert.deepEqual(parseTafs(`${taf('WIII')}=\nTAF WIII 151800Z NIL=`, ['WIII'], now), {});
  assert.deepEqual(parseTafs(`${taf('WIII')}=\nTAF AMD WIII 151800Z 1518/1700 CNL=`, ['WIII'], now), {});
});
test('handles month rollover', () => {
  assert.equal(Object.keys(parseTafs('TAF WIII 312300Z 0100/0206 08010KT CAVOK', ['WIII'], new Date('2026-02-01T01:00Z'))).length, 1);
});
test('fills only missing Indonesian and Australian stations and preserves ADDS', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url.includes('aviationweather')) return new Response(taf('WIII'));
    if (url.includes('bmkg') && !options.method) return new Response('<input name="_token" value="test">', { headers: { 'Set-Cookie': 'session=test; Path=/' } });
    if (url.includes('bmkg')) {
      assert.equal(options.body.get('stasiun'), 'WATO');
      assert.equal(options.headers.Cookie, 'session=test');
      return new Response(`<td>${taf('WATO')}</td><td>${taf('WATO', '151100')}</td>`);
    }
    assert.equal(options.body.get('keyword'), 'YPPH');
    return new Response(`<p class="product">${taf('YPPH')}<br/>RMK TAF3</p><p>METAR YPPH 151800Z AUTO</p>`);
  };
  const result = await fetchLatestTafs(['WIII', 'WATO', 'YPPH', 'WMKK', 'WSSS', 'WBKK'], { fetchImpl, now });
  assert.deepEqual(Object.keys(result).sort(), ['WATO', 'WIII', 'YPPH']);
  assert.equal(result.WIII, taf('WIII') + '=');
  assert.equal(calls.length, 4);
});
test('ADDS outage still fetches BOM and a regional failure is isolated', async () => {
  const result = await fetchLatestTafs(['WIII', 'YPPH'], { now, fetchImpl: async url => {
    if (url.includes('aviationweather')) throw new Error('offline');
    if (url.includes('bmkg')) return new Response('unavailable', { status: 503 });
    return new Response(`<p>${taf('YPPH')}</p>`);
  }});
  assert.deepEqual(result, { YPPH: taf('YPPH') + '=' });
});
test('empty ADDS falls back; complete ADDS avoids regional requests', async () => {
  let calls = 0;
  assert.deepEqual(await fetchLatestTafs(['YPPH'], { now, fetchImpl: async () => { calls++; return new Response(taf('YPPH')); } }), { YPPH: taf('YPPH') + '=' });
  assert.equal(calls, 1);
  calls = 0;
  const result = await fetchLatestTafs(['YPPH'], { now, fetchImpl: async () => ++calls === 1 ? new Response(null, {status: 204}) : new Response(`<p>${taf('YPPH')}</p>`) });
  assert.ok(result.YPPH);
  assert.equal(calls, 2);
});

test('TAF refresh station list ignores broken flight rows and FIR codes', () => {
  const firCodes = new Set(['WIIF']);
  const rows = [
    { callsign: '818', dep: 'WIII', dest: 'WADD', alt: 'WATO' },
    { callsign: '"', dep: '20260908', dest: 'WIIF', alt: '' },
    { callsign: '819', dep: 'WADD', dest: 'WIIF', alt: '' }
  ];
  assert.deepEqual(tafStationsFromFlights(rows, { excludedStations: firCodes }), ['WIII', 'WADD', 'WATO']);
});

test('TAF refresh keeps valid airports not present in the FIR mapping', () => {
  const rows = [{ callsign: '819', dep: 'WADD', dest: 'YPPH', alt: 'WIII' }];
  assert.deepEqual(tafStationsFromFlights(rows, { excludedStations: ['WIIF'] }), ['WADD', 'YPPH', 'WIII']);
});
