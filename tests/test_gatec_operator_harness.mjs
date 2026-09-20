// Gate C — the manual operator harness must serve a page that (a) parses, (b) carries
// the SHIPPED aerodrome rule rather than a copy, and (c) can record fidelity per
// selection size. Without this, a broken harness is only discovered by the operator
// mid-run, and the gap it exists to close (Sheet fidelity per size) is silently lost.
//
// Imports the harness module directly, so it needs no port and cannot collide with a
// running operator session.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pageHtml, SCENARIOS, DATASETS } from './gatec_manual_firefox.mjs';
import { buildFlightDataset, FIR_DESIGNATORS, isFirStation } from './gatec_fixtures.mjs';

const checks = [];
const chk = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });

const html = pageHtml();
chk('harness page renders', html.length > 5000, `${html.length} bytes`);

// (a) every inline script parses as JavaScript
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
chk('page has inline scripts', scripts.length > 0, `${scripts.length} scripts`);
scripts.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `operator-page#${i}` });
    chk(`inline script ${i} parses`, true, `${code.length} chars`);
  } catch (e) {
    chk(`inline script ${i} parses`, false, e.message);
  }
});

// (b) the shipped rule is embedded verbatim, and no mock of it is
chk('page evaluates the shipped aerodrome predicate', html.includes('window.isAerodromeReportNotam = function(notam, stationSet)'));
chk('page evaluates the shipped station-set builder', html.includes('window.reportStationSet = function(flights)'));
chk('page evaluates the shipped context selector', html.includes('window.getReportNotamContext = function(flights)'));
chk('page evaluates the shipped payload builder', html.includes('window.openReportWeb1 = function()'));
chk('page does not stub the NOTAM selector', !html.includes('window.getReportNotamContext = function (flights) {'));
// The page embeds the dataset (which carries the FIR station keys), not the designator
// list itself: the rule decides scope, and the fixture only supplies the raw response.
chk('page embeds the FIR rows the rule must drop',
  FIR_DESIGNATORS.some((d) => html.includes(`"${d}"`)),
  FIR_DESIGNATORS.join(','));

// (c) per-selection-size fidelity capture exists and covers 1..4
for (const marker of [
  'gatec-fidelity-by-scenario', 'snapshotScenarioState', 'restoreScenarioFields',
  'coverageRecord', 'rememberRunEvidence', 'renderScenarioRecord',
  'record-sel1', 'record-sel2', 'record-sel3', 'record-sel4', 'id="coverage"',
  'fid-sheetUrl', 'fid-templateUsed', 'fid-flightsInSheet', 'fid-notamNoSig', 'fid-notes'
]) {
  chk(`page carries: ${marker}`, html.includes(marker));
}
chk('export carries the coverage record', html.includes('coverage: {') && html.includes('perSize: coverage.perSize'));
chk('export separates missing fidelity from missing run', html.includes('sizesMissingFidelity: coverage.sizesMissingFidelity') && html.includes('sizesMissingRun: coverage.sizesMissingRun'));
// The export log line once recorded `undefined/4` after a refactor renamed the field.
chk('export log line reports a real coverage figure', html.includes("coverage: coverage.fullyCovered + '/4'"), 'logEvent export coverage');

// (d) the scenarios the operator will click actually exercise the drop rule
const handoffScenarios = SCENARIOS.filter((s) => s.kind === 'handoff' && /^sel[1-4]$/.test(s.id));
chk('four handoff scenarios exist for 1..4 flights', handoffScenarios.length === 4, handoffScenarios.map((s) => s.id).join(','));
for (const n of [1, 2, 3, 4]) {
  const key = String(n);
  const ds = DATASETS[key] || buildFlightDataset(n);
  const firStations = ds.notamResponseByStation.data.filter((s) => isFirStation(s.station)).map((s) => s.station);
  chk(`dataset ${n} flight(s) has ${n} FIR row(s) to drop`, ds.expectedFirDropped === n && firStations.length === n, `dropped=${ds.expectedFirDropped} fir=[${firStations}]`);
  chk(`dataset ${n} flight(s) has aerodrome NOTAMs to keep`, Object.values(ds.notamsByFlight).flat().length > 0, `${Object.values(ds.notamsByFlight).flat().length} notams`);
  chk(`dataset ${n} flight(s) carries real staging NOTAM text`, Object.values(ds.notamsByFlight).flat().every((x) => typeof x.text === 'string' && x.text.length > 0));
}
const firRowsTotal = DATASETS['4'].notamResponseByStation.data.filter((s) => isFirStation(s.station)).flatMap((s) => s.notams.map((x) => ({ id: x.notamNum, station: s.station })));
chk('the 4-flight dataset drops exactly the FIR rows it holds', firRowsTotal.length === DATASETS['4'].expectedFirDropped, JSON.stringify(firRowsTotal));

// (e) fidelity fields are per scenario, not one shared blob
chk('fidelity is stored per scenario key', html.includes('fidelityStore[id] = { fields: {}, marks: {}, evidence: null }'));
chk('switching scenario persists the previous one', html.includes('snapshotScenarioState(); // persist what was filled in for the previous scenario'));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.ok ? '' : ' — ' + c.detail}`);
}
console.log(`\nGate C operator harness: ${checks.length - failed}/${checks.length} checks passed`);
assert.equal(failed, 0);
process.exit(failed ? 1 : 0);
