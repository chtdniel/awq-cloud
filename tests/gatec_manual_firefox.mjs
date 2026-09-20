// Gate C — manual evidence harness for REAL Firefox and for the authenticated
// live run against the staging Apps Script deployment.
//
// Why this exists: Playwright's Firefox build deadlocks in this environment
// (browser launches, newPage() never resolves — recorded in the QA evidence).
// Rather than weaken the Firefox requirement, this serves the REAL Web 2 report
// script with real seeded TAF/NOTAM data and points it at the REAL staging
// deployment, so an operator can exercise Firefox (or an authenticated live run)
// and export a JSON evidence log.
//
// Usage:
//   node tests/gatec_manual_firefox.mjs
//   -> open http://127.0.0.1:8788/ in Firefox
//   -> pick a selection size, click DOWNLOAD SHEET, then work the checklist
//   -> DOWNLOAD EVIDENCE JSON and store it under test-results/gate-c/manual/
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildFlightDataset } from './gatec_fixtures.mjs';

// Port and evidence directory are overridable so an automated check can run its own
// harness instance without writing into the operator's evidence log. Operator runs must
// keep the defaults (8788 + test-results/gate-c/manual/).
const PORT = Number(process.env.GATEC_MANUAL_PORT || 8788);
const OUT_DIR = process.env.GATEC_MANUAL_OUT
  ? pathToFileURL(process.env.GATEC_MANUAL_OUT.replace(/[\\/]+$/, '') + '/')
  : new URL('../test-results/gate-c/manual/', import.meta.url);
const DEPLOYMENT_URL = 'https://script.google.com/macros/s/AKfycbz0gdvfrKdGu-7LovIZylT7q-REolKKBNmCRUOL13Dd9gdUZhDmeb6134hMKfv5wLPajA/exec';

const reportUi = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8'));
const reportScript = reportUi.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');
const sprite = reportUi.match(/<svg[^>]*id="i-sprite"[\s\S]*?<\/svg>/)?.[0] || '';

// The aerodrome-only rule lives in src/Notam_Ui.html. The operator run must exercise
// the SHIPPED implementation, not a hand-written mock of it, so the real
// `reportStationSet` / `isAerodromeReportNotam` / `getReportNotamContext` block is
// lifted out of the source and evaluated in the harness page. If the block moves,
// this throws instead of silently testing a stale copy.
const notamUi = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/Notam_Ui.html', import.meta.url), 'utf8'));
const notamFilterCode = (() => {
  const startMarker = '// Gate C rule: the report carries AERODROME NOTAMs only.';
  const start = notamUi.indexOf(startMarker);
  if (start < 0) throw new Error('src/Notam_Ui.html: aerodrome rule comment not found — update the manual harness extractor');
  const endMarker = '\n    window.activeStationGlobalState';
  const end = notamUi.indexOf(endMarker, start);
  if (end < 0) throw new Error('src/Notam_Ui.html: end of getReportNotamContext not found — update the manual harness extractor');
  const code = notamUi.slice(start, end);
  for (const fn of ['reportStationSet', 'isAerodromeReportNotam', 'getReportNotamContext']) {
    if (!code.includes(`window.${fn} = function`)) throw new Error(`src/Notam_Ui.html: ${fn} missing from the extracted aerodrome block`);
  }
  return code;
})();

/** Many real NOTAM texts: per-text stays well under 8 KiB, only the total trips the limit. */
function oversizeTotalDataset() {
  const base = buildFlightDataset(4);
  const uniqueTexts = [...new Set(Object.values(base.notamsByFlight).flat().map((n) => n.text))];
  const perFlight = 45;
  const notamsByFlight = {};
  base.flights.forEach((f, i) => {
    notamsByFlight[f.FLIGHT] = Array.from({ length: perFlight }, (_, k) => ({
      id: `${f.FLIGHT}-N${k + 1}`,
      station: f.DEP,
      flights: [f.FLIGHT],
      text: uniqueTexts[(i * perFlight + k) % uniqueTexts.length],
      status: 'IMPACTED',
      selected: true
    }));
  });
  return {
    ...base,
    notamsByFlight,
    savedNotamAnalysis: Object.fromEntries(base.flights.map((f) => [f.FLIGHT, notamsByFlight[f.FLIGHT].map((n) => n.id)]))
  };
}

const DATASETS = {
  1: buildFlightDataset(1),
  2: buildFlightDataset(2),
  3: buildFlightDataset(3),
  4: buildFlightDataset(4),
  oversizeText: buildFlightDataset(1, { oversizeText: 12 * 1024 }),
  oversizeTotal: oversizeTotalDataset()
};

