// Gate C QA fixtures.
//
// Builds 1/2/3/4-flight Web 2 selection datasets, TAF context and NOTAM context
// from the repository's REAL seeded data (archive/seed_tafs.sql,
// archive/seed_notams.sql, archive/seed_flights.sql) so the QA matrix exercises
// operational text sizes rather than toy strings.
//
// The returned object is the exact contract the Web 2 harness exposes to
// src/Report_Ui.html: flights[], tafByStation{}, notamsByFlight[]. The harness
// mirrors the helpers the production surfaces provide
// (window.getReportTafContext from src/Taf_Ui.html and
// window.getReportNotamContext from src/Notam_Ui.html).
import { readFile } from 'node:fs/promises';

const SRC = new URL('../archive/', import.meta.url);
const read = (name) => readFile(new URL(name, SRC), 'utf8');

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');

// ---- real seed corpus -------------------------------------------------------
const tafSql = await read('seed_tafs.sql');
const notamSql = await read('seed_notams.sql');
const flightSql = await read('seed_flights.sql');

/** @type {Record<string, {station:string, text:string, issueTime:string}>} */
const TAFS = {};
for (const m of tafSql.matchAll(/VALUES \('([^']+)', '([\s\S]*?)', '([^']+)'\);/g)) {
  TAFS[m[1]] = { station: m[1], text: m[2], issueTime: m[3] };
}

/** @type {{id:string, station:string, qCode:string, text:string}[]} */
const NOTAMS = [];
for (const m of notamSql.matchAll(/VALUES \('([^']+)', '([^']+)', '([^']*)', '([\s\S]*?)', '/g)) {
  NOTAMS.push({ id: m[1], station: m[2], qCode: m[3], text: m[4] });
}

/** @type {{callsign:string, dep:string, dest:string, reg:string, alt:string, dof:string, etd:string, eta:string}[]} */
const SEED_FLIGHTS = [];
for (const m of flightSql.matchAll(
  /VALUES \('([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)'\)/g
)) {
  SEED_FLIGHTS.push({ callsign: m[1], dep: m[2], dest: m[3], reg: m[4], alt: m[5], dof: m[6], etd: m[7], eta: m[8] });
}

if (!Object.keys(TAFS).length || !NOTAMS.length || !SEED_FLIGHTS.length) {
  throw new Error('Gate C fixtures: failed to parse the seeded TAF/NOTAM/flight corpus');
}

const hhmm = (iso) => {
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  return m ? `${m[1]}${m[2]}` : '';
};
const dofDash = (d) => (/^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(d || ''));

const stationOf = (n) => String(n.station || '').trim().toUpperCase();

// ---- FIR/UIR vs aerodrome scope ---------------------------------------------
//
// `notams.kind` ('FIR' | 'AD', migrations/005 + 006) is the authority, and the seed
// corpus (archive/seed_notams.sql) is the *FIR* half of it: every row in that file is
// one of the nine FIR/UIR designators below. The staging snapshot is pulled with
// `WHERE kind = 'AD'`, so it is the aerodrome half.
//
// This used to be guessed from the code's last letter (`/[FI]$/`), which is wrong in
// both directions: Bangkok/Brisbane/Melbourne FIRs (VTBB, YBBB, YMMM) and the
// Colombo/Kuala Lumpur/Ujung Pandang FIRs (WBFC, WMFC, WSJC) are FIRs that end in
// B/C/M, while Jakarta's aerodrome NOTAMs (WIII) end in I. Classifying by membership
// in the seed corpus is exact for this data and fails loudly if the corpus changes.
export const FIR_DESIGNATORS = [...new Set(NOTAMS.map((n) => String(n.station || '').trim().toUpperCase()))].sort();
const FIR_DESIGNATOR_SET = new Set(FIR_DESIGNATORS);
if (FIR_DESIGNATORS.length < 5) {
  throw new Error(`Gate C fixtures: expected the seed NOTAM corpus to be FIR/UIR-scoped, found ${FIR_DESIGNATORS.length} designators`);
}

