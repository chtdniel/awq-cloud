// Self-test matrix wajib skill `notam-analyst` v1.6.0 (fixtures 1-7) untuk halaman
// FIR (`src/FIR_Ui.html`) dan FIR NOTAM (`src/FIR_Notam_Ui.html`).
//
// Latar belakang & bukti lengkap: docs/notam-analyst-audit-fir.md
//
// Prinsip file ini:
//   * Semua assert menembak KODE PRODUKSI — `functions/api/notamUtils.js` diimpor
//     sebagai modul, dan handler RPC dijalankan lewat bundle esbuild + D1 in-memory.
//     Tidak ada salinan logika di sini, supaya test tidak bisa "lulus sendiri".
//   * Assert yang HIJAU mengunci perilaku yang sudah benar (year-crossing, midnight
//     rollover, interval ganda, PERM/EST, Q-scope yang tidak salah baca).
//   * Assert untuk temuan audit dikumpulkan di DEFECTS dan dijalankan sebagai
//     regression test per ID temuan (H1..M3). Semua temuan pada audit
//     docs/notam-analyst-audit-fir.md sudah ditutup; kalau ada temuan baru yang belum
//     diperbaiki, tambahkan entri DEFECTS + opsi `{ todo }` di loop bawah supaya suite
//     tetap hijau, dan ledger test menjaga jumlahnya sinkron.
//
// CATATAN OUTPUT: test `{ todo }` yang gagal dicetak Node di bawah header
// "✖ failing tests:" dengan tanda ⚠. Itu NORMAL dan bukan kegagalan suite selama
// ringkasannya `fail 0` dan exit code 0. Saat ini tidak ada test `{ todo }`.
//
// Catatan: perubahan apa pun yang menyentuh logika waktu B/C/D, altitud, atau
// geo-math wajib peer review sebelum deploy (skill step 5).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

/* ------------------------------------------------------------------ produksi */
const utilsSource = await readFile(new URL('../functions/api/notamUtils.js', import.meta.url), 'utf8');
const { parseNotamRow, checkScheduleDOverlap, isAerodromeOnlyNotam, duParseIcaoDateCode } = await import(
  'data:text/javascript;base64,' + Buffer.from(utilsSource).toString('base64')
);

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../functions/api/rpc.js', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false
});
const { onRequestPost } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

/* ---------------------------------------------------------------- DB in-memory */
const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE firs (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE user_profiles (user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT,
    updated_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE notams (id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT,
    valid_from TEXT, valid_to TEXT, kind TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE airport_firs (airport_icao TEXT NOT NULL, fir_code TEXT NOT NULL,
    PRIMARY KEY (airport_icao, fir_code));
  CREATE TABLE flights (id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT, dep TEXT, dest TEXT,
    ac_type TEXT, etd TEXT, eta TEXT, alt TEXT, taf_dep TEXT, taf_arr TEXT, enr1 TEXT, enr2 TEXT,
    enr3 TEXT, atc TEXT, remarks TEXT, dof TEXT, active_route_id TEXT);
  CREATE TABLE routes (id TEXT PRIMARY KEY, dep_airport TEXT, arr_airport TEXT, dep_rwy TEXT,
    sid TEXT, waypoint_seq TEXT, star TEXT, arr_rwy TEXT, route_string TEXT);
  CREATE TABLE latlong (id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT, waypoint TEXT,
    latitude TEXT, longitude TEXT, sequence_order INTEGER);
  INSERT INTO firs (id, name) VALUES ('YMMM','Melbourne FIR'),('WIIF','Jakarta FIR'),('RPHI','Manila FIR');
`);
function statement(sql, parameters = []) {
  return {
    bind(...values) { return statement(sql, values); },
    async all() { return { results: database.prepare(sql).all(...parameters) }; },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async run() { return database.prepare(sql).run(...parameters); }
  };
}
const DB = {
  prepare: statement,
  async batch(statements) {
    database.exec('BEGIN');
    try { const out = []; for (const s of statements) out.push(await s.run()); database.exec('COMMIT'); return out; }
    catch (e) { database.exec('ROLLBACK'); throw e; }
  }
};
const authHeaders = await seedAuthUser(database, DB);

async function rpc(method, args = []) {
  const response = await onRequestPost({
    request: new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ method, args })
    }),
    env: { DB }
  });
  assert.equal(response.status, 200, `RPC ${method} harus 200`);
  return (await response.json()).data;
}

// Baris NOTAM kind='FIR'. vf/vt = kolom valid_from/valid_to (null untuk PERM).
function seedNotam(id, location, message, kind = 'FIR', vf = null, vt = null) {
  database.prepare('INSERT OR REPLACE INTO notams (id, location, message, valid_from, valid_to, kind) VALUES (?,?,?,?,?,?)')
    .run(id, location, message, vf, vt, kind);
}
const dropNotam = (...ids) => database.prepare(
  `DELETE FROM notams WHERE id IN (${ids.map(() => '?').join(',')})`
).run(...ids);

// YYMMDDHHMM beberapa hari ke belakang — supaya test tidak basi seiring waktu.
function icaoDateDaysAgo(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = n => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes());
}
const notamText = (number, b, c, location = 'YMMM', qsuffix = 'QRDCA/IV/BO/W/000/999/2054S08637E744') => `${number} NOTAMN
Q) ${location}/${qsuffix}
A) ${location} B) ${b} C) ${c}
E) TEST FIXTURE`;

/* ------------------------------------------- klien FIR NOTAM: parseNotam */
// Parser klien diuji dengan mengekstrak fungsinya dari HTML (pola yang sama dipakai
// tests/test_fir_map_geometry.mjs) supaya yang diuji kode halaman yang benar-benar dikirim.
const firNotamSource = await readFile(new URL('../src/FIR_Notam_Ui.html', import.meta.url), 'utf8');
function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `fungsi tidak ditemukan di FIR_Notam_Ui.html: ${marker}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) + ';'; }
  }
  throw new Error('kurung tidak seimbang setelah: ' + marker);
}
const clientParse = new Function(
  ['yyMMddHHmm', 'parseNotam'].map(name => extractFunction(firNotamSource, 'function ' + name + '(')).join('\n') +
  '\nreturn { parseNotam, yyMMddHHmm };'
)();

