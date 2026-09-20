// WX WARNING parser tests.
//
// Fixtures are real products captured from the official dissemination feeds on
// 20 SEP 2026 — the two JTWC/VAA products are the exact texts an operator pastes
// into the manual input box, so the manual path is exercised with production
// shapes rather than hand-made samples:
//   * WTPN31 PGTW 202100 — TROPICAL STORM 24W (DUJUAN) WARNING NR 022
//   * FVAU01 ADRM 202000 — Darwin VAAC, DUKONO 268010 (indented continuation)
//   * FVAU02 ADRM 201550 — Darwin VAAC, SEMERU 263300 (continuation at column 0)
//   * WTIO31 PGTW 270300 — continuation part of a split message (must be refused)
//   * ISIGMET sample — VA + TC + hazards outside scope (must be filtered)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseJtwcWarningText, parseVaaText, parseIsigmetWarnings, parseProducts,
  splitProducts, detectProductKind, unwrapVaaFields, parseCompactCoord,
  parseFlightLevels, parseWindRadii, maxRadiusNm, resolveDayHourMinute,
  parseVaaTimestamp, freshnessOf, inAsiaPacific, warningInRegion,
  textFingerprint, manualExternalId, toWarningRow, fromWarningRow,
  vaacListingCandidates, computeRouteHits, TC_MAX_AGE_HOURS, VA_MAX_AGE_HOURS
} from '../shared/wxwarning.mjs';

