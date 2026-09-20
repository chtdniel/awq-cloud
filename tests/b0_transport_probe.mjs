// Gate B0 transport proof probe.
// Proves READY -> CONTEXT -> ACCEPTED across the real Apps Script iframe,
// and records window/iframe relationships for Chrome/Edge/Firefox evidence.
//
// Usage:
//   node tests/b0_transport_probe.mjs                 # chromium, firefox, webkit (installed ones)
//   node tests/b0_transport_probe.mjs chromium        # single browser
//
// The real Web 1 deployment must already serve ?page=report (see docs/nonproduction-deploy-guide.md).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const reportHtml = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');
const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reportScript) throw new Error('inline <script> not found in src/Report_Ui.html');

const flight = {
  rowIdx: 17, FLIGHT: 'QZ646', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS',
  STD: '0300', STA: '0600', REG: 'PK-AZK', ALT: 'WMKK', TAF_DEP: 'TAF WIII', TAF_ARR: 'TAF WSSS', ENR1: 'WARA'
};

// Minimal Web 2 harness that loads the reconstructed report script + B0 instrumentation.
const harnessHtml = `<!doctype html><html><body>
  <button id="btn-download-sheet" type="button" onclick="window.openReportWeb1()">DOWNLOAD SHEET</button>
  <div id="report-status"></div>
  <script>
    window.escapeHtml = function (value) { return String(value == null ? '' : value); };
    window.safeStorage = {
      get: function (key, fallback) {
        if (key === 'occ_notam_analysis') return ${JSON.stringify({ QZ646: ['A0001/26'] })};
        return fallback || {};
      }
    };
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
    window.__popupRef = null;
    window.__diag = [];
    var _open = window.open.bind(window);
    window.open = function (url, target) { var w = _open(url, target); window.__popupRef = w; return w; };
    window.addEventListener('message', function (ev) {
      var topMatch = null;
      try { topMatch = (window.__popupRef && ev.source && ev.source.top === window.__popupRef); }
      catch (e) { topMatch = 'ERR:' + e.message; }
      window.__diag.push({
        t: Date.now(),
        type: ev.data && ev.data.type,
        origin: ev.origin,
        sourceNotNull: !!ev.source,
        sourceTopMatchesPopup: topMatch
      });
    });
    ${reportScript}
  </script>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(harnessHtml);
});
await new Promise((resolve) => server.listen(8788, '127.0.0.1', resolve));

const BASE = 'http://127.0.0.1:8788/';

async function readWeb1Frames(popup) {
  const frames = [];
  let status = '(no #status found)';
  for (const f of popup.frames()) {
    frames.push(f.url());
    const el = f.locator('#status');
    if (await el.count() > 0) {
      status = await el.innerText().catch(() => '(unreadable)');
    }
  }
  return { frames, status };
}

async function run(browserType, name) {
  const out = { browser: name, ok: false, error: null, web2Terminal: '', web2Diag: [], web1Frames: [], web1Status: '', web1Url: '' };
  let browser;
  try {
    browser = await browserType.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE);
    const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await page.click('#btn-download-sheet');
    const popup = await popupPromise;
    if (!popup) { out.error = 'popup did not open (blocked?)'; return out; }
    out.web1Url = popup.url();
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    // poll for handshake completion (readiness 30s + receipt 10s => allow ~45s)
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(1000);
      const term = await page.locator('#report-status').innerText().catch(() => '');
      if (term.includes('accepted the report context') || term.includes('rejected the report context') || term.includes('did not signal ready')) break;
    }
    out.web2Terminal = await page.locator('#report-status').innerText().catch(() => '(none)');
    out.web2Diag = await page.evaluate(() => window.__diag);
    const w1 = await readWeb1Frames(popup);
    out.web1Frames = w1.frames;
    out.web1Status = w1.status;
    out.ok = out.web2Terminal.includes('accepted the report context');
    return out;
  } catch (e) {
    out.error = e.message;
    return out;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const wanted = (process.argv[2] || '').toLowerCase();
const targets = [];
if (!wanted || wanted === 'chromium') targets.push([chromium, 'chromium']);
if (!wanted || wanted === 'firefox') targets.push([firefox, 'firefox']);
if (!wanted || wanted === 'webkit') targets.push([webkit, 'webkit']);

const results = [];
for (const [bt, name] of targets) {
  process.stderr.write(`\n=== running ${name} ===\n`);
  results.push(await run(bt, name));
}

console.log('\n===== B0 TRANSPORT PROOF RESULTS =====');
for (const r of results) {
  console.log('\n--- ' + r.browser + ' ---');
  console.log('PASS: ' + (r.ok ? 'YES' : 'NO'));
  if (r.error) console.log('ERROR: ' + r.error);
  console.log('web1Url: ' + r.web1Url);
  console.log('web1Frames (' + r.web1Frames.length + '):');
  r.web1Frames.forEach((u) => console.log('  - ' + u));
  console.log('web2 message evidence:');
  for (const d of r.web2Diag) {
    console.log('  - type=' + d.type + ' origin=' + d.origin + ' sourceNotNull=' + d.sourceNotNull + ' sourceTopMatchesPopup=' + d.sourceTopMatchesPopup);
  }
  console.log('--- web1 #status ---');
  console.log(r.web1Status);
  console.log('--- web2 terminal ---');
  console.log(r.web2Terminal);
}

const allPass = results.every((r) => r.ok);
server.close();
process.exit(allPass ? 0 : 1);