/** True when a 4-letter code is a FIR/UIR designator rather than an aerodrome. */
export const isFirStation = (code) => FIR_DESIGNATOR_SET.has(String(code || '').trim().toUpperCase());

// ---- aerodrome NOTAM corpus (staging snapshot) ------------------------------
//
// The report must carry AERODROME NOTAMs only. The seed corpus
// (archive/seed_notams.sql) is entirely FIR/UIR-scoped (WIIF, WAAF, RPHI, …), so
// the aerodrome corpus is pulled read-only from staging D1 by
// tests/pull_staging_ad_notams.mjs into a gitignored snapshot. When the snapshot
// is absent the fixtures fall back to the seed corpus and say so, rather than
// silently pretending the data is aerodrome-scoped.
const STAGING_SNAPSHOT = new URL('../test-results/gate-c/staging/notams-ad-staging.json', import.meta.url);

let AERODROME_NOTAMS = [];
let AERODROME_SOURCE = 'unavailable';
try {
  const snapshot = JSON.parse(await readFile(STAGING_SNAPSHOT, 'utf8'));
  // The snapshot is already `kind = 'AD'`; this drops anything that contradicts that
  // and reports it instead of quietly shipping a FIR row as "aerodrome".
  const contradictory = (snapshot.rows || []).map((r) => String(r.location).toUpperCase()).filter(isFirStation);
  if (contradictory.length) {
    throw new Error(`staging snapshot contains FIR/UIR rows despite kind='AD': ${[...new Set(contradictory)].join(', ')}`);
  }
  AERODROME_NOTAMS = (snapshot.rows || [])
    .map((r) => ({
      id: String(r.id),
      station: String(r.location).toUpperCase(),
      qCode: String(r.qCode || ''),
      text: String(r.message || '')
    }));
  if (AERODROME_NOTAMS.length) {
    AERODROME_SOURCE = `${snapshot.source} (pulled ${snapshot.pulledAt})`;
  }
} catch {
  AERODROME_NOTAMS = [];
}

// FIR-scoped rows kept intentionally: each report fixture mixes a few in so the
// "aerodrome only" rule is exercised (they must be dropped before the payload).
const FIR_NOTAMS = NOTAMS.map((n) => ({ ...n, fir: true }));

// Real FIR/UIR designators from the seed corpus (WIIF, WAAF, RPHI, …). Used as the
// station key of the mixed-in FIR rows, because that is what makes a NOTAM
// non-aerodrome in the shipped rule.
const FIR_STATIONS = [...new Set(NOTAMS.map(stationOf).filter(isFirStation))].sort();
if (!FIR_STATIONS.length) throw new Error('Gate C fixtures: seed corpus has no FIR/UIR designator to exercise the drop rule');

const AERODROME_BY_STATION = new Map();
for (const n of AERODROME_NOTAMS) {
  if (!AERODROME_BY_STATION.has(n.station)) AERODROME_BY_STATION.set(n.station, []);
  AERODROME_BY_STATION.get(n.station).push(n);
}
const AERODROME_STATIONS = [...AERODROME_BY_STATION.keys()].sort();

