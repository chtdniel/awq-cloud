// Halaman FIR dulu tidak pernah menggambar polygon/lingkaran NOTAM area: RPC
// getActiveNotams mengirim radiusNm=null dan polygon=[] untuk semua baris, jadi
// peta hanya menampilkan titik. Uji ini mengunci dua sisi perbaikan:
//   1. payload RPC membawa geometri area dari teks NOTAM (Q) pusat/radius, E) batas),
//   2. klien FIR tetap bisa menggambar area walau payload hanya berisi teks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { seedAuthUser } from './rpc_auth_fixture.mjs';

// ------------------------------------------------------------------ fixtures
// Teks NOTAM nyata (bentuk sama dengan data DINS: Q) DM 4/5 digit + radius 3 digit).
const polygonNotam = number => `(${number} NOTAMN
Q) RPHI/QWELW/IV/BO /W /000/010/1418N12050E008
A) RPHI B) 2606302200 C) 2609301600
D) 2200-1600
E) MIL EXER WILL TAKE PLACE WI:
142305N 1205257E -
141804N 1205714E -
141104N 1204729E -
141710N 1204208E -
142305N 1205257E
(CAVITE AREA).
F) SFC G) 1000FT AMSL)`;
const circleNotam = number => `(${number} NOTAMN
Q) RPHI/QWELW/IV/BO /W /000/020/1002N12336E002
A) RPHI B) 2606210000 C) 2609202359
E) MIL EXER WILL TAKE PLACE WI:
1.5NM RADIUS CENTERED ON 100203N 1233542E
(SIBONGA, CEBU).
F) SFC G) 2000FT AMSL)`;
// DMS Q) line (6/7 digit) + radius of influence 999 = tidak didefinisikan.
const dmsNotam = number => `(${number} NOTAMN
Q) WIIF/QRTCA/IV/BO/E/000/999/060000S1060000E
A) WIIF B) 2609010000 C) 2610010000
E) TEMPO DANGER AREA ESTABLISHED
F) SFC G) 5000FT AMSL)`;

const polygonText = polygonNotam('B2376/26').slice(polygonNotam('B2376/26').indexOf('(') + 1);
const circleText = circleNotam('B2825/26').slice(circleNotam('B2825/26').indexOf('(') + 1);