// Supplied by the operator as the manual-input example.
const JTWC_DUJUAN = `WTPN31 PGTW 202100
MSGID/GENADMIN/JOINT TYPHOON WRNCEN PEARL HARBOR HI//
SUBJ/TROPICAL STORM 24W (DUJUAN) WARNING NR 022//
RMKS/
1. TROPICAL STORM 24W (DUJUAN) WARNING NR 022
   01 ACTIVE TROPICAL CYCLONE IN NORTHWESTPAC
   MAX SUSTAINED WINDS BASED ON ONE-MINUTE AVERAGE
   WIND RADII VALID OVER OPEN WATER ONLY
    ---
   WARNING POSITION:
   201800Z --- NEAR 31.3N 137.9E
     MOVEMENT PAST SIX HOURS - 020 DEGREES AT 11 KTS
     POSITION ACCURATE TO WITHIN 030 NM
     POSITION BASED ON CENTER LOCATED BY SATELLITE
   PRESENT WIND DISTRIBUTION:
   MAX SUSTAINED WINDS - 060 KT, GUSTS 075 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 050 KT WINDS - 050 NM NORTHEAST QUADRANT
                            050 NM SOUTHEAST QUADRANT
                            040 NM SOUTHWEST QUADRANT
                            040 NM NORTHWEST QUADRANT
   RADIUS OF 034 KT WINDS - 200 NM NORTHEAST QUADRANT
                            170 NM SOUTHEAST QUADRANT
                            160 NM SOUTHWEST QUADRANT
                            200 NM NORTHWEST QUADRANT
   REPEAT POSIT: 31.3N 137.9E
    ---
   FORECASTS:
   12 HRS, VALID AT:
   210600Z --- 33.5N 139.9E
   MAX SUSTAINED WINDS - 065 KT, GUSTS 080 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 064 KT WINDS - 020 NM NORTHEAST QUADRANT
                            030 NM SOUTHEAST QUADRANT
                            020 NM SOUTHWEST QUADRANT
                            000 NM NORTHWEST QUADRANT
   RADIUS OF 050 KT WINDS - 050 NM NORTHEAST QUADRANT
                            050 NM SOUTHEAST QUADRANT
                            040 NM SOUTHWEST QUADRANT
                            040 NM NORTHWEST QUADRANT
   RADIUS OF 034 KT WINDS - 170 NM NORTHEAST QUADRANT
                            170 NM SOUTHEAST QUADRANT
                            160 NM SOUTHWEST QUADRANT
                            150 NM NORTHWEST QUADRANT
   VECTOR TO 24 HR POSIT: 050 DEG/ 21 KTS
    ---
   24 HRS, VALID AT:
   211800Z --- 36.0N 143.9E
   MAX SUSTAINED WINDS - 070 KT, GUSTS 085 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 064 KT WINDS - 020 NM NORTHEAST QUADRANT
                            030 NM SOUTHEAST QUADRANT
                            020 NM SOUTHWEST QUADRANT
                            000 NM NORTHWEST QUADRANT
   RADIUS OF 050 KT WINDS - 050 NM NORTHEAST QUADRANT
                            060 NM SOUTHEAST QUADRANT
                            040 NM SOUTHWEST QUADRANT
                            040 NM NORTHWEST QUADRANT
   RADIUS OF 034 KT WINDS - 140 NM NORTHEAST QUADRANT
                            170 NM SOUTHEAST QUADRANT
                            170 NM SOUTHWEST QUADRANT
                            150 NM NORTHWEST QUADRANT
   VECTOR TO 36 HR POSIT: 060 DEG/ 26 KTS
    ---
   36 HRS, VALID AT:
   220600Z --- 38.4N 149.8E
   MAX SUSTAINED WINDS - 065 KT, GUSTS 080 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 064 KT WINDS - 000 NM NORTHEAST QUADRANT
                            030 NM SOUTHEAST QUADRANT
                            020 NM SOUTHWEST QUADRANT
                            000 NM NORTHWEST QUADRANT
   RADIUS OF 050 KT WINDS - 040 NM NORTHEAST QUADRANT
                            050 NM SOUTHEAST QUADRANT
                            040 NM SOUTHWEST QUADRANT
                            030 NM NORTHWEST QUADRANT
   RADIUS OF 034 KT WINDS - 110 NM NORTHEAST QUADRANT
                            170 NM SOUTHEAST QUADRANT
                            180 NM SOUTHWEST QUADRANT
                            150 NM NORTHWEST QUADRANT
   VECTOR TO 48 HR POSIT: 070 DEG/ 27 KTS
    ---
   EXTENDED OUTLOOK:
   48 HRS, VALID AT:
   221800Z --- 40.1N 156.5E
   MAX SUSTAINED WINDS - 055 KT, GUSTS 070 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   BECOMING EXTRATROPICAL
   RADIUS OF 050 KT WINDS - 020 NM NORTHEAST QUADRANT
                            050 NM SOUTHEAST QUADRANT
                            040 NM SOUTHWEST QUADRANT
                            020 NM NORTHWEST QUADRANT
   RADIUS OF 034 KT WINDS - 080 NM NORTHEAST QUADRANT
                            160 NM SOUTHEAST QUADRANT
                            180 NM SOUTHWEST QUADRANT
                            140 NM NORTHWEST QUADRANT
   VECTOR TO 60 HR POSIT: 075 DEG/ 30 KTS
    ---
   60 HRS, VALID AT:
   230600Z --- 41.6N 164.3E
   MAX SUSTAINED WINDS - 045 KT, GUSTS 055 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   EXTRATROPICAL
   RADIUS OF 034 KT WINDS - 050 NM NORTHEAST QUADRANT
                            120 NM SOUTHEAST QUADRANT
                            180 NM SOUTHWEST QUADRANT
                            110 NM NORTHWEST QUADRANT
    ---
REMARKS:
202100Z POSITION NEAR 31.9N 138.4E.
20SEP26. TROPICAL STORM 24W (DUJUAN), LOCATED APPROXIMATELY 256
NM SOUTH-SOUTHWEST OF YOKOSUKA, JAPAN, HAS TRACKED NORTH-
NORTHEASTWARD AT 11 KNOTS OVER THE PAST SIX HOURS.
MINIMUM CENTRAL PRESSURE AT 201800Z IS 976 MB. MAXIMUM
SIGNIFICANT WAVE HEIGHT AT 201800Z IS 28 FEET.
NEXT WARNINGS AT 210300Z, 210900Z, 211500Z AND 212100Z.//
NNNN`;

