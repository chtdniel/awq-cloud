import assert from 'node:assert/strict';
import { createWaypointFixture } from './waypoint_fixture.mjs';

const fixture = await createWaypointFixture();
const { database, rpc } = fixture;
const rawText = 'WADD S 08 44.8 E 115 10.2\nMAMAD S 08 45.0 E 115 27.9';
try {
  const preview = await rpc('latlongGetPreview', [rawText, 'column']);
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.data.count, 2);
  assert.equal(preview.data.dedupedCount, 2);
  const save = (mode, routeId, text = rawText) => rpc('latlongSaveBulk', [{ rawText: text, mode, routeId, orderMode: 'column' }]);
  const knownSave = await save('replace', 'route-a');
  assert.equal(knownSave.data.inserted, 2);
  assert.equal(knownSave.data.routeKnown, true, 'ROUTE-A punya profil di registry (perbandingan tidak case-sensitive)');
  const orphanSave = await save('append', 'route-b');
  assert.equal(orphanSave.data.inserted, 2);
  assert.equal(orphanSave.data.routeKnown, false, 'ROUTE-B belum ada di registry, koordinatnya harus ditandai belum dikenal');
  const merged = await save('merge', 'route-a', 'WADD S 08 40.0 E 115 10.2\nVTK N 01 24.9 E 104 01.3');
  assert.equal(merged.data.updated, 1);
  assert.equal(merged.data.inserted, 1);
  const rows = (await rpc('latlongGetEditorData')).data.rows;
  assert.equal(rows.length, 5);
  assert.equal(rows.find(row => row.ID === 'ROUTE-B' && row.Waypoint === 'WADD').Latitude, 'S 08 44.8');
  // Baris yatim: route_id tanpa profil di registry. Hanya ROUTE-A yang punya
  // profil di fixture, jadi ROUTE-B (dan ID yang tidak dikenal) harus ditandai.
  const editor = (await rpc('latlongGetEditorData')).data;
  assert.equal(editor.orphanCount, 2, 'hanya baris yang Route ID-nya tidak ada di registry yang dihitung yatim');
  assert.deepEqual([...new Set(editor.rows.filter(row => row.orphan).map(row => row.ID))], ['ROUTE-B']);
  assert.equal(editor.rows.filter(row => row.ID === 'ROUTE-A').every(row => row.orphan === false), true, 'ROUTE-A punya profil, jadi bukan yatim');
  for (const [mode, routeId, text] of [['invalid', 'A', rawText], ['replace', '', rawText], ['replace', 'A', 'invalid text'], ['replace', 'A', 'WADD S 91 00.0 E 115 10.2']]) {
    assert.equal((await save(mode, routeId, text)).status, 400);
    assert.equal((await rpc('latlongGetEditorData')).data.count, 5);
  }
  const twoColumns = 'AAAA N 1 01.0 E 1 01.0 BBBB N 2 02.0 E 2 02.0\nCCCC N 3 03.0 E 3 03.0 DDDD N 4 04.0 E 4 04.0\nAAAA N 1 01.0 E 1 01.0';
  const column = (await rpc('latlongGetPreview', [twoColumns, 'column'])).data;
  assert.deepEqual(column.entries.map(row => row.waypoint), ['AAAA', 'CCCC', 'BBBB', 'DDDD']);
  assert.equal(column.dupCount, 1);
  assert.deepEqual((await rpc('latlongGetPreview', [twoColumns, 'row'])).data.entries.map(row => row.waypoint), ['AAAA', 'BBBB', 'CCCC', 'DDDD']);
  const target = rows.find(row => row.ID === 'ROUTE-A' && row.Waypoint === 'WADD');
  assert.equal((await rpc('latlongDeleteWaypoint', [target.Waypoint, target.rowId])).data.deleted, 1);
  assert.equal((await rpc('latlongGetEditorData')).data.count, 4);
  for (const method of ['latlongSaveBulk', 'latlongDeleteWaypoint', 'latlongClearAll']) {
    assert.equal((await rpc(method, [], { Cookie: fixture.authHeaders.Cookie })).status, 403);
  }
  database.exec("CREATE TRIGGER fail_waypoint BEFORE INSERT ON latlong WHEN NEW.waypoint = 'STOP' BEGIN SELECT RAISE(ABORT, 'Simulated write failure'); END");
  assert.equal((await save('replace', 'route-c', 'STOP N 01 00.0 E 100 00.0')).status, 500);
  assert.equal((await rpc('latlongGetEditorData')).data.count, 4, 'Failed replace must roll back the delete');
  database.exec('DROP TRIGGER fail_waypoint');
  assert.equal((await rpc('latlongSaveBulk', [], {})).status, 401);
  const lastSave = await save('replace', 'route-c');
  assert.equal(lastSave.data.inserted, 2);
  assert.equal(lastSave.data.routeKnown, false, 'route-c tidak punya profil di registry');
  assert.equal((await rpc('latlongClearAll')).data.cleared, 2);
  assert.equal((await rpc('latlongGetEditorData')).data.count, 0);
} finally { database.close(); }
const viewer = await createWaypointFixture('readonly');
try {
  for (const method of ['latlongGetPreview', 'latlongGetEditorData', 'latlongSaveBulk', 'latlongDeleteWaypoint', 'latlongClearAll']) {
    assert.equal((await viewer.rpc(method, method === 'latlongGetPreview' ? [rawText, 'column'] : [])).status, 403, method + ' must be admin-only');
  }
} finally { viewer.database.close(); }

const registered = await createWaypointFixture('registered');
try {
  for (const method of ['latlongGetPreview', 'latlongGetEditorData', 'latlongSaveBulk', 'latlongDeleteWaypoint', 'latlongClearAll']) {
    assert.equal((await registered.rpc(method, method === 'latlongGetPreview' ? [rawText, 'column'] : [])).status, 403, method + ' must be admin-only');
  }
} finally { registered.database.close(); }

const orderFixture = await createWaypointFixture();
try {
  const twoColumnRoute = 'AAAA N 1 01.0 E 1 01.0 BBBB N 2 02.0 E 2 02.0\nCCCC N 3 03.0 E 3 03.0 DDDD N 4 04.0 E 4 04.0';
  orderFixture.database.exec(`
    INSERT INTO latlong (route_id, waypoint, latitude, longitude) VALUES
      ('ROUTE-COLUMN', 'AAAA', 'N 01 01.0', 'E 001 01.0'),
      ('ROUTE-COLUMN', 'BBBB', 'N 02 02.0', 'E 002 02.0'),
      ('ROUTE-COLUMN', 'CCCC', 'N 03 03.0', 'E 003 03.0'),
      ('ROUTE-COLUMN', 'DDDD', 'N 04 04.0', 'E 004 04.0');
  `);
  const saved = await orderFixture.rpc('latlongSaveBulk', [{ rawText: twoColumnRoute, mode: 'merge', routeId: 'ROUTE-COLUMN', orderMode: 'column' }]);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const readBack = await orderFixture.rpc('latlongGetEditorData');
  assert.deepEqual(
    readBack.data.rows.filter(row => row.ID === 'ROUTE-COLUMN').map(row => row.Waypoint),
    ['AAAA', 'CCCC', 'BBBB', 'DDDD'],
    'MERGE must persist the requested COLUMN scan order, not retain an older row-by-row database order.'
  );
} finally { orderFixture.database.close(); }
console.log('Waypoint preview, save modes, route isolation, validation, delete, clear and authorization passed.');
