// Gate C QA harness — shared by the browser matrix, failure-mode and interop suites.
//
// Two cooperating surfaces, served from ONE long-lived HTTP listener set so a
// scenario change never churns sockets (closing and rebinding the fixed loopback
// ports leaked TIME_WAIT/CONNECTING sockets and served stale pages):
//   Web 2 (port 8788) : a minimal shell that loads the REAL REPORT page script
//                       extracted from src/Report_Ui.html and exposes the same
//                       globals the production shell provides
//                       (getSelectedFlightObjects, getReportTafContext,
//                       getReportNotamContext, safeStorage, escapeHtml).
//   Web 1 (port 8789) : the REAL archive/Report.html served as-is, with a
//                       `google.script` RPC stub injected before its own script
//                       so the Apps Script round trip is deterministic.
//   Attack (port 8790) : an unrelated-origin page used for the origin-mismatch
//                       failure mode.
//
// Only the Apps Script platform boundary is mocked. The postMessage handshake,
// origin/nonce/source validation, iframe-aware binding, preview rendering and
// window.open behaviour all run as shipped code.
//
// Scenario state lives on the server and is selected per request:
//   Web 2 : /?view=<view>
//   Web 1 : /?outcome=<outcome>&ack=ok|reject|silent&ready=ok|bad-nonce|silent
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export const WEB2_PORT = 8788;
export const WEB1_PORT = 8789;
export const ATTACK_PORT = 8790;
export const WEB2_ORIGIN = `http://127.0.0.1:${WEB2_PORT}`;
export const WEB1_ORIGIN = `http://127.0.0.1:${WEB1_PORT}`;
export const ATTACK_ORIGIN = `http://127.0.0.1:${ATTACK_PORT}`;

const reportUi = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
// Normalise line endings so the extracted script is byte-stable no matter which
// editor wrote src/Report_Ui.html last (the mutation control matches exact text).
const reportScript = reportUi.match(/<script>([\s\S]*?)<\/script>/)?.[1]?.replace(/\r\n/g, '\n');
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');
if (!reportScript.includes('__REPORT_WEB1_URL_OVERRIDE')) {
  throw new Error('src/Report_Ui.html lost the __REPORT_WEB1_URL_OVERRIDE test hook');
}
const iconSprite = reportUi.match(/<svg[^>]*id="i-sprite"[\s\S]*?<\/svg>/)?.[0] || '';
const reportHtmlRaw = await readFile(new URL('../archive/Report.html', import.meta.url), 'utf8');

/**
 * Mutation control: run the shipped script with the iframe/source relationship
 * check removed. The function body is rewritten *before* the script runs so the
 * already-registered message listener really uses the mutated version (a later
 * assignment could not affect a captured function reference).
 */
function reportScriptFor(disableSourceCheck) {
  if (!disableSourceCheck) return reportScript;
  const needle = `      try { return !!event.source && event.source.top === reportWeb1Window; }
      catch (e) { return false; }`;
  const fallback = `      try { return !!event.source; }
      catch (e) { return false; }`;
  if (!reportScript.includes(needle) && !reportScript.includes(fallback)) {
    throw new Error('disableSourceCheck mutation could not locate the source-relationship check');
  }
  return reportScript.replace(needle, '      // mutation: source-relationship check disabled\n      return true;');
}

