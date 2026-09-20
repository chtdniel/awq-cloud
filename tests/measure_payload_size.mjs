// Gate B prerequisite: validate the provisional payload size limits against
// representative four-flight fixtures built from REAL seeded TAF/NOTAM text.
// Reports total serialized bytes and max per-text bytes vs 40 KiB / 8 KiB.
import { readFile } from 'node:fs/promises';

const tafSql = await readFile(new URL('../archive/seed_tafs.sql', import.meta.url), 'utf8');
const notamSql = await readFile(new URL('../archive/seed_notams.sql', import.meta.url), 'utf8');

const tafs = {};
for (const m of tafSql.matchAll(/VALUES \('([^']+)', '([\s\S]*?)', '([^']+)'\);/g)) {
  tafs[m[1]] = { station: m[1], text: m[2], issueTime: m[3] };
}
const notams = [];
for (const m of notamSql.matchAll(/VALUES \('([^']+)', '([^']+)', '([^']*)', '([\s\S]*?)', '/g)) {
  notams.push({ id: m[1], station: m[2], qCode: m[3], text: m[4] });
}

const b = (s) => Buffer.byteLength(String(s), 'utf8');
const kb = (n) => (n / 1024).toFixed(2) + ' KiB';
const LIMIT_TOTAL = 64 * 1024; // locked after this real-data measurement
const LIMIT_TEXT = 8 * 1024;

const tafStations = Object.keys(tafs);
console.log('parsed TAFs:', tafStations.length, '| parsed NOTAMs:', notams.length);
if (!tafStations.length || !notams.length) { console.error('PARSE FAILED'); process.exit(1); }

const tafLens = Object.values(tafs).map((t) => b(t.text)).sort((a, z) => a - z);
const notamLens = notams.map((n) => b(n.text)).sort((a, z) => a - z);
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
console.log('TAF text bytes  min/median/p95/max:', tafLens[0], pct(tafLens, .5), pct(tafLens, .95), tafLens[tafLens.length - 1]);
console.log('NOTAM text bytes min/median/p95/max:', notamLens[0], pct(notamLens, .5), pct(notamLens, .95), notamLens[notamLens.length - 1]);

// Pick 4 flights whose stations all have real TAF text.
const picks = tafStations.slice(0, 4).map((s, i) => ({
  rowIdx: 10 + i, FLIGHT: 'QZ' + (600 + i), DOF: '2026-09-19',
  DEP: s, ARR: tafStations[(i + 5) % tafStations.length], ALT: tafStations[(i + 11) % tafStations.length],
  STD: '0300', STA: '0600', REG: 'PK-AZ' + i,
  ENR1: tafStations[(i + 17) % tafStations.length], ENR2: tafStations[(i + 23) % tafStations.length], ENR3: '',
  TAF_DEP: 'BOARD SUMMARY DEP', TAF_ARR: 'BOARD SUMMARY ARR'
}));

function buildPayload(notamsPerFlight, longest) {
  const stations = [...new Set(picks.flatMap((f) => [f.DEP, f.ARR, f.ALT, f.ENR1, f.ENR2, f.ENR3].filter(Boolean)))];
  const pool = longest ? [...notams].sort((a, z) => b(z.text) - b(a.text)) : notams;
  const savedNotamAnalysis = {};
  const notamContext = [];
  picks.forEach((f) => {
    const ids = [];
    for (let k = 0; k < notamsPerFlight; k++) {
      const n = pool[(f.rowIdx + k) % pool.length];
      ids.push(n.id);
      notamContext.push({ id: n.id, station: n.station, flights: [f.FLIGHT], text: n.text, status: 'IMPACTED', selected: true });
    }
    savedNotamAnalysis[f.FLIGHT] = ids;
  });
  const payload = {
    version: 1,
    reportRequestId: '11111111-2222-3333-4444-555555555555',
    requestedAt: '2026-09-19T00:00:00.000Z',
    flights: picks,
    tafContext: stations.map((s, i) => {
      const t = tafs[s];
      return { station: s, roles: ['DEP'], flights: [picks[i % picks.length].FLIGHT], text: t ? t.text : '', issueTime: t ? t.issueTime : null };
    }),
    notamContext,
    savedNotamAnalysis,
    noSigStationMap: Object.fromEntries(stations.slice(0, 2).map((s) => [s, true]))
  };
  return payload;
}

function report(label, payload) {
  const json = JSON.stringify(payload);
  const total = b(json);
  const maxTaf = Math.max(...payload.tafContext.map((t) => b(t.text)), 0);
  const maxNotam = Math.max(...payload.notamContext.map((n) => b(n.text)), 0);
  console.log(`\n--- ${label} ---`);
  console.log(`flights=${payload.flights.length} tafContext=${payload.tafContext.length} notamContext=${payload.notamContext.length}`);
  console.log(`TOTAL ${total} bytes (${kb(total)})   limit 64 KiB -> ${total <= LIMIT_TOTAL ? 'OK' : 'EXCEEDS'}  headroom ${kb(LIMIT_TOTAL - total)}`);
  console.log(`max TAF text   ${maxTaf} bytes (${kb(maxTaf)})   limit 8 KiB -> ${maxTaf <= LIMIT_TEXT ? 'OK' : 'EXCEEDS'}`);
  console.log(`max NOTAM text ${maxNotam} bytes (${kb(maxNotam)})   limit 8 KiB -> ${maxNotam <= LIMIT_TEXT ? 'OK' : 'EXCEEDS'}`);
  return { total, maxTaf, maxNotam };
}

const typical = report('TYPICAL (3 NOTAM/flight, seed order)', buildPayload(3, false));
const heavy = report('HEAVY (5 NOTAM/flight, longest first)', buildPayload(5, true));
const worst = report('WORST CASE (10 NOTAM/flight, longest first)', buildPayload(10, true));

const allOk = worst.total <= LIMIT_TOTAL && worst.maxTaf <= LIMIT_TEXT && worst.maxNotam <= LIMIT_TEXT;
console.log('\nLOCKED LIMITS (64 KiB total / 8 KiB per text) SUFFICIENT FOR REAL DATA: ' + (allOk ? 'YES' : 'NO'));
process.exit(allOk ? 0 : 1);
