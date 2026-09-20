// Unit tests for the Web 2 payload-builder helpers added for Gate B:
//   src/Taf_Ui.html    -> window.getReportTafContext
//   src/Notam_Ui.html  -> window.getReportNotamContext
//   src/Report_Ui.html -> reportByteLength_ / reportOversizeText_
// Helpers are extracted by brace-matching and evaluated in isolation.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

function extract(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) + ';'; }
  }
  throw new Error('unbalanced braces after: ' + marker);
}

const tafSrc = await readFile(new URL('../src/Taf_Ui.html', import.meta.url), 'utf8');
const notamSrc = await readFile(new URL('../src/Notam_Ui.html', import.meta.url), 'utf8');
const reportSrc = await readFile(new URL('../src/Report_Ui.html', import.meta.url), 'utf8');

let pass = 0;
function check(name, fn) { fn(); pass++; console.log('  ok - ' + name); }

console.log('web 2 payload builder tests');

// ---------------------------------------------------------------- TAF helper
const tafWin = {};
const localTafData = [
  { STATION: 'wiii', RAW_TAF: 'TAF OLD', TIMESTAMP: '2026-09-12T00:00:00Z' },
  { STATION: 'WIII', RAW_TAF: 'TAF NEW', TIMESTAMP: '2026-09-19T00:00:00Z' },
  { STATION: 'WSSS', RAW_TAF: '   ', TIMESTAMP: '2026-09-19T00:00:00Z' },
  { STATION: 'WARR', RAW_TAF: 'TAF UNAVAIL', TIMESTAMP: '2026-09-19T00:00:00Z', IS_UNAVAILABLE: true }
];
new Function('window', 'localTafData', extract(tafSrc, 'window.getReportTafContext ='))(tafWin, localTafData);
const tafCtx = tafWin.getReportTafContext(['wiii', ' WSSS ', 'WARR', 'WADD', '', null, 'WIII']);

check('taf: dedupes, uppercases, trims, drops empties', () => {
  assert.deepEqual(tafCtx.map((t) => t.station), ['WIII', 'WSSS', 'WARR', 'WADD']);
});
check('taf: newest TIMESTAMP wins between two full values', () => {
  assert.equal(tafCtx[0].text, 'TAF NEW');
  assert.equal(tafCtx[0].issueTime, '2026-09-19T00:00:00Z');
  assert.equal(tafCtx[0].available, true);
});
check('taf: blank / flagged / missing all return explicit unavailable (no substitution)', () => {
  assert.equal(tafCtx[1].available, false);
  assert.equal(tafCtx[1].text, '');
  assert.equal(tafCtx[2].available, false);
  assert.equal(tafCtx[3].available, false);
});

// -------------------------------------------------------------- NOTAM helper
const notamWin = {
  awqReportState: {
    notamResponse: {
      data: [
        { station: 'WIII', flightsStr: 'QZ646, QZ700', notams: [
          { notamNum: 'A0001/26', rawText: 'RAW ONE', status: 'IMPACTED' },
          { notamNum: 'A0002/26', rawText: 'RAW TWO', status: 'INFO' }
        ] },
        { station: 'WSSS', flightsStr: 'QZ999', notams: [
          { notamNum: 'B0001/26', rawText: 'OTHER', status: 'IMPACTED' }
        ] }
      ]
    }
  },
  savedNotamAnalysis: { QZ646: ['A0001/26'] }
};
new Function('window', [
  extract(notamSrc, 'window.reportStationSet ='),
  extract(notamSrc, 'window.isAerodromeReportNotam ='),
  extract(notamSrc, 'window.getReportNotamContext =')
].join('\n'))(notamWin);
// Flights carry their aerodrome stations: the shipped rule scopes NOTAMs to the
// selected flights' DEP/ARR/ALT/ENR set, so a flight object with only FLIGHT would
// legitimately drop everything.
const notamFlights = [
  { FLIGHT: 'QZ646', DEP: 'WIII', ARR: 'WSSS' },
  { FLIGHT: 'QZ700', DEP: 'WIII' },
  { FLIGHT: 'QZ555', DEP: 'WADD' }
];
const notamCtx = notamWin.getReportNotamContext(notamFlights);

