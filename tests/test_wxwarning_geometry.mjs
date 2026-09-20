// Geometry + route resolution tests for the WX WARNING map.
//
// Two things are covered here because they are what decides whether a warning is
// reported as cutting the flight's route:
//   * shared/geo.mjs      — spherical distance, point-in-polygon (including the
//                           date-line case), ring-to-path distance;
//   * shared/routegeom.mjs — turning D1 routes/latlong rows into the ordered
//                           coordinate list the map draws, with the same rules the
//                           FIR page uses (active route first, DEP/ARR fallback,
//                           duplicate coordinates collapsed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  haversineNm, distanceToSegmentNm, distanceToPathNm, pointInPolygon,
  polygonToPathDistanceNm, polygonGeoJson
} from '../shared/geo.mjs';
import { parseDms, parseInlineCoord, resolveRouteForFlight, airportFallbackCoord } from '../shared/routegeom.mjs';
import { parseVaaText, computeRouteHits } from '../shared/wxwarning.mjs';

const NOW = new Date('2026-09-20T21:30:00Z');
const SQUARE = [[0, 0], [2, 0], [2, 2], [0, 2]];

/* ------------------------------------------------------------------- geo --- */

test('great-circle distance matches known airport pairs within a percent', () => {
  const wiiiWadd = haversineNm([106.6558, -6.1256], [115.1668, -8.7482]);
  assert.ok(wiiiWadd > 500 && wiiiWadd < 560, `WIII-WADD should be about 530 NM, got ${wiiiWadd.toFixed(1)}`);
  assert.equal(haversineNm([0, 0], [0, 0]), 0);
  const oneDegree = haversineNm([0, 0], [0, 1]);
  assert.ok(Math.abs(oneDegree - 60) < 0.1, `one degree of latitude is 60 NM, got ${oneDegree.toFixed(3)}`);
});

test('distance to a segment uses the perpendicular foot and clamps past the ends', () => {
  const perpendicular = distanceToSegmentNm([0, 1], [0, 0], [1, 0]);
  assert.ok(Math.abs(perpendicular - 60) < 0.2, `expected 60 NM, got ${perpendicular.toFixed(3)}`);
  const beyondEnd = distanceToSegmentNm([2, 0], [0, 0], [1, 0]);
  assert.ok(Math.abs(beyondEnd - 60) < 0.2, `expected the endpoint distance 60 NM, got ${beyondEnd.toFixed(3)}`);
  assert.equal(distanceToSegmentNm([0.5, 0], [0, 0], [1, 0]), 0);
});

test('distance to a polyline follows the nearest leg', () => {
  const path = [[0, 0], [1, 0], [1, 1]];
  assert.ok(Math.abs(distanceToPathNm([0.5, 0.5], path) - 30) < 1, 'should be 30 NM from the first leg');
  assert.equal(distanceToPathNm([1, 0], path), 0);
});

test('point in polygon: inside, outside and on the plane', () => {
  assert.equal(pointInPolygon([1, 1], SQUARE), true);
  assert.equal(pointInPolygon([3, 1], SQUARE), false);
  assert.equal(pointInPolygon([1, 1], [[0, 0], [1, 1]]), false, 'a degenerate ring is never "inside"');
});

test('point in polygon works across the date line', () => {
  const fiji = [[179, -18], [-179, -18], [-179, -20], [179, -20]];
  assert.equal(pointInPolygon([179.5, -19], fiji), true);
  assert.equal(pointInPolygon([-179.5, -19], fiji), true);
  assert.equal(pointInPolygon([178, -19], fiji), false);
});

test('ring to path distance is zero when the route runs through the hazard', () => {
  const through = [[1, -1], [1, 3]];
  assert.equal(polygonToPathDistanceNm(SQUARE, through), 0);
  const northOfIt = [[0, 3], [2, 3]];
  const gap = polygonToPathDistanceNm(SQUARE, northOfIt);
  assert.ok(Math.abs(gap - 60) < 1, `expected a 60 NM gap, got ${gap.toFixed(2)}`);
});

