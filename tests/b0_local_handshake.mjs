// Local end-to-end smoke of the reconstructed handoff: Web 2 (openReportWeb1)
// -> mock Web 1 (archive/Report.html) -> READY -> CONTEXT -> ACCEPTED.
// Runs fully offline (no Apps Script); proves the protocol + code wiring, NOT
// the Apps Script iframe/opener relationship (that needs the real B0 probe).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const reportHtml = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');

const web1Html = await readFile(new URL('../archive/Report.html', import.meta.url), 'utf8');

const flight = {
  rowIdx: 17, FLIGHT: 'QZ646', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS',
  STD: '0300', STA: '0600', REG: 'PK-AZK', ALT: 'WMKK', TAF_DEP: 'TAF WIII', TAF_ARR: 'TAF WSSS', ENR1: 'WARA'
};

const web2Html = `<!doctype html><html><body>
  <button id="btn-download-sheet" type="button" onclick="window.openReportWeb1()">DOWNLOAD SHEET</button>
  <div id="report-status"></div>
  <script>
    window.escapeHtml = function (value) { return String(value == null ? '' : value); };
    window.safeStorage = { get: function (key, fb) { return key === 'occ_notam_analysis' ? ${JSON.stringify({ QZ646: ['A0001/26'] })} : (fb || {}); } };
    window.getSelectedFlightObjects = function () { return [${JSON.stringify(flight)}]; };
    window.__REPORT_WEB1_ORIGINS = ['http://127.0.0.1:8789'];
    var _open = window.open.bind(window);
    window.open = function (url, target) {
      var u = new URL(url);
      var mapped = 'http://127.0.0.1:8789/' + (u.search || '') + (u.hash || '');
      return _open(mapped, target);
    };
    ${reportScript}
  </script>
</body></html>`;

const server2 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(web2Html); });
const server1 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(web1Html); });
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
  if (!popup) { console.error('FAIL: no popup opened'); process.exitCode = 1; }
  else {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(1000);
      const term = await page.locator('#report-status').innerText().catch(() => '');
      if (term.includes('accepted the report context') || term.includes('rejected the report context') || term.includes('did not signal ready')) break;
    }
    const web2Term = await page.locator('#report-status').innerText().catch(() => '(none)');
    const web1Status = await popup.locator('#status').innerText().catch(() => '(unreadable)');
    console.log('--- Web 2 terminal ---\n' + web2Term);
    console.log('--- Web 1 status ---\n' + web1Status);
    const pass = web2Term.includes('accepted the report context');
    console.log('\nLOCAL HANDSHAKE: ' + (pass ? 'PASS' : 'FAIL'));
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser.close().catch(() => {});
  server1.close();
  server2.close();
}
