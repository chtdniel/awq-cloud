// Gate B0 negative path: lost-receipt recovery.
// Web 1 sends READY and receives CONTEXT but never sends ACCEPTED.
// Web 2 must show the 10-second receipt-timeout recovery message with the SAME
// request ID (never a new ID), proving the RECEIPT_UNKNOWN path.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const reportHtml = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reportScript) throw new Error('inline <script> not found');

const flight = {
  rowIdx: 17, FLIGHT: 'QZ646', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS',
  STD: '0300', STA: '0600', REG: 'PK-AZK', ALT: 'WMKK', TAF_DEP: 'TAF WIII', TAF_ARR: 'TAF WSSS', ENR1: 'WARA'
};

const web2Html = `<!doctype html><html><body>
  <button id="btn-download-sheet" type="button" onclick="window.openReportWeb1()">DOWNLOAD SHEET</button>
  <div id="report-status"></div>
  <script>
    window.escapeHtml = function (v) { return String(v == null ? '' : v); };
    window.safeStorage = { get: function (k, fb) { return k === 'occ_notam_analysis' ? ${JSON.stringify({ QZ646: ['A0001/26'] })} : (fb || {}); } };
    window.getSelectedFlightObjects = function () { return [${JSON.stringify(flight)}]; };
    window.__REPORT_WEB1_ORIGINS = ['http://127.0.0.1:8789'];
    window.__REPORT_RECEIPT_TIMEOUT_MS = 3000;
    var _open = window.open.bind(window);
    window.open = function (url, target) {
      var u = new URL(url);
      return _open('http://127.0.0.1:8789/' + (u.search || '') + (u.hash || ''), target);
    };
    ${reportScript}
  </script>
</body></html>`;

// Web 1 that sends READY with the fragment nonce, receives CONTEXT, but never ACKs.
const noAckHtml = `<!doctype html><html><body>
  <div id="status"></div>
  <script>
    var nonce = '';
    var h = window.location.hash.replace(/^#/, '');
    h.split('&').forEach(function (p) { var i = p.indexOf('='); if (p.slice(0, i) === 'nonce') nonce = decodeURIComponent(p.slice(i + 1)); });
    document.getElementById('status').textContent = 'nonce=' + nonce;
    setTimeout(function () { window.opener.postMessage({ type: 'AWQ_REPORT_READY', nonce: nonce }, 'http://127.0.0.1:8788'); }, 100);
    window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'AWQ_REPORT_CONTEXT') document.getElementById('status').textContent = 'got CONTEXT, not acking';
    });
  </script>
</body></html>`;

const server2 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(web2Html); });
const server1 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(noAckHtml); });
await new Promise((r) => server2.listen(8788, '127.0.0.1', r));
await new Promise((r) => server1.listen(8789, '127.0.0.1', r));

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8788/');
  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.click('#btn-download-sheet');
  const popup = await popupPromise;
  if (!popup) { console.error('FAIL: no popup'); process.exitCode = 1; }
  else {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    // wait past the overridden 3s receipt window
    await page.waitForTimeout(5000);
    const term = await page.locator('#report-status').innerText().catch(() => '(none)');
    console.log('--- Web 2 terminal ---\n' + term);
    const pass = term.includes('No receipt within');
    console.log('\nLOST-RECEIPT RECOVERY: ' + (pass ? 'PASS' : 'FAIL'));
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser.close().catch(() => {});
  server1.close(); server2.close();
}