// Geometri matahari (algoritma NOAA/SunCalc) HANYA untuk mengaudit FIXTURE_4:
// pembanding independen untuk cek apakah SR-SS benar-benar diresolusi ke posisi
// matahari. Bukan kode produksi.
const RAD = Math.PI / 180, DAY_MS = 86400000, J1970 = 2440588, J2000 = 2451545, OBLIQ = RAD * 23.4397;
const toJulian = d => d.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = j => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = d => toJulian(d) - J2000;
const solarMeanAnomaly = d => RAD * (357.5291 + 0.98560028 * toDays(d));
const eclipticLongitude = M => M + RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + RAD * 102.9372 + Math.PI;
const declination = L => Math.asin(Math.sin(OBLIQ) * Math.sin(L));
const julianCycle = (d, lw) => Math.round(toDays(d) - 0.0009 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));
function sunTimes(date, lat, lon) {
  const lw = RAD * -lon, phi = RAD * lat, d = new Date(date);
  const n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(d), L = eclipticLongitude(M), dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);
  const Jset = solarTransitJ(approxTransit(hourAngle(-0.833 * RAD, phi, dec), lw, n), M, L);
  return { sunrise: fromJulian(Jnoon - (Jset - Jnoon)), sunset: fromJulian(Jset) };
}

/* ==================================================== FIXTURE 1: year crossing */
test('FIXTURE_1 B/C lintas tahun ter-parse ke tahun berbeda', () => {
  const parsed = parseNotamRow({ id: 'A9001/26', message: notamText('A9001/26', '2612312359', '2701011200') });
  assert.ok(parsed, 'NOTAM lintas tahun harus ter-parse');
  assert.equal(parsed.effFrom.toISOString(), '2026-12-31T23:59:00.000Z');
  assert.equal(parsed.effTo.toISOString(), '2027-01-01T12:00:00.000Z');
});

test('FIXTURE_1 D) blok lintas tahun overlap pada jendela yang tepat', () => {
  // Aktif 2026-12-31 23:59Z s/d 2027-01-01 00:00Z.
  assert.equal(checkScheduleDOverlap('2612312359 TO 2701010000',
    new Date('2026-12-31T23:30:00Z'), new Date('2027-01-01T00:30:00Z')), true, 'harus overlap');
  assert.equal(checkScheduleDOverlap('2612312359 TO 2701010000',
    new Date('2027-01-01T00:30:00Z'), new Date('2027-01-01T02:00:00Z')), false, 'sesudah blok berakhir');
});

test('FIXTURE_1 RPC getActiveNotams melaporkan tanggal lintas tahun apa adanya', async () => {
  seedNotam('A9001/26', 'YMMM', notamText('A9001/26', '2612312359', '2701011200'),
    'FIR', '2026-12-31T23:59:00Z', '2027-01-01T12:00:00Z');
  try {
    const row = ((await rpc('getActiveNotams')).notams || []).find(n => n.number === 'A9001/26');
    assert.ok(row, 'baris harus ada di payload');
    assert.equal(row.effectiveDate, '2026-12-31T23:59:00.000Z');
    assert.equal(row.expirationDate, '2027-01-01T12:00:00.000Z');
  } finally { dropNotam('A9001/26'); }
});

/* ============================================== FIXTURE 2: midnight crossing */
test('FIXTURE_2 band 2300-0100 butuh rollover +1 hari', () => {
  assert.equal(checkScheduleDOverlap('DAILY 2300-0100',
    new Date('2026-09-29T00:30:00Z'), new Date('2026-09-29T01:30:00Z')), true, '00:30Z masih di dalam band');
  assert.equal(checkScheduleDOverlap('DAILY 2300-0100',
    new Date('2026-09-29T23:30:00Z'), new Date('2026-09-30T00:10:00Z')), true, '23:30Z di dalam band');
  assert.equal(checkScheduleDOverlap('DAILY 2300-0100',
    new Date('2026-09-29T03:00:00Z'), new Date('2026-09-29T04:00:00Z')), false, '03:00Z di luar band');
});

test('FIXTURE_2 dua interval sehari tidak digabung menjadi satu span', () => {
  const sched = 'DAILY 0800-1200 1400-1800';
  assert.equal(checkScheduleDOverlap(sched, new Date('2026-09-29T15:00:00Z'), new Date('2026-09-29T15:30:00Z')), true,
    '15:00Z ada di interval kedua');
  assert.equal(checkScheduleDOverlap(sched, new Date('2026-09-29T13:00:00Z'), new Date('2026-09-29T13:30:00Z')), false,
    '13:00Z ada di jeda antar interval — kalau digabung jadi satu span, ini akan salah overlap');
});

/* ================================================= FIXTURE 3: PERM vs EST */
test('FIXTURE_3 C) PERM dan C) EST ditandai continuous', () => {
  const perm = parseNotamRow({ id: 'A9002/26', message: notamText('A9002/26', '2609100000', 'PERM') });
  const est = parseNotamRow({ id: 'A9003/26', message: notamText('A9003/26', '2609100000', '2610041447EST') });
  assert.equal(perm.isContinuous, true, 'PERM');
  assert.equal(est.isContinuous, true, 'EST');
});

