import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const source = (await readFile(new URL('../functions/api/briefing-xlsx.js', import.meta.url), 'utf8')).replace("'./notamUtils.js'", JSON.stringify('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../functions/api/notamUtils.js', import.meta.url), 'utf8')).toString('base64')));
const handlers = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const template = await readFile(new URL('../public/briefing-template.xlsx', import.meta.url));
assert.deepEqual(template, await readFile(new URL('../archive/Crew Briefing Report Form.xlsx', import.meta.url)));

export function unzip(bytes) {
  const files = new Map();
  let end = bytes.length - 22;
  while (bytes.readUInt32LE(end) !== 0x06054b50) end--;
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function cell(xml, reference) {
  return xml.match(new RegExp('<c r="' + reference + '"[^>]*>([\\s\\S]*?)</c>'))?.[1] || '';
}

const flights = [
  { id: 1, callsign: 'QZ646', dep: 'WIII', dest: 'WSSS', alt: 'WMKK', ac_type: 'PK-AZK', etd: '2026-09-14T03:00:00Z', eta: '0600', dof: '2026-09-14', taf_dep: 'TAF WIII FROM FLIGHT BOARD', taf_arr: 'TAF WSSS FROM FLIGHT BOARD' },
  { id: 2, callsign: 'QZ647', dep: 'WSSS', dest: 'WIII', alt: 'WARR', ac_type: 'PK-AZF', etd: '0700', eta: '0800', dof: '2026-09-14', taf_dep: 'TAF WSSS SECOND FLIGHT', taf_arr: 'TAF WIII SECOND FLIGHT' }
];
const notams = [
  { id: 'A0001/26', location: 'WIII', message: 'A0001/26 SELECTED FIRST FLIGHT' },
  { id: 'A0002/26', location: 'WIII', message: 'A0002/26 SELECTED SECOND FLIGHT' },
  { id: 'A0003/26', location: 'WIII', message: 'A0003/26 UNSELECTED MUST NOT LEAK' },
  { id: 'A0004/26', location: 'WIIF', message: 'A0004/26 SELECTED FIR' },
  { id: 'A0005/26', location: 'WMKK', message: 'A0005/26 UNSELECTED NO SIG STATION' }
];
const context = {
  request: new Request('https://example.test/api/rpc'),
  env: {
    ASSETS: { async fetch(request) { assert.equal(new URL(request.url).pathname, '/briefing-template.xlsx'); return new Response(template); } },
    DB: { prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async all() {
          if (sql.includes('FROM flights')) return { results: flights.filter(flight => bindings.includes(flight.callsign) || bindings.includes(String(flight.id))) };
          if (sql.includes('FROM tafs')) return { results: [{ station: 'WIII', raw_text: 'TAF WIII CURRENT' }] };
          if (sql.includes('FROM notams')) return { results: notams.filter(notam => bindings.includes(notam.id) || bindings.includes(notam.location)) };
          if (sql.includes('FROM briefing_reports')) return { results: [] };
          throw new Error('Unexpected query: ' + sql);
        }
      };
    } }
  }
};

const form = {
  fields: { recNo: 'TEST-001', formDate: '2026-09-14 10:00Z', pageOf: '1 of 1' },
  legs: Array.from({ length: 6 }, (_, index) => ({ flightNo: 'QZ' + (646 + index), date: '2026-09-14', reg: 'PK-AZK', pod: 'WIII', std: '0300', poa: 'WSSS', sta: '0600', alt: 'WMKK', ofpRef: 'OFP' + index })),
  tafs: Array.from({ length: 6 }, (_, index) => [
    { slot: 'POD' + (index + 1), station: 'WIII', time: '0300', forecast: 'POD FORECAST ' + (index + 1) },
    { slot: 'POA' + (index + 1), station: 'WSSS', time: '0600', forecast: 'POA FORECAST ' + (index + 1) }
  ]).flat(),
  notams: Array.from({ length: 8 }, (_, index) => ({ station: 'STN' + index, text: 'NOTAM TEXT ' + index })),
  signatures: { dxrName: 'TEST DXR', picName: 'TEST PIC' }
};