// ---- real flight records (staging snapshot) ---------------------------------
//
// The seed file (archive/seed_flights.sql) only carries callsign/dep/dest/alt, so it has
// no enroute stations at all. Inventing them once made a WADD→WATO flight show TAF and
// NOTAM for VTSP (Phuket) and VVDN (Da Nang) — stations that flight does not have. Real
// records come from tests/pull_staging_flights.mjs; when the snapshot is absent the
// fixtures use the seed values and simply have no enroute stations, which is also what
// most real flights look like (45 of 55 staging flights have enr1-3 empty).
const FLIGHTS_SNAPSHOT = new URL('../test-results/gate-c/staging/flights-staging.json', import.meta.url);
let REAL_FLIGHTS = [];
let FLIGHTS_SOURCE = `archive/seed_flights.sql (${SEED_FLIGHTS.length} rows, no enroute columns)`;
try {
  const snap = JSON.parse(await readFile(FLIGHTS_SNAPSHOT, 'utf8'));
  REAL_FLIGHTS = (snap.rows || []).map((r) => ({
    callsign: String(r.callsign || '').trim(),
    dep: String(r.dep || '').trim().toUpperCase(),
    dest: String(r.dest || '').trim().toUpperCase(),
    alt: String(r.alt || '').trim().toUpperCase(),
    enr1: String(r.enr1 || '').trim().toUpperCase(),
    enr2: String(r.enr2 || '').trim().toUpperCase(),
    enr3: String(r.enr3 || '').trim().toUpperCase(),
    acType: String(r.acType || '').trim(),
    dof: String(r.dof || '').trim(),
    etd: String(r.etd || '').trim(),
    eta: String(r.eta || '').trim()
  })).filter((r) => r.callsign && r.dep && r.dest);
  if (REAL_FLIGHTS.length) FLIGHTS_SOURCE = `${snap.source} (pulled ${snap.pulledAt})`;
} catch {
  REAL_FLIGHTS = [];
}

// TAF stations are still needed to assert that a flight's context is complete; they are
// validation input, never a source of flight stations.
const TAF_STATIONS = Object.keys(TAFS).sort();
const NOTAMS_BY_STATION = new Map();
for (const n of NOTAMS) {
  const s = stationOf(n);
  if (!NOTAMS_BY_STATION.has(s)) NOTAMS_BY_STATION.set(s, []);
  NOTAMS_BY_STATION.get(s).push(n);
}
const NOTAM_STATIONS = [...NOTAMS_BY_STATION.keys()].sort();

const hasTaf = (code) => !!TAFS[String(code || '').toUpperCase()];
const stationCodes = (f) => ['dep', 'dest', 'alt', 'enr1', 'enr2', 'enr3']
  .map((k) => String(f[k] || '').trim().toUpperCase())
  .filter(Boolean);
/** A flight is "TAF-complete" when EVERY station it uses has real TAF text. */
const tafComplete = (f) => stationCodes(f).every(hasTaf);

/**
 * Pick `count` REAL flights. Prefers TAF-complete flights whose callsign is not already
 * QZ-prefixed, so the fixture exercises the record exactly as the database holds it and
 * the TAF assertions have real data to check. Flights whose alternate/enroute stations
 * have no TAF row are legitimate — they produce explicit "unavailable" context — but
 * they belong in their own scenario, not in the fidelity matrix.
 * Falls back to the seed rows when no snapshot exists.
 */
function pickSeedFlights(count) {
  if (REAL_FLIGHTS.length) {
    const clean = REAL_FLIGHTS.filter((f) => !/^QZ/i.test(f.callsign));
    const complete = clean.filter(tafComplete);
    const source = complete.length >= count ? complete : (clean.length >= count ? clean : REAL_FLIGHTS);
    return source.slice(0, count);
  }
  const pool = SEED_FLIGHTS.filter((f) => TAFS[f.dep] && TAFS[f.dest]);
  const source = pool.length >= count ? pool : SEED_FLIGHTS;
  return source.slice(0, count).map((f) => ({ ...f, enr1: '', enr2: '', enr3: '' }));
}

const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
};

/**
 * Build a selection dataset for `count` flights (1..4).
 * @param {number} count 1..4
 * @param {{notamsPerFlight?:number, oversizeText?:number, phase?:string}} [opts]
 */
