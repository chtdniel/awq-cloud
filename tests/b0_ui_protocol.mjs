// Gate B browser protocol test for the Web 1 UI (archive/Report.html).
// Serves a mock Web 2 opener + the real Report.html with a mocked google.script.run,
// then drives the full Gate B flow: CONTEXT -> recordReportReceived -> preview ->
// ACCEPTED, confirm -> SUCCEEDED, CHECK REPORT STATUS.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const reportUi = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
const reportScript = reportUi.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');

let reportHtml = await readFile(new URL('../archive/Report.html', import.meta.url), 'utf8');

// Inject a google.script stub BEFORE Report.html's own script (fragment + RPC mock).
const googleStub = `<script>
  window.__calls = [];
  window.__receipt = { ok: true };
  window.google = {
    script: {
      url: { getLocation: function (cb) { cb({ hash: window.location.hash || '' }); } },
      run: (function () {
        var success = null, failure = null;
        var api = {
          withSuccessHandler: function (fn) { success = fn; return api; },
          withFailureHandler: function (fn) { failure = fn; return api; },
          reportHandoffDiagnostic: function () { window.__calls.push('reportHandoffDiagnostic'); if (success) success({ ok: true, activeUser: 'ops@x.com', templates: { CBR1: true }, errors: [] }); return api; },
          recordReportReceived: function (p) {
            window.__calls.push('recordReportReceived');
            if (window.__receipt.ok) { if (success) success({ ok: true, status: 'AWAITING_CONFIRMATION', reportRequestId: p.reportRequestId, template: 'CBR1', previewExpiresAt: '2026-09-19T00:15:00.000Z' }); }
            else { if (success) success({ ok: false, status: 'UNAUTHORIZED', error: 'receipt denied' }); }
            return api;
          },
          confirmReport: function () { window.__calls.push('confirmReport'); if (success) success({ ok: true, status: 'SUCCEEDED', url: 'https://docs.google.com/spreadsheets/d/SS_GEN_1/edit' }); return api; },
          getReportStatus: function () { window.__calls.push('getReportStatus'); if (success) success({ ok: true, status: 'SUCCEEDED', url: 'https://docs.google.com/spreadsheets/d/SS_GEN_1/edit' }); return api; }
        };
        return api;
      })()
    }
  };
</script>`;
reportHtml = reportHtml.replace('<base target="_top">', '<base target="_top">' + googleStub);

const flight = {
  rowIdx: 17, FLIGHT: 'QZ646', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS',
  STD: '0300', STA: '0600', REG: 'PK-AZK', ALT: 'WMKK', TAF_DEP: 'BOARD DEP', TAF_ARR: 'BOARD ARR', ENR1: 'WARA'
};

const web2Html = `<!doctype html><html><body>
  <button id="btn-download-sheet" type="button" onclick="window.openReportWeb1()">DOWNLOAD SHEET</button>
  <div id="report-status"></div>
  <script>
    window.escapeHtml = function (v) { return String(v == null ? '' : v); };
    window.safeStorage = { get: function (k, fb) { return k === 'occ_notam_analysis' ? ${JSON.stringify({ QZ646: ['A0001/26'] })} : (fb || {}); } };
    window.getSelectedFlightObjects = function () { return [${JSON.stringify(flight)}]; };
    window.getReportTafContext = function (stations) { return (stations || []).map(function (s) { return { station: s, text: 'TAF ' + s + ' 121700Z 1218/1324 27005KT 9999 SCT020', issueTime: '2026-09-12T18:35:44.700Z', available: true }; }); };
    window.getReportNotamContext = function (flights) { return (flights || []).map(function (f) { return { id: 'A0001/26', station: f.DEP, flights: [f.FLIGHT], text: 'A0001/26 NOTAMN E) SAMPLE', status: 'IMPACTED', selected: true }; }); };
    window.__REPORT_WEB1_ORIGINS = ['http://127.0.0.1:8789'];
    var _open = window.open.bind(window);
    window.open = function (url, target) { var u = new URL(url); return _open('http://127.0.0.1:8789/' + (u.search || '') + (u.hash || ''), target); };
    ${reportScript}
  </script>
</body></html>`;

const server2 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(web2Html); });
const server1 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(reportHtml); });
await new Promise((r) => server2.listen(8788, '127.0.0.1', r));
await new Promise((r) => server1.listen(8789, '127.0.0.1', r));

let pass = 0;
async function check(name, fn) { await fn(); pass++; console.log('  ok - ' + name); }

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8788/app');
  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.click('#btn-download-sheet');
  const popup = await popupPromise;
  assert.ok(popup, 'Web 1 popup must open');
  await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await popup.waitForTimeout(500);
    const calls = await popup.evaluate(() => window.__calls || []);
    if (calls.includes('recordReportReceived')) break;
  }

  console.log('gate B UI protocol tests');

  await check('CONTEXT triggers recordReportReceived and renders the preview', async () => {
    const calls = await popup.evaluate(() => window.__calls || []);
    assert.ok(calls.includes('recordReportReceived'), 'receipt RPC called');
    assert.equal(await popup.locator('#preview').isVisible(), true);
    const text = await popup.locator('#preview-body').innerText();
    assert.match(text, /CBR1/);
    assert.match(text, /QZ646/);
    assert.match(text, /Selected NOTAMs/);
    assert.match(text, /NO SIG stations/);
  });

  await check('Web 2 receives ACCEPTED only after the receipt', async () => {
    const term = await page.locator('#report-status').innerText();
    assert.match(term, /accepted the report context/);
  });

  await check('confirm calls confirmReport once and shows the Sheet link', async () => {
    await popup.click('#btn-confirm');
    for (let i = 0; i < 20; i++) {
      await popup.waitForTimeout(300);
      const calls = await popup.evaluate(() => window.__calls || []);
      if (calls.filter((c) => c === 'confirmReport').length >= 1) break;
    }
    const calls = await popup.evaluate(() => window.__calls || []);
    assert.equal(calls.filter((c) => c === 'confirmReport').length, 1);
    const result = await popup.locator('#result').innerText();
    assert.match(result, /SUCCEEDED/);
    assert.match(result, /OPEN GOOGLE SHEET/);
  });

  await check('CHECK REPORT STATUS calls getReportStatus and reports SUCCEEDED', async () => {
    await popup.click('#btn-check');
    await popup.waitForTimeout(500);
    const calls = await popup.evaluate(() => window.__calls || []);
    assert.equal(calls.filter((c) => c === 'getReportStatus').length, 1);
    const result = await popup.locator('#result').innerText();
    assert.match(result, /SUCCEEDED/);
  });
} finally {
  await browser.close().catch(() => {});
  server1.close(); server2.close();
}

console.log('\n' + pass + ' checks passed');