const response = await handlers.handleGenerateBriefingXlsx(context, [form]);
assert.equal(response.status, 200);
const files = unzip(Buffer.from(await response.arrayBuffer()));
const original = unzip(template);
const cbr = files.get('xl/worksheets/sheet5.xml').toString();
assert.match(cell(cbr, 'Q2'), /TEST-001/, 'record number must use merged anchor');
assert.match(cell(cbr, 'Q3'), /2026-09-14/);
assert.match(cell(cbr, 'D7'), /QZ646/);
assert.match(cell(cbr, 'D11'), /PK-AZK/, 'registration belongs next to A/C REG');
assert.match(cell(cbr, 'H7'), /WIII/);
assert.match(cell(cbr, 'K7'), /WSSS/);
assert.match(cell(cbr, 'O7'), /WMKK/);
assert.match(cell(cbr, 'S7'), /OFP0/);
assert.match(cell(cbr, 'E30'), /WIII/, 'TAF station must not overwrite POD label');
assert.match(cell(cbr, 'F30'), /0300/);
assert.match(cell(cbr, 'P35'), /POA FORECAST 6/, 'last flight forecast must survive');
assert.match(cell(cbr, 'E45'), /NOTAM sheet/, 'CBR must disclose NOTAM continuation');
assert.deepEqual([...files.get('xl/workbook.xml').toString().matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map(match => match[1]), ['CBR', 'WX', 'NOTAM']);
assert.deepEqual(files.get('xl/styles.xml'), original.get('xl/styles.xml'));
assert.deepEqual(files.get('xl/media/image2.png'), original.get('xl/media/image2.png'));
assert.equal(cbr.match(/<mergeCells[\s\S]*?<\/mergeCells>/)?.[0], original.get('xl/worksheets/sheet5.xml').toString().match(/<mergeCells[\s\S]*?<\/mergeCells>/)?.[0]);
const bulkNotam = files.get('xl/worksheets/sheet17.xml').toString();
assert.match(bulkNotam, /NOTAM TEXT 7/);
assert.match(cell(bulkNotam, 'B26'), /TEST DXR/);
console.log('PASS workbook anchors, six-flight forecasts, continuation and template preservation');

const reportResponse = await handlers.handleGenerateReportXlsx(context, [{ flights: ['QZ646', 'QZ647'], notamAnalysis: { QZ646: ['A0001/26', 'A0004/26'], QZ647: [{ notamNum: 'A0002/26' }] }, noSigMap: { WMKK: true, WIII: true } }]);
assert.equal(reportResponse.status, 200);
const reportFiles = unzip(Buffer.from(await reportResponse.arrayBuffer()));
const reportNotam = reportFiles.get('xl/worksheets/sheet17.xml').toString();
assert.match(reportNotam, /SELECTED FIRST FLIGHT/);
assert.match(reportNotam, /SELECTED SECOND FLIGHT/);
assert.match(reportNotam, /SELECTED FIR/);
assert.match(reportNotam, /NIL SIGNIFICANT NOTAM/);
assert.doesNotMatch(reportNotam, /UNSELECTED/);
const reportCbr = reportFiles.get('xl/worksheets/sheet5.xml').toString();
assert.match(reportCbr, /14-SEP-2026/, 'flight dates use DD-MMM-YYYY');
assert.doesNotMatch(cell(reportCbr, 'Q2'), /CBR-QZ/, 'generated report record number stays blank');
assert.doesNotMatch(cell(reportCbr, 'Q3'), /Date: [^<]*\d/, 'generated report date stays blank');
assert.match(reportCbr, /TAF WIII FROM FLIGHT BOARD/, 'departure forecast comes from flight board');
assert.match(reportCbr, /TAF WSSS FROM FLIGHT BOARD/, 'arrival forecast comes from flight board');
assert.match(cell(reportCbr, 'L39'), /SELECTED SECOND FLIGHT/, 'second NOTAM uses adjacent CBR column');
console.log('PASS analysis selection union, flight-board forecasts, blank header fields, date format and balanced NOTAM columns');

for (const invalid of [
  { ...form, legs: [...form.legs, form.legs[0]] },
  { ...form, notams: Array(31).fill(form.notams[0]) },
  { ...form, notams: [{ station: 'WIII', text: 'X'.repeat(32768) }] }
]) {
  const excessive = await handlers.handleGenerateBriefingXlsx(context, [invalid]);
  assert.equal(excessive.status, 400);
}
console.log('PASS explicit capacity rejection without silent data loss');
