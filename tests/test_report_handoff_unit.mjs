// Unit tests for the pure helpers in archive/Report_Handoff.gs.
// Evaluates the Apps Script source in Node with stubbed platform globals.
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const src = await readFile(new URL('../archive/Report_Handoff.gs', import.meta.url), 'utf8');

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_alg, str) => Array.from(crypto.createHash('sha256').update(String(str), 'utf8').digest())
    .map((b) => (b > 127 ? b - 256 : b)) // Apps Script returns signed bytes
};

const factory = new Function(
  'Utilities', 'LockService', 'SpreadsheetApp', 'getActiveSS', 'requireAuthorized', 'getCurrentUserEmail',
  src + '\n;return { reportCanonicalJson_, reportPayloadHash_, reportTemplateFor_, reportFlightSetKey_, reportFlightBrief_, reportEffectiveStatus_, reportValidatePayload_, reportSha256Hex_, reportUniqueStations_ };'
);
const H = factory(Utilities, {}, {}, () => { throw new Error('unused'); }, () => {}, () => 'ops@x.com');

let pass = 0;
function check(name, fn) { fn(); pass++; console.log('  ok - ' + name); }

console.log('report handoff unit tests');

check('canonicalJson is key-order independent (incl. nested)', () => {
  assert.equal(H.reportCanonicalJson_({ b: 1, a: { d: 4, c: 3 } }), H.reportCanonicalJson_({ a: { c: 3, d: 4 }, b: 1 }));
});

check('canonicalJson preserves array order', () => {
  assert.notEqual(H.reportCanonicalJson_([1, 2]), H.reportCanonicalJson_([2, 1]));
});

check('payload hash stable across key order, changes on value change', () => {
  const a = { version: 1, reportRequestId: 'r1', flights: [{ FLIGHT: 'QZ1', STD: '0300', DEP: 'WIII' }] };
  const b = { reportRequestId: 'r1', flights: [{ DEP: 'WIII', FLIGHT: 'QZ1', STD: '0300' }], version: 1 };
  const c = { reportRequestId: 'r1', flights: [{ DEP: 'WIII', FLIGHT: 'QZ1', STD: '0301' }], version: 1 };
  assert.equal(H.reportPayloadHash_(a), H.reportPayloadHash_(b));
  assert.notEqual(H.reportPayloadHash_(a), H.reportPayloadHash_(c));
  assert.equal(H.reportPayloadHash_(a).length, 64);
});

check('template mapping 1/2/3/4', () => {
  assert.equal(H.reportTemplateFor_(1), 'CBR1');
  assert.equal(H.reportTemplateFor_(2), 'CBR2');
  assert.equal(H.reportTemplateFor_(3), 'CBR4');
  assert.equal(H.reportTemplateFor_(4), 'CBR4');
  assert.throws(() => H.reportTemplateFor_(0));
  assert.throws(() => H.reportTemplateFor_(5));
});

check('flight-set key ignores order/index and includes STD', () => {
  const f1 = { FLIGHT: 'QZ1', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS', STD: '0300', rowIdx: 5 };
  const f2 = { FLIGHT: 'QZ2', DOF: '2026-09-19', DEP: 'WSSS', ARR: 'WIII', STD: '0600', rowIdx: 9 };
  const k1 = H.reportFlightSetKey_([f1, f2]);
  const k2 = H.reportFlightSetKey_([{ ...f2, rowIdx: 1 }, { ...f1, rowIdx: 99 }]);
  assert.equal(k1, k2);
  assert.notEqual(k1, H.reportFlightSetKey_([{ ...f1, STD: '0310' }, f2]));
});

check('lazy expiry: awaiting past deadline reads EXPIRED, future stays', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  assert.equal(H.reportEffectiveStatus_({ STATUS: 'AWAITING_CONFIRMATION', PREVIEW_EXPIRES_AT: past }), 'EXPIRED');
  assert.equal(H.reportEffectiveStatus_({ STATUS: 'AWAITING_CONFIRMATION', PREVIEW_EXPIRES_AT: future }), 'AWAITING_CONFIRMATION');
  assert.equal(H.reportEffectiveStatus_({ STATUS: 'SUCCEEDED', PREVIEW_EXPIRES_AT: past }), 'SUCCEEDED');
});

check('validatePayload accepts valid, rejects malformed', () => {
  const ok = { version: 1, reportRequestId: 'r1', flights: [{ FLIGHT: 'QZ1' }] };
  assert.equal(H.reportValidatePayload_(ok), 'r1');
  assert.throws(() => H.reportValidatePayload_({ ...ok, version: 2 }), /version/i);
  assert.throws(() => H.reportValidatePayload_({ ...ok, reportRequestId: '' }), /reportRequestId/);
  assert.throws(() => H.reportValidatePayload_({ ...ok, flights: [] }), /1 and 4/);
  assert.throws(() => H.reportValidatePayload_({ ...ok, flights: [{}, {}, {}, {}, {}] }), /1 and 4/);
  assert.throws(() => H.reportValidatePayload_({ ...ok, flights: [{ DOF: 'x' }] }), /FLIGHT/);
});

check('flightBrief drops rowIdx and raw payload text', () => {
  const brief = H.reportFlightBrief_({ FLIGHT: 'QZ1', DOF: 'd', DEP: 'WIII', ARR: 'WSSS', STD: '0300', rowIdx: 7, tafContext: ['SECRET'] });
  assert.equal(brief.rowIdx, undefined);
  assert.equal(brief.tafContext, undefined);
  assert.equal(brief.FLIGHT, 'QZ1');
});

check('uniqueStations uppercases, trims, dedupes, drops empties', () => {
  assert.deepEqual(H.reportUniqueStations_(['wiii', ' WIII ', '', null, 'wsss', 'WSSS']), ['WIII', 'WSSS']);
});

console.log('\n' + pass + ' checks passed');