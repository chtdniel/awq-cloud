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
const artifactDirectory = join(tmpdir(), 'awq-fir-report-browser-' + Date.now());
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
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname));
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
function assertWorkbook(bytes) {
  const files = unzip(bytes);
  const report = files.get('xl/worksheets/sheet5.xml').toString();
  const selected = files.get('xl/worksheets/sheet17.xml').toString();
  assert.match(report, /QZ646/);
  assert.match(report, /PK-AZK/);
  assert.match(selected, /SELECTED AERODROME RUNWAY/);
  assert.match(selected, /UPDATED FIR AIRSPACE/);
  assert.doesNotMatch(selected, /UNSELECTED AERODROME RUNWAY/);
}
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
await context.addInitScript(() => {
  localStorage.setItem('occ_active_board', JSON.stringify([1]));
  localStorage.setItem('occ_notam_analysis', JSON.stringify({ QZ646: ['A2001/26', 'A1001/26', 'A1002/26'], QZ999: ['A2001/26'] }));
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
  await page.goto(baseUrl);
  await page.getByRole('checkbox', { name: 'Select flight QZ646', exact: true }).check();
  await page.locator('#nav-data').click();
  await page.locator('[data-tab="fir-update"]').click();
  const replacement = notam('A1001/26', 'E', 'UPDATED FIR AIRSPACE');
  await page.locator('#firn-bulk-raw').fill(replacement);
  await page.locator('#firn-bulk-preview').click();
  await page.waitForFunction(() => document.getElementById('firn-bulk-status').textContent.includes('overwrite-valid 1'));
  assert.equal(await page.locator('#firn-bulk-import').isDisabled(), true);
  assert.equal(await page.locator('#firn-bulk-overwrite').isEnabled(), true);
  await page.screenshot({ path: join(artifactDirectory, 'fir-overwrite-preview.png'), fullPage: true });
  await page.locator('#firn-bulk-raw').fill(replacement + '\n');
  assert.equal(await page.locator('#firn-bulk-overwrite').isDisabled(), true);
  assert.match(await page.locator('#firn-bulk-status').innerText(), /Text changed/);
  await page.locator('#firn-bulk-preview').click();
  await page.waitForFunction(() => !document.getElementById('firn-bulk-overwrite').disabled);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#firn-bulk-overwrite').click();
  await page.waitForFunction(() => document.getElementById('firn-bulk-status').textContent.includes('replaced the previous dataset'));
  assert.equal(database.prepare("SELECT count(*) AS count FROM notams WHERE kind = 'FIR'").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM notams WHERE kind = 'AD'").get().count, 2);
  assert.match(database.prepare("SELECT message FROM notams WHERE id = 'A1001/26'").get().message, /UPDATED FIR AIRSPACE/);
  console.log('PASS FIR UI duplicate overwrite, stale preview invalidation and AD preservation');
  seed('A2003/26', 'A', 'MISLABELED AERODROME', 'FIR');
  await page.locator('#nav-fir').click();
  await page.waitForFunction(() => /NOTAM: 1 active \/ 1/.test(document.getElementById('fir-notam-status').textContent));
  await page.screenshot({ path: join(artifactDirectory, 'fir-display.png'), fullPage: true });
  await page.locator('#nav-fir-notam').click();
  await page.waitForFunction(() => document.getElementById('firn-results-list').textContent.includes('A1001/26'));
  assert.doesNotMatch(await page.locator('#firn-results-list').innerText(), /A200[123]\/26|AERODROME/);
  await page.screenshot({ path: join(artifactDirectory, 'fir-notam-results.png'), fullPage: true });
  console.log('PASS FIR display and results exclude AD and legacy mislabeled aerodrome records');
  const staleResponse = await page.evaluate(async () => {
    const response = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'generateReportXlsx', args: [window.getReportSheetPayload()] }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(staleResponse.status, 400);
  assert.match(staleResponse.body.error, /Selected NOTAMs have changed or expired/);
  await page.locator('#nav-notam').click();
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('occ_notam_analysis'));
    return saved && !saved.QZ646.includes('A1002/26');
  });
  const refreshed = await page.evaluate(() => JSON.parse(localStorage.getItem('occ_notam_analysis')));
  assert.deepEqual(refreshed.QZ646, ['A2001/26', 'A1001/26']);
  assert.deepEqual(refreshed.QZ999, ['A2001/26']);
  console.log('PASS stale report rejection and analysis refresh recovery preserving AD, FIR and other flight selections');
  await page.locator('#nav-report').click();
  await page.waitForFunction(() => document.getElementById('report-sum-count').textContent === '1');
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  
  await page.locator('#btn-download-sheet').click();
  // Wait for the button to be re-enabled indicating fetch completed or failed
  await page.waitForFunction(() => !document.getElementById('btn-download-sheet').disabled, { timeout: 30000 });

  const download = await downloadPromise;
  await download.saveAs(join(artifactDirectory, 'downloaded-report.xlsx'));
  assertWorkbook(await readFile(await download.path()));
  await page.waitForFunction(() => !document.getElementById('btn-google-sheet').disabled);
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-google-sheet').click();
  const popup = await popupPromise;
  await popup.waitForURL('https://docs.google.com/spreadsheets/d/fixture-sheet-123/edit');
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('Report created.'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].headers.authorization, 'Bearer fixture-token');
  const boundary = uploads[0].headers['content-type'].split('boundary=')[1];
  const multipart = uploads[0].body;
  assert.match(multipart.toString('utf8', 0, 400), /application\/vnd.google-apps.spreadsheet/);
  const workbookStart = multipart.indexOf(Buffer.from('PK\x03\x04', 'binary'));
  const workbookEnd = multipart.lastIndexOf(Buffer.from('\r\n--' + boundary));
  assert.ok(workbookStart > 0 && workbookEnd > workbookStart);
  assertWorkbook(multipart.subarray(workbookStart, workbookEnd));
  assert.match(await page.locator('#report-status a').getAttribute('href'), /fixture-sheet-123\/edit$/);
  await page.screenshot({ path: join(artifactDirectory, 'report-google-success.png'), fullPage: true });
  await popup.close();
  console.log('PASS Report XLSX download, selected analysis, Google multipart conversion and automatic Sheets tab');
  consentMode = 'deny';
  await page.locator('#btn-google-sheet').click();
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('permission was not granted'));
  assert.equal(uploads.length, 1);
  assert.equal(await page.locator('#btn-google-sheet').isEnabled(), true);
  consentMode = 'allow';
  uploadMode = 'error';
  await page.locator('#btn-google-sheet').click();
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('Fixture Drive permission error'));
  assert.equal(await page.locator('#btn-google-sheet').isEnabled(), true);
  googleConfigured = false;
  await page.reload();
  await page.getByRole('checkbox', { name: 'Select flight QZ646', exact: true }).check();
  await page.locator('#nav-report').click();
  await page.waitForFunction(() => !document.getElementById('btn-google-sheet').disabled);
  await page.locator('#btn-google-sheet').click();
  await page.waitForFunction(() => document.getElementById('report-status').textContent.includes('GOOGLE_OAUTH_CLIENT_ID'));
  assert.equal(await page.locator('#btn-download-sheet').isEnabled(), true);
  await page.screenshot({ path: join(artifactDirectory, 'report-google-missing-config.png'), fullPage: true });
  console.log('PASS Google consent denial, upload failure recovery and missing configuration with XLSX available');
  assert.deepEqual(pageErrors, [], 'browser should not produce uncaught JavaScript errors');
  await writeFile(join(artifactDirectory, 'evidence.json'), JSON.stringify({ passed: true, rpcMethods: rpcRequests.map(request => request.method), uploads: uploads.length, pageErrors, limitation: 'Google identity and Drive responses are intercepted fixtures; real OAuth consent and Google import rendering require configured credentials.' }, null, 2));
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
