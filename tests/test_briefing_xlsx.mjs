// E2E self-check: server-side functions simulating the Worker runtime pieces
// used by briefing-xlsx.js (ZIP round-trip + inline cell edit).
// Run: node tests/test_briefing_xlsx.mjs
import { readFile, writeFile } from 'node:fs/promises';
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

// Central-directory reader for a GENERATED workbook: inflates deflated parts.
function zipPartMap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  assert(eocd !== -1, 'generated workbook has an EOCD');
  const count = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);
  const parts = new Map();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(cd + 10, true);
    const compSize = view.getUint32(cd + 20, true);
    const nameLen = view.getUint16(cd + 28, true);
    const extraLen = view.getUint16(cd + 30, true);
    const commentLen = view.getUint16(cd + 32, true);
    const lhOff = view.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cd + 46, cd + 46 + nameLen));
    const lhNameLen = view.getUint16(lhOff + 26, true);
    const lhExtraLen = view.getUint16(lhOff + 28, true);
    const dataOff = lhOff + 30 + lhNameLen + lhExtraLen;
    const raw = bytes.slice(dataOff, dataOff + compSize);
    parts.set(name, method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : raw);
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

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
  // Dispatcher identity comes from the profile; the email is the documented
  // fallback, so one assertion below drops this table on purpose.
  database.exec('CREATE TABLE user_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT, iaa_id TEXT, lic_no TEXT, updated_by INTEGER, created_at TEXT, updated_at TEXT)');
  database.prepare('INSERT INTO user_profiles (user_id, full_name, lic_no) VALUES (?, ?, ?)').run(userId, 'CHRIS DANIEL', 'FOOL-881234');
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

  const parts = zipPartMap(generated);

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
  console.log('PASS: XLSX embeds a scannable QR image part wired into the CBR drawing with E48 intact.');

  // --- Report page path: generateReportXlsx must NOT carry the signature QR ---
  // Both report-page controls (DOWNLOAD SHEET XLSX and CREATE GOOGLE SHEET) call
  // this method; a report is not the signed briefing form, so no QR image part
  // and no QR drawing anchor may appear. The printed DXR name is unaffected.
  const reportRequest = new Request('http://localhost/api/rpc', { method: 'POST', headers, body: JSON.stringify({ method: 'generateReportXlsx', args: [payload] }) });
  const reportResponse = await onRequestPost({ request: reportRequest, env: { DB, ASSETS } });
  assert(reportResponse.status === 200, 'generateReportXlsx returns 200');
  const reportBytes = new Uint8Array(await reportResponse.arrayBuffer());
  // Manual QA hook: AWQ_XLSX_DUMP=<path> writes the generated report so it can be
  // opened in Excel / Google Sheets to eyeball the DATE picker.
  if (process.env.AWQ_XLSX_DUMP) await writeFile(process.env.AWQ_XLSX_DUMP, Buffer.from(reportBytes));
  const reportParts = zipPartMap(reportBytes);

  const templateMedia = entries.map(e => e.name).filter(n => n.startsWith('xl/media/')).sort();
  const reportMedia = [...reportParts.keys()].filter(n => n.startsWith('xl/media/')).sort();
  assert(JSON.stringify(reportMedia) === JSON.stringify(templateMedia), 'report XLSX adds no QR image part (' + reportMedia.join(', ') + ')');

  const reportDrawing = new TextDecoder().decode(reportParts.get('xl/drawings/drawing4.xml'));
  const reportDrawingRels = new TextDecoder().decode(reportParts.get('xl/drawings/_rels/drawing4.xml.rels'));
  assert(!reportDrawing.includes('qr.png'), 'report CBR drawing carries no QR anchor');
  assert(!/qr/i.test(reportDrawingRels) && !reportDrawingRels.includes('../media/image3.png'), 'report drawing relationships add no QR image target');
  assert((reportDrawing.match(/<xdr:oneCellAnchor>/g) || []).length === 1, 'report CBR drawing keeps only the template anchor');
  assert(new TextDecoder().decode(reportParts.get('xl/worksheets/sheet5.xml')).includes('CHRIS DANIEL (LIC: FOOL-881234)'), 'report E48 still carries the saved DXR signature text');

  // --- Report page DATE row: today (UTC) as a real, changeable date ---------
  // D9 must be a numeric date serial (not the flight-date text), carry the
  // DD-MMM-YYYY number format on its own cloned xf, and expose a date validation
  // so Google Sheets shows its calendar and Excel enforces a valid date.
  const reportSheet = new TextDecoder().decode(reportParts.get('xl/worksheets/sheet5.xml'));
  const d9 = (reportSheet.match(/<c r="D9"[^>]*>[\s\S]*?<\/c>/) || [''])[0];
  assert(!d9.includes('inlineStr') && /<v>\d+<\/v>/.test(d9), 'report D9 holds a numeric date serial, not text (' + d9 + ')');
  const d9Serial = Number((d9.match(/<v>(\d+)<\/v>/) || [])[1]);
  const nowUtc = new Date();
  const expectedSerial = Math.floor(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()) / 86400000) + 25569;
  assert(d9Serial === expectedSerial, 'report D9 serial is today in UTC (' + d9Serial + ' === ' + expectedSerial + ')');

  const d9StyleId = Number((d9.match(/s="(\d+)"/) || [])[1]);
  const reportStyles = new TextDecoder().decode(reportParts.get('xl/styles.xml'));
  const formSheet = new TextDecoder().decode(parts.get('xl/worksheets/sheet5.xml'));
  const formStyles = new TextDecoder().decode(parts.get('xl/styles.xml'));
  const xfsOf = (styles) => [...(styles.match(/<cellXfs[^>]*>[\s\S]*?<\/cellXfs>/) || [''])[0]
    .matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(m => m[0]);
  const reportXfs = xfsOf(reportStyles);
  assert(reportStyles.includes('formatCode="DD-MMM-YYYY"'), 'report styles add the DD-MMM-YYYY number format');
  const xfCount = Number((reportStyles.match(/<cellXfs count="(\d+)"/) || [])[1]);
  assert(reportXfs.length === xfCount, 'cellXfs count matches the appended date style (' + reportXfs.length + ' === ' + xfCount + ')');
  const dateXf = reportXfs[d9StyleId] || '';
  const formD9StyleId = Number((formSheet.match(/<c r="D9"[^>]*s="(\d+)"/) || [])[1]);
  const formD9Xf = xfsOf(formStyles)[formD9StyleId] || '';
  const borderOf = (xf) => (xf.match(/borderId="(\d+)"/) || [])[1];
  const dateNumFmtId = (dateXf.match(/numFmtId="(\d+)"/) || [])[1];
  assert(dateXf.includes('applyNumberFormat="1"') && new RegExp('numFmtId="' + dateNumFmtId + '" formatCode="DD-MMM-YYYY"').test(reportStyles), 'D9 xf applies the DD-MMM-YYYY format (numFmtId ' + dateNumFmtId + ')');
  assert(!!borderOf(formD9Xf) && borderOf(dateXf) === borderOf(formD9Xf), 'D9 keeps the template border on the cloned xf (' + borderOf(dateXf) + ')');
  assert(/horizontal="center"/.test(dateXf) && /horizontal="center"/.test(formD9Xf), 'D9 keeps the template centering on the cloned xf');

  const reportValidation = (reportSheet.match(/<dataValidations[\s\S]*?<\/dataValidations>/) || [''])[0];
  assert(/type="date"/.test(reportValidation) && /sqref="D9"/.test(reportValidation), 'report D9 carries a date data-validation');
  assert(reportSheet.indexOf('</mergeCells>') < reportSheet.indexOf('<dataValidations') && reportSheet.indexOf('<dataValidations') < reportSheet.indexOf('<printOptions'), 'dataValidations sits between mergeCells and printOptions (schema order)');
  assert(/<c r="D9"[^>]*t="inlineStr"/.test(formSheet), 'briefing-form D9 still holds the flight-date TEXT');
  assert(!/<dataValidations/.test(formSheet), 'briefing-form XLSX gets no date validation (out of scope for the report-page rule)');

  // --- TAF block: rows auto-fit to their text, empty rows auto-hidden -------
  const rowTag = (sheet, n) => (sheet.match(new RegExp('<row r="' + n + '"[^>]*>')) || [''])[0];
  const htOf = (sheet, n) => Number((rowTag(sheet, n).match(/ht="([\d.]+)"/) || [])[1]);
  // One TAF (WADD / "NIL"): row 20 stays visible at content height, 21-26 hidden.
  assert(htOf(reportSheet, 20) > 0 && !/hidden="1"/.test(rowTag(reportSheet, 20)), 'TAF row 20 (station present) stays visible and is sized');
  assert(htOf(reportSheet, 20) < 60, 'one-line TAF row shrinks from the template 60pt (' + htOf(reportSheet, 20) + 'pt)');
  for (let r = 21; r <= 26; r++) {
    assert(/hidden="1"/.test(rowTag(reportSheet, r)), 'empty TAF row ' + r + ' is auto-hidden');
  }
  // A 5-line forecast (like YPGK/YPPD in the real report) must grow the row so
  // nothing is clipped: 5 lines x ceil(14pt * 1.4) + 3 >= 100pt.
  const multiTaf = ['TAF YPGK 200511Z 2006/2106 15008KT CAVOK', 'FM201400 11008KT CAVOK', 'FM201900 10008KT 9999 FEW010', 'FM210000 07008KT CAVOK', 'FM220000 09008KT CAVOK='].join('\n');
  const multiPayload = { ...payload, tafs: [{ ...payload.tafs[0], forecast: multiTaf }] };
  const multiRequest = new Request('http://localhost/api/rpc', { method: 'POST', headers, body: JSON.stringify({ method: 'generateBriefingXlsx', args: [multiPayload] }) });
  const multiResponse = await onRequestPost({ request: multiRequest, env: { DB, ASSETS } });
  assert(multiResponse.status === 200, 'generateBriefingXlsx with a 5-line TAF returns 200');
  const multiSheet = new TextDecoder().decode(zipPartMap(new Uint8Array(await multiResponse.arrayBuffer())).get('xl/worksheets/sheet5.xml'));
  assert(htOf(multiSheet, 20) >= 100, 'five-line TAF grows the row height (' + htOf(multiSheet, 20) + 'pt >= 100pt)');
  assert(htOf(multiSheet, 20) > htOf(reportSheet, 20), 'multi-line row is taller than the one-line row');
  assert(/customHeight="1"/.test(rowTag(multiSheet, 20)), 'computed height is explicit (customHeight) so Excel honours it');
  assert((multiSheet.match(/<row r="20"[^>]*ht="60"/) || []).length === 0, 'the template 60pt height no longer survives in the TAF block');
  // The editable briefing form is the same document, so it follows the same rule.
  assert(/hidden="1"/.test(rowTag(formSheet, 21)), 'briefing-form TAF block hides empty rows too');
  assert(htOf(formSheet, 20) < 60, 'briefing-form TAF row is auto-fit as well (' + htOf(formSheet, 20) + 'pt)');

  // --- SIGNIFICANT NOTAM block: same auto-fit + auto-hide rule ---------------
  // One NOTAM group ("NIL"): row 39 visible at content height, rows 40-45 hidden.
  assert(!/hidden="1"/.test(rowTag(reportSheet, 39)), 'NOTAM row 39 (content present) stays visible');
  assert(htOf(reportSheet, 39) > 0 && htOf(reportSheet, 39) < 138.75, 'NOTAM row auto-fits from the template 138.75pt (' + htOf(reportSheet, 39) + 'pt)');
  for (let r = 40; r <= 45; r++) {
    assert(/hidden="1"/.test(rowTag(reportSheet, r)), 'empty NOTAM row ' + r + ' is auto-hidden');
  }
  assert(/hidden="1"/.test(rowTag(formSheet, 40)), 'briefing-form SIGNIFICANT NOTAM block hides empty rows too');

  // --- Dispatcher name from the login account (F50) -------------------------
  const cellText = (sheet, ref) => {
    const cell = (sheet.match(new RegExp('<c r="' + ref + '"[^>]*>[\\s\\S]*?</c>')) || [''])[0];
    return (cell.match(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/) || [])[1] || '';
  };
  assert(cellText(reportSheet, 'F50') === 'CHRIS DANIEL', 'report F50 carries the logged-in dispatcher profile name (' + cellText(reportSheet, 'F50') + ')');
  assert(cellText(formSheet, 'F50') === 'CHRIS DANIEL', 'briefing-form F50 carries the dispatcher name too');
  assert(cellText(reportSheet, 'E48') === 'CHRIS DANIEL (LIC: FOOL-881234)', 'E48 keeps the form DXR signature untouched');

  // A raw 4-line NOTAM must grow the SIGNIFICANT NOTAM row. Dropping the profile
  // table first also proves the documented fallback: the account email.
  database.exec('DROP TABLE user_profiles');
  const multiNotam = ['A1234/26 NOTAMN', 'Q) WIIF/QRTCA/IV/BO/A/000/999/0600S10600E005', 'A) WADD B) 2609010000 C) 2610010000', 'E) AIRSPACE RESTRICTED'].join('\n');
  const notamPayload = { ...payload, notams: [{ ...payload.notams[0], text: multiNotam }] };
  const notamRequest = new Request('http://localhost/api/rpc', { method: 'POST', headers, body: JSON.stringify({ method: 'generateBriefingXlsx', args: [notamPayload] }) });
  const notamResponse = await onRequestPost({ request: notamRequest, env: { DB, ASSETS } });
  assert(notamResponse.status === 200, 'generateBriefingXlsx with a 4-line NOTAM returns 200');
  const notamSheet = new TextDecoder().decode(zipPartMap(new Uint8Array(await notamResponse.arrayBuffer())).get('xl/worksheets/sheet5.xml'));
  assert(!/hidden="1"/.test(rowTag(notamSheet, 39)), 'the four-line NOTAM row stays visible');
  assert(htOf(notamSheet, 39) >= 4 * 17, 'four-line NOTAM grows the row height (' + htOf(notamSheet, 39) + 'pt >= 68pt)');
  assert(htOf(notamSheet, 39) > htOf(reportSheet, 39), 'a longer NOTAM row is taller than the one-line row');
  assert(cellText(notamSheet, 'F50') === 't@example.com', 'F50 falls back to the account email when no profile name exists (' + cellText(notamSheet, 'F50') + ')');

  // --- Per-leg "Forecasts" columns (G:J left, P:S right) ---------------------
  // Legs 1-3 write the merged G:J cell, legs 4-6 the merged P:S one. The right
  // forecast must land on the merge anchor (P), and both must grow the shared row.
  const legPayload = {
    ...payload,
    tafs: [
      { ...payload.tafs[0], slot: 'POD1', forecast: multiTaf },
      { ...payload.tafs[0], slot: 'POD4', station: 'YPPH', stationEntered: 'YPPH', forecast: multiTaf }
    ]
  };
  const legRequest = new Request('http://localhost/api/rpc', { method: 'POST', headers, body: JSON.stringify({ method: 'generateBriefingXlsx', args: [legPayload] }) });
  const legResponse = await onRequestPost({ request: legRequest, env: { DB, ASSETS } });
  assert(legResponse.status === 200, 'generateBriefingXlsx with left+right leg forecasts returns 200');
  const legBytes = new Uint8Array(await legResponse.arrayBuffer());
  // Manual QA hook for the per-leg Forecasts columns.
  if (process.env.AWQ_XLSX_DUMP_LEGS) await writeFile(process.env.AWQ_XLSX_DUMP_LEGS, Buffer.from(legBytes));
  const legParts = zipPartMap(legBytes);
  const legSheet = new TextDecoder().decode(legParts.get('xl/worksheets/sheet5.xml'));
  const legStyles = new TextDecoder().decode(legParts.get('xl/styles.xml'));

  assert(cellText(legSheet, 'G30').length > 0, 'left leg forecast is written to the merged G:J anchor');
  assert(cellText(legSheet, 'P30').length > 0, 'right leg forecast is written to the merged P:S anchor');
  assert(cellText(legSheet, 'Q30') === '', 'the covered cell Q30 stays empty (writing there is invisible in Excel)');
  assert(htOf(legSheet, 30) > 42.75, 'forecast row grows past the template 42.75pt (' + htOf(legSheet, 30) + 'pt)');
  assert(/customHeight="1"/.test(rowTag(legSheet, 30)), 'the grown forecast row keeps an explicit height');
  assert(cellText(legSheet, 'G31') === '' && htOf(legSheet, 31) === 42.75, 'an untouched leg row keeps the template height (' + htOf(legSheet, 31) + 'pt)');
  assert(!/hidden="1"/.test(rowTag(legSheet, 31)), 'leg rows are never hidden (left and right legs share a row)');
  // The right Forecasts cells had no wrapText in the template; long text would clip.
  const rightForecastStyles = [...legSheet.matchAll(/<c r="P3[0-5]"[^>]*s="(\d+)"/g)].map(m => Number(m[1]));
  const legXfs = [...(legStyles.match(/<cellXfs[^>]*>[\s\S]*?<\/cellXfs>/) || [''])[0].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(m => m[0]);
  assert(new Set(rightForecastStyles).size === 1 && /wrapText="1"/.test(legXfs[rightForecastStyles[0]] || ''), 'right Forecasts cells share one cloned style with wrapText ("' + legXfs[rightForecastStyles[0]] + '")');
  const leftForecastStyle = Number((legSheet.match(/<c r="G30"[^>]*s="(\d+)"/) || [])[1]);
  assert(/wrapText="1"/.test(legXfs[leftForecastStyle] || ''), 'left Forecasts cell keeps its template wrap style');
  // The clone must keep the template's font/border/number format and only add wrap.
  const templateSheet = rawOf('xl/worksheets/sheet5.xml');
  const templateP30Style = Number((templateSheet.match(/<c r="P30"[^>]*s="(\d+)"/) || [])[1]);
  const templateP30Xf = xfsOf(rawOf('xl/styles.xml'))[templateP30Style] || '';
  const cloneXf = legXfs[rightForecastStyles[0]] || '';
  const styleAttrs = (xf) => (xf.match(/numFmtId="\d+"|fontId="\d+"|borderId="\d+"/g) || []).join(',');
  assert(styleAttrs(cloneXf) === styleAttrs(templateP30Xf) && /wrapText="1"/.test(cloneXf) && !/wrapText="1"/.test(templateP30Xf),
    'cloned right-Forecasts style keeps font/border/number format and only adds wrapText (' + styleAttrs(cloneXf) + ')');

  // --- Default print setup (imported by Google Sheets) -----------------------
  const pageSetupTag = (reportSheet.match(/<pageSetup[^>]*\/>/) || [''])[0];
  assert(/paperSize="9"/.test(pageSetupTag) && /orientation="portrait"/.test(pageSetupTag), 'default print: A4 portrait (' + pageSetupTag + ')');
  assert(/fitToWidth="1"/.test(pageSetupTag) && /fitToHeight="0"/.test(pageSetupTag), 'default print: fit to width (height auto)');
  const marginsTag = (reportSheet.match(/<pageMargins[^>]*\/>/) || [''])[0];
  assert(/left="0.25"/.test(marginsTag) && /right="0.25"/.test(marginsTag) && /top="0.4"/.test(marginsTag) && /bottom="0.3"/.test(marginsTag), 'default print: margins left/right 0.25, top 0.4, bottom 0.3 (' + marginsTag + ')');
  const printOptionsTag = (reportSheet.match(/<printOptions[^>]*\/>/) || [''])[0];
  assert(/horizontalCentered="1"/.test(printOptionsTag) && /verticalCentered="0"/.test(printOptionsTag), 'default print: horizontal center, vertical top (' + printOptionsTag + ')');
  assert(/<pageSetUpPr fitToPage="1"\/>/.test(reportSheet), 'default print: fitToPage enabled on the sheet');
  assert(/<headerFooter\/>/.test(reportSheet) && !/&amp;P/.test(reportSheet), 'default print: page numbers (footer) off');
  const printOrder = ['<printOptions', '<pageMargins', '<pageSetup', '<headerFooter', '<drawing'].map(t => reportSheet.indexOf(t));
  assert(printOrder.every((v, i) => v > 0 && (i === 0 || v > printOrder[i - 1])), 'print elements keep the CT_Worksheet order');
  assert(/paperSize="9"/.test(formSheet) && /<headerFooter\/>/.test(formSheet), 'editable-form XLSX gets the same print defaults');

  console.log('PASS: report XLSX (report page) carries no QR image part or anchor; DATE row defaults to today (UTC) with DD-MMM-YYYY + date validation.');
  database.close();
}
console.log('All briefing-xlsx contract checks passed.');