test('FIXTURE_3 PERM dan EST tetap ACTIVE di getActiveNotams (alert tidak dibungkam)', async () => {
  const b = icaoDateDaysAgo(10);
  seedNotam('A9002/26', 'YMMM', notamText('A9002/26', b, 'PERM'), 'FIR', null, null);
  seedNotam('A9003/26', 'YMMM', notamText('A9003/26', b, '2610041447EST'), 'FIR', null, '2099-01-01T00:00:00Z');
  try {
    const notams = (await rpc('getActiveNotams')).notams || [];
    const perm = notams.find(n => n.number === 'A9002/26');
    const est = notams.find(n => n.number === 'A9003/26');
    assert.ok(perm && est, 'kedua baris harus ada');
    assert.equal(perm.active, true, 'PERM tetap aktif');
    assert.equal(perm.expirationDate, 'PERM', 'PERM dilabeli PERM, bukan tanggal');
    assert.equal(est.active, true, 'EST tetap aktif — estimasi bukan alasan membungkam alert');
    assert.equal(est.expirationDate, 'PERM');
  } finally { dropNotam('A9002/26', 'A9003/26'); }
});

/* ================================================ FIXTURE 4: SR-SS / HN */
// Pembanding matahari disanity-check dulu supaya klaim FIXTURE_4 tidak bersandar
// pada asumsi: Jakarta terbit sekitar 22:40Z hari sebelumnya.
test('FIXTURE_4 pembanding matahari waras (Jakarta sunrise ~22:30-23:00Z hari-1)', () => {
  const jk = sunTimes(new Date('2026-09-29T00:00:00Z'), -6.2, 106.8);
  const riseHours = jk.sunrise.getUTCHours() + jk.sunrise.getUTCMinutes() / 60;
  assert.ok(riseHours > 21.5 && riseHours < 23.5, `sunrise Jakarta ${jk.sunrise.toISOString()}`);
});

// Koordinat YMMM (Melbourne FIR). Hari surya di bujur timur melintang tengah malam
// UTC, jadi setiap assertion dibandingkan dengan sunrise/sunset hasil hitungan
// sendiri, bukan angka jam yang di-hardcode.
const MEL = { lat: -37.8136, lon: 144.9631 };

test('FIXTURE_4 SR-SS diresolusi ke posisi matahari: window siang lokal (YMMM)', () => {
  // 2026-09-29 20:30-22:30Z = 30 Sep 06:30-08:30 lokal (+10).
  const start = new Date('2026-09-29T20:30:00Z'), end = new Date('2026-09-29T22:30:00Z');
  const sun = sunTimes(start, MEL.lat, MEL.lon);
  assert.ok(start >= sun.sunrise && end <= sun.sunset,
    `pembanding: window harus di dalam siang (${sun.sunrise.toISOString()}-${sun.sunset.toISOString()})`);
  assert.equal(checkScheduleDOverlap('SR-SS', start, end, MEL), true,
    'band UTC tetap 06:00-18:00 dulu menilai window siang ini sebagai tidak overlap (false clear)');
});

test('FIXTURE_4 SR-SS tidak overlap saat malam lokal (YMMM 12:00Z = 22:00 lokal)', () => {
  const start = new Date('2026-09-29T12:00:00Z'), end = new Date('2026-09-29T13:00:00Z');
  const sun = sunTimes(start, MEL.lat, MEL.lon);
  assert.ok(end < sun.sunrise || start > sun.sunset, 'pembanding: window harus di luar siang');
  assert.equal(checkScheduleDOverlap('SR-SS', start, end, MEL), false,
    'band UTC tetap 06:00-18:00 dulu menilai window malam ini sebagai overlap (false alarm)');
});

test('FIXTURE_4 SR-SS tanpa koordinat fail-open, bukan menebak jam tetap', () => {
  const start = new Date('2026-09-29T12:00:00Z'), end = new Date('2026-09-29T13:00:00Z');
  assert.equal(checkScheduleDOverlap('SR-SS', start, end), true, 'tanpa coords: anggap aktif (arah aman)');
  assert.equal(checkScheduleDOverlap('SR-SS', start, end, { lat: null, lon: null }), true);
  assert.equal(checkScheduleDOverlap('SR-SS', start, end, { lat: 'x', lon: 'y' }), true);
});

test('FIXTURE_4 HJ = siang dan HN = malam pada koordinat yang sama', () => {
  const dayStart = new Date('2026-09-30T02:00:00Z'), dayEnd = new Date('2026-09-30T03:00:00Z');   // 12:00 lokal
  const nightStart = new Date('2026-09-30T12:00:00Z'), nightEnd = new Date('2026-09-30T13:00:00Z'); // 22:00 lokal
  const sunDay = sunTimes(dayStart, MEL.lat, MEL.lon);
  const sunNight = sunTimes(nightStart, MEL.lat, MEL.lon);
  assert.ok(dayStart >= sunDay.sunrise && dayEnd <= sunDay.sunset, 'pembanding: window siang');
  assert.ok(nightEnd < sunNight.sunrise || nightStart > sunNight.sunset, 'pembanding: window malam');
  assert.equal(checkScheduleDOverlap('HJ', dayStart, dayEnd, MEL), true, 'HJ = siang');
  assert.equal(checkScheduleDOverlap('HN', dayStart, dayEnd, MEL), false, 'HN bukan siang');
  assert.equal(checkScheduleDOverlap('HJ', nightStart, nightEnd, MEL), false, 'HJ bukan malam');
  assert.equal(checkScheduleDOverlap('HN', nightStart, nightEnd, MEL), true, 'HN = malam');
});