export function buildFlightDataset(count, opts = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error('buildFlightDataset: count must be 1..4');
  }
  const notamsPerFlight = opts.notamsPerFlight ?? 3;
  const oversizeText = opts.oversizeText ?? 0;
  const phase = opts.phase || '01';

  const seed = pickSeedFlights(count);
  const used = new Set();
  const flights = [];

  seed.forEach((s, i) => {
    const dep = s.dep;
    const arr = s.dest;
    const alt = s.alt;
    used.add(dep); used.add(arr); used.add(alt);

    // Enroute stations come from the RECORD, never from a station pool. Most real
    // flights have none (45 of 55 in staging), and a flight that has none must show
    // TAF/NOTAM for exactly dep/arr/alt — nothing else.
    const enr1 = String(s.enr1 || '').trim().toUpperCase();
    const enr2 = String(s.enr2 || '').trim().toUpperCase();
    const enr3 = String(s.enr3 || '').trim().toUpperCase();
    if (enr1) used.add(enr1);
    if (enr2) used.add(enr2);
    if (enr3) used.add(enr3);

    flights.push({
      rowIdx: 20 + i,
      FLIGHT: /^QZ/i.test(s.callsign) ? s.callsign.toUpperCase() : `QZ${s.callsign}`,
      DOF: dofDash(s.dof),
      DEP: dep,
      ARR: arr,
      STD: hhmm(s.etd),
      STA: hhmm(s.eta),
      REG: s.reg || s.acType || '',
      ALT: alt,
      ENR1: enr1,
      ENR2: enr2,
      ENR3: enr3,
      TAF_DEP: `TAF ${dep} (board summary)`,
      TAF_ARR: `TAF ${arr} (board summary)`
    });
  });

  // ---- TAF context ---------------------------------------------------------
  const tafStations = [];
  const roleFor = { DEP: 'DEP', ARR: 'ARR', ALT: 'ALT', ENR1: 'ENR', ENR2: 'ENR', ENR3: 'ENR' };
  const meta = new Map();
  for (const f of flights) {
    for (const k of ['DEP', 'ARR', 'ALT', 'ENR1', 'ENR2', 'ENR3']) {
      const stn = String(f[k] || '').trim().toUpperCase();
      if (!stn) continue;
      if (!meta.has(stn)) { meta.set(stn, { roles: [], flights: [] }); tafStations.push(stn); }
      const m = meta.get(stn);
      if (!m.roles.includes(roleFor[k])) m.roles.push(roleFor[k]);
      if (!m.flights.includes(f.FLIGHT)) m.flights.push(f.FLIGHT);
    }
  }

  const tafByStation = {};
  for (const stn of tafStations) {
    const t = TAFS[stn];
    const m = meta.get(stn);
    const text = oversizeText && stn === tafStations[0] ? 'X'.repeat(oversizeText) : (t ? t.text : '');
    tafByStation[stn] = {
      station: stn,
      roles: m.roles,
      flights: m.flights,
      text,
      issueTime: t ? t.issueTime : null,
      available: !!(t && t.text)
    };
  }

  // ---- NOTAM context: AERODROME ONLY ---------------------------------------
  //
  // `notamContext` must never carry FIR/UIR-scoped NOTAMs. The fixture builds the
  // aerodrome part from the staging corpus and then deliberately mixes in FIR rows
  // (one per flight) so the QA suite can assert they are dropped at the payload
  // boundary. `firStationMap` records what those FIR rows were attached to, which
  // lets a test prove the payload dropped them rather than the fixture omitting them.
  const notamsByFlight = {};
  const firStationMap = {};
  flights.forEach((f, i) => {
    // Aerodrome NOTAMs must belong to a station the flight actually has. Choosing from
    // the global aerodrome pool instead produced NOTAMs for WADL/WARR on a flight whose
    // stations are WADD/VTSP/WIMM/WMKP — which the shipped rule then correctly dropped as
    // out of scope, making the fixture look like it had found a rule violation.
    const flightStations = ['DEP', 'ARR', 'ALT', 'ENR1', 'ENR2', 'ENR3']
      .map((k) => String(f[k] || '').trim().toUpperCase())
      .filter(Boolean);
    const aerodromeStation = flightStations.find((s) => AERODROME_BY_STATION.has(s)) || f.DEP;
    const aerodromePool = AERODROME_BY_STATION.get(aerodromeStation) || [];
    // FIR rows come from the seed corpus; keyed by the aerodrome they were filed near.
    const seedPool = NOTAMS_BY_STATION.get(f.DEP) || NOTAMS_BY_STATION.get(NOTAM_STATIONS[i % NOTAM_STATIONS.length]) || [];

    const chosen = [];
    for (let k = 0; k < notamsPerFlight; k++) {
      if (!aerodromePool.length) break;
      chosen.push({ ...aerodromePool[(i * 7 + k * 3) % aerodromePool.length], aerodrome: true });
    }
    // One FIR/UIR row attached to a selected flight: the report must not include it.
    // Its `station` stays the FIR designator — that is what makes it non-aerodrome —
    // so the Web 1 preview names the FIR, not the aerodrome it was filed near.
    if (seedPool.length) {
      const fir = { ...seedPool[i % seedPool.length], aerodrome: false, fir: true };
      chosen.push(fir);
      firStationMap[aerodromeStation] = fir.id;
    }

    notamsByFlight[f.FLIGHT] = chosen.map((n, k) => ({
      id: `${n.id}-${k + 1}`,
      station: n.aerodrome === false ? String(n.station).toUpperCase() : aerodromeStation,
      flights: [f.FLIGHT],
      text: k === 0 && oversizeText ? 'N'.repeat(oversizeText) : n.text,
      status: 'IMPACTED',
      selected: true,
      aerodrome: n.aerodrome !== false,
      fir: n.fir === true
    }));
  });
  const rawNotamsByFlight = JSON.parse(JSON.stringify(notamsByFlight));

  // Raw shape of Web 2's `analyzeNotams` response, per station, mixing aerodrome
  // and FIR/UIR rows. The real `getReportNotamContext()` from src/Notam_Ui.html
  // consumes this shape, so a harness that feeds it this response exercises the
  // shipped aerodrome-only rule instead of re-implementing it.
  const notamResponseByStation = {};
  const responseStation = (station, flightsStr) => {
    if (!notamResponseByStation[station]) notamResponseByStation[station] = { station: station, stationKey: station, flightsStr: '', notams: [] };
    var entry = notamResponseByStation[station];
    // `flightsStr` is the UNION of the flights this station entry serves, exactly like
    // the real analyzeNotams response. Keeping only the first flight made rows belonging
    // to the second flight look unowned, so the shipped selector rejected them as
    // "not selected for a selected flight" instead of scoping them.
    var have = entry.flightsStr ? entry.flightsStr.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    if (have.indexOf(flightsStr) === -1) have.push(flightsStr);
    entry.flightsStr = have.join(', ');
    return entry;
  };
  flights.forEach((f) => {
    // The UI only produces aerodrome rows for a selected flight; the FIR row below
    // is what makes the drop rule observable.
    for (const n of rawNotamsByFlight[f.FLIGHT]) {
      if (!n.aerodrome) continue;
      const entry = responseStation(n.station, f.FLIGHT);
      // The shipped selector reads NOTAM fields from the station entry (`station`,
      // `notamNum`, `rawText`, `status`) — the same shape the staging Worker returns.
      if (!entry.notams.some((x) => x.notamNum === n.id)) {
        entry.notams.push({ station: n.station, notamNum: n.id, rawText: n.text, status: n.status });
      }
    }
  });
  // FIR/UIR-wide rows, keyed by their FIR designator. Each is attached to the
  // selected flight that owns it, exactly like the staging response does.
  //
  // The designator must NOT also be one of the flights' aerodrome stations: the rule
  // accepts a NOTAM whose station is any DEP/ARR/ALT/ENR of a selected flight, so a
  // collision would make the row legitimately in-scope and the fixture would then be
  // measuring nothing. (A real flight enroute through its own FIR would match for the
  // same reason — that is the rule working, not a gap.)
  const allFlightStations = new Set();
  flights.forEach((f) => ['DEP', 'ARR', 'ALT', 'ENR1', 'ENR2', 'ENR3'].forEach((k) => {
    const s = String(f[k] || '').trim().toUpperCase();
    if (s) allFlightStations.add(s);
  }));
  const usableFirStations = FIR_STATIONS.filter((s) => !allFlightStations.has(s));
  if (usableFirStations.length < flights.length) {
    if (process.env.GATEC_DEBUG_FIXTURE) {
      console.error('[debug] flight stations:', JSON.stringify([...allFlightStations].sort()));
      console.error('[debug] FIR_STATIONS  :', JSON.stringify(FIR_STATIONS));
      console.error('[debug] flights       :', JSON.stringify(flights.map((f) => [f.FLIGHT, f.DEP, f.ARR, f.ALT, f.ENR1, f.ENR2])));
    }
    throw new Error(`Gate C fixtures: need ${flights.length} FIR designators that are not aerodrome stations, have ${usableFirStations.length}`);
  }
  flights.forEach((f, i) => {
    const fir = rawNotamsByFlight[f.FLIGHT].find((n) => !n.aerodrome);
    if (!fir) return;
    const firStation = usableFirStations[i];
    const entry = responseStation(firStation, f.FLIGHT);
    entry.notams.push({ station: firStation, notamNum: fir.id, rawText: fir.text, status: fir.status });
    firStationMap[firStation] = fir.id;
  });
  // Nothing in the fixture is allowed to be FIR-scoped outside those rows.
  const expectedFirDropped = flights.filter((f) => (rawNotamsByFlight[f.FLIGHT] || []).some((n) => !n.aerodrome)).length;
  if (expectedFirDropped !== flights.length) {
    throw new Error(`Gate C fixtures: expected one FIR row per flight, got ${expectedFirDropped}/${flights.length}`);
  }

  // What Web 2 should actually send: aerodrome rows only.
  for (const flightNumber of Object.keys(notamsByFlight)) {
    notamsByFlight[flightNumber] = notamsByFlight[flightNumber].filter((n) => n.aerodrome);
  }

  const noSigStationMap = Object.fromEntries(tafStations.slice(0, 2).map((s) => [s, true]));

  // Exact shape Web 2 persists after analyzeNotams: { [FLIGHT]: [notamId, ...] }.
  //
  // Built from the RAW response, so it includes the FIR/UIR rows. That matters: the
  // shipped selector only considers a NOTAM it can attribute to a selected flight, and
  // drops it for being out of scope. If the FIR rows were absent here they would be
  // rejected as *unowned* instead, and the fixture would be proving the wrong rule.
  const savedNotamAnalysis = Object.fromEntries(
    flights.map((f) => [f.FLIGHT, rawNotamsByFlight[f.FLIGHT].map((n) => n.id)])
  );
  const expectedAerodromeNotams = Object.fromEntries(
    flights.map((f) => [f.FLIGHT, notamsByFlight[f.FLIGHT].map((n) => n.id)])
  );

  return {
    count,
    phase,
    flights,
    tafByStation,
    notamsByFlight,
    rawNotamsByFlight,
    firStationMap,
    notamResponseByStation: {
      ok: true,
      data: Object.keys(notamResponseByStation).sort().map((s) => notamResponseByStation[s])
    },
    expectedFirDropped: expectedFirDropped,
    savedNotamAnalysis,
    expectedAerodromeNotams,
    noSigStationMap,
    flightNumbers: flights.map((f) => f.FLIGHT),
    maxTafBytes: Math.max(0, ...tafStations.map((s) => bytes(tafByStation[s].text))),
    maxNotamBytes: Math.max(
      0,
      ...Object.values(notamsByFlight).flat().map((n) => bytes(n.text))
    ),
    seedSource: {
      tafs: `archive/seed_tafs.sql (${Object.keys(TAFS).length} rows)`,
      notams: AERODROME_SOURCE,
      firNotamsMixed: `${FIR_NOTAMS.length} FIR-scoped seed rows available; 1 per flight mixed in to test the drop rule`,
      flights: `archive/seed_flights.sql (${SEED_FLIGHTS.length} rows)`
    }
  };
}

export { canonicalJson, bytes, TAFS, NOTAMS, SEED_FLIGHTS, AERODROME_NOTAMS, AERODROME_SOURCE, FIR_STATIONS };
