import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
const source = (await readFile('functions/api/briefing-xlsx.js', 'utf8')).replace("'./notamUtils.js'", JSON.stringify('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../functions/api/notamUtils.js', import.meta.url), 'utf8')).toString('base64')));
const handlers = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { parseLocalEntries, findSheetFile };').toString('base64'));
const template = await readFile('public/briefing-template.xlsx');
const flight = { id: 1, callsign: 'QZ544', dep: 'WADD', dest: 'YPPH', alt: 'YPKG', enr1: 'WARR', enr2: 'WIII', enr3: 'WSSS', taf_dep: 'TAF WADD DEPARTURE', taf_arr: 'TAF YPPH ARRIVAL' };
const context = {
  request: new Request('https://example.test/api/rpc'),
  env: {
    ASSETS: { fetch: async () => new Response(template) },
    DB: { prepare(sql) { return {
      bind() { return this; },
      async all() {
        if (sql.includes('FROM flights')) return { results: [flight] };
        if (sql.includes('FROM tafs')) return { results: ['YPKG', 'WARR', 'WIII'].map(station => ({ station, raw_text: 'TAF ' + station + ' FORECAST' })) };
        if (sql.includes('FROM notams')) return { results: [{ id: 'H7257/26', location: 'YPPH', message: 'ILS &apos;IPH&apos;&#x20;109.9 RWY 24 U/S &lt;LIMIT&gt;' }] };
        if (sql.includes('FROM briefing_reports')) return { results: [] };
        throw new Error('Unexpected query: ' + sql);
      }
    }; } }
  }
};
function unpack(bytes) {
  return new Map(handlers.parseLocalEntries(bytes).map(entry => [entry.name, Buffer.from(entry.method === 8 ? inflateRawSync(entry.data) : entry.data).toString()]));
}
function cell(xml, ref) {
  const start = xml.indexOf('<c r="' + ref + '"');
  assert.ok(start >= 0, 'Missing cell ' + ref);
  const end = xml.indexOf('>', start);
  return xml[end - 1] === '/' ? xml.slice(start, end + 1) : xml.slice(start, xml.indexOf('</c>', end) + 4);
}
async function generate() {
  const response = await handlers.handleGenerateReportXlsx(context, [{ flights: ['QZ544'], notamAnalysis: { QZ544: ['H7257/26'] } }]);
  assert.equal(response.status, 200);
  const files = unpack(new Uint8Array(await response.arrayBuffer()));
  const file = handlers.findSheetFile(files.get('xl/workbook.xml'), files.get('xl/_rels/workbook.xml.rels'), 'CBR');
  assert.match(files.get(file), /ILS 'IPH' 109.9 RWY 24 U\/S &lt;LIMIT&gt;/);
  assert.doesNotMatch(files.get(file), /&amp;apos;|&amp;#x20;/);
  return { xml: files.get(file), file };
}
const { xml, file } = await generate();
for (const [index, station] of ['WADD', 'YPPH', 'YPKG', 'WARR', 'WIII', 'WSSS'].entries()) {
  assert.match(cell(xml, 'C' + (20 + index)), new RegExp(station));
  assert.match(cell(xml, 'E' + (20 + index)), new RegExp(station === 'WSSS' ? 'NIL TAF DATA IN DATABASE' : 'TAF ' + station));
}
const original = unpack(template).get(file);
for (const row of [7, 9, 11, 13, 15, 17]) assert.equal(cell(xml, 'M' + row), cell(original, 'M' + row));
flight.alt = 'WADD';
flight.enr1 = 'WADD';
flight.enr2 = '';
flight.enr3 = '';
const duplicate = (await generate()).xml;
assert.match(cell(duplicate, 'E20'), /TAF WADD DEPARTURE/);
assert.doesNotMatch(cell(duplicate, 'C22'), /WADD|WIII|WSSS/);
console.log('PASS generated report: DEP, ARR, ALTN, ENR1–3, missing forecast, duplicates, empty enroute and preserved column M.');