test('FIXTURE_4 SR-30 SS+15 memakai offset terhadap matahari', () => {
  const ref = new Date('2026-09-30T02:00:00Z');
  const sun = sunTimes(ref, MEL.lat, MEL.lon);
  // Band = [sunrise-30m, sunset+15m]. Window 20 menit SEBELUM terbit hanya masuk
  // kalau offset -30 benar-benar dihormati (tanpa offset, band mulai saat terbit).
  const early = new Date(sun.sunrise.getTime() - 20 * 60000);
  assert.equal(checkScheduleDOverlap('SR-30 SS+15', early, new Date(early.getTime() + 10 * 60000), MEL), true,
    'offset -30 menit harus dihormati');
  // 20 menit sesudah terbenam: di luar sunset+15.
  const late = new Date(sun.sunset.getTime() + 20 * 60000);
  assert.equal(checkScheduleDOverlap('SR-30 SS+15', late, new Date(late.getTime() + 10 * 60000), MEL), false);
  // Token matahari tunggal tidak bisa jadi band -> fail-open.
  assert.equal(checkScheduleDOverlap('SR-30', late, new Date(late.getTime() + 10 * 60000), MEL), true);
});

test('FIXTURE_4 lintang tinggi: polar day vs polar night (Svalbard)', () => {
  const SVALBARD = { lat: 78.2, lon: 15.6 };
  const juneStart = new Date('2026-06-21T12:00:00Z'), juneEnd = new Date('2026-06-21T13:00:00Z');
  const decStart = new Date('2026-12-21T12:00:00Z'), decEnd = new Date('2026-12-21T13:00:00Z');
  assert.equal(checkScheduleDOverlap('SR-SS', juneStart, juneEnd, SVALBARD), true, 'midnight sun = siang penuh');
  assert.equal(checkScheduleDOverlap('HN', juneStart, juneEnd, SVALBARD), false, 'tidak ada malam');
  assert.equal(checkScheduleDOverlap('SR-SS', decStart, decEnd, SVALBARD), false, 'polar night = tidak ada siang');
  assert.equal(checkScheduleDOverlap('HN', decStart, decEnd, SVALBARD), true, 'malam penuh');
});

/* ================================= FIXTURE 5: Q-line multi-qualifier & scope */
test('FIXTURE_5 scope A terdeteksi', () => {
  assert.equal(isAerodromeOnlyNotam(notamText('A9004/26', '2609100000', '2610041447',
    'YMMM', 'QRDCA/IV/BO/A/000/999/2054S08637E744')), true);
});

test('FIXTURE_5 Q-line dengan field kosong (K /K /K) tidak salah dibaca sebagai scope A', () => {
  assert.equal(isAerodromeOnlyNotam(notamText('A9005/26', '2609100000', '2610041447',
    'WRXX', 'QKKKK/K /K /K /000/999/0607S10639E999')), false,
    'lokasi Q) WRXX jadi FIR, split("/")[4] = "K " — bukan scope A');
});

test('FIXTURE_5 NOTAM Q-line K-scope tetap tampil di getActiveNotams', async () => {
  const b = icaoDateDaysAgo(10);
  seedNotam('A9005/26', 'WIIF', notamText('A9005/26', b, '2610041447', 'WRXX', 'QKKKK/K /K /K /000/999/0607S10639E999'),
    'FIR', new Date(Date.now() - 10 * 86400000).toISOString(), '2026-10-04T14:47:00Z');
  try {
    const notams = (await rpc('getActiveNotams')).notams || [];
    assert.ok(notams.some(n => n.number === 'A9005/26'), 'baris K-scope harus ikut terkirim');
  } finally { dropNotam('A9005/26'); }
});

/* ============================================ FIXTURE 6: AFTN line wrapping */
test('FIXTURE_6 pasangan lat/lon terbelah newline tetap terbaca (E field)', async () => {
  const b = icaoDateDaysAgo(10);
  const message = `A9006/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) ${b} C) 2610041447
E) AREA WI:
2630S 07500E - 2342S 07500E -
2303S 07659E - 2145S
08057E - 1856S 08742E
F) SFC G) UNL`;
  seedNotam('A9006/26', 'YMMM', message, 'FIR', new Date(Date.now() - 10 * 86400000).toISOString(), '2026-10-04T14:47:00Z');
  try {
    const row = ((await rpc('getActiveNotams')).notams || []).find(n => n.number === 'A9006/26');
    assert.ok(row, 'baris harus ada');
    assert.equal(row.polygon.length, 5, '5 koordinat di teks, termasuk pasangan yang terbelah newline');
  } finally { dropNotam('A9006/26'); }
});

test('FIXTURE_6 digit terbelah di tengah token (23|42S) di-join sebelum parsing', async () => {
  const b = icaoDateDaysAgo(10);
  const message = `A9007/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) ${b} C) 2610041447
E) AREA WI: 2630S 07500E - 23
42S 07500E - 2303S 07659E
F) SFC G) UNL`;
  seedNotam('A9007/26', 'YMMM', message, 'FIR', new Date(Date.now() - 10 * 86400000).toISOString(), '2026-10-04T14:47:00Z');
  try {
    const row = ((await rpc('getActiveNotams')).notams || []).find(n => n.number === 'A9007/26');
    assert.ok(row, 'baris harus ada');
    assert.equal(row.polygon.length, 3, 'satu koordinat hilang kalau token yang terbelah tidak disambung dulu');
  } finally { dropNotam('A9007/26'); }
});

