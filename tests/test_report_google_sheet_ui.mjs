// Focused replacement for the deleted tests/test_fir_report_browser.mjs.
//
// That test failed on an assertion that had gone obsolete: it expected a click on
// #btn-download-sheet to produce a .xlsx download, but the button now hands the
// report context to the Web 1 / Google Sheets generator (window.openReportWeb1).
// Deleting it wholesale would also have dropped three behaviours that no other
// test covered, so those are ported here against their current contract:
//
//   1. #btn-download-sheet stays wired to the handoff — never back to the removed
//      window.downloadReportXlsx() blob download. This is the exact drift that
//      broke the old test, asserted statically so no popup is opened (the handoff
//      round trip itself is covered by tests/b0_*.mjs).
//   2. The FIR flight list follows Flight Board changes (occ:boardChanged).
//   3. A report whose saved NOTAM analysis points at a NOTAM that no longer
//      exists is refused with a 400, and re-running analysis recovers.
//   4. CREATE GOOGLE SHEET: Drive multipart import, consent denial, upload
//      failure recovery, and the missing-OAuth-configuration path.
//
// Deliberately NOT covered here (already owned elsewhere): FIR bulk overwrite
// preview (tests/test_fir_update_ui.mjs), AD/mislabeled aerodrome exclusion
// (tests/test_gatec_aerodrome_only.mjs, tests/test_fir_import.mjs), the
// generateReportXlsx core (tests/test_briefing_xlsx.mjs) and the report handoff
// (tests/b0_*.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');
const artifactDirectory = join(tmpdir(), 'awq-report-google-sheet-' + Date.now());
await mkdir(artifactDirectory);
console.log('QA artifacts: ' + artifactDirectory);

