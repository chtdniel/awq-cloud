// E2E self-check: server-side functions simulating the Worker runtime pieces
// used by briefing-xlsx.js (ZIP round-trip + inline cell edit).
// Run: node tests/test_briefing_xlsx.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tplPath = path.join(repo, 'public', 'briefing-template.xlsx');
const tpl = new Uint8Array(await readFile(tplPath));
console.log('template bytes:', tpl.length);

// --- replicate parseLocalEntries + CRC + buildZip from briefing-xlsx.js ---
// (imported logic duplicated here is intentional: the worker file must stay
// dependency-free and importable by wrangler, this test re-implements the
// seam to prove the format contract independently.)
function parseLocalEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('EOCD not found');
  const count = view.getUint16(eocd + 10, true);
  let cdOff = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(cdOff + 10, true);
    const compSize = view.getUint32(cdOff + 20, true);
    const nameLen = view.getUint16(cdOff + 28, true);
    const extraLen = view.getUint16(cdOff + 30, true);
    const commentLen = view.getUint16(cdOff + 32, true);
    const lhOff = view.getUint32(cdOff + 42, true);
    const nameBytes = bytes.slice(cdOff + 46, cdOff + 46 + nameLen);
    const lhNameLen = view.getUint16(lhOff + 26, true);
    const lhExtraLen = view.getUint16(lhOff + 28, true);
    const dataOff = lhOff + 30 + lhNameLen + lhExtraLen;
    entries.push({ name: new TextDecoder().decode(nameBytes), method, nameBytes, data: bytes.slice(dataOff, dataOff + compSize) });
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const assert = (c, msg) => { if (!c) { console.error('FAIL:', msg); process.exit(1); } console.log('PASS:', msg); };

const entries = parseLocalEntries(tpl);
assert(entries.length > 50, 'template parses as ZIP with 50+ entries (' + entries.length + ')');
const names = entries.map(e => e.name);
assert(names.includes('xl/workbook.xml'), 'workbook.xml present');
assert(names.includes('xl/worksheets/sheet5.xml'), 'CBR sheet5.xml present');
assert(names.includes('xl/media/image2.png'), 'logo image present');
assert(names.includes('[Content_Types].xml'), '[Content_Types] present');
const methods = new Set(entries.map(e => e.method));
assert(methods.has(8), 'template uses deflate (method 8) — inflate path required, stored-only would fail');

const rawOf = (name) => {
  const e = entries.find(x => x.name === name);
  const buf = Buffer.from(e.data);
  return new TextDecoder().decode(e.method === 8 ? inflateRawSync(buf) : buf);
};
const wb = rawOf('xl/workbook.xml');
const cbrTag = (wb.match(/<sheet[^>]*name="CBR"[^>]*\/>/) || [])[0] || '';
const cbr = cbrTag.match(/r:id="([^"]+)"/);
assert(!!cbr, 'CBR sheet found in workbook.xml, rId=' + (cbr && cbr[1]));

