// Gate C — the aerodrome-only rule must drop FIR/UIR NOTAMs at the payload boundary.
//
// This runs the SHIPPED code from both source files (no browser, no mocks of the rule
// itself): the real `getReportNotamContext()` from src/Notam_Ui.html consumes the real
// `analyzeNotams` response shape, and the real `getReportWeb1Payload()` from
// src/Report_Ui.html consumes the result. It exercises the live-data fixture
// (tests/gatec_fixtures.mjs) whose response mixes one FIR/UIR designator row in per
// selected flight, and asserts the rule — not the fixture — is what removes them.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { buildFlightDataset, isFirStation } from './gatec_fixtures.mjs';

const notamUi = await readFile(new URL('../src/Notam_Ui.html', import.meta.url), 'utf8');
const reportUi = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
const notamScript = notamUi.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const reportScript = reportUi.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!notamScript) throw new Error('inline <script> not found in src/Notam_Ui.html');
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');

const checks = [];
const chk = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); };

/** Fresh VM context per dataset: window globals are shared state in the real app. */
function makeContext(dataset) {
  // A classic browser script's top-level `function` declarations become properties of
  // the global object, and the shipped code reaches them through `window`. Model that
  // by exposing the VM's own global object as `window`.
  const ctx = vm.createContext({ console, Date, JSON, Math, String, Number, Object, Array, TextEncoder, crypto: globalThis.crypto });
  const win = new Proxy({}, {
    get: (t, k) => (typeof k === 'string' && k in t ? t[k] : ctx[k]),
    set: (t, k, v) => { t[k] = v; ctx[k] = v; return true; },
    has: (t, k) => k in t || k in ctx,
    deleteProperty: (t, k) => { delete t[k]; delete ctx[k]; return true; }
  });
  ctx.window = win;
  // The shipped files do DOM work at load time (scroll listeners, status elements).
  // Only the payload path is under test, so DOM access is satisfied by inert stubs.
  const el = () => new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (k === 'style' || k === 'classList' ? el() : (typeof k === 'string' ? () => undefined : undefined))),
    set: (t, k, v) => { t[k] = v; return true; }
  });
  ctx.__el = el;
  vm.runInContext(`
    window.addEventListener = function(){};
    window.removeEventListener = function(){};
    window.dispatchEvent = function(){ return true; };
    window.document = {
      getElementById: function(){ return __el(); },
      querySelector: function(){ return __el(); },
      querySelectorAll: function(){ return []; },
      createElement: function(){ return __el(); },
      addEventListener: function(){},
      body: __el()
    };
    window.localStorage = { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){} };
    window.MutationObserver = function(){ this.observe = function(){}; this.disconnect = function(){}; };
    window.navigator = { userAgent: 'node' };
    window.matchMedia = function(){ return { matches: false, addEventListener: function(){}, addListener: function(){} }; };
  `, ctx, { filename: 'dom-stub' });
  vm.runInContext(notamScript, ctx, { filename: 'src/Notam_Ui.html' });
  vm.runInContext(reportScript, ctx, { filename: 'src/Report_Ui.html' });
  win.__ds = dataset;
  vm.runInContext(`
    window.safeStorage = { get: function (k, fb) {
      if (k === 'occ_notam_analysis') return window.__ds.savedNotamAnalysis;
      if (k === 'occ_report_no_sig_station') return window.__ds.noSigStationMap;
      return fb || {};
    }, set: function(){}, remove: function(){} };
    window.getSelectedFlightObjects = function () { return window.__ds.flights; };
    // Notam_Ui seeds this from safeStorage at load time; in the real app the operator's
    // persisted analysis is already there, so the test supplies the same shape.
    window.savedNotamAnalysis = window.__ds.savedNotamAnalysis;
    window.awqReportState = { notamResponse: window.__ds.notamResponseByStation };
    window.getReportTafContext = function (stations) {
      return (stations || []).map(function (s) {
        var t = window.__ds.tafByStation[s];
        return t ? { station: t.station, text: t.text, issueTime: t.issueTime, available: t.available }
                 : { station: s, text: '', issueTime: null, available: false };
      });
    };
  `, ctx, { filename: 'harness-bootstrap' });
  return win;
}