const VAA_DUKONO = `FVAU01 ADRM 202000
VA ADVISORY
DTG: 20260920/2000Z
VAAC: DARWIN
VOLCANO: DUKONO 268010
PSN: N0142 E12754
AREA: INDONESIA
SOURCE ELEV: 1229M AMSL
ADVISORY NR: 2026/777
INFO SOURCE: HIMAWARI-9
ERUPTION DETAILS: VA TO FL070 LAST OBS 19/2330Z EXT SSE
EST VA DTG: 20/1930Z
EST VA CLD: SFC/FL070 N0141 E12747 - N0211 E12801 - N0214
        E12825 - N0156 E12841 - N0131 E12837 - N0124 E12815 MOV E
        05KT
FCST VA CLD +6 HR: 21/0130Z SFC/FL070 N0137 E12748 - N0146
        E12747 - N0214 E12804 - N0208 E12830 - N0142 E12834 - N0116
        E12819
FCST VA CLD +12 HR: 21/0730Z SFC/FL070 N0136 E12751 - N0144
        E12747 - N0215 E12805 - N0209 E12832 - N0148 E12839 - N0137
        E12826
FCST VA CLD +18 HR: 21/1330Z SFC/FL070 N0142 E12745 - N0216
        E12805 - N0206 E12832 - N0134 E12839 - N0129 E12756
RMK: VA NOT IDENTIFIABLE ON RECENT SATELLITE IMAGERY.
        EMISSIONS EXPECTED TO BE ONGOING. HEIGHT AND MOVEMENT BASED
        ON SATELLITE IMAGERY AND MODEL GUIDANCE.
NXT ADVISORY: NO LATER THAN 20260921/0200Z=`;

// Supplied by the operator. Note the wrapped EST/FCST VA CLD lines that continue
// at column 0 — the unwrapper must not treat them as new fields.
const VAA_SEMERU = `FVAU02 ADRM 201550
VA ADVISORY
DTG: 20260920/1550Z
VAAC: DARWIN
VOLCANO: SEMERU 263300
PSN: S0806 E11255
AREA: INDONESIA
SOURCE ELEV: 3657M AMSL
ADVISORY NR: 2026/1078
INFO SOURCE: HIMAWARI-9, CVGHM
ERUPTION DETAILS: VA EMISSION REP FM GND AT 20/1333Z
EST VA DTG: 20/1530Z
EST VA CLD: SFC/FL150 S0808 E11253 - S0803 E11253 - S0755
E11319 - S0805 E11325 - S0817 E11318 MOV E 15KT
FCST VA CLD +6 HR: 20/2130Z SFC/FL150 S0809 E11253 - S0803
E11253 - S0756 E11319 - S0806 E11326 - S0817 E11318
FCST VA CLD +12 HR: 21/0330Z SFC/FL150 S0809 E11253 - S0803
E11253 - S0755 E11319 - S0806 E11325 - S0817 E11318
FCST VA CLD +18 HR: 21/0930Z SFC/FL150 S0809 E11253 - S0803
E11253 - S0755 E11319 - S0806 E11325 - S0817 E11318
RMK: VA NOT IDENTIFIABLE ON CURRENT SATELLITE IMAGERY.
HOWEVER, EMISSION IS EXPECTED TO BE ONGOING. HEIGHT AND
MOVEMENT BASED ON SATELLITE IMAGERY, GROUND REPORTS AND
MODEL GUIDANCE.
NXT ADVISORY: NO LATER THAN 20260920/2150Z=`;

// Tail of a split JTWC message: no position, no forecasts. Must be refused
// rather than turned into a phantom storm.
const JTWC_PARTIAL = `WTIO31 PGTW 270300
AS THE SYSTEM APPROACHES THE WEST COAST OF  MALAYSIA. OVER THE NEXT
12 HOURS, TC 04B IS FORECASTED TO CONTINUE EASTWARD AND MAKE LANDFALL
JUST PRIOR TO TAU 12. REGARDING INTENSITY, THE JTWC INTENSITY FORECAST
IS ALIGED CLOSELY TO THE JTWC CONSENSUS, MAINTAINING 25 KTS UNTIL THE
END OF THE FORECAST PERIOD. THIS IS THE FINAL WARNING ON THIS SYSTEM
BY THE JOINT TYPHOON WRNCEN PEARL HARBOR HI.//
// END PART 02/02 //`;