test('GeoJSON ring closure and the degenerate case', () => {
  const geojson = polygonGeoJson(SQUARE);
  assert.equal(geojson.type, 'Polygon');
  assert.deepEqual(geojson.coordinates[0][0], geojson.coordinates[0][geojson.coordinates[0].length - 1]);
  assert.equal(polygonGeoJson([[0, 0], [1, 1]]), null, 'fewer than three points cannot be a polygon');
});

/* -------------------------------------------------------------- routegeom --- */

test('DMS and inline waypoint coordinates', () => {
  assert.ok(Math.abs(parseDms('S 08 06.0') - (-8.1)) < 1e-9);
  assert.ok(Math.abs(parseDms('N 02 19.5') - 2.325) < 1e-9);
  assert.equal(parseDms('not a coordinate'), null);
  assert.equal(parseDms(null), null);

  const compact = parseInlineCoord('0540N10630E');
  assert.ok(Math.abs(compact[0] - 106.5) < 1e-9);
  assert.ok(Math.abs(compact[1] - 5.6667) < 1e-3);
  assert.deepEqual(parseInlineCoord('05N106E'), [106, 5]);
  assert.equal(parseInlineCoord('DOLTA'), null);
});

const ROUTES = [
  { id: 'WIIIWADD10', dep_airport: 'WIII', arr_airport: 'WADD', waypoint_seq: 'WIII DOLTA 0800S11000E WADD' },
  { id: 'WIIIWADD20', dep_airport: 'WIII', arr_airport: 'WADD', waypoint_seq: 'WIII GULAV WADD' }
];

const LATLONG = [
  { route_id: 'WIIIWADD10', waypoint: 'WIII', latitude: 'S 06 07.5', longitude: 'E 106 39.3' },
  { route_id: 'WIIIWADD10', waypoint: 'DOLTA', latitude: 'S 08 00.0', longitude: 'E 110 00.0' },
  { route_id: 'WIIIWADD10', waypoint: 'WADD', latitude: 'S 08 44.9', longitude: 'E 115 10.0' },
  { route_id: 'WIIIWADD20', waypoint: 'WIII', latitude: 'S 06 07.5', longitude: 'E 106 39.3' },
  { route_id: 'WIIIWADD20', waypoint: 'GULAV', latitude: 'S 07 30.0', longitude: 'E 112 30.0' },
  { route_id: 'WIIIWADD20', waypoint: 'WADD', latitude: 'S 08 44.9', longitude: 'E 115 10.0' }
];

test('route resolution matches DEP/ARR and collapses duplicate coordinates', () => {
  const route = resolveRouteForFlight({ id: 1, dep: 'WIII', dest: 'WADD' }, { routes: ROUTES, latlong: LATLONG });
  assert.equal(route.routeId, 'WIIIWADD10');
  assert.equal(route.coords.length, 3, 'the inline 0800S11000E repeats DOLTA and must collapse');
  assert.deepEqual(route.waypoints.map(point => point.name), ['WIII', 'DOLTA', 'WADD']);
  assert.ok(Math.abs(route.coords[1][0] - 110) < 1e-6);
  assert.ok(Math.abs(route.coords[1][1] - (-8)) < 1e-6);
  assert.deepEqual(route.missing, []);
});

test('ACTIVE_ROUTE_ID wins over the DEP/ARR pair', () => {
  const route = resolveRouteForFlight({ id: 1, dep: 'WIII', dest: 'WADD', active_route_id: 'WIIIWADD20' }, { routes: ROUTES, latlong: LATLONG });
  assert.equal(route.routeId, 'WIIIWADD20');
  assert.deepEqual(route.waypoints.map(point => point.name), ['WIII', 'GULAV', 'WADD']);
});

