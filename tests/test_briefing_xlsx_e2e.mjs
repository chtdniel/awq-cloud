// Round-trip E2E: call the REAL handleGenerateBriefingXlsx with a stub context,
// unzip the result with Expand-Archive, assert filled cells + intact styles.
// Run: node tests/test_briefing_xlsx_e2e.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// briefing-xlsx.js is a Workers ES module but package.json is commonjs → load via temp .mjs copy.
const bxSrc = path.join(repo, 'functions', 'api', 'briefing-xlsx.js');
const bxTmp = path.join(os.tmpdir(), 'briefing-xlsx.e2e.mjs');
(await import('node:fs')).copyFileSync(bxSrc, bxTmp);
const mod = await import(pathToFileURL(bxTmp).href);
const tplBytes = await readFile(path.join(repo, 'public', 'briefing-template.xlsx'));

const form = {
  fields: { recNo: 'TEST-001', formDate: '2026-09-13 10:00Z', pageOf: '1 of 1' },
  legs: [
    { flightNo: 'QZ646', date: '2026-09-13', reg: 'PK-AZK', pod: 'WIII', std: '0300', poa: 'WSSS', sta: '0600', alt: 'WMKK', ofpRef: 'OFP1' },
    { flightNo: 'QZ647', date: '2026-09-13', reg: 'PK-AZF', pod: 'WSSS', std: '0700', poa: 'WIII', sta: '0800', alt: 'WARR', ofpRef: 'OFP2' }
  ],
  tafs: [
    { slot: 'POD1', station: 'WIII', time: '0300', forecast: 'TAF WIII TEST' },
    { slot: 'POA1', station: 'WSSS', time: '0600', forecast: 'TAF WSSS TEST' }
  ],
  notams: [{ station: 'WIII', text: 'A9999/26 TEST NOTAM' }],
  signatures: { dxrName: 'TEST DXR', picName: 'TEST PIC' }
};

const context = {
  request: { url: 'https://x.test/api/rpc' },
  env: {}
};
// stub fetch for the template URL only
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('briefing-template.xlsx')) {
    return new Response(tplBytes, { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
  }
  return realFetch(url);
};

const res = await mod.handleGenerateBriefingXlsx(context, [form]);
const assert = (c, msg) => { if (!c) { console.error('FAIL:', msg); process.exit(1); } console.log('PASS:', msg); };
assert(res.status === 200, 'handler returns 200 (got ' + res.status + ')');
assert((res.headers.get('Content-Type') || '').includes('spreadsheetml'), 'xlsx content type');

const outDir = path.join(os.tmpdir(), 'cbr-e2e');
const zipPath = path.join(outDir, 'out.zip');
await import('node:fs').then(async (fs) => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
});
const uDir = path.join(outDir, 'u');
try { execFileSync('powershell', ['-NoProfile', '-Command', `if (Test-Path '${uDir}') { Remove-Item -Recurse -Force '${uDir}' }; Expand-Archive '${zipPath}' '${uDir}' -Force`]); }
catch (e) { console.error('FAIL: unzip:', e.message); process.exit(1); }
const fs2 = await import('node:fs');
const sheet = fs2.readFileSync(path.join(uDir, 'xl', 'worksheets', 'sheet5.xml'), 'utf8');
const has = (t) => sheet.includes(t);
assert(has('QZ646') && has('QZ647'), 'leg flight numbers filled');
assert(has('PK-AZK') && has('PK-AZF'), 'leg regs filled');
assert(has('TEST-001'), 'recNo filled');
assert(has('TAF WIII TEST') && has('TAF WSSS TEST'), 'TAF forecasts filled');
assert(has('A9999/26 TEST NOTAM'), 'NOTAM text filled');
assert(has('TEST DXR') && has('TEST PIC'), 'signatures filled');
assert(has('mergeCell'), 'merges preserved');
const drawing = fs2.readFileSync(path.join(uDir, 'xl', 'worksheets', '_rels', 'sheet5.xml.rels'), 'utf8');
assert(drawing.includes('drawing'), 'drawing rel (logo) preserved');
assert(fs2.existsSync(path.join(uDir, 'xl', 'media', 'image2.png')), 'logo image bytes preserved');
console.log('E2E briefing-xlsx checks passed.');