test('FIXTURE_6 blob AFTN 3 NOTAM tetap terpecah 3 baris walau header terbelah', async () => {
  const b = icaoDateDaysAgo(10);
  const head = `Q) WIIF/QRDCA/IV/BO/W/000/999/0607S10639E999\nA) WIIF B) ${b} C) 2610041447\n`;
  const blob = `(A9101/26 NOTAMN\n${head}E) PERTAMA)\nWIIF A9102/26\nNOTAMN\n${head}E) KEDUA)\n(A9103/26 NOTAMN\n${head}E) KETIGA)`;
  const preview = await rpc('firBulkPreviewNotams', [blob]);
  assert.equal(preview.total, 3, 'header "WIIF A9102/26" + baris "NOTAMN" tidak boleh menelan NOTAM berikutnya');
  assert.deepEqual(preview.warnings || [], [], 'blob yang benar tidak boleh memicu peringatan potongan gabungan');
});

test('FIXTURE_6 pre-join hanya di field E) — tidak mengarang titik pusat di luar itu', () => {
  // Tanpa koordinat di Q), parseNotamGeometry memindai SELURUH pesan sebagai fallback.
  // Kalau penyambungan digit lintas baris ikut jalan di sana, "2630" + "42S 07500E"
  // menjadi 30°42'S 075°00'E: titik pusat karangan yang juga dipakai meresolusi SR/SS.
  const message = `A9601/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/
A) YMMM B) 2609100000 C) 2610041447
E) NO COORDINATES IN THIS FIELD
F) 2630
42S 07500E
G) UNL`;
  const parsed = parseNotamRow({ id: 'A9601/26', message });
  assert.ok(parsed, 'NOTAM tetap terparse (Q)/B)/C) lengkap)');
  assert.equal(parsed.center, null, 'tidak boleh ada pusat karangan dari penggabungan lintas baris');
});

test('FIXTURE_6 parseNotam (klien FIR NOTAM) menyambung B)/C) yang terbelah wrap', () => {
  const wrapped = `A9102/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) 26092812
23 C) 26100414
47
E) TEST`;
  const out = clientParse.parseNotam(wrapped);
  assert.equal(out.Location, 'YMMM');
  assert.equal(out['Effective Date'], '2026-09-28 12:23', 'B) terbelah newline harus tetap terbaca');
  assert.equal(out['Expiration Date'], '2026-10-04 14:47', 'C) terbelah newline harus tetap terbaca');
});

/* ================== FIXTURE 9: lifecycle NOTAMR/NOTAMC + paritas risiko (H4/H10) */
test('FIXTURE_9 NOTAMR/NOTAMC menurunkan status di getActiveNotams (H4)', async () => {
  const b = icaoDateDaysAgo(10);
  const perm = `A9401/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) ${b} C) PERM
E) ORIGINAL AKAN DI-REPLACE`;
  const replacer = `A9402/26 NOTAMR A9401/26
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) ${b} C) PERM
E) PENGGANTI`;
  const target = `A9403/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) ${b} C) PERM
E) AKAN DIBATALKAN`;
  const canceller = `A9404/26 NOTAMC A9403/26
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) ${b} C) PERM
E) PEMBATALAN`;
  seedNotam('A9401/26', 'YMMM', perm, 'FIR', null, null);
  seedNotam('A9402/26', 'YMMM', replacer, 'FIR', null, null);
  seedNotam('A9403/26', 'YMMM', target, 'FIR', null, null);
  seedNotam('A9404/26', 'YMMM', canceller, 'FIR', null, null);
  try {
    const notams = (await rpc('getActiveNotams')).notams || [];
    const byId = (id) => notams.find(n => n.number === id);
    assert.equal(byId('A9401/26').status, 'REPLACED', 'NOTAM yang di-replace tidak boleh ACTIVE');
    assert.equal(byId('A9401/26').lifecycle, 'REPLACED');
    assert.equal(byId('A9402/26').status, 'ACTIVE', 'NOTAMR pengganti tetap ACTIVE');
    assert.equal(byId('A9403/26').status, 'CANCELLED', 'NOTAM yang dibatalkan tidak boleh ACTIVE');
    assert.equal(byId('A9404/26').status, 'CANCELLED', 'NOTAMC sendiri bukan warning aktif');

    // Halaman FIR NOTAM harus sepakat.
    const results = (await rpc('firGetNotamResults')).results || [];
    const findRes = (id) => results.find(n => n['NOTAM #'] === id);
    assert.equal(findRes('A9401/26').status, 'REPLACED');
    assert.equal(findRes('A9403/26').status, 'CANCELLED');
  } finally { dropNotam('A9401/26', 'A9402/26', 'A9403/26', 'A9404/26'); }
});

test('FIXTURE_9 baris tak terparse berisiko sama di kedua halaman, bukan LOW (H10)', async () => {
  // Tanpa Q)/B) → parseNotamRow null. Kata kunci hazard harus menghasilkan risiko
  // konservatif yang sama di getActiveNotams dan firGetNotamResults.
  const message = 'DANGER AREA ACT ROCKET LAUNCH WI COORD 0416S10415E - 0412S10413E';
  seedNotam('A9405/26', 'YMMM', message, 'FIR', new Date(Date.now() - 86400000).toISOString(), '2026-10-04T14:47:00Z');
  try {
    const active = ((await rpc('getActiveNotams')).notams || []).find(n => n.number === 'A9405/26');
    const listed = ((await rpc('firGetNotamResults')).results || []).find(n => n['NOTAM #'] === 'A9405/26');
    assert.ok(active && listed, 'baris harus tetap reviewable di kedua halaman');
    assert.equal(active.status, 'UNVERIFIED');
    assert.equal(listed.status, 'UNVERIFIED');
    assert.equal(active.risk, listed.risk, `risiko harus identik (FIR=${active.risk}, LIST=${listed.risk})`);
    assert.notEqual(listed.risk, 'LOW', 'baris tak terparse tidak boleh turun ke LOW');
    assert.equal(listed.risk, 'HIGH', 'kata kunci ROCKET LAUNCH = HIGH');
  } finally { dropNotam('A9405/26'); }
});