const SCENARIOS = [
  { id: 'sel1', kind: 'handoff', dataset: '1', title: '1 flight → CBR1', expect: 'Web 1 preview shows CBR1 and one flight' },
  { id: 'sel2', kind: 'handoff', dataset: '2', title: '2 flights → CBR2', expect: 'Web 1 preview shows CBR2 and two flights in selection order' },
  { id: 'sel3', kind: 'handoff', dataset: '3', title: '3 flights → CBR4', expect: 'Web 1 preview shows CBR4 with three populated flights' },
  { id: 'sel4', kind: 'handoff', dataset: '4', title: '4 flights → CBR4', expect: 'Web 1 preview shows CBR4 with four flights' },
  { id: 'popup', kind: 'popup', title: 'Failure — popup blocked', expect: 'Web 2 shows “Allow pop-ups to open the Google Sheets report.” and claims no success' },
  { id: 'badText', kind: 'oversize', dataset: 'oversizeText', title: 'Failure — TAF text over 8 KiB', expect: 'Web 2 names the TAF station and the 8 KiB per-text limit, opens no tab' },
  { id: 'badTotal', kind: 'oversize', dataset: 'oversizeTotal', title: 'Failure — total context over 64 KiB', expect: 'Web 2 reports the total byte count against the 64 KiB limit, opens no tab' },
  { id: 'readyTimeout', kind: 'handoff', dataset: '1', title: 'Failure — Web 1 never ready (30 s)', expect: 'Web 2 reports the readiness timeout, no CONTEXT sent, no success claim' },
  { id: 'receiptTimeout', kind: 'handoff', dataset: '2', title: 'Failure — no receipt (45 s)', expect: 'Web 2 reports the receipt timeout with the SAME request ID' }
];