// ---------------------------------------------------------------- Web 2 page
//
// `options` carries the production globals for the view. `view` decides which
// data set and which failure injection is active; the mutated script is
// selectable per request so a mutation control can be run against the same server.
function web2Html(options, view, cfg, mutate, claimedOrigin) {
  const data = JSON.stringify(options);
  const meta = JSON.stringify({ view, blockPopup: !!cfg.blockPopup, readyTimeoutMs: cfg.readyTimeoutMs || 0, receiptTimeoutMs: cfg.receiptTimeoutMs || 0 });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gate C Web 2 harness (${view})</title>
<style>body{background:#0b0f14;color:#d7e3f0;font-family:Consolas,monospace;padding:24px}#report-status{white-space:pre-wrap}</style>
</head><body>
  ${iconSprite}
  <button id="btn-download-sheet" type="button" onclick="window.openReportWeb1()">DOWNLOAD SHEET</button>
  <div id="report-status"></div>
  <script>
    window.__CFG = ${meta};
    var __DATA = ${data};
    window.__diag = [];
    window.__popupRef = null;
    window.__openCalls = [];

    // ---- production-provided globals (Flight_Ui / Notam_Ui / shell) ----
    window.escapeHtml = function (value) { return String(value == null ? '' : value); };
    var __store = { occ_notam_analysis: __DATA.savedNotamAnalysis, occ_report_no_sig_station: __DATA.noSigStationMap };
    window.safeStorage = {
      get: function (key, fallback) { return Object.prototype.hasOwnProperty.call(__store, key) ? __store[key] : (fallback || {}); },
      set: function (key, value) { __store[key] = value; },
      remove: function (key) { delete __store[key]; }
    };
    window.getSelectedFlightObjects = function () { return __DATA.flights; };
    window.getReportTafContext = function (stations) {
      return (stations || []).map(function (stn) {
        var t = __DATA.tafByStation[stn];
        if (!t) return { station: stn, text: '', issueTime: null, available: false };
        return { station: t.station, text: t.text, issueTime: t.issueTime, available: t.available };
      });
    };
    window.getReportNotamContext = function (flights) {
      // Mirrors src/Notam_Ui.html: aerodrome scope only. A NOTAM is aerodrome
      // scoped when its station is one of the selected flights' aerodromes. The
      // fixture also attaches FIR/UIR-scoped rows (flagged fir:true) to aerodrome
      // stations, standing for a record whose location column is the FIR but whose
      // A) item is an aerodrome — the payload must drop both kinds.
      var stationSet = {};
      (flights || []).forEach(function (f) {
        ['DEP', 'ARR', 'ALT', 'ENR1', 'ENR2', 'ENR3'].forEach(function (k) {
          var stn = f && f[k] ? String(f[k]).trim().toUpperCase() : '';
          if (stn) stationSet[stn] = true;
        });
      });
      window.reportNotamScope = { dropped: [], available: true };
      var out = [];
      (flights || []).forEach(function (f) {
        // rawNotamsByFlight is what Web 2's NOTAM desk holds (aerodrome + FIR rows
        // attached to the same station); the drop rule is applied right here.
        var source = (__DATA.rawNotamsByFlight && __DATA.rawNotamsByFlight[f.FLIGHT]) || __DATA.notamsByFlight[f.FLIGHT] || [];
        source.forEach(function (n) {
          var stn = String(n.station || '').toUpperCase();
          // FIR/UIR scope comes from the fixture's explicit marker (it knows the real
          // designator set). A code-suffix guess would miss VTBB/YBBB/YMMM.
          if (n.fir === true || !stationSet[stn]) {
            window.reportNotamScope.dropped.push({ id: n.id, station: stn, reason: n.fir === true ? 'FIR/UIR scope' : 'station not in selection' });
            return;
          }
          out.push({ id: n.id, station: stn, flights: n.flights.slice(), text: n.text, status: n.status, selected: n.selected });
        });
      });
      return out;
    };

    // ---- window.open instrumentation / popup blocking ----
    var __nativeOpen = window.open.bind(window);
    window.open = function (url, target) {
      if (window.__CFG.blockPopup) { window.__openCalls.push({ url: String(url), blocked: true }); return null; }
      var w = __nativeOpen(url, target);
      window.__popupRef = w;
      try { w.__popupRef = true; } catch (e) { /* cross-origin */ }
      window.__openCalls.push({ url: String(url), blocked: false });
      return w;
    };

    // ---- message instrumentation (records everything Web 2 receives) ----
    window.addEventListener('message', function (ev) {
      var topMatch = null;
      try { topMatch = (window.__popupRef && ev.source && ev.source.top === window.__popupRef); }
      catch (e) { topMatch = 'ERR:' + e.message; }
      window.__diag.push({
        t: Date.now(),
        type: ev.data && ev.data.type,
        origin: ev.origin,
        nonce: ev.data && ev.data.nonce ? String(ev.data.nonce) : '',
        sourceNotNull: !!ev.source,
        sourceTopMatchesPopup: topMatch
      });
      // Every inbound message is reported server-side too, so evidence does not
      // depend on the page staying alive.
      fetch('/ipc-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: ev.data && ev.data.type, origin: ev.origin, sourceTopMatchesPopup: topMatch })
      }).catch(function () {});
    });

    // ---- report-script test hooks (read at script parse time) ----
    window.__REPORT_WEB1_ORIGINS = ${JSON.stringify([WEB1_ORIGIN])};
    window.__REPORT_WEB1_URL_OVERRIDE = ${JSON.stringify(`${WEB1_ORIGIN}/?page=report`)};
    window.__REPORT_RECEIPT_TIMEOUT_MS = ${Number(cfg.receiptTimeoutMs || 0) || 'undefined'};
    window.__REPORT_READY_TIMEOUT_MS = ${Number(cfg.readyTimeoutMs || 0) || 'undefined'};
    ${claimedOrigin ? `(function () {
      var nativeLocation = window.location;
      var claimed = ${JSON.stringify(claimedOrigin)};
      try {
        Object.defineProperty(window, '__claimedOrigin', { value: claimed, configurable: true });
        var loc = { origin: claimed, protocol: 'https:', href: nativeLocation.href };
        Object.defineProperty(window, 'location', { configurable: true, get: function () { return loc; } });
      } catch (e) { /* fall back to the real location */ }
    })();` : ''}

    ${reportScriptFor(mutate)}
  </script>
</body></html>`;
}

// ---------------------------------------------------------------- Web 1 page
//
// `outcome` drives the mocked RPC results. `readyMode` decides who announces
// readiness for the handshake:
//   'real'   : the shipped page sends READY itself (the normal path); the stub
//              hands it the same nonce Web 2 put in the fragment.
//   'silent' : nobody announces readiness (readiness-timeout scenario).
//   'mock'   : the stub's transport hook sends READY (and can inject a forged
//              nonce first), while the shipped page is halted by a mismatched
//              fragment nonce so it cannot send its own READY.
// `ackMode`: 'ok' | 'silent' | 'reject' — drives the receipt for any CONTEXT.
export function buildWeb1Html({ outcome, readyMode = 'real', ackMode = 'ok', stubNonce, sourceOrigin }) {
  const stubHash = readyMode === 'mock'
    ? `#nonce=${encodeURIComponent('stub-control-nonce')}&sourceOrigin=${encodeURIComponent(sourceOrigin)}`
    : `#nonce=${encodeURIComponent(stubNonce || '')}&sourceOrigin=${encodeURIComponent(sourceOrigin)}`;
  const stub = `<script>
  window.__outcome = ${JSON.stringify(outcome)};
  window.__readyMode = ${JSON.stringify(readyMode)};
  window.__ackMode = ${JSON.stringify(ackMode)};
  window.__calls = [];
  window.__received = { count: 0, payloadJson: '', payloadHash: '', flights: [], template: '', status: '' };
  window.__contextCount = 0;
  window.__confirmCalls = 0;
  window.__statusCalls = 0;
  window.__stubNonce = ${JSON.stringify(stubNonce || '')};

  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(value[k]); }).join(',') + '}';
  }
  function sha256Hex(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function chain(handlers) {
    var outcome = window.__outcome;
    var api = {
      withSuccessHandler: function (fn) { handlers.success = fn; return api; },
      withFailureHandler: function (fn) { handlers.failure = fn; return api; },
      reportHandoffDiagnostic: function () {
        window.__calls.push('reportHandoffDiagnostic');
        if (outcome === 'unauthorized') { if (handlers.failure) handlers.failure(new Error('No active user email; operator identity unavailable.')); }
        else if (handlers.success) handlers.success({ ok: true, activeUser: 'chtdniel@gmail.com', isAuthorized: true, templates: { CBR1: true, CBR2: true, CBR4: true }, errors: [] });
        return api;
      },
      recordReportReceived: function (p) {
        window.__calls.push('recordReportReceived');
        window.__received.count += 1;
        window.__received.payloadJson = JSON.stringify(p);
        window.__received.flights = (p.flights || []).map(function (f) { return f.FLIGHT; });
        var n = (p.flights || []).length;
        var template = n === 1 ? 'CBR1' : (n === 2 ? 'CBR2' : 'CBR4');
        window.__received.template = template;
        var first = window.__received.count === 1;
        if (outcome === 'receipt-silent') return; // RPC never answers: lost receipt
        setTimeout(function () {
          if (outcome === 'unauthorized') { if (handlers.success) handlers.success({ ok: false, status: 'UNAUTHORIZED', error: 'No active user email; operator identity unavailable.' }); return; }
          if (outcome === 'request-conflict') { if (handlers.success) handlers.success({ ok: false, status: 'REQUEST_CONFLICT', error: 'Same request ID received with a different payload.' }); return; }
          sha256Hex(canonicalJson(p)).then(function (h) {
            if (first) { window.__received.payloadHash = h; window.__received.status = 'AWAITING_CONFIRMATION'; }
            if (handlers.success) handlers.success({
              ok: true, status: 'AWAITING_CONFIRMATION', reportRequestId: p.reportRequestId,
              previewExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              retryable: false, template: template
            });
          });
        }, 0);
        return api;
      },
      confirmReport: function (p) {
        window.__calls.push('confirmReport');
        window.__confirmCalls += 1;
        if (outcome === 'confirm-timeout') return api; // never answers: browser deadline
        setTimeout(function () {
          if (outcome === 'reconciliation-required') { if (handlers.success) handlers.success({ ok: false, status: 'RECONCILIATION_REQUIRED', reportRequestId: p.reportRequestId, error: 'A Sheet for this request may already exist; reconcile before retrying.' }); }
          else if (outcome === 'unknown') { if (handlers.success) handlers.success({ ok: false, status: 'UNKNOWN', reportRequestId: p.reportRequestId, error: 'Creation outcome uncertain; use CHECK REPORT STATUS.' }); }
          else if (outcome === 'busy') { if (handlers.success) handlers.success({ ok: false, status: 'BUSY', reportRequestId: p.reportRequestId, error: 'Could not acquire the report lock within 5000ms.' }); }
          else if (outcome === 'failed') { if (handlers.success) handlers.success({ ok: false, status: 'FAILED', reportRequestId: p.reportRequestId, retryable: true, error: 'Proven pre-create failure.' }); }
          else { if (handlers.success) handlers.success({ ok: true, status: 'SUCCEEDED', reportRequestId: p.reportRequestId, spreadsheetId: 'SS_GATEC_MOCK', url: 'https://docs.google.com/spreadsheets/d/SS_GATEC_MOCK/edit' }); }
        }, 0);
        return api;
      },
      getReportStatus: function (rid) {
        window.__calls.push('getReportStatus');
        window.__statusCalls += 1;
        setTimeout(function () {
          if (outcome === 'status-not-found') { if (handlers.success) handlers.success({ ok: false, status: 'NOT_FOUND', error: 'No audit record for request ' + rid }); return; }
          if (handlers.success) handlers.success({ ok: true, status: 'SUCCEEDED', reportRequestId: rid, spreadsheetId: 'SS_GATEC_MOCK', url: 'https://docs.google.com/spreadsheets/d/SS_GATEC_MOCK/edit' });
        }, 0);
        return api;
      }
    };
    return api;
  }

  window.google = {
    script: {
      url: {
        // Apps Script's asynchronous URL callback. The fragment is the only place
        // the one-time nonce travels, so the stub hands the page the same values
        // Web 2 put in the URL (or a control nonce in mock mode).
        getLocation: function (cb) { cb({ hash: ${JSON.stringify(stubHash)} }); }
      },
      run: {
        withSuccessHandler: function (fn) { return chain({ success: fn }); },
        withFailureHandler: function (fn) { return chain({ failure: fn }); }
      }
    }
  };
  </script>`;
  return reportHtmlRaw.replace('<base target="_top">', '<base target="_top">' + stub);
}