const ISIGMET_SAMPLE = [
  {
    icaoId: 'WAAA', firId: 'WAAF', firName: 'WAAF UJUNG PANDANG', receiptTime: '2026-09-20T14:01:38.150Z',
    validTimeFrom: 1789912800, validTimeTo: 1789934400, seriesId: '13', hazard: 'VA', qualifier: 'DUKONO',
    base: 0, top: 7000, geom: 'AREA', dir: 'E', spd: '05', chng: 'NC',
    coords: [
      { lon: 127.817, lat: 1.667 }, { lon: 127.833, lat: 1.767 }, { lon: 128.4, lat: 2.033 },
      { lon: 128.55, lat: 1.617 }, { lon: 128.25, lat: 1.25 }, { lon: 127.817, lat: 1.667 }
    ],
    rawSigmet: 'WVID21 WAAA 201400\nWAAF SIGMET 13 VALID 201400/202000 WAAA- VA ERUPTION MT DUKONO='
  },
  {
    icaoId: 'RJTD', firId: 'RJJJ', firName: 'RJJJ FUKUOKA', receiptTime: '2026-09-20T19:09:44.616Z',
    validTimeFrom: 1789931340, validTimeTo: 1789952940, seriesId: 'D04', hazard: 'TC', qualifier: 'DUJUAN',
    base: null, top: 55000, geom: 'AREA', dir: null, spd: null, chng: 'NC',
    coords: [
      { lon: 137.83, lat: 32.75 }, { lon: 139.3, lat: 31.5 }, { lon: 137.83, lat: 30.25 },
      { lon: 136.37, lat: 31.5 }, { lon: 137.83, lat: 32.75 }
    ],
    rawSigmet: 'WCJP31 RJTD 201909\nRJJJ SIGMET D04 VALID 201909/210109 RJTD- TC DUJUAN='
  },
  // Out of scope: not a VA/TC hazard.
  {
    icaoId: 'YMRF', firId: 'YMMM', hazard: 'TURB', qualifier: 'SEV', base: 0, top: 3000,
    validTimeFrom: 1789920000, validTimeTo: 1789934400, seriesId: 'W01',
    coords: [{ lon: 146.667, lat: -39.167 }, { lon: 146.333, lat: -39.167 }, { lon: 146.167, lat: -38.833 }]
  },
  // Out of scope: volcanic ash, but in South America (outside the working box).
  {
    icaoId: 'SKBO', firId: 'SKED', hazard: 'VA', qualifier: 'PURACE', base: 0, top: 18000,
    validTimeFrom: 1789911900, validTimeTo: 1789934100, seriesId: 'B2',
    coords: [{ lon: -76.383, lat: 2.317 }, { lon: -76.567, lat: 2.233 }, { lon: -76.583, lat: 2.317 }]
  }
];

const NOW = new Date('2026-09-20T21:30:00Z');

/* ------------------------------------------------------------- JTWC (TC) --- */

test('JTWC warning: header, identity and issue time', () => {
  const { ok, warning } = parseJtwcWarningText(JTWC_DUJUAN, { now: NOW });
  assert.equal(ok, true);
  assert.equal(warning.source, 'JTWC');
  assert.equal(warning.kind, 'TC');
  assert.equal(warning.title, 'TROPICAL STORM 24W (DUJUAN) WARNING NR 022');
  assert.equal(warning.advisoryNr, '022');
  assert.equal(warning.stormId, '24W');
  assert.equal(warning.stormName, 'DUJUAN');
  assert.equal(warning.basin, 'NORTHWESTPAC');
  assert.equal(warning.dtg, '2026-09-20T21:00:00.000Z');
  assert.equal(warning.intensity.class, 'TROPICAL STORM');
});

test('JTWC warning: present position, movement and intensity', () => {
  const { warning } = parseJtwcWarningText(JTWC_DUJUAN, { now: NOW });
  assert.equal(warning.centerLat, 31.3);
  assert.equal(warning.centerLon, 137.9);
  assert.equal(warning.movement.deg, 20);
  assert.equal(warning.movement.kt, 11);
  assert.equal(warning.intensity.windKt, 60);
  assert.equal(warning.intensity.gustKt, 75);
  assert.equal(warning.intensity.mslpMb, 976);
  assert.equal(warning.intensity.accuracyNm, 30);
});

