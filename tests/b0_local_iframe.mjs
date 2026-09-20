// Local simulation of the Apps Script iframe nesting, cross-browser:
//   Web 2 -> window.open(WRAPPER) -> WRAPPER embeds <iframe src=Web1> -> Report.html
// Verifies the iframe-aware contract: event.source.top === popup (Web 2 side) and
// window.top.opener (Web 1 side) across two cross-origin hops.
// NOT a substitute for the real B0 probe, but de-risks the window-relationship logic.
//
// Usage: node tests/b0_local_iframe.mjs [chromium|firefox|webkit]   (default: all)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

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
      var mapped = 'http://127.0.0.1:8787/' + (u.search || '') + (u.hash || '');
      return _open(mapped, target);
    };
    ${reportScript}
  </script>
</body></html>`;

const wrapperHtml = `<!doctype html><html><body style="margin:0">
  <script>
    var ifr = document.createElement('iframe');
    ifr.src = 'http://127.0.0.1:8789/' + (window.location.hash || '');
    ifr.style.cssText = 'width:100%;height:100%;border:0;display:block';
    document.body.appendChild(ifr);
  </script>
</body></html>`;

const server2 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(web2Html); });
const serverWrap = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(wrapperHtml); });
const server1 = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(web1Html); });
await new Promise((r) => server2.listen(8788, '127.0.0.1', r));
await new Promise((r) => serverWrap.listen(8787, '127.0.0.1', r));
await new Promise((r) => server1.listen(8789, '127.0.0.1', r));

async function run(browserType, name) {
  const out = { browser: name, pass: false, error: null, web2Term: '', web1Status: '' };
  let browser;
  try {
    browser = await browserType.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:8788/');
    const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await page.click('#btn-download-sheet');
    const popup = await popupPromise;
    if (!popup) { out.error = 'no popup opened'; return out; }
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(1000);
      const term = await page.locator('#report-status').innerText().catch(() => '');
      if (term.includes('accepted the report context') || term.includes('rejected the report context') || term.includes('did not signal ready')) break;
    }
    out.web2Term = await page.locator('#report-status').innerText().catch(() => '(none)');
    for (const f of popup.frames()) {
      const el = f.locator('#status');
      if (await el.count() > 0) out.web1Status = await el.innerText().catch(() => '(unreadable)');
    }
    out.pass = out.web2Term.includes('accepted the report context');
    return out;
  } catch (e) { out.error = e.message; return out; }
  finally { if (browser) await browser.close().catch(() => {}); }
}

const wanted = (process.argv[2] || '').toLowerCase();
const targets = [];
if (!wanted || wanted === 'chromium') targets.push([chromium, 'chromium']);
if (!wanted || wanted === 'firefox') targets.push([firefox, 'firefox']);
if (!wanted || wanted === 'webkit') targets.push([webkit, 'webkit']);

let allPass = true;
for (const [bt, name] of targets) {
  process.stderr.write(`\n=== ${name} ===\n`);
  const r = await run(bt, name);
  if (!r.pass) allPass = false;
  console.log(`${name}: ${r.pass ? 'PASS' : 'FAIL'}${r.error ? '  ERROR=' + r.error : ''}`);
  console.log(r.web2Term.trim());
  if (!r.pass && r.web1Status) console.log('  web1: ' + r.web1Status.split('\n')[0]);
}

server1.close(); serverWrap.close(); server2.close();
process.exit(allPass ? 0 : 1);