// ---- evidence is written server-side as well, so a browser crash cannot lose it
const incidents = [];
async function persist() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('manual-incidents.json', OUT_DIR), JSON.stringify(incidents, null, 2), 'utf8');
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gate C — manual evidence harness</title>
<style>
 :root{--bg:#0b0f14;--panel:#111820;--fg:#d7e3f0;--muted:#8aa0b8;--ok:#6fdf8f;--err:#ff6b6b;--warn:#ffc46b;--accent:#5ec8ff}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font-family:Consolas,"Liberation Mono",monospace;font-size:13px;padding:18px}
 h1{font-size:13px;letter-spacing:.18em;color:var(--accent);text-transform:uppercase;margin:0 0 14px}
 h2{font-size:11px;letter-spacing:.14em;color:var(--accent);text-transform:uppercase;margin:18px 0 8px}
 .cols{display:grid;grid-template-columns:340px 1fr 380px;gap:16px;align-items:start}
 .card{background:var(--panel);border:1px solid #233240;border-radius:8px;padding:12px}
 button{font-family:inherit;font-size:12px;font-weight:700;padding:9px 12px;margin:4px 4px 4px 0;cursor:pointer;border-radius:6px;border:1px solid #2c4257;background:#16232f;color:var(--fg)}
 button:hover{border-color:var(--accent)}
 button.active{border-color:var(--accent);color:var(--accent)}
 #terminal{white-space:pre-wrap;min-height:320px;max-height:520px;overflow:auto;background:#0e141b;border:1px solid #233240;border-radius:8px;padding:12px}
 .term-success{color:var(--ok)}.term-error{color:var(--err)}.term-warn{color:var(--warn)}.term-info{color:var(--fg)}
 .kv{display:flex;gap:10px;padding:3px 0;border-bottom:1px dashed #1d2a36}
 .kv b{color:var(--muted);font-weight:400;min-width:150px}
 .muted{color:var(--muted)}
 ol{padding-left:20px;margin:0}ol li{margin:6px 0}
 label.chk{display:flex;gap:8px;align-items:flex-start;margin:7px 0;cursor:pointer}
 .status-ok{color:var(--ok)}.status-err{color:var(--err)}
 code{color:var(--accent)}
</style></head><body>
<h1>Gate C — manual QA evidence harness (Firefox / authenticated live run)</h1>
<div class="cols">
  <div>
    <div class="card">
      <h2>1. Scenario</h2>
      <div id="scenarios"></div>
      <div class="kv" style="margin-top:10px"><b>Active scenario</b><span id="active">(none)</span></div>
      <div class="kv"><b>Dataset flights</b><span id="dsFlights">-</span></div>
      <div class="kv"><b>TAF stations</b><span id="dsTaf">-</span></div>
      <div class="kv"><b>Selected NOTAMs</b><span id="dsNotam">-</span></div>
      <div class="kv"><b>Refused by scope rule</b><span id="dsRefused">-</span></div>
      <div class="kv"><b>Expected</b><span id="dsExpect">-</span></div>
      <h2>2. Run</h2>
      <button id="btn-download-sheet" type="button" onclick="window.__activeRun()">DOWNLOAD SHEET</button>
      <button type="button" onclick="window.__exportEvidence()">DOWNLOAD EVIDENCE JSON</button>
      <div class="kv"><b>Web 1 target</b><span>${DEPLOYMENT_URL.replace(/^(https:\/\/[^/]+).*$/, '$1')} (staging)</span></div>
      <div class="kv" style="margin-top:10px"><b>Per-size records</b><span id="record-sel1" class="muted">-</span></div>
      <div class="kv"><b></b><span id="record-sel2" class="muted">-</span></div>
      <div class="kv"><b></b><span id="record-sel3" class="muted">-</span></div>
      <div class="kv"><b></b><span id="record-sel4" class="muted">-</span></div>
      <div class="kv"><b>Coverage 1/2/3/4</b><span id="coverage">-</span></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Observed transfer</h2>
      <div class="kv"><b>Last event</b><span id="obsState">-</span></div>
      <div class="kv"><b>Request ID</b><span id="obsReq">-</span></div>
      <div class="kv"><b>Nonce</b><span id="obsNonce">-</span></div>
      <div class="kv"><b>Payload bytes</b><span id="obsBytes">-</span></div>
      <div class="kv"><b>Payload SHA-256</b><span id="obsHash" style="word-break:break-all">-</span></div>
      <div class="kv"><b>Scope rule</b><span id="obsScope">-</span></div>
      <div class="kv"><b>Web 2 terminal</b><span id="obsTerm">-</span></div>
    </div>
  </div>
  <div>
    <div class="card">
      <h2>Live Web 2 terminal (real DOWNLOAD SHEET code path)</h2>
      <div id="terminal"></div>
    </div>
    ${sprite}
    <div id="report-status" style="display:none"></div>
  </div>
  <div class="card">
    <h2>3. Operator checklist</h2>
    <ol>
      <li>Browser: <span id="ua" class="muted"></span></li>
      <li>Signed in to Google in THIS browser profile (required for the staging run).</li>
      <li>Pick each scenario in turn and click <b>DOWNLOAD SHEET</b>.</li>
      <li>In the Web 1 tab: verify preview = expected template/flights/counts <b>and</b> the
          <code>Scope rule: AERODROME ONLY</code> line with its <i>FIR-wide excluded</i> warning,
          then confirm <b>GENERATE GOOGLE SHEET</b> and open the Sheet.</li>
      <li>Tick the fidelity checks below and export the evidence JSON.</li>
    </ol>
    <div id="checks"></div>
    <h2>4. Sheet fidelity (fill for each confirmed run — these are exported)</h2>
    <div class="kv"><b>Sheet URL</b><span id="fid-sheetUrl" contenteditable="true" style="min-width:120px;border-bottom:1px dashed #2c4257;flex:1"> </span></div>
    <div class="kv"><b>Template used</b><span id="fid-templateUsed" contenteditable="true" style="min-width:120px;border-bottom:1px dashed #2c4257;flex:1"> </span></div>
    <div class="kv"><b>Flights in sheet</b><span id="fid-flightsInSheet" contenteditable="true" style="min-width:120px;border-bottom:1px dashed #2c4257;flex:1"> </span></div>
    <div class="kv"><b>NOTAM/NO SIG OK?</b><span id="fid-notamNoSig" contenteditable="true" style="min-width:120px;border-bottom:1px dashed #2c4257;flex:1"> </span></div>
    <div class="kv"><b>Notes</b><span id="fid-notes" contenteditable="true" style="min-width:120px;border-bottom:1px dashed #2c4257;flex:1"> </span></div>
  </div>
</div>
<script>
  var SCENARIOS = ${JSON.stringify(SCENARIOS)};
  var DATASETS = ${JSON.stringify(DATASETS)};
  var state = { activeId: null, events: [], marks: {} };
  document.getElementById('ua').textContent = navigator.userAgent;
  try { state.marks = JSON.parse(localStorage.getItem('gatec-marks') || '{}'); } catch (e) {}

  // ---- dataset-driven globals (mirrors the production shells) ----
  function applyDataset(key) {
    var d = DATASETS[key];
    window.__DS = d;
    window.safeStorage = {
      get: function (k, fb) {
        if (k === 'occ_notam_analysis') return d.savedNotamAnalysis;
        if (k === 'occ_report_no_sig_station') return d.noSigStationMap;
        return fb || {};
      },
      set: function () {}, remove: function () {}
    };
    window.getSelectedFlightObjects = function () { return d.flights; };
    window.getReportTafContext = function (stations) {
      return (stations || []).map(function (s) {
        var t = d.tafByStation[s];
        return t ? { station: t.station, text: t.text, issueTime: t.issueTime, available: t.available }
                 : { station: s, text: '', issueTime: null, available: false };
      });
    };
    // NOTAM selection is NOT stubbed: the real rule from src/Notam_Ui.html reads the
    // raw analyzeNotams response below, so the FIR rows mixed into the fixture are
    // dropped by the shipped code and recorded in window.reportNotamScope.
    window.awqReportState = { notamResponse: d.notamResponseByStation };
    window.savedNotamAnalysis = d.savedNotamAnalysis;
    window.__dsExpectedFirDropped = d.expectedFirDropped;
    document.getElementById('dsFlights').textContent = d.flightNumbers.join(', ') || '(none)';
    document.getElementById('dsTaf').textContent = Object.keys(d.tafByStation).length + ' stations';
    document.getElementById('dsNotam').textContent = Object.values(d.notamsByFlight).reduce(function (a, v) { return a + v.length; }, 0) + ' NOTAMs';
    document.getElementById('dsRefused').textContent = d.expectedFirDropped + ' FIR-wide (must be dropped)';
  }

  // ---- terminal mirror + evidence log ----
  function renderTerminal() {
    var box = document.getElementById('terminal');
    box.innerHTML = state.events.filter(function (e) { return e.kind === 'terminal'; })
      .map(function (e) { return '<div class="' + (e.cls || 'term-info') + '">[' + e.t + '] ' + escapeHtml(e.text) + '</div>'; }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function escapeHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function logEvent(kind, data) {
    state.events.push(Object.assign({ kind: kind, t: new Date().toISOString(), scenario: state.activeId, seq: state.events.length }, data));
    if (kind === 'terminal') renderTerminal();
    fetch('/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state.events[state.events.length - 1]) }).catch(function () {});
  }

  // ---- scenario picker ----
  //
  // Gate C needs a fidelity record PER SELECTION SIZE, not one checklist for whichever
  // scenario happened to run last. Fidelity fields and per-scenario run evidence are
  // therefore kept in a store keyed by scenario id and restored when the operator
  // returns to that scenario. Checklist marks are shared but also snapshotted per
  // scenario, so the export can show which sizes were actually verified.
  var FID_STORE_KEY = 'gatec-fidelity-by-scenario';
  var fidelityStore = {};
  try { fidelityStore = JSON.parse(localStorage.getItem(FID_STORE_KEY) || '{}'); } catch (e) { fidelityStore = {}; }
  function scenarioStore(id) {
    if (!fidelityStore[id]) fidelityStore[id] = { fields: {}, marks: {}, evidence: null };
    if (!fidelityStore[id].fields) fidelityStore[id].fields = {};
    if (!fidelityStore[id].marks) fidelityStore[id].marks = {};
    return fidelityStore[id];
  }
  function saveFidelityStore() {
    try { localStorage.setItem(FID_STORE_KEY, JSON.stringify(fidelityStore)); } catch (e) {}
  }

  var box = document.getElementById('scenarios');
  SCENARIOS.forEach(function (s) {
    var b = document.createElement('button');
    b.textContent = s.title;
    b.onclick = function () {
      snapshotScenarioState(); // persist what was filled in for the previous scenario
      state.activeId = s.id;
      window.__active = s;
      [].forEach.call(box.children, function (c) { c.classList.remove('active'); });
      b.classList.add('active');
      document.getElementById('active').textContent = s.title;
      document.getElementById('dsExpect').textContent = s.expect;
      applyDataset(s.dataset || '1');
      window.__applyMode(s);
      restoreScenarioFields(s.id);
      renderScenarioRecord(s.id);
      logEvent('scenario', { id: s.id, title: s.title, expect: s.expect, dataset: s.dataset || '1' });
    };
    box.appendChild(b);
  });

  // ---- mode switching on the real handoff code ----
  var nativeOpen = window.open.bind(window);
  window.__applyMode = function (s) {
    window.open = function (url, target) {
      if (s.kind === 'popup') { logEvent('note', { text: 'window.open suppressed to simulate a popup blocker' }); return null; }
      var w = nativeOpen(url, target);
      logEvent('open', { url: String(url), dataset: s.dataset || '1' });
      return w;
    };
    window.__REPORT_READY_TIMEOUT_MS = s.id === 'readyTimeout' ? 6000 : undefined;
    window.__REPORT_RECEIPT_TIMEOUT_MS = s.id === 'receiptTimeout' ? 8000 : undefined;
  };
  window.__applyMode(SCENARIOS[0]);
  document.getElementById('active').textContent = '(none)';

  // ---- run + observe ----
  // These two globals hold the shipped page's last completed handoff. They must be
  // cleared before each run, otherwise the first snapshots of a new scenario
  // report the PREVIOUS request's state and the evidence looks contradictory.
  function runToken() { return state.activeId + '#' + state.events.length; }
  function byteLength(s) { try { return new TextEncoder().encode(String(s)).length; } catch (e) { return String(s).length; } }
  function sha256Hex(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  // Same canonical, stable-key serialization the Web 1 backend hashes with, so the
  // exported fingerprint is directly comparable to the automated matrix evidence.
  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(value[k]); }).join(',') + '}';
  }
  function capturePayload() {
    // Called only AFTER the handoff is recorded, so the neutralized payload is
    // byte-identical to the one Web 2 actually delivered (same immutable request
    // ID and timestamp); a fresh requestId would not be comparable.
    try {
      var sent = window.__gatecContextSent;
      if (!sent) return;
      var p = getReportWeb1Payload();
      p.reportRequestId = sent.reportRequestId;
      var json = JSON.stringify(p);
      // getReportWeb1Payload() runs the shipped aerodrome rule, which republishes its
      // decision in window.reportNotamScope. Snapshot it here, before anything else
      // can call the selector again.
      var liveScope = (window.reportNotamScope && window.reportNotamScope.available)
        ? {
            rule: 'AERODROME_ONLY',
            droppedFirWide: (window.reportNotamScope.dropped || []).length,
            dropped: (window.reportNotamScope.dropped || []).map(function (x) { return { id: x.id, station: x.station }; }),
            expectedFirDropped: window.__dsExpectedFirDropped
          }
        : null;
      window.__lastPayload = {
        reportRequestId: p.reportRequestId,
        flights: (p.flights || []).length,
        tafStations: (p.tafContext || []).length,
        notams: (p.notamContext || []).length,
        bytes: byteLength(json),
        verifiedAgainstSentRequestId: true,
        scopeFromShippedRule: liveScope,
        scopeInPayload: p.notamScope || null
      };
      document.getElementById('obsBytes').textContent = window.__lastPayload.bytes + ' bytes (' + window.__lastPayload.flights + ' flight, ' + window.__lastPayload.tafStations + ' TAF, ' + window.__lastPayload.notams + ' NOTAM)';
      document.getElementById('obsScope').textContent = liveScope
        ? ('kept ' + window.__lastPayload.notams + ', dropped ' + liveScope.droppedFirWide + ' FIR-wide (expected ' + liveScope.expectedFirDropped + ')')
        : '(rule not available)';
      logEvent('payload', window.__lastPayload);
      rememberRunEvidence({
        reportRequestId: p.reportRequestId,
        scopeDropped: liveScope ? liveScope.droppedFirWide : null,
        scopeExpected: liveScope ? liveScope.expectedFirDropped : null,
        payloadBytes: window.__lastPayload.bytes,
        notams: window.__lastPayload.notams,
        tafStations: window.__lastPayload.tafStations
      });
      sha256Hex(canonicalJson(p)).then(function (h) {
        window.__lastPayload.hash = h;
        document.getElementById('obsHash').textContent = h;
        rememberRunEvidence({ payloadHash: h });
        logEvent('payloadHash', { reportRequestId: p.reportRequestId, hash: h, canonical: true });
      });
    } catch (e) {
      logEvent('note', { text: 'payload capture failed: ' + e.message });
    }
  }
  window.__activeRun = function () {
    var token = runToken();
    state.runToken = token;
    try { delete window.__gatecTransferState; } catch (e) { window.__gatecTransferState = undefined; }
    try { delete window.__gatecContextSent; } catch (e) { window.__gatecContextSent = undefined; }
    document.getElementById('obsState').textContent = '(pending)';
    document.getElementById('obsReq').textContent = '-';
    document.getElementById('obsNonce').textContent = '-';
    document.getElementById('obsBytes').textContent = '-';
    document.getElementById('obsHash').textContent = '-';
    document.getElementById('obsScope').textContent = '-';
    logEvent('click', { id: state.activeId, runToken: token });
    window.openReportWeb1();
    setTimeout(function () { snapshot(token); }, 900);
    setTimeout(function () { snapshot(token); }, 2500);
    setTimeout(function () { snapshot(token); }, 7000);
    if (state.activeId === 'receiptTimeout') setTimeout(function () { snapshot(token); }, 11000);
    if (state.activeId === 'readyTimeout') setTimeout(function () { snapshot(token); }, 8000);
  };
  function snapshot(token) {
    if (token && state.runToken !== token) return; // a newer run superseded this snapshot
    var st = window.__gatecTransferState || null;
    var sent = window.__gatecContextSent || null;
    document.getElementById('obsState').textContent = st ? st.state : (sent ? 'CONTEXT_SENT' : '(pending)');
    var req = (st && st.reportRequestId) || (sent && sent.reportRequestId) || '-';
    document.getElementById('obsReq').textContent = req;
    document.getElementById('obsNonce').textContent = sent ? sent.nonce : '-';
    document.getElementById('obsTerm').textContent = (document.getElementById('report-status').innerText || '').split('\\n').slice(-1)[0] || '-';
    if (sent) {
      logEvent('snapshot', { transferState: st, contextSent: sent, runToken: token });
      if (!window.__payloadCapturedFor || window.__payloadCapturedFor !== sent.reportRequestId) {
        window.__payloadCapturedFor = sent.reportRequestId;
        capturePayload();
      }
    } else if (st) {
      logEvent('snapshot', { transferState: st, contextSent: null, runToken: token });
    }
  }

  // ---- fidelity checklist ----
  var CHECKS = [
    'Web 1 tab opened (or blocked exactly as expected for the popup scenario)',
    'Web 1 preview shows the expected CBR template for the selection size',
    'Web 1 preview flight list matches Web 2 selection AND order',
    'TAF station count and NOTAM count look correct for the selection',
    'Web 1 preview shows “Scope rule: AERODROME ONLY” and warns that FIR-wide NOTAMs were excluded',
    'No SIG stations rendered',
    'Confirm button required an explicit click (no auto-generation)',
    'Generated Sheet opened and shows the same flights',
    'Web 2 terminal result matches the expected outcome above'
  ];
  var checkBox = document.getElementById('checks');
  CHECKS.forEach(function (label, i) {
    var id = 'chk' + i;
    var l = document.createElement('label');
    l.className = 'chk';
    l.innerHTML = '<input type="checkbox" id="' + id + '"><span>' + escapeHtml(label) + '</span>';
    checkBox.appendChild(l);
    var input = l.querySelector('input');
    input.checked = !!state.marks[id];
    input.onchange = function () {
      state.marks[id] = input.checked;
      localStorage.setItem('gatec-marks', JSON.stringify(state.marks));
      snapshotScenarioState();
      logEvent('check', { id: id, label: label, checked: input.checked, scenario: state.activeId });
    };
    if (input.checked) logEvent('check', { id: id, label: label, checked: true });
  });

  // Operator-recorded fidelity values. These are part of the Gate C requirement
  // ("verify spreadsheet template and data fidelity manually"), so they must be in
  // the exported artifact — not only in the on-page fields.
  var FIDELITY_FIELDS = ['sheetUrl', 'templateUsed', 'flightsInSheet', 'notamNoSig', 'notes'];
  window.__readFidelity = function () {
    var out = {};
    FIDELITY_FIELDS.forEach(function (key) {
      var el = document.getElementById('fid-' + key);
      out[key] = el ? String(el.textContent || '').trim() : '';
    });
    return out;
  };
  FIDELITY_FIELDS.forEach(function (key) {
    var el = document.getElementById('fid-' + key);
    if (!el) return;
    el.addEventListener('input', function () {
      clearTimeout(el.__t);
      el.__t = setTimeout(function () {
        snapshotScenarioState();
        logEvent('fidelity', { field: key, value: String(el.textContent || '').trim(), scenario: state.activeId });
      }, 900);
    });
  });

  /** Persist the on-page fidelity fields + checklist under the active scenario. */
  function snapshotScenarioState() {
    if (!state.activeId) return;
    var store = scenarioStore(state.activeId);
    store.fields = window.__readFidelity();
    store.marks = Object.assign({}, state.marks);
    saveFidelityStore();
  }
  /** Load the stored fidelity fields for a scenario back into the page. */
  function restoreScenarioFields(id) {
    var store = scenarioStore(id);
    FIDELITY_FIELDS.forEach(function (key) {
      var el = document.getElementById('fid-' + key);
      if (el) el.textContent = store.fields[key] || ' ';
    });
    updateCoverage();
  }
  function selectionSizeOf(id) {
    var m = /^sel([1-4])$/.exec(String(id || ''));
    return m ? Number(m[1]) : null;
  }

  // What the export can prove, per selection size: fidelity recorded, handoff seen,
  // Sheet opened. Shown on the page so the operator can see what is still missing
  // instead of guessing at the end of the session.
  function scenarioRecord(id) {
    var store = scenarioStore(id);
    var evidence = store.evidence || {};
    var fields = store.fields || {};
    return {
      scenario: id,
      selectionSize: selectionSizeOf(id),
      title: (SCENARIOS.filter(function (s) { return s.id === id; })[0] || {}).title || id,
      fidelityRecorded: !!(fields.sheetUrl || '').trim(),
      sheetUrl: (fields.sheetUrl || '').trim(),
      templateUsed: (fields.templateUsed || '').trim(),
      reportRequestId: evidence.reportRequestId || '',
      scopeDropped: evidence.scopeDropped === undefined ? null : evidence.scopeDropped,
      scopeExpected: evidence.scopeExpected === undefined ? null : evidence.scopeExpected,
      payloadHash: evidence.payloadHash || '',
      marks: store.marks || {}
    };
  }
  function coverageRecord() {
    var sizes = [1, 2, 3, 4];
    var perSize = {};
    sizes.forEach(function (n) {
      var id = 'sel' + n;
      perSize[n] = scenarioRecord(id);
    });
    // Two distinct notions, kept separate so neither hides the other:
    //  - fidelityMissing: no Sheet-fidelity record (URL) for that size.
    //  - runMissing:      no completed handoff (request ID) for that size.
    // "complete" means the size has BOTH, i.e. a full verified run.
    var fidelityMissing = sizes.filter(function (n) { return !perSize[n].fidelityRecorded; });
    var runMissing = sizes.filter(function (n) { return !perSize[n].reportRequestId; });
    return {
      perSize: perSize,
      sizesMissingFidelity: fidelityMissing.map(function (n) { return 'sel' + n; }),
      sizesMissingRun: runMissing.map(function (n) { return 'sel' + n; }),
      complete: sizes.filter(function (n) { return !perSize[n].fidelityRecorded || !perSize[n].reportRequestId; }).map(function (n) { return 'sel' + n; }),
      fullyCovered: sizes.filter(function (n) { return perSize[n].fidelityRecorded && perSize[n].reportRequestId; }).length
    };
  }
  window.__coverage = coverageRecord;
  function updateCoverage() {
    var el = document.getElementById('coverage');
    if (!el) return;
    var c = coverageRecord();
    var parts = [1, 2, 3, 4].map(function (n) {
      var r = c.perSize[n];
      var bits = [];
      bits.push(r.reportRequestId ? 'handoff' : '—');
      bits.push(r.scopeDropped === null ? '—' : ('scope ' + r.scopeDropped + '/' + r.scopeExpected));
      bits.push(r.fidelityRecorded ? 'Sheet' : 'no Sheet URL');
      return n + ' flight: ' + bits.join(', ');
    });
    el.textContent = parts.join('   |   ') + (c.complete.length ? '   ⟵ kurang: ' + c.complete.join(', ') : '   |   SEMUA UKURAN LENGKAP');
    el.className = c.complete.length ? 'status-err' : 'status-ok';
  }
  function renderScenarioRecord(id) {
    var el = document.getElementById('record-' + id);
    if (!el) return;
    var r = scenarioRecord(id);
    el.textContent = 'req ' + (r.reportRequestId ? r.reportRequestId.slice(0, 8) : '-')
      + ' · payload ' + (r.payloadHash ? r.payloadHash.slice(0, 12) : '-')
      + ' · dropped ' + (r.scopeDropped === null ? '-' : r.scopeDropped + '/' + r.scopeExpected)
      + ' · Sheet ' + (r.fidelityRecorded ? 'ok' : '-');
  }
  function rememberRunEvidence(data) {
    if (!state.activeId) return;
    var store = scenarioStore(state.activeId);
    store.evidence = Object.assign({}, store.evidence || {}, data);
    saveFidelityStore();
    renderScenarioRecord(state.activeId);
    updateCoverage();
  }

  window.__exportEvidence = function () {
    snapshotScenarioState();
    var coverage = coverageRecord();
    var payload = {
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      deployment: '${DEPLOYMENT_URL}',
      build: {
        reportUiHashPinnedBy: 'src/Report_Ui.html extracted inline script',
        notamRulePinnedBy: 'src/Notam_Ui.html aerodrome block (reportStationSet / isAerodromeReportNotam / getReportNotamContext) evaluated verbatim',
        firefoxNote: 'Playwright Firefox newPage() deadlocks in this environment; this run is the Firefox evidence source'
      },
      // Per-selection-size records: this is what closes the Gate C fidelity gap.
      coverage: {
        fullyCovered: coverage.fullyCovered,
        total: 4,
        missing: coverage.complete,
        sizesMissingFidelity: coverage.sizesMissingFidelity,
        sizesMissingRun: coverage.sizesMissingRun,
        perSize: coverage.perSize
      },
      fidelity: window.__readFidelity(),
      marks: state.marks,
      events: state.events
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gatec-manual-' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    logEvent('export', { bytes: blob.size, coverage: coverage.fullyCovered + '/4', missing: coverage.complete.join(',') });
  };

  window.__gatecDiag = [];
  window.addEventListener('message', function (ev) {
    window.__gatecDiag.push({ t: Date.now(), type: ev.data && ev.data.type, origin: ev.origin, nonce: ev.data && ev.data.nonce });
    logEvent('message', { type: ev.data && ev.data.type, origin: ev.origin });
  });

  // Restore whatever was already recorded (a reload must not lose operator input).
  SCENARIOS.forEach(function (s) { renderScenarioRecord(s.id); });
  updateCoverage();
</script>
<script>
  window.escapeHtml = function (value) { return String(value == null ? '' : value); };
  // SHIPPED aerodrome-only rule, lifted verbatim from src/Notam_Ui.html. Evaluated
  // before the report script so getReportWeb1Payload() binds to the real selector.
  ${notamFilterCode}
  ${reportScript}
  // Mirror the real terminal into the evidence panel. The report script keeps an
  // internal reference to its own printer, so the DOM is the only reliable tap.
  (function () {
    var box = document.getElementById('report-status');
    if (!box || typeof MutationObserver !== 'function') return;
    var seen = new WeakSet();
    var observer = new MutationObserver(function () {
      [].forEach.call(box.querySelectorAll('.terminal-line'), function (line) {
        if (seen.has(line)) return;
        seen.add(line);
        var text = line.innerText || '';
        var cls = (line.querySelector('.term-success, .term-error, .term-warn, .term-info') || {}).className || 'term-info';
        var entry = { kind: 'terminal', t: new Date().toISOString(), scenario: state.activeId, seq: state.events.length, text: text, cls: cls };
        state.events.push(entry);
        renderTerminal();
        fetch('/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) }).catch(function () {});
      });
    });
    observer.observe(box, { childList: true, subtree: true });
  })();
</script>
</body></html>`;
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try { incidents.push(JSON.parse(body)); await persist(); } catch (e) { /* ignore malformed */ }
      res.writeHead(204); res.end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml());
});

// Exported so a test can verify the served page (script parses, shipped rule present)
// without starting a second server on the shared ports.
export { pageHtml, SCENARIOS, DATASETS };

// Importing this module for that check must not bind the port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is in use — stop the other Gate C suite/manual server first.`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(PORT, '127.0.0.1', async () => {
    await mkdir(OUT_DIR, { recursive: true });
    await persist();
    console.log('Gate C manual evidence harness');
    console.log(`  Web 2 harness : http://127.0.0.1:${PORT}/`);
    console.log('  Web 1 target  : ' + DEPLOYMENT_URL);
    console.log('  Instructions  : open the URL in REAL Firefox (or a signed-in Chrome profile),');
    console.log('                  pick a scenario, click DOWNLOAD SHEET, then export evidence JSON.');
    console.log('  Server log    : ' + new URL('manual-incidents.json', OUT_DIR).pathname);
    if (process.env.GATEC_MANUAL_OUT) {
      console.log('  NOTE: GATEC_MANUAL_OUT is set — this instance writes to a scratch directory,');
      console.log('        so anything recorded here is NOT operator evidence.');
    }
  });

  // Keep the process alive until Ctrl+C.
  process.on('SIGINT', () => { server.close(); process.exit(0); });
}