test('unknown waypoints are reported instead of silently dropped', () => {
  const routes = [{ id: 'X1', dep_airport: 'WIII', arr_airport: 'WADD', waypoint_seq: 'WIII ZZZZZ WADD' }];
  const route = resolveRouteForFlight({ dep: 'WIII', dest: 'WADD' }, { routes, latlong: LATLONG });
  assert.deepEqual(route.missing, ['ZZZZZ']);
  assert.equal(route.coords.length, 2, 'the unknown fix contributes no coordinate; the airports still anchor the route');
  assert.deepEqual(route.waypoints.map(point => point.name), ['WIII', 'WADD']);
});

test('a flight without a route yields an empty path, not a straight line guess', () => {
  const route = resolveRouteForFlight({ dep: 'WIII', dest: 'WADD' }, { routes: [], latlong: [] });
  assert.equal(route.routeId, '');
  assert.deepEqual(route.coords, []);
  assert.deepEqual(route.waypoints, []);
});

test('the airport fallback keeps the endpoints when latlong lacks them', () => {
  const routes = [{ id: 'Y1', dep_airport: 'WIII', arr_airport: 'YPPH', waypoint_seq: 'WIII YPPH' }];
  const route = resolveRouteForFlight({ dep: 'WIII', dest: 'YPPH' }, { routes, latlong: [] });
  assert.equal(route.coords.length, 2);
  assert.deepEqual(route.coords[0], airportFallbackCoord('WIII'));
  assert.deepEqual(route.coords[1], airportFallbackCoord('YPPH'));
});

/* ------------------------------------------------- warning vs route report --- */

test('a volcanic-ash advisory over the flight route is flagged for the briefing', () => {
  const warning = parseVaaText(`FVAU02 ADRM 201550
VA ADVISORY
DTG: 20260920/1550Z
VAAC: DARWIN
VOLCANO: SEMERU 263300
PSN: S0806 E11255
AREA: INDONESIA
ADVISORY NR: 2026/1078
EST VA CLD: SFC/FL150 S0808 E11253 - S0803 E11253 - S0755
E11319 - S0805 E11325 - S0817 E11318 MOV E 15KT
NXT ADVISORY: NO LATER THAN 20260920/2150Z=`, { now: NOW }).warning;
  warning.id = 11;
  // Jakarta -> Denpasar, i.e. straight across the ash cloud.
  const route = resolveRouteForFlight({ dep: 'WIII', dest: 'WADD' }, { routes: ROUTES, latlong: LATLANG_FOR_TEST() });
  const hits = computeRouteHits([warning], route.coords, 50);
  assert.equal(hits['11'].hit, true);
});

function LATLANG_FOR_TEST() {
  return [
    { route_id: 'WIIIWADD10', waypoint: 'WIII', latitude: 'S 06 07.5', longitude: 'E 106 39.3' },
    { route_id: 'WIIIWADD10', waypoint: 'DOLTA', latitude: 'S 08 00.0', longitude: 'E 112 00.0' },
    { route_id: 'WIIIWADD10', waypoint: 'WADD', latitude: 'S 08 44.9', longitude: 'E 115 10.0' }
  ];
}

test('a route to the north of Java reports no volcanic-ash impact', () => {
  const warning = parseVaaText(`FVAU02 ADRM 201550
VA ADVISORY
DTG: 20260920/1550Z
VAAC: DARWIN
VOLCANO: SEMERU 263300
PSN: S0806 E11255
AREA: INDONESIA
ADVISORY NR: 2026/1078
EST VA CLD: SFC/FL150 S0808 E11253 - S0803 E11253 - S0755
E11319 - S0805 E11325 - S0817 E11318 MOV E 15KT
NXT ADVISORY: NO LATER THAN 20260920/2150Z=`, { now: NOW }).warning;
  warning.id = 12;
  const borneo = [[109.0, -2.0], [114.0, 1.0]];
  const hits = computeRouteHits([warning], borneo, 50);
  assert.equal(hits['12'].hit, false);
  assert.ok(hits['12'].nm > 300);
});