// Mock transport hook. The shipped page owns READY on the normal path; this hook
// only injects forged signals (bad-nonce / foreign-origin modes) and drives the
// receipt for any CONTEXT that arrives.
//
// `ready` modes:
//   'none'        : only the shipped page announces readiness
//   'silent'      : nobody announces readiness
//   'bad-nonce'   : a READY carrying a wrong nonce arrives before the genuine one
//   'foreign'     : a READY with the right nonce but claiming `foreignOrigin`
//   'foreign-source': right origin and nonce, but posted from `foreignOrigin`
function web1Transport({ ready, ack, sourceOrigin, readyDelayMs = 0, foreignOrigin = null }) {
  return `<script>
  (function () {
    var ready = ${JSON.stringify(ready)};
    var ack = ${JSON.stringify(ack)};
    var readyDelayMs = ${Number(readyDelayMs) || 0};
    var sourceOrigin = ${JSON.stringify(sourceOrigin)};
    var foreignOrigin = ${JSON.stringify(foreignOrigin)};
    var nonce = window.__stubNonce || '';
    function target() { try { return (window.top && window.top.opener) || null; } catch (e) { return null; } }
    function send(type, extra, origin) {
      var t = target();
      if (!t) return false;
      try { t.postMessage(Object.assign({ type: type, nonce: nonce }, extra || {}), origin || sourceOrigin); } catch (e) { return false; }
      return true;
    }
    if (ready === 'bad-nonce') {
      setTimeout(function () { send('AWQ_REPORT_READY', { nonce: 'nonce-not-from-web2' }); }, readyDelayMs);
    }
    if (ready === 'foreign') {
      // Right-hand value, untrusted origin: Web 2 must ignore it by origin.
      setTimeout(function () { send('AWQ_REPORT_READY', {}, foreignOrigin || 'http://127.0.0.1:8790'); }, readyDelayMs);
    }
    window.addEventListener('message', function (ev) {
      if (!ev.data || ev.data.type !== 'AWQ_REPORT_CONTEXT') return;
      window.__contextCount += 1;
      window.__lastContextNonce = ev.data.nonce;
      if (ack === 'silent') return;
      var rid = (ev.data.payload && ev.data.payload.reportRequestId) || '';
      setTimeout(function () {
        if (ack === 'reject') send('AWQ_REPORT_REJECTED', { reportRequestId: rid, reason: 'payload rejected by staging Web 1' });
        else send('AWQ_REPORT_ACCEPTED', { reportRequestId: rid, status: 'AWAITING_CONFIRMATION', ok: true });
      }, 30);
    });
  })();
  </script>`;
}