test('JTWC warning: wind radii per quadrant for the present fix', () => {
  const { warning } = parseJtwcWarningText(JTWC_DUJUAN, { now: NOW });
  const present = warning.track[0];
  assert.equal(present.tauHr, 0);
  assert.deepEqual(present.radii.kt50, { ne: 50, se: 50, sw: 40, nw: 40 });
  assert.equal(maxRadiusNm(present.radii, 34), 200);
  assert.equal(maxRadiusNm(present.radii, 64), 0);
});

test('JTWC warning: forecast track parses every tau including the extended outlook', () => {
  const { warning } = parseJtwcWarningText(JTWC_DUJUAN, { now: NOW });
  assert.deepEqual(warning.track.map(entry => entry.tauHr), [0, 12, 24, 36, 48, 60]);
  const tau12 = warning.track.find(entry => entry.tauHr === 12);
  assert.equal(tau12.lat, 33.5);
  assert.equal(tau12.lon, 139.9);
  assert.equal(tau12.validAt, '2026-09-21T06:00:00.000Z');
  assert.equal(tau12.windKt, 65);
  assert.equal(tau12.gustKt, 80);
  assert.equal(tau12.radii.kt64.ne, 20);
  assert.equal(tau12.radii.kt64.nw, 0);
  const tau60 = warning.track.find(entry => entry.tauHr === 60);
  assert.equal(tau60.lat, 41.6);
  assert.equal(tau60.lon, 164.3);
  assert.equal(tau60.note, 'EXTRATROPICAL');
  const tau48 = warning.track.find(entry => entry.tauHr === 48);
  assert.equal(tau48.note, 'BECOMING EXTRATROPICAL');
});

test('JTWC warning: a continuation part is refused, not guessed', () => {
  const parsed = parseJtwcWarningText(JTWC_PARTIAL, { now: NOW });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /continuation part|No warning position/i);
  assert.deepEqual(parsed.notes, ['PARTIAL PRODUCT']);
  assert.equal(parsed.warning, null);
});

/* -------------------------------------------------------------- VAA (VA) --- */

test('VAA: volcano identity, position and advisory number', () => {
  const { ok, warning } = parseVaaText(VAA_SEMERU, { now: NOW });
  assert.equal(ok, true);
  assert.equal(warning.kind, 'VA');
  assert.equal(warning.source, 'VAAC');
  assert.equal(warning.title, 'VA SEMERU 263300');
  assert.equal(warning.volcano.name, 'SEMERU');
  assert.equal(warning.volcano.number, '263300');
  assert.equal(warning.volcano.area, 'INDONESIA');
  assert.equal(warning.volcano.elevation, '3657M AMSL');
  assert.equal(warning.vaac, 'DARWIN');
  assert.equal(warning.advisoryNr, '2026/1078');
  assert.equal(warning.dtg, '2026-09-20T15:50:00.000Z');
  assert.equal(warning.centerLat, -8.1);
  assert.equal(warning.centerLon, 112.9167);
  assert.equal(warning.volcano.lat, -8.1);
});

test('VAA: wrapped cloud lines unwrap into one field (the real Darwin shapes)', () => {
  const columnZero = unwrapVaaFields(VAA_SEMERU).fields['EST VA CLD'];
  assert.match(columnZero, /S0808 E11253/);
  assert.match(columnZero, /S0817 E11318/);
  assert.match(columnZero, /MOV E 15KT/);
  const indented = unwrapVaaFields(VAA_DUKONO).fields['EST VA CLD'];
  assert.match(indented, /N0141 E12747/);
  assert.match(indented, /N0124 E12815/);
  assert.match(indented, /MOV E 05KT/);
});

test('VAA: OBS and FCST polygons, levels and movement', () => {
  const { warning } = parseVaaText(VAA_SEMERU, { now: NOW });
  assert.deepEqual(warning.polygons.map(poly => poly.role), ['OBS', 'FCST+6HR', 'FCST+12HR', 'FCST+18HR']);
  const obs = warning.polygons[0];
  assert.equal(obs.coords.length, 5);
  assert.deepEqual(obs.coords[0], [112.8833, -8.1333]);
  assert.equal(obs.flBase, 0);
  assert.equal(obs.flTop, 15000);
  assert.equal(obs.validAt, '2026-09-20T15:30:00.000Z');
  assert.equal(warning.flBase, 0);
  assert.equal(warning.flTop, 15000);
  assert.equal(warning.movement.dir, 'E');
  assert.equal(warning.movement.kt, 15);
  assert.equal(warning.movement.deg, 90);
  assert.equal(warning.validTo, '2026-09-20T21:50:00.000Z');
});

