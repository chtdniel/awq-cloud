/**
 * Notam_Tests.gs — NOTAM regression fixtures.
 * Run `runNotamRegressionTests()` from the Apps Script editor.
 * No framework: assert-style, throw on fail, return JSON report.
 */

function runNotamRegressionTests() {
  const results = [];
  function t(name, fn) {
    try { fn(); results.push({ name: name, pass: true }); }
    catch (e) { results.push({ name: name, pass: false, error: String((e && e.message) || e) }); }
  }
  function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((label || 'value') + ' — expected ' + b + ' got ' + a);
  }
  function ok(cond, label) { if (!cond) throw new Error(label); }
  function isUtc(d, y, mo, day, h, mi) {
    ok(d instanceof Date && !isNaN(d.getTime()), 'not a valid Date');
    eq([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()],
      [y, mo, day, h, mi], 'UTC datetime');
  }

  // --- duParseNotamDate (B/C line) ---
  t('B-line year-end boundary 2512312300', () => isUtc(duParseNotamDate('2512312300'), 2025, 12, 31, 23, 0));
  t('B-line year rollover 2601010100', () => isUtc(duParseNotamDate('2601010100'), 2026, 1, 1, 1, 0));
  t('8-digit YYYYMMDD', () => isUtc(duParseNotamDate('20260821'), 2026, 8, 21, 0, 0));
  t('PERM is not a date', () => ok(isNaN(duParseNotamDate('PERM').getTime()), 'PERM must be NaN'));
  t('invalid month rejected', () => ok(isNaN(duParseNotamDate('2613011230').getTime()), 'month 13 must be NaN'));

  // --- duParseFlightDate (DOF) ---
  t('DOF 6-digit YYMMDD', () => isUtc(duParseFlightDate('260821'), 2026, 8, 21, 0, 0));
  t('DOF invalid -> null', () => eq(duParseFlightDate('invalid-date'), null));

  // --- duParseAltitude ---
  t('altitude GND/SFC/FL/UNL/FL999', () => {
    eq(duParseAltitude('GND'), 0);
    eq(duParseAltitude('SFC'), 0);
    eq(duParseAltitude('FL360'), 360);
    eq(duParseAltitude('360'), 360);
    eq(duParseAltitude('UNL'), 999);
    eq(duParseAltitude('UNLIMITED'), 999);
    eq(duParseAltitude('FL999'), 999);
    eq(duParseAltitude('bogus'), null);
  });

  // --- firParseNotamText ---
  t('parse full NOTAM', () => {
    const p = firParseNotamText('W0012/26\nQ) WAAA/QDLUL/IV/BO/W/003/999/0610S10639E012\nA) WAAA\nB) 2608210900\nC) 2608211500\nE) DANGER AREA ACTIVE\nF) FL100\nG) FL200');
    eq(p.qCode, 'QDLUL');
    eq(p.start, '2608210900');
    eq(p.end, '2608211500');
    eq(p.schedule, null);
    eq(p.minAlt, 100);
    eq(p.maxAlt, 200);
  });
  t('parse GND/UNL limits', () => {
    const p = firParseNotamText('W0001/26\nQ) WAAA/QXXXX/IV/BO/E/000/999/0610S10639E\nA) WAAA\nB) 2608210900\nC) 2608211500\nF) GND\nG) UNL');
    eq(p.minAlt, 0);
    eq(p.maxAlt, 999);
  });
  t('parse D-line schedule + C PERM', () => {
    const p = firParseNotamText('W0009/26\nQ) WAAA/QRLRW/IV/BO/E/000/999/0620S10648E000\nA) WAAA\nB) 2608010000\nC) PERM\nD) DAILY 1300-1500\nE) WORK\nF) GND\nG) SFC');
    eq(p.schedule, 'DAILY 1300-1500');
    eq(p.end, 'PERM');
  });
  t('no Q line -> null', () => eq(firParseNotamText('A) WAAA\nB) 2608210900'), null));
  t('no B line -> null', () => eq(firParseNotamText('Q) WAAA/QDLUL/IV/BO/W/003/999/0610S10639E012\nA) WAAA'), null));
  t('DINS dump header still parses', () => {
    const p = firParseNotamText('NOTAM LIST\nWAAA 5\nW0123/26\nQ) WAAA/QDMRU/IV/BO/W/000/999/0620S10648E000\nB) 2608210000\nC) PERM\nE) MILITARY FLYING ACTIVITY');
    ok(p, 'must still parse');
    eq(p.qCode, 'QDMRU');
    eq(p.start, '2608210000');
    eq(p.end, 'PERM');
  });
  t('class = number prefix letter', () => {
    eq(firInferNotamClass('W0123/26'), 'W');
    eq(firInferNotamClass('E0456/26 R E0455/26'), 'E');
    eq(firInferNotamClass('no number here'), 'N/A');
  });

  // --- Q-line geometry ---
  t('Q-line DMS + radius', () => {
    const text = 'Q) WAAA/QDLUL/IV/BO/W/003/999/0610S10639E012\nA) WAAA\nE) TEST';
    eq(firParseNotamCoord(text), { lat: -6.1667, lon: 106.65 });
    const g = firParseNotamGeometry(text);
    eq(g.center, [106.65, -6.1667]);
    eq(g.radiusNm, 12);
    eq(g.polygon, []);
  });
  t('Q-line without radius', () => {
    const g = firParseNotamGeometry('Q) WAAA/QXXXX/IV/NBO/E/000/999/1234S12000E\nE) VOR U/S');
    eq(g.center, [120, -12.5667]);
    eq(g.radiusNm, null);
  });
  t('Q-line without coords', () => {
    const g = firParseNotamGeometry('Q) WAAA/QXXXX/IV/NBO/E/000/999\nE) VOR U/S');
    eq(g.center, null);
    eq(g.radiusNm, null);
    eq(g.polygon, []);
  });
  t('E-line polygon extraction', () => {
    const g = firParseNotamGeometry('Q) WAAA/QDLUL/IV/BO/W/003/999/0610S10639E012\nE) 0600S10600E 0600S10700E 0700S10700E 0700S10600E');
    eq(g.polygon, [[106, -6], [107, -6], [107, -7], [106, -7]]);
  });

  // --- time overlap ---
  t('time overlap: intersecting', () => {
    const w = firGetFlightTimeWindow({ DOF: '260821', STD: '1000', STA: '1200' });
    ok(firCheckTimeOverlap(w, '2608210900', '2608211100', null), 'must overlap');
  });
  t('time overlap: disjoint', () => {
    const w = firGetFlightTimeWindow({ DOF: '260821', STD: '1000', STA: '1200' });
    ok(!firCheckTimeOverlap(w, '2608211300', '2608211400', null), 'must not overlap');
  });
  t('flight window crosses year end', () => {
    const w = firGetFlightTimeWindow({ DOF: '251231', STD: '2330', STA: '0130' });
    isUtc(w.start, 2025, 12, 31, 23, 30);
    isUtc(w.end, 2026, 1, 1, 1, 30);
    ok(firCheckTimeOverlap(w, '2512312300', '2601010200', null), 'rollover must overlap');
  });
  t('D-line crossing midnight: inside', () => {
    const w = firGetFlightTimeWindow({ DOF: '260821', STD: '2300', STA: '0100' });
    ok(firCheckTimeOverlap(w, '2608210000', '2608212359', 'DAILY 2200-0200'), 'must be inside DAILY 2200-0200');
  });
  t('D-line crossing midnight: outside', () => {
    const w = firGetFlightTimeWindow({ DOF: '260821', STD: '0400', STA: '0500' });
    ok(!firCheckTimeOverlap(w, '2608210000', '2608212359', 'DAILY 2200-0200'), 'must be outside');
  });

  // --- route text impact (weak check for now) ---
  t('route impact: waypoint in E-text', () => {
    const r = firCheckRouteImpact('E) VOR WADD U/S', ['WADD', 'PU20']);
    ok(r.impacted, 'must be impacted');
    eq(r.matches, ['WADD']);
  });
  t('route impact: no mention', () => {
    ok(!firCheckRouteImpact('E) NAVAID U/S', ['WADD']).impacted, 'must not be impacted');
  });

  // --- end-to-end firAnalyzeFlight ---
  const e2eFlight = { DOF: '260821', STD: '1000', STA: '1200', 'CRZ FL': 360, 'FIR 1': 'WAAA', 'ROUTE ID': 'R01' };
  const e2eRoutes = [{ ID: 'R01', 'WAYPOINT_SEQ (Airway & Fix)': 'WADD PU20 WAWL' }];
  t('e2e: direct impact flagged HIGH', () => {
    const r = firAnalyzeFlight(e2eFlight, [{
      Location: 'WAAA',
      'NOTAM #': 'W0001/26',
      'NOTAM Text': 'W0001/26\nQ) WAAA/QDMRU/IV/BO/W/000/999/0620S10648E000\nA) WAAA\nB) 2608210900\nC) 2608211500\nE) MILITARY ACTIVITY WADD ACTIVE\nF) GND\nG) UNL'
    }], e2eRoutes);
    eq(r.analysis.length, 1);
    ok(r.analysis[0].isDirectImpact, 'must be direct impact');
    eq(r.riskLevel, 'HIGH');
  });
  t('e2e: waypoint not mentioned -> Clear', () => {
    const r = firAnalyzeFlight(e2eFlight, [{
      Location: 'WAAA',
      'NOTAM #': 'W0002/26',
      'NOTAM Text': 'W0002/26\nQ) WAAA/QDMRU/IV/BO/W/000/999/0620S10648E000\nA) WAAA\nB) 2608210900\nC) 2608211500\nE) MILITARY ACTIVITY FAR AWAY\nF) GND\nG) UNL'
    }], e2eRoutes);
    ok(!r.analysis[0].isDirectImpact, 'must not be direct impact');
    eq(r.riskLevel, 'Clear');
  });

  // --- bulk import date normalization ---
  t('bulk raw ICAO: dates normalized to YYYY-MM-DD HH:MM', () => {
    const p = firParseBulkNotamText('W0001/26\nQ) WAAA/QDMRU/IV/BO/W/000/999/0620S10648E000\nA) WAAA 2608210900\nB) 2608210900\nC) 2608221500\nE) TEST');
    ok(p.ok, 'parse failed: ' + (p.error || ''));
    eq(p.rows.length, 1);
    eq(p.rows[0][3], '2026-08-21 09:00');
    eq(p.rows[0][4], '2026-08-21 09:00');
    eq(p.rows[0][5], '2026-08-22 15:00');
  });
  t('bulk raw ICAO: C) PERM preserved', () => {
    const p = firParseBulkNotamText('W0002/26\nQ) WAAA/QDMRU/IV/BO/W/000/999/0620S10648E000\nA) WAAA 2608210900\nB) 2608210900\nC) PERM\nE) TEST');
    ok(p.ok, 'parse failed: ' + (p.error || ''));
    eq(p.rows[0][5], 'PERM');
  });

  const passed = results.filter(r => r.pass).length;
  const report = { total: results.length, passed: passed, failed: results.length - passed, details: results };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Phase 0 — FIR analysis remediation: real-schema regression fixtures.
 * Run `runFirRealSchemaTests()` from the Apps Script editor.
 * Red-first: baseline 2026-08-30 expected 12 RED / 3 GREEN.
 * Reference: audit/fir-analysis-backend-audit-2026-08-30.md
 *          audit/fir-analysis-remediation-plan.md (Fase 0)
 */