const attackPage = `<!doctype html><html><body><div id="attack">attack frame ready (unrelated origin ${ATTACK_ORIGIN})</div></body></html>`;

// ------------------------------------------------------------- server state
const state = {
  dataset: null,
  datasets: new Map(), // token → dataset (oversize fixtures exceed a sane URL length)
  nonce: '',           // faked fragment nonce handed to the Web 1 fixture page
  cfg: {},
  outcome: 'ok',
  ready: 'real',
  ack: 'ok',
  log: []
};
let datasetSeq = 0;

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onListening); reject(e); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

let servers = null;

/** Start the fixture servers once for the whole suite. */
export async function startHarness() {
  if (servers) return harnessHandle();

  const s2 = createServer((req, res) => {
    const url = new URL(req.url, WEB2_ORIGIN);
    if (req.method === 'POST' && url.pathname === '/log') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const entry = JSON.parse(body);
          state.log.push({ t: new Date().toISOString(), source: 'web2', ...entry });
        } catch { /* ignore */ }
        res.writeHead(204); res.end();
      });
      return;
    }
    // Oversize fixtures do not fit in a URL; register them and pass a token.
    if (req.method === 'POST' && url.pathname === '/datasets') {      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const token = 'ds' + (++datasetSeq);
        try {
          state.datasets.set(token, JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // Independent observation channel for the origin-mismatch attack.
    if (url.pathname === '/attack-report') {
      state.log.push({ t: new Date().toISOString(), source: 'attack-report', type: 'AWQ_ATTACK_REPORT', nonce: url.searchParams.get('nonce') || '' });
      res.writeHead(204); res.end();
      return;
    }
    // Server-side log of every postMessage Web 2 received.
    if (req.method === 'POST' && url.pathname === '/ipc-log') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { state.log.push({ t: new Date().toISOString(), source: 'ipc', ...JSON.parse(body) }); } catch { /* ignore */ }
        res.writeHead(204); res.end();
      });
      return;
    }
    const view = url.searchParams.get('view') || 'sel1';
    const mutate = url.searchParams.get('mutate') === '1';
    // Test-only: advertise a source origin Web 2 does not allowlist, which halts
    // the shipped Web 1 page so a transport hook can inject forged signals.
    const claimedOrigin = url.searchParams.get('xorigin') || null;
    let options = state.dataset;
    let cfg = {};
    if (view === 'vs') {
      const inline = url.searchParams.get('ds');
      const token = url.searchParams.get('dst');
      options = token ? state.datasets.get(token) : JSON.parse(inline || '{}');
    } else if (view === 'popup') {
      cfg = { blockPopup: true };
    } else if (view === 'ready-timeout') {
      cfg = { readyTimeoutMs: Number(url.searchParams.get('ms') || 1800) };
    } else if (view === 'receipt-timeout') {
      cfg = { receiptTimeoutMs: Number(url.searchParams.get('ms') || 2500) };
    } else if (view === 'oversize' || view === 'origin-mismatch') {
      cfg = {};
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(web2Html(options, view, cfg, mutate, claimedOrigin));
  });

  const s1 = createServer((req, res) => {
    const url = new URL(req.url, WEB1_ORIGIN);
    const pageOutcome = url.searchParams.get('outcome') || state.outcome;
    const readyMode = url.searchParams.get('ready') || state.ready;   // real | silent
    const ackMode = url.searchParams.get('ack') || state.ack;         // ok | silent | reject
    const readyDelayMs = Number(url.searchParams.get('readyDelayMs') || state.readyDelayMs || 0);
    // The faked fragment control value cannot arrive via the URL fragment
    // (browsers strip it from the HTTP request), so the suite publishes it here.
    // Without a nonce the shipped page halts — used for the readiness-timeout
    // and origin-mismatch scenarios.
    const stubNonce = url.searchParams.get('stubNonce') ?? state.nonce ?? '';
    const silent = readyMode === 'silent' || !stubNonce;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const html = buildWeb1Html({
      outcome: pageOutcome,
      readyMode: silent ? 'silent' : 'real',
      ackMode,
      stubNonce,
      sourceOrigin: WEB2_ORIGIN
    }).replace('</body>', web1Transport({
      ready: silent ? 'silent' : readyMode,
      ack: ackMode,
      sourceOrigin: WEB2_ORIGIN,
      readyDelayMs,
      foreignOrigin: ATTACK_ORIGIN
    }) + '</body>');
    res.end(html);
  });

  const s3 = createServer((req, res) => {
    const url = new URL(req.url, ATTACK_ORIGIN);
    if (url.pathname === '/attack-ready') {
      let diag = null;
      try { diag = JSON.parse(url.searchParams.get('diag') || 'null'); } catch { /* ignore */ }
      state.log.push({
        t: new Date().toISOString(),
        source: 'attack',
        type: 'AWQ_REPORT_READY',
        nonce: url.searchParams.get('nonce') || '',
        diag
      });
      res.writeHead(204); res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(attackPage);
  });

  await listen(s2, WEB2_PORT);
  await listen(s1, WEB1_PORT);
  await listen(s3, ATTACK_PORT);
  servers = { s2, s1, s3 };
  return harnessHandle();
}

