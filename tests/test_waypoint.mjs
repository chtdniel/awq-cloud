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
  assert.equal((await save('replace', 'route-a')).data.inserted, 2);
  assert.equal((await save('append', 'route-b')).data.inserted, 2);
  const merged = await save('merge', 'route-a', 'WADD S 08 40.0 E 115 10.2\nVTK N 01 24.9 E 104 01.3');
  assert.equal(merged.data.updated, 1);
  assert.equal(merged.data.inserted, 1);
  const rows = (await rpc('latlongGetEditorData')).data.rows;
  assert.equal(rows.length, 5);
  assert.equal(rows.find(row => row.ID === 'ROUTE-B' && row.Waypoint === 'WADD').Latitude, 'S 08 44.8');
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
  assert.equal((await save('replace', 'route-c')).data.inserted, 2);
  assert.equal((await rpc('latlongClearAll')).data.cleared, 2);
  assert.equal((await rpc('latlongGetEditorData')).data.count, 0);
} finally { database.close(); }
const viewer = await createWaypointFixture('readonly');
try {
  assert.equal((await viewer.rpc('latlongGetPreview', [rawText, 'column'])).status, 200);
  for (const method of ['latlongSaveBulk', 'latlongDeleteWaypoint', 'latlongClearAll']) assert.equal((await viewer.rpc(method)).status, 403);
} finally { viewer.database.close(); }
console.log('Waypoint preview, save modes, route isolation, validation, delete, clear and authorization passed.');