const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const database = new DatabaseSync(':memory:');
database.exec(await readFile('schema.sql', 'utf8'));
database.exec('ALTER TABLE notams ADD COLUMN updated_at TEXT DEFAULT NULL');
database.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('SETTINGS_ADMIN_EMAILS', 'admin@example.com');
database.prepare('INSERT INTO flights (id, callsign, dep, dest, ac_type, etd, eta, alt, dof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(1, 'QZ646', 'WIII', 'WSSS', 'PK-AZK', '0300', '0600', 'WMKK', '2026-09-14');
database.prepare('INSERT INTO tafs (station, raw_text) VALUES (?, ?)').run('WIII', 'TAF WIII 140000Z 1400/1506 12005KT 9999 SCT020');

const notam = (number, scope, description, location = 'WIIF') => `(${number} NOTAMN\nQ) WIIF/QRTCA/IV/BO/${scope}/000/999/0600S10600E005\nA) ${location} B) 2609010000 C) 2610010000\nE) ${description})`;
function seed(number, scope, description, kind, location = 'WIIF') {
  database.prepare('INSERT INTO notams (id, location, message, valid_from, valid_to, kind) VALUES (?, ?, ?, ?, ?, ?)')
    .run(number, location, notam(number, scope, description, location), '2026-09-01 00:00', '2026-10-01 00:00', kind);
}
seed('A1001/26', 'E', 'OLD FIR AIRSPACE', 'FIR');
seed('A1002/26', 'E', 'STALE FIR AIRSPACE', 'FIR');
seed('A2001/26', 'A', 'SELECTED AERODROME RUNWAY', 'AD', 'WIII');
seed('A2002/26', 'A', 'UNSELECTED AERODROME RUNWAY', 'AD', 'WIII');

function statement(sql, parameters = []) {
  return {
    bind(...values) { return statement(sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}
const DB = {
  prepare: statement,
  async batch(statements) {
    database.exec('BEGIN');
    try {
      const results = [];
      for (const prepared of statements) results.push(await prepared.run());
      database.exec('COMMIT');
      return results;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
};

const authHeaders = await seedAuthUser(database, DB, 'admin');
const publicDirectory = resolve('public');
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json', '.svg': 'image/svg+xml' };
async function asset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname === '/app' ? '/app/index.html' : pathname));
  if (!filename.startsWith(publicDirectory + '\\') && !filename.startsWith(publicDirectory + '/')) return new Response('Forbidden', { status: 403 });
  try { return new Response(await readFile(filename), { headers: { 'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
}

const rpcRequests = [];
let googleConfigured = true;
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = 'http://' + incoming.headers.host + incoming.url;
    let response;
    if (incoming.url === '/api/rpc') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      rpcRequests.push(JSON.parse(body));
      const headers = new Headers(incoming.headers);
      for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value);
      response = await onRequestPost({ request: new Request(url, { method: 'POST', headers, body }), env: { DB, ASSETS: { fetch: asset } } });
    } else if (incoming.url === '/api/google-sheets-config') {
      response = Response.json({ clientId: googleConfigured ? 'fixture-client.apps.googleusercontent.com' : '' });
    } else response = await asset(new Request(url));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

// ---- workbook helpers -----------------------------------------------------
// Cell text is written inline (no sharedStrings indirection), the same layout
// tests/test_briefing_xlsx.mjs relies on.
function unzip(bytes) {
  const files = new Map();
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'workbook must contain a ZIP directory');
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return files;
}
// Scans every worksheet rather than pinning sheet indexes: the point is which
// NOTAMs reach the briefing, not which sheet number they landed on.
function assertReportWorkbook(bytes) {
  const files = unzip(bytes);
  const sheets = [...files.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, content]) => content.toString('utf8'));
  assert.ok(sheets.length > 0, 'workbook must contain at least one worksheet');
  const has = text => sheets.some(sheet => sheet.includes(text));
  assert.ok(has('QZ646'), 'the workbook must carry the flight callsign');
  assert.ok(has('PK-AZK'), 'the workbook must carry the aircraft registration');
  assert.ok(has('SELECTED AERODROME RUNWAY'), 'a NOTAM the operator selected must reach the workbook');
  assert.ok(has('OLD FIR AIRSPACE'), 'the selected FIR NOTAM must reach the workbook');
  assert.ok(!has('UNSELECTED AERODROME RUNWAY'), 'a NOTAM the operator never ticked must never reach the workbook');
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
await context.addInitScript(() => {
  // Seed once, never overwrite. The Google Sheets popup is a page in this same
  // context and starts life as about:blank, so it shares the app origin's
  // localStorage; an unconditional seed here would restore the ORIGINAL analysis
  // and silently undo the stale-NOTAM recovery. Asserted again before the second
  // Sheets attempt so the trap cannot come back unnoticed.
  if (!localStorage.getItem('occ_notam_analysis')) {
    localStorage.setItem('occ_notam_analysis', JSON.stringify({ QZ646: ['A2001/26', 'A1001/26', 'A1002/26'], QZ999: ['A2001/26'] }));
  }
  if (!localStorage.getItem('occ_active_board')) {
    localStorage.setItem('occ_active_board', JSON.stringify([1]));
  }
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

let consentMode = 'allow';
let uploadMode = 'success';
const uploads = [];
await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'text/javascript', body: `window.google = window.google || {}; window.google.accounts = { oauth2: { hasGrantedAllScopes: function(result) { return !result.error; }, initTokenClient: function(options) { window.__fixtureTokenClient = options; options.requestAccessToken = async function() { const mode = await window.__fixtureConsentMode(); options.callback(mode === 'deny' ? { error: 'access_denied' } : { access_token: 'fixture-token', scope: 'https://www.googleapis.com/auth/drive.file' }); }; return options; } } };` }));
await page.exposeFunction('__fixtureConsentMode', () => consentMode);
await context.route('https://www.googleapis.com/upload/drive/v3/files?**', async route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  const request = route.request();
  uploads.push({ headers: request.headers(), body: request.postDataBuffer() });
  await route.fulfill({ status: uploadMode === 'success' ? 200 : 403, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(uploadMode === 'success' ? { id: 'fixture-sheet-123' } : { error: { message: 'Fixture Drive permission error' } }) });
});
await context.route('https://docs.google.com/spreadsheets/d/fixture-sheet-123/edit', route => route.fulfill({ contentType: 'text/html', body: '<title>Fixture Google Sheet</title><h1>Google Sheets external boundary fixture</h1>' }));

try {
  await page.goto(baseUrl + '/app');
  await page.getByRole('checkbox', { name: 'Select flight QZ646', exact: true }).check();

  // ---- 1. #btn-download-sheet is the handoff, not a blob download ----------
  // Static assertion on purpose: clicking it opens a popup into Web 1, which is
  // the b0_*.mjs suites' job. What matters here is that nobody re-points the
  // button at the removed window.downloadReportXlsx(), which is what made the
  // old browser test wait forever for a download event.
  const sheetButtonHandler = await page.locator('#btn-download-sheet').getAttribute('onclick');
  assert.match(sheetButtonHandler || '', /openReportWeb1\(\)/, '#btn-download-sheet must stay wired to the report handoff');
  assert.doesNotMatch(sheetButtonHandler || '', /downloadReportXlsx/, '#btn-download-sheet must not go back to the removed XLSX blob download');
  assert.equal(await page.evaluate(() => typeof window.openReportWeb1), 'function', 'the handoff entry point must exist');
  console.log('PASS DOWNLOAD SHEET stays a handoff into the Sheets generator (no obsolete .xlsx download)');

  // ---- 2. The FIR flight list follows Flight Board changes -----------------
  await page.locator('#nav-fir').click();
  await page.waitForFunction(() => document.querySelector('#fir-flight-list .fir-callsign')?.textContent === 'QZ646');
  assert.match(await page.locator('#fir-flight-list').innerText(), /QZ646/);
  await page.evaluate(() => {
    window.activeBoardRowIds = [];
    localStorage.setItem('occ_active_board', '[]');
    window.dispatchEvent(new CustomEvent('occ:boardChanged', { detail: { ids: [] } }));
  });
  await page.waitForFunction(() => document.getElementById('fir-flight-list')?.textContent.includes('No flights on Flight Board'));
  await page.evaluate(() => {
    window.activeBoardRowIds = [1];
    localStorage.setItem('occ_active_board', '[1]');
    window.dispatchEvent(new CustomEvent('occ:boardChanged', { detail: { ids: [1] } }));
  });
  await page.waitForFunction(() => document.querySelector('#fir-flight-list .fir-callsign')?.textContent === 'QZ646');
  console.log('PASS FIR flight list loads the active Flight Board and follows board changes');

  // ---- 3. A NOTAM removed under a saved analysis is refused, then recovered -
  // Real-world shape: the operator ticked A1002/26 earlier; the NOTAM is gone by
  // the time the report is generated. Clear it in the DB after asserting the
  // client still selects it, so the 400 cannot pass vacuously.
  const analysisBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('occ_notam_analysis')));
  assert.ok(analysisBefore.QZ646.includes('A1002/26'), 'precondition: the saved analysis must still select the NOTAM we are about to remove');
  database.prepare("DELETE FROM notams WHERE id = 'A1002/26'").run();
  const staleResponse = await page.evaluate(async () => {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'generateReportXlsx', args: [window.getReportSheetPayload()] })
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(staleResponse.status, 400, 'a report built on a vanished NOTAM must be refused, not silently generated');
  assert.match(staleResponse.body.error, /Selected NOTAMs have changed or expired/);
  await page.locator('#nav-notam').click();
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('occ_notam_analysis'));
    return saved && !saved.QZ646.includes('A1002/26');
  });
  const refreshed = await page.evaluate(() => JSON.parse(localStorage.getItem('occ_notam_analysis')));
  assert.deepEqual(refreshed.QZ646, ['A2001/26', 'A1001/26'], 're-running analysis must drop the vanished NOTAM and keep the rest');
  assert.deepEqual(refreshed.QZ999, ['A2001/26'], 'another flight\u2019s selection must survive the refresh untouched');
  console.log('PASS stale report rejection (400) and analysis recovery that drops the vanished NOTAM');

  // ---- 4. CREATE GOOGLE SHEET ----------------------------------------------
  await page.locator('#nav-report').click();
  await page.waitForFunction(() => document.getElementById('report-sum-count').textContent === '1');
  await page.waitForFunction(() => !document.getElementById('btn-google-sheet').disabled);

  // 4a. Happy path: Drive multipart import into a new Google Sheet.
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-google-sheet').click();
  const popup = await popupPromise;
  await popup.waitForURL('https://docs.google.com/spreadsheets/d/fixture-sheet-123/edit');
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('Report created.'));
  assert.equal(uploads.length, 1, 'exactly one Drive upload per CREATE GOOGLE SHEET click');
  assert.equal(uploads[0].headers.authorization, 'Bearer fixture-token');
  const boundary = uploads[0].headers['content-type'].split('boundary=')[1];
  const multipart = uploads[0].body;
  assert.match(multipart.toString('utf8', 0, 400), /application\/vnd\.google-apps\.spreadsheet/);
  const workbookStart = multipart.indexOf(Buffer.from('PK\x03\x04', 'binary'));
  const workbookEnd = multipart.lastIndexOf(Buffer.from('\r\n--' + boundary));
  assert.ok(workbookStart > 0 && workbookEnd > workbookStart, 'the multipart body must embed the generated workbook');
  assertReportWorkbook(multipart.subarray(workbookStart, workbookEnd));
  assert.match(await page.locator('#report-status a').getAttribute('href'), /fixture-sheet-123\/edit$/);
  await page.screenshot({ path: join(artifactDirectory, 'report-google-success.png'), fullPage: true });
  console.log('PASS Google Sheets multipart import carries the briefing workbook and opens the new sheet');

  // 4b. Consent denied: no upload, clear message, buttons usable again.
  //     Also the guard for the seeding trap: the popup opened in 4a must not have
  //     put the vanished NOTAM back into the saved analysis.
  const analysisAfterPopup = await page.evaluate(() => JSON.parse(localStorage.getItem('occ_notam_analysis')));
  assert.deepEqual(analysisAfterPopup.QZ646, ['A2001/26', 'A1001/26'], 'the Sheets popup must not re-seed the app analysis behind the operator');
  consentMode = 'deny';
  await page.locator('#btn-google-sheet').click();
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('permission was not granted'));
  assert.equal(uploads.length, 1, 'a denied consent must not upload anything');
  assert.equal(await page.locator('#btn-google-sheet').isEnabled(), true, 'a denied consent must leave the button usable');
  console.log('PASS denied Google consent uploads nothing and leaves the form usable');

  // 4c. Drive rejects the upload: surfaced, and the form recovers.
  consentMode = 'allow';
  uploadMode = 'error';
  await page.locator('#btn-google-sheet').click();
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('Fixture Drive permission error'));
  assert.equal(await page.locator('#btn-google-sheet').isEnabled(), true, 'a failed Drive upload must leave the button usable');
  console.log('PASS failed Drive upload is reported and the form recovers');

  // 4d. No OAuth client configured: the Sheets path fails closed while the
  //     handoff button stays available.
  uploadMode = 'success';
  googleConfigured = false;
  await page.reload();
  await page.getByRole('checkbox', { name: 'Select flight QZ646', exact: true }).check();
  await page.locator('#nav-report').click();
  await page.waitForFunction(() => !document.getElementById('btn-google-sheet').disabled);
  await page.locator('#btn-google-sheet').click();
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('GOOGLE_OAUTH_CLIENT_ID'));
  assert.equal(await page.locator('#btn-download-sheet').isEnabled(), true, 'the report handoff must stay available when Google Sheets is unconfigured');
  await page.screenshot({ path: join(artifactDirectory, 'report-google-missing-config.png'), fullPage: true });
  console.log('PASS missing GOOGLE_OAUTH_CLIENT_ID fails closed with the handoff still available');

  assert.deepEqual(pageErrors, [], 'browser should not produce uncaught JavaScript errors');
  await writeFile(join(artifactDirectory, 'evidence.json'), JSON.stringify({
    passed: true,
    rpcMethods: rpcRequests.map(request => request.method),
    driveUploads: uploads.length,
    pageErrors,
    limitation: 'Google identity and Drive responses are intercepted fixtures; real OAuth consent and Google import rendering require configured credentials.'
  }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'failure.png'), fullPage: true });
  await writeFile(join(artifactDirectory, 'failure.html'), await page.content());
  console.error('Browser errors:', pageErrors);
  throw error;
} finally {
  await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
  database.close();
}