for (const count of [1, 2, 3, 4]) {
  const ds = buildFlightDataset(count);
  const win = makeContext(ds);
  const payload = win.getReportWeb1Payload();
  const scope = win.reportNotamScope;
  // The response is keyed by station+flight, so two flights sharing a departure
  // aerodrome produce two entries for it — the selector dedupes by (station, notamNum).
  const responseRows = ds.notamResponseByStation.data
    .flatMap((s) => s.notams.map((n) => ({ id: n.notamNum, station: String(n.station).toUpperCase() })));
  const uniqueResponseRows = [...new Map(responseRows.map((r) => [`${r.station}|${r.id}`, r])).values()];
  const rawNotamCount = uniqueResponseRows.length;
  const firRowsInResponse = uniqueResponseRows.filter((r) => isFirStation(r.station));
  const kept = payload.notamContext || [];
  const leaked = kept.filter((n) => isFirStation(n.station));

  chk(`${count} flight(s): payload carries no FIR/UIR station`, leaked.length === 0, JSON.stringify(leaked.map((n) => n.station)));
  chk(`${count} flight(s): no FIR/UIR NOTAM id survives into the payload`,
    !kept.some((n) => firRowsInResponse.some((f) => f.id === n.id)),
    JSON.stringify(kept.map((n) => n.id)));
  chk(`${count} flight(s): payload scopes every NOTAM to a selected aerodrome`,
    kept.every((n) => ds.flights.some((f) => [f.DEP, f.ARR, f.ALT, f.ENR1, f.ENR2, f.ENR3].includes(n.station))),
    JSON.stringify([...new Set(kept.map((n) => n.station))]));
  chk(`${count} flight(s): FIR rows were present in the response and removed by the rule`,
    firRowsInResponse.length === ds.expectedFirDropped && ds.expectedFirDropped === count,
    `firRows=${firRowsInResponse.length} expected=${ds.expectedFirDropped}`);
  chk(`${count} flight(s): payload notamScope reports AERODROME_ONLY`,
    payload.notamScope && payload.notamScope.rule === 'AERODROME_ONLY',
    JSON.stringify(payload.notamScope));
  chk(`${count} flight(s): droppedFirWide equals the number of FIR rows removed`,
    payload.notamScope && Number(payload.notamScope.droppedFirWide) === ds.expectedFirDropped,
    `droppedFirWide=${payload.notamScope && payload.notamScope.droppedFirWide} expected=${ds.expectedFirDropped}`);
  chk(`${count} flight(s): dropped list names the dropped id and its FIR station`,
    payload.notamScope && payload.notamScope.dropped.length === ds.expectedFirDropped
      && payload.notamScope.dropped.every((d) => d.id && isFirStation(d.station)),
    JSON.stringify(payload.notamScope && payload.notamScope.dropped));
  const droppedIds = new Set((payload.notamScope.dropped || []).map((d) => d.id));
  chk(`${count} flight(s): every FIR row selected in Web 2 is named in the dropped list`,
    firRowsInResponse.length > 0 && firRowsInResponse.every((r) => droppedIds.has(r.id)),
    `firRows=${JSON.stringify(firRowsInResponse.map((r) => r.id))} dropped=${JSON.stringify([...droppedIds])}`);
  chk(`${count} flight(s): no aerodrome NOTAM was dropped`,
    (payload.notamScope.dropped || []).every((d) => isFirStation(d.station)),
    JSON.stringify(payload.notamScope.dropped));
  chk(`${count} flight(s): live scope recorder agrees with the payload`,
    !!scope && scope.dropped.length === payload.notamScope.droppedFirWide,
    `recorder=${scope && scope.dropped.length} payload=${payload.notamScope.droppedFirWide}`);

  console.log(`count=${count} kept=${kept.length} dropped=${payload.notamScope.droppedFirWide} raw=${rawNotamCount} stations=${JSON.stringify([...new Set(kept.map((n) => n.station))])} firStations=${JSON.stringify([...new Set(firRowsInResponse.map((f) => f.station))])}`);
}

// Control: same flights, but the response carries no FIR/UIR station at all. Nothing may
// be reported as dropped, and nothing may be lost. Built by dropping FIR station entries
// wholesale — no per-flight bookkeeping, so the control cannot be wrong for the wrong
// reason.
const cleanDs = buildFlightDataset(2);
cleanDs.notamResponseByStation = {
  ok: true,
  data: cleanDs.notamResponseByStation.data.filter((s) => !isFirStation(s.station))
};
cleanDs.expectedFirDropped = 0;
const cleanWin = makeContext(cleanDs);
const cleanPayload = cleanWin.getReportWeb1Payload();
const cleanResponseNotams = cleanDs.notamResponseByStation.data
  .flatMap((s) => s.notams.map((n) => `${s.station}|${n.notamNum}`));
const cleanKept = new Set((cleanPayload.notamContext || []).map((n) => `${n.station}|${n.id}`));
chk('control: a response with no FIR row drops nothing',
  Number(cleanPayload.notamScope.droppedFirWide) === 0 && cleanPayload.notamScope.dropped.length === 0,
  JSON.stringify(cleanPayload.notamScope));
chk('control: every aerodrome NOTAM in the response is kept, none is lost',
  cleanKept.size === new Set(cleanResponseNotams).size
    && [...new Set(cleanResponseNotams)].every((k) => cleanKept.has(k)),
  `kept=${cleanKept.size} response=${new Set(cleanResponseNotams).size} missing=${JSON.stringify([...new Set(cleanResponseNotams)].filter((k) => !cleanKept.has(k)))}`);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.ok ? '' : ' — ' + c.detail}`);
}
console.log(`\nGate C aerodrome-only rule: ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