test('VAA: indented-continuation product (DUKONO) parses fully', () => {
  const { ok, warning } = parseVaaText(VAA_DUKONO, { now: NOW });
  assert.equal(ok, true);
  assert.equal(warning.title, 'VA DUKONO 268010');
  assert.equal(warning.advisoryNr, '2026/777');
  assert.equal(warning.flTop, 7000);
  assert.equal(warning.movement.kt, 5);
  assert.deepEqual(warning.polygons.map(poly => poly.role), ['OBS', 'FCST+6HR', 'FCST+12HR', 'FCST+18HR']);
  assert.equal(warning.polygons[0].coords.length, 6);
  assert.equal(warning.polygons[3].coords.length, 5);
  assert.equal(warning.validTo, '2026-09-21T02:00:00.000Z');
});

test('VAA: a NOTICE advisory is refused with a clear reason', () => {
  const notice = `FVAU04 ADRM 010116
VA ADVISORY
DTG: 20260701/0116Z
VAAC: DARWIN
VOLCANO: NOTICE 999999
PSN: N0000 E00000
AREA: UNKNOWN
ADVISORY NR: 2026/1
EST VA CLD: SFC/FL000 N0000 E00000 - N0001 E00000 - N0000 E0001
NXT ADVISORY: NO LATER THAN 20260701/0716Z=`;
  const parsed = parseVaaText(notice, { now: NOW });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /NOTICE/);
});

/* ---------------------------------------------------------------- SIGMET --- */

test('SIGMET: VA and TC kept, other hazards and other regions dropped', () => {
  const warnings = parseIsigmetWarnings(ISIGMET_SAMPLE, { now: NOW });
  assert.equal(warnings.length, 2);
  const [va, tc] = warnings;
  assert.equal(va.kind, 'VA');
  assert.equal(va.fir, 'WAAF');
  assert.equal(va.flTop, 7000);
  assert.equal(va.movement.kt, 5);
  assert.equal(va.polygons[0].coords.length, 6);
  assert.equal(tc.kind, 'TC');
  assert.equal(tc.title, 'TC SIGMET DUJUAN (RJJJ)');
  assert.equal(tc.flTop, 55000);
  assert.equal(tc.validFrom, new Date(1789931340 * 1000).toISOString());
});

test('SIGMET: multi-ring (AREAS) geometry is preserved', () => {
  const warnings = parseIsigmetWarnings([{
    firId: 'WAAF', hazard: 'VA', qualifier: 'IBU', seriesId: '15', base: 0, top: 7000,
    validTimeFrom: 1789920600, validTimeTo: 1789942200,
    coords: [
      [[127.617, 1.55], [128.033, 1.633], [128.117, 1.333]],
      [[127.85, 1.133], [127.567, 1.467], [127.617, 1.55]]
    ]
  }], { now: NOW });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].polygons.length, 2);
  assert.equal(warnings[0].polygons[1].coords.length, 3);
});

/* ------------------------------------------------------- splitting + blob --- */

test('product splitting handles a blob of several products with adornments', () => {
  const blob = `${JTWC_DUJUAN}\n\n-----------------\n\n${VAA_SEMERU}\n`;
  const chunks = splitProducts(blob);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].header, 'WTPN31 PGTW 202100');
  assert.equal(chunks[1].header, 'FVAU02 ADRM 201550');
  assert.doesNotMatch(chunks[0].text, /^-----$/m);
  const parsed = parseProducts(blob, { now: NOW });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(entry => entry.kind), ['TC', 'VA']);
  assert.ok(parsed.every(entry => entry.ok));
});

test('product splitting never swallows the first product of a paste', () => {
  const chunks = splitProducts(`${VAA_SEMERU}\n$$`);
  assert.equal(chunks.length, 1);
  assert.equal(detectProductKind(chunks[0].header, chunks[0].text), 'VA');
});