function harnessHandle() {
  return {
    web2Url: `${WEB2_ORIGIN}/`,
    web1Url: `${WEB1_ORIGIN}/`,
    attackUrl: `${ATTACK_ORIGIN}/`,
    /** Publish the faked fragment nonce the Web 1 fixture page should see. */
    setNonce(nonce) { state.nonce = String(nonce || ''); },
    /** Web 1 fixture URL with explicit per-tab transport behaviour. */
    web1PageUrl({ outcome, ready, ack } = {}) {
      // Omitted parameters fall back to the configured defaults (URL query wins).
      const url = new URL('/?page=report', WEB1_ORIGIN);
      if (outcome) url.searchParams.set('outcome', outcome);
      if (ready) url.searchParams.set('ready', ready);
      if (ack) url.searchParams.set('ack', ack);
      const qs = url.searchParams.toString();
      return WEB1_ORIGIN + '/' + (qs ? '?' + qs : '');
    },
    log: () => state.log.map((e) => ({ ...e })),
    clearLog: () => { state.log.length = 0; },
    /** Register a large data set and return a short token for the fixture URL. */
    async putDataset(dataset) {
      const res = await fetch(`${WEB2_ORIGIN}/datasets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dataset)
      });
      const { token } = await res.json();
      return token;
    },
    /**
     * Origin-mismatch attack, staged as follows so the guard under test really is
     * the source-relationship check:
     *   1. an unrelated-origin frame is injected inside the Web 1 tab;
     *   2. Web 1's test relay (same origin as the frame) posts the shipped READY
     *      envelope *from that frame's window* at Web 2 with the real nonce;
     *   3. Web 1 withholds its own READY long enough that the forged one is the
     *      first readiness Web 2 sees.
     * A real attacker cannot reference the Web 2 window at all, so the relay
     * supplies that reachability; the forged message itself stays cross-origin.
     */
    async armAttack({ nonce, web1Frame, attackUrl }) {
      await web1Frame.evaluate((url) => {
        if (document.getElementById('gatec-attack-frame')) return;
        const f = document.createElement('iframe');
        f.id = 'gatec-attack-frame';
        f.src = url;
        document.body.appendChild(f);
      }, attackUrl);
      await new Promise((r) => setTimeout(r, 800));
      return web1Frame.evaluate(async (n) => {
        const frame = document.getElementById('gatec-attack-frame');
        const target = 'http://127.0.0.1:8788';
        const diag = { marker: 'attack-relay-v5', nonceSeen: !!n };
        const cw = frame.contentWindow;
        diag.hasContentWindow = !!cw;
        diag.frameSrc = frame.src;
        diag.relayDocumentUrl = location.href;
        diag.relayOrigin = location.origin;
        diag.popupRefSet = !!window.__popupRef;
        diag.openerPresent = !!window.top.opener;
        diag.framed = (() => { try { return cw.top !== cw.self; } catch (e) { return 'cross-origin'; } })();
        try {
          cw.postMessage({ type: 'AWQ_REPORT_READY', nonce: n }, target);
          diag.postAttempted = true;
        } catch (e) { diag.thrown = e.message; }
        // Independent observation: a Web 2 fixture route records any READY that
        // actually reaches the Web 2 window, whatever the guard decides.
        try {
          const res = await fetch('http://127.0.0.1:8788/attack-report?nonce=' + encodeURIComponent(n));
          diag.reported = res.status;
        } catch (e) { diag.reportFailed = e.message; }
        return diag;
      }, nonce);
    },
    /** Configure the default dataset/transport used when the URL omits them. */
    set(options = {}) {
      if (options.dataset) state.dataset = options.dataset;
      if (options.web1) {
        if (options.web1.outcome) state.outcome = options.web1.outcome;
        if (options.web1.ready) state.ready = options.web1.ready;
        if (options.web1.ack) state.ack = options.web1.ack;
        if (options.web1.readyDelayMs !== undefined) state.readyDelayMs = options.web1.readyDelayMs;
        if (options.web1.nonce !== undefined) state.nonce = options.web1.nonce;
      }
    },
    /** Kept for API parity with the per-scenario harness; servers stay up. */
    async close() {}
  };
}

/** Force the servers down (used once at the end of a suite). */
export async function stopHarness() {
  if (!servers) return;
  const { s2, s1, s3 } = servers;
  servers = null;
  await Promise.all([s2, s1, s3].map((s) => new Promise((r) => s.close(r))));
}

export { reportHtmlRaw, reportScript };