function runFirRealSchemaTests() {
  const results = [];
  function t(name, fn) {
    try { fn(); results.push({ name: name, pass: true }); }
    catch (e) { results.push({ name: name, pass: false, error: String((e && e.message) || e) }); }
  }
  function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((label || 'value') + ' — expected ' + b + ' got ' + a);
  }
  function ok(cond, label) { if (!cond) throw new Error(label); }
  function isUtc(d, y, mo, day, h, mi) {
    ok(d instanceof Date && !isNaN(d.getTime()), 'not a valid Date');
    eq([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()],
      [y, mo, day, h, mi], 'UTC datetime');
  }

  // Flight shape EXACTLY as firProcessSheetData() output over the real header
  // 17 columns of sheet 'FLT INFO' (see Flight_Backend.gs).
  // `airports` = in-memory stub for firGetAirportFirMap_ (B-strategy);
  // in GAS the map is read from sheet AIRPORT_FIR.
  const realFlight = {
    FLIGHT: 'QZ534', DEP: 'WIII', ARR: 'WADD', STD: '1000', STA: '1200',
    REG: 'HS-WAA', ALT: 'FL360', 'CRZ FL': 'FL360',
    DOF: '260821', 'ACTIVE ROUTE ID': 'WIIWAD10'
  };
  const realRoutes = [{ ID: 'WIIWAD10', WAYPOINT_SEQ: 'ATMAP KALIV BLI' }];
  const mkNotam = function (num, eText, fLine, gLine) {
    return {
      Location: 'WIII',
      'NOTAM #': num,
      'NOTAM Text': num +
        '\nQ) WIII/QDMRU/IV/BO/W/000/999/0610S10639E025' +
        '\nA) WIII\nB) 2608210900\nC) 2608211500' +
        '\nF) ' + (fLine || 'GND') +
        '\nG) ' + (gLine || 'UNL') +
        '\nE) ' + eText
    };
  };

  // F-01 — real-schema e2e (RED today: no FIR column → empty filter;
  // 'ROUTE ID' vs 'ACTIVE ROUTE ID'; parseInt('FL360')=0).
  t('F-01 real-schema e2e: direct impact HIGH', () => {
    const r = firAnalyzeFlight(realFlight, [mkNotam('W0001/26', 'MILITARY FLYING ACTIVITY NEAR KALIV 1000-1400')], realRoutes);
    eq(r.analysis.length, 1, 'analysis entries');
    eq(r.analysis[0].isDirectImpact, true, 'isDirectImpact');
    eq(r.riskLevel, 'HIGH', 'riskLevel');
  });

  // F-02 — cruise altitude contract (RED today; assert post-Phase-1 behavior).
  t('F-02a cruise FL360 within FL200-FL400', () => {
    const r = firAnalyzeFlight(realFlight, [mkNotam('W0002/26', 'WIP NEAR KALIV', 'FL200', 'FL400')], realRoutes);
    eq(r.analysis.length, 1, 'analysis entries');
    eq(r.analysis[0].isDirectImpact, true, 'alt match must hold');
  });
  t('F-02b cruise FL360 outside GND-FL100', () => {
    const r = firAnalyzeFlight(realFlight, [mkNotam('W0003/26', 'WIP NEAR KALIV', 'GND', 'FL100')], realRoutes);
    eq(r.analysis.length, 1, 'analysis entries');
    eq(r.analysis[0].isDirectImpact, false, 'alt mismatch expected');
  });

  // F-03 — real header mapping contract (guard; expected GREEN).
  t('F-03 firProcessSheetData maps real 17-col header', () => {
    const header = ['FLIGHT','DEP','ARR','STD','STA','REG','ALT','TAF_DEP','TAF_ARR','ENR1','ENR2','ENR3','CGO','ATC','REMARK','DOF','ACTIVE ROUTE ID',''];
    const row = ['QZ534','WIII','WADD','1000','1200','HS-WAA','FL360','','','','','','','','','260821','WIIWAD10',''];
    const out = firProcessSheetData([header, row]);
    eq(out.length, 1, 'rows');
    eq(out[0].FLIGHT, 'QZ534', 'FLIGHT');
    eq(out[0]['ACTIVE ROUTE ID'], 'WIIWAD10', 'ACTIVE ROUTE ID');
    eq(out[0].ALT, 'FL360', 'ALT');
    eq(out[0]['CRZ FL'], 'FL360', 'alias CRZ FL from ALT');
  });

  // F-04 — lifecycle R/C: replaced/cancelled ones are not hazards (RED today).
  const mkRepl = function () {
    return {
      Location: 'WIII',
      'NOTAM #': 'W0125/26',
      'NOTAM Text': 'W0125/26 NOTAMR W0120/26' +
        '\nQ) WIII/QDMRU/IV/BO/W/000/999/0610S10639E025' +
        '\nA) WIII\nB) 2608210900\nC) 2608211500\nF) GND\nG) UNL' +
        '\nE) DANGER NEAR KALIV (UPDATED)'
    };
  };
  t('F-04a replaced NOTAM suppressed', () => {
    const r = firAnalyzeFlight(realFlight, [mkNotam('W0120/26', 'DANGER NEAR KALIV'), mkRepl()], realRoutes);
    const haz = r.analysis.filter(a => a.isDirectImpact);
    eq(haz.length, 1, 'only the replacement NOTAM counts');
    ok(!haz.some(a => a.number === 'W0120/26'), 'replaced NOTAM is not a hazard');
    ok(haz.some(a => a.number === 'W0125/26'), 'replacement NOTAM is the hazard');
  });
  t('F-04b cancelled NOTAM suppressed', () => {
    const cancel = {
      Location: 'WIII',
      'NOTAM #': 'W0130/26',
      'NOTAM Text': 'W0130/26 NOTAMC W0125/26' +
        '\nQ) WIII/QDMRU/IV/BO/W/000/999/0610S10639E025' +
        '\nA) WIII\nB) 2608210900\nC) 2608211500\nF) GND\nG) UNL' +
        '\nE) NOTAMC W0125/26'
    };
    const r = firAnalyzeFlight(realFlight, [mkNotam('W0120/26', 'DANGER NEAR KALIV'), mkRepl(), cancel], realRoutes);
    ok(r.analysis.some(a => a.number === 'W0125/26'), 'input must reach the engine (anti-vacuous guard)');
    eq(r.analysis.filter(a => a.isDirectImpact).length, 0, 'no active hazard after cancel');
  });

  // F-05 — D-line weekday (RED today: only DAILY supported).
  t('F-05a MON-FRI, Saturday flight -> no overlap', () => {
    const w = firGetFlightTimeWindow({ DOF: '260822', STD: '1400', STA: '1600' }); // Saturday 22 Aug 2026
    eq(firCheckTimeOverlap(w, '2608170000', '2608312359', 'MON-FRI 1300-1500'), false, 'Saturday outside MON-FRI');
  });
  t('F-05b MON-FRI, Monday flight -> overlap (control)', () => {
    const w = firGetFlightTimeWindow({ DOF: '260824', STD: '1400', STA: '1500' }); // Monday 24 Aug 2026
    eq(firCheckTimeOverlap(w, '2608170000', '2608312359', 'MON-FRI 1300-1500'), true, 'Monday inside MON-FRI');
  });

  // F-06 — TZ contract: typed Date cells = UTC (RED today in the STD part: local getHours).
  t('F-06a STD typed Date read as UTC', () => {
    const w = firGetFlightTimeWindow({ DOF: '260821', STD: new Date(Date.UTC(2026, 7, 21, 1, 0)), STA: '1200' });
    isUtc(w.start, 2026, 8, 21, 1, 0);
  });
  t('F-06b DOF typed Date resolved to its UTC day', () => {
    const w = firGetFlightTimeWindow({ DOF: new Date(Date.UTC(2026, 7, 20, 17, 0)), STD: '1000', STA: '1200' });
    isUtc(w.start, 2026, 8, 21, 10, 0);
  });

  // F-07 — Date cells in the FIR sheet must parse to correct UTC (RED today:
  // String(Date) = garbage locale → duParseNotamDate NaN).
  t('F-07 FIR-sheet Date cell -> Effective/Expiration UTC', () => {
    const row = ['WIII', 'A0055/26', 'E',
      new Date(Date.UTC(2026, 7, 21, 6, 0)),
      new Date(Date.UTC(2026, 7, 21, 9, 0)),
      new Date(Date.UTC(2026, 7, 31, 23, 59)),
      'Q)WIII/QWULW/IV/NBO/E/000/999/0610S10639E012\nA)WIII B)2608210900 C)2608312359\nE)RWY 09 CLSD'];
    const out = firParseFirSheetNotams([row]);
    eq(out.length, 1, 'parsed row');
    isUtc(duParseNotamDate(out[0]['Effective Date']), 2026, 8, 21, 9, 0);
    isUtc(duParseNotamDate(out[0]['Expiration Date']), 2026, 8, 31, 23, 59);
  });

  // F-08 — geometric detection (RED today: firCheckRouteGeometry missing).
  // Phase-3 contract: polyline = [[lat, lon], ...]; geometry = shape
  // firParseNotamGeometry {center:[lon,lat], radiusNm, polygon:[[lon,lat],...]}.
  const geoCircle = firParseNotamGeometry('Q) WIII/QDMRU/IV/BO/W/000/999/0600S10636E050\nE) TEST'); // center (106.6,-6.0) r=50nm
  t('F-08a route 20 nm from center, radius 50 -> impacted', () => {
    const near = [[-5.667, 106.6], [-5.667, 106.7]];
    eq(firCheckRouteGeometry(near, geoCircle).impacted, true, 'circle intersect');
  });
  t('F-08b route 60 nm from center, radius 50 -> not impacted', () => {
    const far = [[-5.0, 106.6], [-5.0, 106.7]];
    eq(firCheckRouteGeometry(far, geoCircle).impacted, false, 'circle miss');
  });
  const geoBox = { center: null, radiusNm: null, polygon: [[106.5, -6.5], [107.0, -6.5], [107.0, -5.5], [106.5, -5.5]] };
  t('F-08c route crossing polygon -> impacted', () => {
    eq(firCheckRouteGeometry([[-6.6, 106.75], [-5.4, 106.75]], geoBox).impacted, true, 'polygon intersect');
  });
  t('F-08d route outside polygon -> not impacted', () => {
    eq(firCheckRouteGeometry([[-7.0, 106.75], [-7.0, 106.8]], geoBox).impacted, false, 'polygon miss');
  });

  // F-08e/f — endpoint clamping: center OUTSIDE the segment (projection t>1) →
  // nearest point = segment endpoint, not free projection.
  // Meridian route 106.6 from -5.0 to -6.0; center (106.8, -6.5) →
  // nearest = endpoint (106.6, -6.0), distance ≈ 32.3 nm (Δlat 0.5°=30nm, Δlon 0.2°≈12nm).
  const geoEnd40 = firParseNotamGeometry('Q) WIII/QDMRU/IV/BO/W/000/999/0630S10648E040\nE) TEST'); // r=40nm
  const geoEnd25 = firParseNotamGeometry('Q) WIII/QDMRU/IV/BO/W/000/999/0630S10648E025\nE) TEST'); // r=25nm
  const endRoute = [[-5.0, 106.6], [-6.0, 106.6]];
  t('F-08e endpoint-clamp: nearest ~32nm, radius 40 -> impacted', () => {
    const r = firCheckRouteGeometry(endRoute, geoEnd40);
    eq(r.impacted, true, 'endpoint hit');
    ok(r.nearestNm >= 30 && r.nearestNm <= 35, 'nearest ~32.3nm, got ' + r.nearestNm);
  });
  t('F-08f endpoint-clamp: nearest ~32nm, radius 25 -> not impacted', () => {
    eq(firCheckRouteGeometry(endRoute, geoEnd25).impacted, false, 'endpoint miss');
  });

  // F-09 — cache contract: all keys must be unique strings (old bug: var Constants = Constants || {} -> key undefined)
  t('F-09 cache keys non-empty & unique', () => {
    const keys = [FIR_CACHE_KEY_FLIGHTS_ROUTES, FIR_CACHE_KEY_ANALYZE_DATASET, FIR_CACHE_KEY_ACTIVE_NOTAMS_V3, FIR_CACHE_KEY_AIRPORT_FIR, FIR_CACHE_KEY_ROUTE_POLYLINE, FIR_NOTAM_CACHE_KEY];
    keys.forEach(k => { if (typeof k !== 'string' || !k) throw new Error('cache key undefined/empty'); });
    if (new Set(keys).size !== keys.length) throw new Error('duplicate cache key');
  });

  const passed = results.filter(r => r.pass).length;
  const report = { suite: 'fir-real-schema', total: results.length, passed: passed, failed: results.length - passed, details: results };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function runOperationalReadinessSelfCheck() {
  return operationalReadinessSelfCheck();
}