check('notam: only selected NOTAMs of selected flights, full raw text kept', () => {
  assert.equal(notamCtx.length, 1);
  assert.equal(notamCtx[0].id, 'A0001/26');
  assert.equal(notamCtx[0].station, 'WIII');
  assert.equal(notamCtx[0].text, 'RAW ONE');
  assert.equal(notamCtx[0].status, 'IMPACTED');
  assert.equal(notamCtx[0].selected, true);
  assert.deepEqual(notamCtx[0].flights, ['QZ646']);
});
check('notam: empty response returns []', () => {
  const w = { awqReportState: {}, savedNotamAnalysis: {} };
  new Function('window', [
    extract(notamSrc, 'window.reportStationSet ='),
    extract(notamSrc, 'window.isAerodromeReportNotam ='),
    extract(notamSrc, 'window.getReportNotamContext =')
  ].join('\n'))(w);
  assert.deepEqual(w.getReportNotamContext([{ FLIGHT: 'QZ1', DEP: 'WIII' }]), []);
});
check('notam: a selected FIR/UIR-scoped NOTAM is dropped and reported, not silently lost', () => {
  const w = {
    awqReportState: {
      notamResponse: {
        data: [
          { station: 'WAAF', flightsStr: 'QZ646', notams: [
            { notamNum: 'FIR1/26', rawText: 'FIR WIDE', status: 'IMPACTED' }
          ] }
        ]
      }
    },
    savedNotamAnalysis: { QZ646: ['FIR1/26'] }
  };
  new Function('window', [
    extract(notamSrc, 'window.reportStationSet ='),
    extract(notamSrc, 'window.isAerodromeReportNotam ='),
    extract(notamSrc, 'window.getReportNotamContext =')
  ].join('\n'))(w);
  const out = w.getReportNotamContext([{ FLIGHT: 'QZ646', DEP: 'WIII', ARR: 'WSSS' }]);
  assert.deepEqual(out, [], 'FIR/UIR row must not reach the payload');
  assert.equal(w.reportNotamScope.available, true);
  assert.equal(w.reportNotamScope.dropped.length, 1);
  assert.equal(w.reportNotamScope.dropped[0].id, 'FIR1/26');
  assert.equal(w.reportNotamScope.dropped[0].station, 'WAAF');
  assert.deepEqual(w.reportNotamScope.dropped[0].flights, ['QZ646']);
});
check('notam: scope recorder starts clean on every call', () => {
  const w = {
    awqReportState: { notamResponse: { data: [] } },
    savedNotamAnalysis: {},
    reportNotamScope: { dropped: [{ id: 'STALE', station: 'WAAF' }], available: true }
  };
  new Function('window', [
    extract(notamSrc, 'window.reportStationSet ='),
    extract(notamSrc, 'window.isAerodromeReportNotam ='),
    extract(notamSrc, 'window.getReportNotamContext =')
  ].join('\n'))(w);
  w.getReportNotamContext([{ FLIGHT: 'QZ1', DEP: 'WIII' }]);
  assert.deepEqual(w.reportNotamScope.dropped, [], 'a previous call must not leak into this one');
});

// ---------------------------------------------------------------- size guards
const sizeFactory = new Function(
  'REPORT_MAX_TEXT_BYTES',
  extract(reportSrc, 'function reportByteLength_') + '\n' + extract(reportSrc, 'function reportOversizeText_') +
  '\n;return { reportByteLength_, reportOversizeText_ };'
);
const S = sizeFactory(8 * 1024);

check('byteLength counts UTF-8 bytes', () => {
  assert.equal(S.reportByteLength_('abc'), 3);
  assert.equal(S.reportByteLength_('é'), 2);
});
check('oversize detects TAF then NOTAM, null when within limits', () => {
  assert.equal(S.reportOversizeText_({ tafContext: [{ station: 'X', text: 'a'.repeat(9000) }], notamContext: [] }).kind, 'TAF');
  assert.equal(S.reportOversizeText_({ tafContext: [], notamContext: [{ id: 'N1', text: 'a'.repeat(9000) }] }).kind, 'NOTAM');
  assert.equal(S.reportOversizeText_({ tafContext: [{ station: 'X', text: 'short' }], notamContext: [] }), null);
});

console.log('\n' + pass + ' checks passed');