test('unrecognised manual input is reported, not parsed into nonsense', () => {
  const parsed = parseProducts('hello world, this is not an aviation product', { now: NOW });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].ok, false);
  assert.equal(parsed[0].kind, null);
  assert.match(parsed[0].reason, /Unrecognised/);
});

/* ------------------------------------------------------- primitives + time --- */

test('compact coordinates: degrees, ddmm and ddmmss', () => {
  assert.deepEqual(parseCompactCoord('0806', 'S', '11255', 'E'), [112.9167, -8.1]);
  assert.deepEqual(parseCompactCoord('01', 'N', '127', 'E'), [127, 1]);
  assert.deepEqual(parseCompactCoord('014233', 'S', '1125530', 'E'), [112.925, -1.7092]);
  assert.equal(parseCompactCoord('99999', 'N', '11255', 'E'), null);
  assert.equal(parseCompactCoord('0806', 'X', '11255', 'E'), null);
});

test('flight levels: SFC/FL, FL/FL and bare FL', () => {
  assert.deepEqual(parseFlightLevels('SFC/FL150 S0808'), { base: 0, top: 15000 });
  assert.deepEqual(parseFlightLevels('FL180/FL250'), { base: 18000, top: 25000 });
  assert.deepEqual(parseFlightLevels('TOP FL550'), { base: null, top: 55000 });
  assert.deepEqual(parseFlightLevels('no levels here'), { base: null, top: null });
});

test('wind radii parser tolerates zero and three-digit values', () => {
  const radii = parseWindRadii('RADIUS OF 064 KT WINDS - 000 NM NORTHEAST QUADRANT\n030 NM SOUTHEAST QUADRANT\n020 NM SOUTHWEST QUADRANT\n000 NM NORTHWEST QUADRANT');
  assert.deepEqual(radii.kt64, { ne: 0, se: 30, sw: 20, nw: 0 });
  assert.equal(maxRadiusNm(radii, 64), 30);
});