test('FIXTURE_9 skipped dilaporkan jujur oleh getActiveNotams (H2/M2)', async () => {
  const b = icaoDateDaysAgo(10);
  const scopeA = `A9406/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/A/000/999/2054S08637E744
A) YMMM B) ${b} C) 2610041447
E) SCOPE A — bukan milik halaman FIR`;
  seedNotam('A9406/26', 'YMMM', scopeA, 'FIR', new Date(Date.now() - 10 * 86400000).toISOString(), '2026-10-04T14:47:00Z');
  try {
    const data = await rpc('getActiveNotams');
    assert.ok((data.notams || []).every(n => n.number !== 'A9406/26'), 'scope A memang bukan scope halaman FIR');
    assert.ok(Number(data.skipped) >= 1, `baris yang dilewati harus dilaporkan (skipped=${data.skipped})`);
  } finally { dropNotam('A9406/26'); }
});

/* ==================== FIXTURE 9 (klien FIR): fail-closed risk & status (H9/H4) */
const firSource = await readFile(new URL('../src/FIR_Ui.html', import.meta.url), 'utf8');
const firClient = new Function(
  ['getRiskClass', 'riskBadge', 'notamIsLive', 'notamStatusKey', 'hazardStatusBucket']
    .map(name => extractFunction(firSource, 'function ' + name + '(')).join('\n') +
  '\nconst esc = (v) => String(v == null ? "" : v);\n' +
  'return { getRiskClass, riskBadge, notamIsLive, notamStatusKey, hazardStatusBucket };'
)();

test('FIXTURE_9 riskBadge fail-closed: data hilang bukan "Clear" (H9)', () => {
  assert.match(firClient.riskBadge(null), /UNVERIFIED/, 'null harus jadi UNVERIFIED, bukan Clear');
  assert.match(firClient.riskBadge(undefined), /UNVERIFIED/);
  assert.match(firClient.riskBadge(''), /UNVERIFIED/);
  assert.match(firClient.riskBadge('UNKNOWN'), /UNVERIFIED/);
  assert.match(firClient.riskBadge('HIGH'), /fir-risk-HIGH/);
  assert.match(firClient.riskBadge('Clear'), /fir-risk-Clear/, 'Clear yang eksplisit dari hasil analisa tetap boleh');
  assert.equal(firClient.getRiskClass(null), 'risk-UNVERIFIED');
  assert.equal(firClient.getRiskClass(''), 'risk-UNVERIFIED');
  assert.equal(firClient.getRiskClass('HIGH'), 'risk-HIGH');
});

test('FIXTURE_9 notamIsLive/hazardStatusBucket: REPLACED & CANCELLED tidak live (H4)', () => {
  assert.equal(firClient.notamIsLive({ status: 'ACTIVE', active: true }), true);
  assert.equal(firClient.notamIsLive({ status: 'UNVERIFIED', active: true }), true, 'belum terverifikasi ≠ aman, tapi tetap ditampilkan');
  assert.equal(firClient.notamIsLive({ status: 'FUTURE', active: true }), false);
  assert.equal(firClient.notamIsLive({ status: 'EXPIRED', active: false }), false);
  assert.equal(firClient.notamIsLive({ status: 'REPLACED', active: true }), false);
  assert.equal(firClient.notamIsLive({ status: 'CANCELLED', active: true }), false);
  assert.equal(firClient.notamIsLive({ status: 'ACTIVE', active: false }), false, 'di luar window = tidak live');
  assert.equal(firClient.hazardStatusBucket({ status: 'REPLACED', active: true }), 'INACTIVE');
  assert.equal(firClient.hazardStatusBucket({ status: 'CANCELLED', active: true }), 'INACTIVE');
  assert.equal(firClient.hazardStatusBucket({ status: 'UNVERIFIED', active: true }), 'UNVERIFIED');
  assert.equal(firClient.hazardStatusBucket({ status: 'ACTIVE', active: true }), 'ACTIVE');
});

test('FIXTURE_9 banner SOURCE_UNAVAILABLE terpasang di kedua halaman (H11)', () => {
  assert.match(firSource, /SOURCE UNAVAILABLE — daftar NOTAM gagal dimuat/, 'hazard list tidak boleh klaim "no impact" saat sumber gagal');
  assert.match(firSource, /ANALYSIS FAILED — hasil analisa NOTAM untuk flight ini tidak tersedia/);
  assert.match(firSource, /state\.notamSourceError = String/, 'loadActiveNotams harus merekam error, bukan mengabaikannya');
  assert.match(firNotamSource, /state\.lastResultsError = String/, 'loadResults harus menandai kegagalan');
  assert.match(firNotamSource, /SOURCE UNAVAILABLE — daftar NOTAM gagal dimuat/, 'daftar basi tidak boleh dilukis ulang sebagai data segar');
});