// spot-check the real template anchors the generator writes
const sheet5 = rawOf('xl/worksheets/sheet5.xml');
for (const ref of ['R2', 'T3', 'T4', 'B8', 'D8', 'G8', 'I8', 'J8', 'K8', 'N8', 'R8', 'E48', 'O48', 'C39', 'E39', 'C30', 'D30', 'G30']) {
  assert(sheet5.includes('<c r="' + ref + '"'), 'anchor cell ' + ref + ' exists in CBR sheet');
}
{
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = await build({ entryPoints: [path.join(repoRoot, 'functions/api/rpc.js')], bundle: true, platform: 'node', format: 'esm', write: false, absWorkingDir: repoRoot });
  const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const authSource = await readFile(path.join(repoRoot, 'functions/api/auth.js'), 'utf8');
  const { hashPassword, createSession } = await import('data:text/javascript;base64,' + Buffer.from(authSource).toString('base64'));

  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE auth_users (id INTEGER PRIMARY KEY AUTOINCREMENT, email_normalized TEXT UNIQUE, email_display TEXT, password_hash TEXT, password_salt TEXT, password_iterations INTEGER, password_algorithm TEXT, role TEXT, is_active INTEGER DEFAULT 1, must_change_password INTEGER DEFAULT 0, failed_login_count INTEGER DEFAULT 0, locked_until TEXT, created_at TEXT, updated_at TEXT, last_login_at TEXT);
    CREATE TABLE auth_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, token_hash TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, revoked_at TEXT);
    CREATE TABLE auth_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, action TEXT, target_user_id INTEGER, request_id TEXT, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, change_summary TEXT);
  `);
  const statement = (sql, params = []) => ({ bind: (...v) => statement(sql, v), async all() { return { results: database.prepare(sql).all(...params) }; }, async first() { return database.prepare(sql).get(...params) || null; }, async run() { return database.prepare(sql).run(...params); } });
  const DB = { prepare: (sql, params) => statement(sql, params), async batch(list) { for (const s of list) await s.run(); } };
  const encoded = await hashPassword('correct horse battery staple');
  database.prepare('INSERT INTO auth_users (email_normalized, email_display, password_hash, password_salt, password_iterations, password_algorithm, role, is_active) VALUES (?,?,?,?,?,?,?,1)')
    .run('t@example.com', 't@example.com', encoded.hash, encoded.salt, encoded.iterations, encoded.algorithm, 'admin');
  const userId = database.prepare('SELECT id FROM auth_users').get().id;
  const session = await createSession({ request: new Request('http://localhost/api/rpc'), env: { DB } }, userId);
  const cookieJar = session.headers.getSetCookie();
  const sessionCookie = cookieJar.find(v => v.startsWith('__Host-awq_session=')).split(';', 1)[0];
  const csrfCookie = cookieJar.find(v => v.startsWith('awq_csrf=')).split(';', 1)[0];
  const headers = { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', Cookie: sessionCookie + '; ' + csrfCookie, 'X-AWQ-CSRF': csrfCookie.split('=')[1] };
  const ASSETS = { async fetch() { return new Response(tpl, { status: 200 }); } };

  const payload = {
    formType: 'CREW BRIEFING REPORT FORM',
    legs: [{ leg: 1, flightNo: '646', date: '18 Sep 2026', reg: 'PK-AZK', pod: 'WADD', std: '0325', poa: 'WATO', sta: '0440', alt: '', ofpRef: '' }],
    tafs: [{ slot: 'POD1', station: 'WADD', stationEntered: 'WADD', time: '0325', forecast: 'NIL', flight: '646' }],
    notams: [{ station: 'WADD', stationEntered: 'WADD', flights: ['646'], enr: false, text: 'NIL' }],
    signatures: { dxrName: 'CHRIS DANIEL (LIC: FOOL-881234)', picName: 'PIC TEST' },
    fields: { pageOf: '1 of 1', formDate: '18 Sep 2026', dxrName: 'CHRIS DANIEL (LIC: FOOL-881234)', picName: 'PIC TEST' }
  };
  const request = new Request('http://localhost/api/rpc', { method: 'POST', headers, body: JSON.stringify({ method: 'generateBriefingXlsx', args: [payload] }) });
  const response = await onRequestPost({ request, env: { DB, ASSETS } });
  assert(response.status === 200, 'generateBriefingXlsx returns 200');
  const generated = new Uint8Array(await response.arrayBuffer());

  const gview = new DataView(generated.buffer, generated.byteOffset, generated.byteLength);
  let geocd = -1;
  for (let i = generated.length - 22; i >= 0; i--) if (gview.getUint32(i, true) === 0x06054b50) { geocd = i; break; }
  const gcount = gview.getUint16(geocd + 10, true);
  let gcd = gview.getUint32(geocd + 16, true);
  const parts = new Map();
  for (let n = 0; n < gcount; n++) {
    const method = gview.getUint16(gcd + 10, true);
    const compSize = gview.getUint32(gcd + 20, true);
    const nameLen = gview.getUint16(gcd + 28, true);
    const extraLen = gview.getUint16(gcd + 30, true);
    const commentLen = gview.getUint16(gcd + 32, true);
    const lhOff = gview.getUint32(gcd + 42, true);
    const name = new TextDecoder().decode(generated.slice(gcd + 46, gcd + 46 + nameLen));
    const lhNameLen = gview.getUint16(lhOff + 26, true);
    const lhExtraLen = gview.getUint16(lhOff + 28, true);
    const dataOff = lhOff + 30 + lhNameLen + lhExtraLen;
    const raw = generated.slice(dataOff, dataOff + compSize);
    parts.set(name, method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : raw);
    gcd += 46 + nameLen + extraLen + commentLen;
  }

  const qrPart = [...parts.keys()].find(name => /^xl\/media\/image\d+\.png$/.test(name) && name !== 'xl/media/image2.png' && name !== 'xl/media/image1.png');
  assert(!!qrPart, 'QR image part added to the generated XLSX (' + qrPart + ')');
  const qrPng = parts.get(qrPart);
  assert([...qrPng.slice(0, 8)].join(',') === '137,80,78,71,13,10,26,10', 'QR part is a valid PNG (signature)');
  const qrHeader = new DataView(qrPng.buffer, qrPng.byteOffset, qrPng.byteLength);
  const qrWidth = qrHeader.getUint32(16, false);
  assert(qrWidth > 40 && qrWidth === qrHeader.getUint32(20, false), 'QR PNG is square and print-sized (' + qrWidth + 'px)');

  const drawing = new TextDecoder().decode(parts.get('xl/drawings/drawing4.xml'));
  const drawingRels = new TextDecoder().decode(parts.get('xl/drawings/_rels/drawing4.xml.rels'));
  assert((drawing.match(/<xdr:oneCellAnchor>/g) || []).length === 2, 'CBR drawing has the existing anchor plus the QR anchor');
  assert(drawing.includes('name="qr.png"'), 'QR anchor is labelled in the drawing');
  const embed = (drawing.match(/name="qr\.png"[\s\S]*?<a:blip r:embed="(rId\d+)"/) || [])[1];
  assert(!!embed, 'QR anchor references a blip relationship (' + embed + ')');
  assert(drawingRels.includes('Id="' + embed + '"') && drawingRels.includes('Target="../media/' + qrPart.split('/').pop() + '"'), 'drawing relationship points at the QR image part');
  assert(new TextDecoder().decode(parts.get('xl/worksheets/sheet5.xml')).includes('CHRIS DANIEL (LIC: FOOL-881234)'), 'E48 still carries the DXR signature');
  database.close();
  console.log('PASS: XLSX embeds a scannable QR image part wired into the CBR drawing with E48 intact.');
}
console.log('All briefing-xlsx contract checks passed.');
