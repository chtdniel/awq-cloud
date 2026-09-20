// Manual B0 transport test for REAL Firefox (no Playwright).
// Serves a minimal Web 2 harness on http://127.0.0.1:8788 that loads the
// reconstructed openReportWeb1 code and opens the real Web 1 (Apps Script).
//
// Usage:
//   node tests/serve_b0_manual.mjs
//   -> open http://127.0.0.1:8788/ in Firefox
//   -> click DOWNLOAD SHEET
//   -> watch the terminal on this page AND the Web 1 tab that opens
//   -> PASS = terminal shows "Web 1 accepted the report context (...)"
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const reportHtml = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');

const flight = {
  rowIdx: 17, FLIGHT: 'QZ646', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS',
  STD: '0300', STA: '0600', REG: 'PK-AZK', ALT: 'WMKK', TAF_DEP: 'TAF WIII', TAF_ARR: 'TAF WSSS', ENR1: 'WARA'
};

const harness = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { background:#0b0f14; color:#d7e3f0; font-family:Consolas,monospace; padding:24px; }
  #report-status { white-space:pre-wrap; background:#111820; border:1px solid #233240; border-radius:8px; padding:16px; min-height:240px; }
  button { padding:10px 20px; font-family:inherit; font-weight:bold; cursor:pointer; margin-bottom:16px; }
</style></head><body>
  <h2>B0 manual test — Web 2 mock (Firefox)</h2>
  <button id="btn-download-sheet" type="button" onclick="window.openReportWeb1()">DOWNLOAD SHEET</button>
  <div id="report-status">ready…</div>
  <script>
    window.escapeHtml = function (v) { return String(v == null ? '' : v); };
    window.safeStorage = { get: function (k, fb) { return k === 'occ_notam_analysis' ? ${JSON.stringify({ QZ646: ['A0001/26'] })} : (fb || {}); } };
    window.getSelectedFlightObjects = function () { return [${JSON.stringify(flight)}]; };
    window.getReportTafContext = function (stations) {
      return (stations || []).map(function (s) {
        return { station: s, text: 'TAF ' + s + ' 121700Z 1218/1324 27005KT 9999 SCT020', issueTime: '2026-09-12T18:35:44.700Z', available: true };
      });
    };
    window.getReportNotamContext = function (flights) {
      return (flights || []).map(function (f) {
        return { id: 'A0001/26', station: f.DEP, flights: [f.FLIGHT], text: 'A0001/26 NOTAMN Q) WIII/QWELW/IV/BO /W /000/010 E) SAMPLE NOTAM TEXT', status: 'IMPACTED', selected: true };
      });
    };
    ${reportScript}
  </script>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(harness);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error('Port 8788 dipakai — tutup proses lain dulu (taskkill /F /IM node.exe, atau tunggu).'); process.exit(1); }
  throw e;
});

server.listen(8788, '127.0.0.1', () => {
  console.log('Web 2 mock: http://127.0.0.1:8788/');
  console.log('Buka URL itu di browser yang SUDAH LOGIN Google (mis. Chrome), lalu klik DOWNLOAD SHEET.');
  console.log('PASS = terminal menampilkan: Web 1 accepted the report context (...)');
  console.log('Ctrl+C untuk berhenti.');
});