/* ============================ FIXTURE 8: scope FIR dari airport_firs (H1) */
// YPDN (Darwin) sengaja dipilih karena TIDAK ada di daftar 13 bandara hardcoded yang
// dulu dipakai analyzeSingleFlight. Dengan tabel airport_firs, flight dari YPDN harus
// membawa YBBB ke dalam scope — kalau tidak, NOTAM YBBB tersaring dan flight bisa
// terbaca "Clear" padahal melintasi FIR itu.
test('FIXTURE_8 scope FIR flight diambil dari tabel airport_firs', async () => {
  const b = icaoDateDaysAgo(2);
  database.exec("INSERT OR REPLACE INTO airport_firs (airport_icao, fir_code) VALUES ('YPDN','YBBB'),('WADD','WAAF'),('YPPH','YMMM')");
  database.prepare('INSERT OR REPLACE INTO firs (id, name) VALUES (?,?)').run('YBBB', 'Brisbane FIR');
  const dof = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  database.prepare("INSERT OR REPLACE INTO flights (id, callsign, dep, dest, etd, eta, dof, enr1) VALUES (9001,'QZ9001','YPDN','YPPH','1000','1200',?,'YPDN')").run(dof);
  seedNotam('A9301/26', 'YBBB', notamText('A9301/26', b, '2610041447', 'YBBB'), 'FIR',
    new Date(Date.now() - 2 * 86400000).toISOString(), '2026-10-04T14:47:00Z');
  try {
    const result = await rpc('analyzeFlightNotams', [9001]);
    assert.equal(result.firScopeSource, 'airport_firs', 'mapping harus dari DB, bukan fallback literal');
    assert.ok((result.firScope || []).includes('YBBB'), `YBBB harus masuk scope (dapat: ${JSON.stringify(result.firScope)})`);
    assert.ok((result.analysis || []).some(n => n.number === 'A9301/26'),
      'NOTAM YBBB harus ikut dianalisa untuk flight dari YPDN');
  } finally { dropNotam('A9301/26'); }

  // Panel "Traversed FIR Boundaries" membaca kunci FIR 1..8 dari getSelectedFlightsData.
  const data = await rpc('getSelectedFlightsData', [[9001]]);
  const flight = (data.flights || [])[0];
  assert.ok(flight, 'flight harus ada di payload');
  const firs = [1, 2, 3, 4, 5, 6, 7, 8].map(i => flight['FIR ' + i]).filter(Boolean);
  // Urutan: dep dulu, lalu dest.
  assert.deepEqual(firs, ['YBBB', 'YMMM'], `panel FIR harus terisi (dapat: ${JSON.stringify(firs)})`);
});