// ------------------------------------------------------- server: RPC payload
const bundle = await build({ entryPoints: ['functions/api/rpc.js'], bundle: true, platform: 'node', format: 'esm', write: false });
const { onRequestPost } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE firs (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE user_profiles (user_id INTEGER PRIMARY KEY, full_name TEXT, iaa_id TEXT, lic_no TEXT, updated_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE notams (id TEXT PRIMARY KEY, location TEXT, q_code TEXT, message TEXT, valid_from TEXT, valid_to TEXT, kind TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO firs (id, name) VALUES ('RPHI', 'Manila FIR'), ('WIIF', 'Jakarta FIR');
  INSERT INTO notams (id, location, message, valid_from, valid_to, kind) VALUES
    ('B2376/26', 'RPHI', ?, '2026-06-30T22:00:00Z', '2026-09-30T16:00:00Z', 'FIR'),
    ('B2825/26', 'RPHI', ?, '2026-06-21T00:00:00Z', '2026-09-20T23:59:00Z', 'FIR'),
    ('A4001/26', 'WIIF', ?, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'FIR')
`, {});
database.prepare('UPDATE notams SET message = ? WHERE id = ?').run(polygonNotam('B2376/26'), 'B2376/26');
database.prepare('UPDATE notams SET message = ? WHERE id = ?').run(circleNotam('B2825/26'), 'B2825/26');
database.prepare('UPDATE notams SET message = ? WHERE id = ?').run(dmsNotam('A4001/26'), 'A4001/26');

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
    try {
      const results = [];
      for (const prepared of statements) results.push(await prepared.run());
      database.exec('COMMIT');
      return results;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
};
const authHeaders = await seedAuthUser(database, DB);
async function rpc(method, args = []) {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST', headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ method, args })
  });
  const response = await onRequestPost({ request, env: { DB } });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}
const payload = (await rpc('getActiveNotams')).notams;
const byNumber = number => payload.find(row => row.number === number);

test('E) boundary coordinate list reaches the FIR map as a polygon', () => {
  const notam = byNumber('B2376/26');
  assert.ok(notam, 'polygon NOTAM is in the active payload');
  assert.equal(notam.polygon.length, 5, 'five corners including the closing point');
  assert.deepEqual(notam.polygon[0], [120.8825, 14.3847], 'first corner is 142305N 1205257E');
  assert.deepEqual(notam.polygon[0], notam.polygon[4], 'ring is closed');
  assert.deepEqual(notam.center, [120.8333, 14.3], 'circle centre comes from the Q) line');
  assert.deepEqual([notam.lon, notam.lat], notam.center, 'lat/lon mirror the map centre');
  assert.equal(notam.radiusNm, 8, 'Q) radius of influence is reported alongside the polygon');
});

test('E) radius phrase reaches the FIR map as a circle', () => {
  const notam = byNumber('B2825/26');
  assert.deepEqual(notam.polygon, [], 'a single centre point is not a polygon');
  assert.equal(notam.radiusNm, 1.5, 'explicit E) radius wins over the Q) radius of influence (002)');
  assert.deepEqual(notam.center, [123.6, 10.0333], 'centre from the Q) line');
});

test('DMS Q) line is accepted and 999 radius is not drawn as a circle', () => {
  const notam = byNumber('A4001/26');
  assert.deepEqual(notam.center, [106, -6], '060000S1060000E parses to 6S 106E');
  assert.equal(notam.radiusNm, null, 'radius 999 means no defined radius of influence');
  assert.deepEqual(notam.polygon, []);
});

// --------------------------------------------- client: FIR dashboard drawing
const firSource = readFileSync(new URL('../src/FIR_Ui.html', import.meta.url), 'utf8');
function extract(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) + ';'; }
  }
  throw new Error('unbalanced braces after: ' + marker);
}
const client = new Function([
  'nfield', 'normalizePolygon', 'parseRadiusPhraseFromText', 'parseNotamGeometryFromText', 'notamShapeProps', 'buildNotamGeom', 'notamRingContains'
].map(name => extract(firSource, 'function ' + name + '(')).join('\n') +
  '\nreturn { notamShapeProps, buildNotamGeom, parseNotamGeometryFromText, notamRingContains };')();

test('client still draws the area when the payload carries text only', () => {
  const polygonProps = client.notamShapeProps({ location: 'RPHI', number: 'B2376/26', risk: 'MEDIUM', text: polygonText }, 14.3, 120.83);
  assert.equal(polygonProps.polygon.length, 5, 'polygon recovered from E) coordinates');
  assert.equal(client.buildNotamGeom(polygonProps).length >= 3, true, 'Leaflet gets a fillable ring');

  const circleProps = client.notamShapeProps({ location: 'RPHI', number: 'B2825/26', risk: 'MEDIUM', text: circleText }, 10.0333, 123.6);
  assert.equal(circleProps.radiusNm, 1.5, 'radius recovered from the E) phrase');
  const ring = client.buildNotamGeom(circleProps);
  assert.equal(ring.length, 65, '64-step circle plus the closing point');
  const lats = ring.map(point => point[1]);
  assert.ok(Math.abs((Math.max(...lats) - Math.min(...lats)) - 0.05) < 0.002, 'ring spans the 1.5 NM radius');
});

test('server geometry is used as-is and truncated text falls back to the Q) circle', () => {
  const serverProps = client.notamShapeProps({ location: 'RPHI', number: 'B2376/26', radiusNm: 8, polygon: [[120.88, 14.38], [120.95, 14.3], [120.88, 14.38]] }, 14.3, 120.88);
  assert.equal(serverProps.polygon.length, 3, 'payload polygon is not re-parsed');
  assert.equal(serverProps.radiusNm, 8);

  const padded = polygonNotam('B2376/26').replace('E) MIL EXER WILL TAKE PLACE WI:', 'E) ' + 'X'.repeat(400) + ' MIL EXER WILL TAKE PLACE WI:');
  assert.ok(padded.length > 400, 'fixture is longer than the 400-char payload cap');
  const truncatedProps = client.notamShapeProps({ location: 'RPHI', number: 'B2376/26', text: padded.slice(0, 400) }, 14.3, 120.83);
  assert.deepEqual(truncatedProps.polygon, [], 'a half-parsed polygon is never drawn');
  assert.equal(truncatedProps.radiusNm, 8, 'the Q) radius draws the circle instead');
});

test('client parser honours S/W hemispheres for both coordinate formats', () => {
  const westDms = client.parseNotamGeometryFromText('Q) WIIF/QRTCA/IV/BO/E/000/999/340000N1180000W\nE) TEST');
  assert.deepEqual(westDms.center, [-118, 34], 'DMS 340000N1180000W parses to 34N 118W');
  const southDm = client.parseNotamGeometryFromText('Q) WIIF/QRTCA/IV/BO/E/000/999/0600S10600E005\nE) TEST');
  assert.deepEqual(southDm.center, [106, -6], 'DM 0600S10600E parses to 6S 106E');
  assert.equal(southDm.radiusNm, 5, 'Q) radius is kept when E) has no radius phrase');
});

test('overlap hit test finds the NOTAMs covering a clicked point', () => {
  // Kotak 1 derajat (ring dari polygon E)) dan lingkaran 5 NM di dalamnya.
  const square = [[[14, 120], [15, 120], [15, 121], [14, 121], [14, 120]]][0];
  assert.equal(client.notamRingContains(square, 14.5, 120.5), true, 'titik di tengah kotak terdeteksi');
  assert.equal(client.notamRingContains(square, 14.5, 121.5), false, 'titik di luar kotak ditolak');
  assert.equal(client.notamRingContains(square, 16, 120.5), false, 'titik di utara kotak ditolak');

  const circleProps = client.notamShapeProps({ location: 'RPHI', number: 'B2824/26', text: 'Q) RPHI/QWELW/IV/BO /W /000/020/1452N12057E008\nE) 5NM RADIUS CENTERED ON 145200N 1205700E' }, 14.8667, 120.95);
  const circleRing = client.buildNotamGeom(circleProps).map(point => [point[1], point[0]]);
  assert.equal(client.notamRingContains(circleRing, 14.8667, 120.95), true, 'pusat lingkaran ada di dalam ring');
  assert.equal(client.notamRingContains(circleRing, 14.8667, 121.2), false, 'titik 0.25 derajat di timur ada di luar ring 5 NM');
  assert.equal(client.notamRingContains(square, 14.8667, 120.95), true, 'titik yang sama juga di dalam polygon yang menutupinya (kasus tumpang tindih)');
});

test('the NOTAM layer and Focus on Map both route through the geometry helper', () => {
  assert.ok(firSource.includes('const props = notamShapeProps(n, lat, lon);'), 'updateNotamLayer uses the helper');
  assert.ok(firSource.includes('const props = notamShapeProps(match, lat, lon);'), 'firFocusNotamOnMap uses the helper');
  assert.ok(firSource.includes('text.length < 400') || firSource.includes('.length < 400'), 'client guard matches the 400-char payload cap');
  // Bentuk area dan bentuk sorotan sama-sama memakai dispatcher tumpang tindih; bentuk
  // sorotan wajib punya handler, kalau tidak dia menelan klik ke polygon di bawahnya.
  assert.ok(firSource.includes('geom.on(\'click\', (e) => onNotamGeomClick(props, lat, lon, e));'), 'polygon layer memakai dispatcher');
  assert.ok(firSource.includes('shape.on(\'click\', (e) => onNotamGeomClick(p, lat, lon, e));'), 'bentuk sorotan ikut menerima klik');
  assert.ok(firSource.includes("el.addEventListener('click', onNotamPickClick);"), 'tombol daftar dipasang di elemen popup (Leaflet stopPropagation)');
  const rpcSource = readFileSync(new URL('../functions/api/rpc.js', import.meta.url), 'utf8');
  assert.ok(rpcSource.includes('parseNotamGeometry(decodedMessage)'), 'getActiveNotams parses geometry from the full message');
  assert.ok(rpcSource.includes('slice(0, 400)'), 'client guard constant still matches the server cap');
});

database.close();