test('day/hour/minute resolution survives month rollover', () => {
  const now = new Date('2026-10-01T02:00:00Z');
  assert.equal(resolveDayHourMinute('302100', now).toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(resolveDayHourMinute('010000', now).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(resolveDayHourMinute('329900', now), null);
  assert.equal(parseVaaTimestamp('20260920/1550Z').toISOString(), '2026-09-20T15:50:00.000Z');
});

test('freshness: a months-old product on the feed is rejected', () => {
  const parsed = parseJtwcWarningText(JTWC_DUJUAN, { now: NOW });
  assert.equal(freshnessOf(parsed.warning, NOW, TC_MAX_AGE_HOURS).ok, true);
  const later = new Date('2026-09-22T12:00:00Z');
  const stale = freshnessOf(parsed.warning, later, TC_MAX_AGE_HOURS);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /old/);
  const vaa = parseVaaText(VAA_DUKONO, { now: NOW }).warning;
  assert.equal(freshnessOf(vaa, NOW, VA_MAX_AGE_HOURS).ok, true);
  assert.equal(freshnessOf(vaa, new Date('2026-09-22T00:00:00Z'), VA_MAX_AGE_HOURS).ok, false);
});

test('region filter: Asia-Pacific box plus the date-line wrap', () => {
  assert.equal(inAsiaPacific(-8.1, 112.9), true);
  assert.equal(inAsiaPacific(31.3, 137.9), true);
  assert.equal(inAsiaPacific(-17.8, 178.0), true);
  assert.equal(inAsiaPacific(-18.0, -178.0), true);
  assert.equal(inAsiaPacific(21.3, -157.8), false);
  assert.equal(inAsiaPacific(2.3, -76.4), false);
  assert.equal(inAsiaPacific(51.5, -0.1), false);
});

test('region filter applies to whole warnings, not just the centre', () => {
  const ujungPandang = parseIsigmetWarnings(ISIGMET_SAMPLE, { now: NOW })[0];
  assert.equal(warningInRegion(ujungPandang), true);
  // Same advisory, geometry relocated out of the working box: every point the
  // filter looks at (polygon, track, centre, volcano) must move with it.
  const movingOut = {
    ...ujungPandang,
    centerLat: 2.3, centerLon: -76.4,
    polygons: [{ role: 'SIGMET', coords: [[-76.4, 2.3], [-76.6, 2.2], [-76.5, 2.4]] }],
    track: [{ tauHr: 0, lat: 2.3, lon: -76.4 }],
    volcano: { name: 'PURACE', number: null, lat: 2.3, lon: -76.4 }
  };
  assert.equal(warningInRegion(movingOut), false);
});

test('VAAC listing picks only the in-scope offices', () => {
  const html = `<a href="fvau01.adrm..txt">x</a><a href="fvfe01.rjtd..txt">y</a><a href="fvps01.nzkl..txt">z</a>` +
    `<a href="fvxx20.knes..txt">no</a><a href="fvxx01.egrr..txt">no</a><a href="fvfe01.rjtd.vaa.ak1.txt">no</a>`;
  const files = vaacListingCandidates(html).map(entry => entry.file);
  assert.deepEqual(files, ['fvau01.adrm..txt', 'fvfe01.rjtd..txt', 'fvps01.nzkl..txt']);
});

/* --------------------------------------------------------- storage mapping --- */

test('manual ids are stable for identical text so a re-paste updates in place', () => {
  assert.equal(manualExternalId(VAA_SEMERU), manualExternalId(`${VAA_SEMERU}\n\n`));
  assert.notEqual(manualExternalId(VAA_SEMERU), manualExternalId(VAA_DUKONO));
  assert.match(textFingerprint('abc'), /^[0-9a-f]{8}3$/);
});

test('row mapping round-trips geometry and identity', () => {
  const warning = parseVaaText(VAA_SEMERU, { now: NOW }).warning;
  const row = toWarningRow(warning, { fetchedAt: NOW, isManual: true, createdBy: 'ops@example.com' });
  assert.equal(row.kind, 'VA');
  assert.equal(row.is_manual, 1);
  assert.equal(row.created_by, 'ops@example.com');
  assert.equal(row.fetched_at, '2026-09-20T21:30:00.000Z');
  const back = fromWarningRow({ ...row, id: 7, created_at: row.fetched_at });
  assert.equal(back.id, 7);
  assert.equal(back.volcano.name, 'SEMERU');
  assert.equal(back.polygons.length, 4);
  assert.equal(back.geojson.length, 4);
  assert.equal(back.geojson[0].geometry.type, 'Polygon');
  assert.equal(back.isManual, true);
  assert.equal(back.createdBy, 'ops@example.com');
  assert.equal(back.flTop, 15000);
});

test('route hits: a warning over the route is flagged, a distant one is not', () => {
  const warning = parseVaaText(VAA_SEMERU, { now: NOW }).warning;
  warning.id = 1;
  // Route that runs straight through the SEMERU ash polygon.
  const overRoute = [[112.0, -8.5], [113.5, -8.0]];
  const hitsOver = computeRouteHits([warning], overRoute, 50);
  assert.equal(hitsOver['1'].hit, true);
  assert.ok(hitsOver['1'].nm <= 10, `expected the route to graze the ash polygon, got ${hitsOver['1'].nm} NM`);
  // Route well clear of Java.
  const farRoute = [[100.0, 10.0], [105.0, 12.0]];
  const hitsFar = computeRouteHits([warning], farRoute, 50);
  assert.equal(hitsFar['1'].hit, false);
  assert.ok(hitsFar['1'].nm > 300);
});

test('route hits: TC wind radii widen the hazard beyond the track point', () => {
  const warning = parseJtwcWarningText(JTWC_DUJUAN, { now: NOW }).warning;
  warning.id = 2;
  // ~150 NM north of the 31.3N/137.9E fix: outside the centre but inside the
  // 200 NM 34 kt radius, so it must count as an affected route.
  const route = [[137.9, 33.8], [138.5, 34.2]];
  const hits = computeRouteHits([warning], route, 50);
  assert.equal(hits['2'].hit, true);
});

test('route hits report NO ROUTE instead of a bogus distance', () => {
  const warning = parseVaaText(VAA_SEMERU, { now: NOW }).warning;
  warning.id = 3;
  const hits = computeRouteHits([warning], [], 50);
  assert.deepEqual(hits['3'], { nm: null, hit: false, reason: 'NO ROUTE' });
});