/* ============ Regression test per temuan audit (dulu todo, sekarang harus HIJAU) */
// Setiap entri mengunci satu temuan audit dengan ID-nya (H1..M3) supaya tidak bisa
// kambuh. Kalau nanti ada temuan baru yang BELUM diperbaiki, tambahkan entri di sini
// dan kembalikan `{ todo: d.id }` di loop bawah — suite tetap hijau sampai cacatnya
// diperbaiki, dan ledger test menjaga daftarnya tidak basi.
const DEFECTS = [
  {
    id: 'H8', fixture: 'AUDIT',
    title: 'tanggal AFTN imajiner ditolak tanpa syarat jam (2602311200 bukan 3 Mar)',
    run: async () => {
      assert.equal(duParseIcaoDateCode('2602311200'), null, '31 Feb 12:00 dulu lolos jadi 3 Mar');
      assert.equal(duParseIcaoDateCode('2602310000'), null);
      assert.equal(duParseIcaoDateCode('2602291200'), null, '2026 bukan tahun kabisat');
      assert.equal(duParseIcaoDateCode('2604311200'), null, '31 April');
      assert.equal(duParseIcaoDateCode('2613459900'), null, 'bulan 13 / jam 99');
      assert.equal(duParseIcaoDateCode('2802291200').toISOString(), '2028-02-29T12:00:00.000Z', '2028 kabisat');
      assert.equal(duParseIcaoDateCode('2609281223').toISOString(), '2026-09-28T12:23:00.000Z', 'tanggal valid tetap lolos');
      // Efek di jalur baca: baris dengan B) imajiner menjadi UNVERIFIED (kolom NULL),
      // bukan dipakai sebagai window valid 3 Mar.
      seedNotam('A9501/26', 'YMMM', notamText('A9501/26', '2602311200', '2610041447'), 'FIR', null, null);
      try {
        const row = ((await rpc('getActiveNotams')).notams || []).find(n => n.number === 'A9501/26');
        assert.ok(row, 'baris tetap reviewable');
        assert.equal(row.status, 'UNVERIFIED');
        assert.equal(row.effectiveDate, null, 'tanggal imajiner tidak boleh dikarang dari rollover');
      } finally { dropNotam('A9501/26'); }
    }
  },
  {
    id: 'H7', fixture: 'AUDIT',
    title: 'yyMMddHHmm klien menolak tanggal imajiner + parseNotam memberi peringatan',
    run: () => {
      assert.equal(clientParse.yyMMddHHmm('2609281223'), '2026-09-28 12:23');
      assert.equal(clientParse.yyMMddHHmm('2802291200'), '2028-02-29 12:00', 'kabisat tetap diterima');
      assert.equal(clientParse.yyMMddHHmm('2613459900'), '', 'bulan 13 / hari 45');
      assert.equal(clientParse.yyMMddHHmm('2602311200'), '', '31 Feb');
      assert.equal(clientParse.yyMMddHHmm('2604311200'), '', '31 April');
      assert.equal(clientParse.yyMMddHHmm('260928122'), '', 'bukan 10 digit');
      assert.equal(clientParse.yyMMddHHmm(''), '');
      assert.equal(clientParse.yyMMddHHmm(null), '');

      const out = clientParse.parseNotam(`A9502/26 NOTAMN
Q) YMMM/QRDCA/IV/BO/W/000/999/2054S08637E744
A) YMMM B) 2602311200 C) 2610041447
E) TEST`);
      assert.equal(out['Effective Date'], '', 'field dibiarkan kosong untuk diisi manual');
      assert.equal(out['Expiration Date'], '2026-10-04 14:47', 'C) valid tetap terisi');
      assert.ok((out._warnings || []).some(w => /B\)/.test(w)),
        `harus ada peringatan B) supaya tidak silent (dapat: ${JSON.stringify(out._warnings)})`);
    }
  },
  {
    id: 'M3', fixture: 'FIXTURE_3',
    title: 'editor menampilkan PERM, bukan string kosong (rpc.js:2363 vs :2471)',
    run: async () => {
      const b = icaoDateDaysAgo(10);
      seedNotam('A9012/26', 'YMMM', notamText('A9012/26', b, 'PERM'), 'FIR', null, null);
      try {
        const row = ((await rpc('firGetNotamEditorData')).notams || []).find(n => n['NOTAM #'] === 'A9012/26');
        assert.ok(row, 'baris harus ada di payload editor');
        assert.equal(String(row['Expiration Date'] || '').toUpperCase(), 'PERM');
      } finally { dropNotam('A9012/26'); }
    }
  },
  {
    id: 'M2', fixture: 'FIXTURE_5',
    title: 'NOTAM Q-scope A tetap reviewable atau terhitung skipped (rpc.js:2361 vs :2376)',
    run: async () => {
      const b = icaoDateDaysAgo(10);
      const message = notamText('A9004/26', b, '2610041447', 'YMMM', 'QRDCA/IV/BO/A/000/999/2054S08637E744');
      seedNotam('A9004/26', 'YMMM', message, 'FIR', new Date(Date.now() - 10 * 86400000).toISOString(), '2026-10-04T14:47:00Z');
      try {
        const active = (await rpc('getActiveNotams')).notams || [];
        const editor = await rpc('firGetNotamEditorData');
        const list = (await rpc('firGetNotamResults')).results || [];
        const surfaced = active.some(n => n.number === 'A9004/26')
          || (editor.notams || []).some(n => n['NOTAM #'] === 'A9004/26')
          || list.some(n => n['NOTAM #'] === 'A9004/26')
          || Number(editor.skipped || 0) > 0;
        assert.ok(surfaced,
          'standar skill: QSCOPE_MISMATCH tetap reviewable + ber-flag, bukan dibuang tanpa jejak (skipped masih 0)');
      } finally { dropNotam('A9004/26'); }
    }
  },
  {
    id: 'M1', fixture: 'FIXTURE_7',
    title: 'SNOWTAM tanpa Q) ditolak dengan alasan yang terlihat user',
    run: async () => {
      const preview = await rpc('firBulkPreviewNotams', [`(SNOWTAM 0211
A) EBBR B) 2609281200
F) 5/5/5 G) 100 H) 40/40/40
T) RWY 25R SNOW CLEARED 40PCT)`]);
      const hasReason = !!preview.error || (preview.preview || []).some(p => p.error);
      assert.ok(hasReason, `sekarang hanya menghasilkan total=${preview.total} tanpa alasan apa pun`);
    }
  },
  {
    id: 'M1', fixture: 'FIXTURE_7',
    title: 'SNOWTAM ber-Q) dirutekan atau diberi flag SNOWTAM/GRF (bukan NOTAM biasa)',
    run: async () => {
      const preview = await rpc('firBulkPreviewNotams', [`(A9201/26 SNOWTAM
Q) EBBR/QFALX/IV/M/AW/000/003/5045N00427E005
A) EBBR B) 2609281200 C) 25R
F) 5/5/5 G) 100 H) 40/40/40
T) RWY 25R WET, RWYCC 5/5/5)`]);
      assert.match(JSON.stringify(preview), /snowtam|GRF|LEGACY/i,
        'C) pada SNOWTAM adalah designator runway, bukan akhir validitas');
    }
  },
  {
    id: 'M1', fixture: 'FIXTURE_7',
    title: 'ASHTAM dirutekan atau diberi flag (bukan senyap 0 baris)',
    run: async () => {
      const preview = await rpc('firBulkPreviewNotams', [`(ASHTAM 0007
A) WIIF B) 2609281200 C) VOLCANO ERUPTION
D) 0730S 11030E E) ASH CLOUD FL250
F) SFC G) UNL H) NE 20KT)`]);
      assert.ok(preview.error || /ashtam/i.test(JSON.stringify(preview)),
        'ASHTAM tidak boleh hilang tanpa jejak');
    }
  }
];

// Jumlah temuan audit yang sudah ditutup dan dikunci sebagai regression test di atas.
// Kalau sebuah temuan baru ditambahkan ke DEFECTS, naikkan angka ini; ledger test gagal
// kalau keduanya tidak sinkron, supaya daftarnya tidak pernah diam-diam basi.
const FIXED_DEFECTS = 7;

for (const defect of DEFECTS) {
  // Semua temuan di DEFECTS sudah diperbaiki (lihat docs/notam-analyst-audit-fir.md),
  // jadi dijalankan sebagai test biasa. Untuk cacat yang belum diperbaiki, tambahkan
  // opsi `{ todo: defect.id + ' belum diperbaiki' }` di sini.
  test(`${defect.fixture} [${defect.id}] ${defect.title}`, defect.run);
}

test('ledger temuan audit sinkron dengan jumlah regression test', () => {
  assert.equal(DEFECTS.length, FIXED_DEFECTS,
    `DEFECTS berisi ${DEFECTS.length} entri tapi FIXED_DEFECTS = ${FIXED_DEFECTS}; perbarui konstanta setelah menambah/menutup temuan`);
  assert.ok(DEFECTS.every(d => d.id && d.fixture && d.title && typeof d.run === 'function'),
    'setiap entri DEFECTS butuh id, fixture, title, dan run');
});

process.on('exit', () => database.close());
