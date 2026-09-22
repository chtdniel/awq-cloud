// Dispatch Assist flight-board row shape.
//
// Why this exists
//   handleFlightBoard used to hand `etd`/`eta` straight to the consumer. Those are
//   stored as published, and the date embedded in an ISO value can be stale by weeks
//   — shared/wxtime.mjs documents a production row carrying dof=20260917 with an etd
//   of 2026-09-08 — so the consumer had to guess the date, and an overnight sector
//   arrived before it departed. The row now carries absolute instants derived from
//   `dof`, with the published values kept alongside so nothing is lost.
//
//   The normalisation is the part that was silently wrong, so it is pinned here
//   rather than only exercised through a D1 mock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// functions/ is ESM while the package is CommonJS, so the module is bundled and
// imported through a data URL — the same route tests/test_wx_time_window.mjs uses
// to reach functions/api/rpc.js.
const bundle = await build({
  entryPoints: ['functions/api/assist.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { boardFlightRow } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

const BASE = {
  id: 534,
  callsign: '534',
  dep: 'WADD',
  dest: 'YPPH',
  alt: 'YPKG',
  enr1: 'YPPD',
  enr2: null,
  enr3: null,
  ac_type: 'PK-AXD',
  registration: 'PK-AXD',
  type_code: null
};

test('the schedule is returned as absolute instants derived from dof', () => {
  const row = boardFlightRow({ ...BASE, etd: '23:05', eta: '03:00', dof: '20260921' });
  assert.equal(row.std, '2026-09-21T23:05:00.000Z');
  assert.equal(row.sta, '2026-09-22T03:00:00.000Z');
  assert.equal(row.dof, '20260921');
});

test('a stale date embedded in etd/eta does not override the date of flight', () => {
  const row = boardFlightRow({
    ...BASE,
    etd: '2026-09-11T23:05:00.000Z',
    eta: '2026-09-11T03:00:00.000Z',
    dof: '20260921'
  });
  assert.equal(row.std, '2026-09-21T23:05:00.000Z');
  assert.equal(row.sta, '2026-09-22T03:00:00.000Z');
});

test('an arrival never precedes its departure on an overnight sector', () => {
  const row = boardFlightRow({
    ...BASE,
    etd: '2026-09-11T23:05:00.000Z',
    eta: '2026-09-11T03:00:00.000Z',
    dof: '20260921'
  });
  assert.ok(new Date(row.sta).getTime() > new Date(row.std).getTime());
});

test('the published values are preserved alongside the normalised instants', () => {
  const row = boardFlightRow({
    ...BASE,
    etd: '2026-09-11T23:05:00.000Z',
    eta: '2026-09-11T03:00:00.000Z',
    dof: '20260921'
  });
  assert.equal(row.publishedStd, '2026-09-11T23:05:00.000Z');
  assert.equal(row.publishedSta, '2026-09-11T03:00:00.000Z');
});

test('a clock time with no date of flight yields a null instant, not a guess', () => {
  const row = boardFlightRow({ ...BASE, etd: '23:00', eta: '00:50', dof: null });
  assert.equal(row.std, null);
  assert.equal(row.sta, null);
  // The raw values survive so a consumer can still prompt for the missing date.
  assert.equal(row.publishedStd, '23:00');
  assert.equal(row.publishedSta, '00:50');
});

test('the rest of the row is unchanged', () => {
  const row = boardFlightRow({ ...BASE, etd: '23:05', eta: '03:00', dof: '20260921' });
  assert.equal(row.id, 534);
  assert.equal(row.callsign, '534');
  assert.equal(row.operator, null);
  assert.equal(row.flightNumber, null);
  assert.equal(row.origin, 'WADD');
  assert.equal(row.destination, 'YPPH');
  assert.deepEqual(row.destinationAlternates, ['YPKG']);
  assert.deepEqual(row.enrouteAlternates, ['YPPD']);
  assert.deepEqual(row.aircraft, { type_code: null, registration: 'PK-AXD' });
});

test('an operator-prefixed callsign is still split into operator and number', () => {
  const row = boardFlightRow({ ...BASE, callsign: 'QZ 534', etd: '23:05', eta: '03:00', dof: '20260921' });
  assert.equal(row.operator, 'QZ');
  assert.equal(row.flightNumber, '534');
});
