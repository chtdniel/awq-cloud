// Geometry primitives for hazard-vs-route work (WX WARNING page).
//
// Convention: every coordinate here is a [lon, lat] pair in decimal degrees,
// matching the client-side convention already used by FIR_Ui's airportCoords /
// routeCoords. Leaflet needs [lat, lon], so the renderer flips the pair at the
// last moment — never in this module.
//
// The functions are pure and dependency-free so both the RPC layer and the cron
// worker (and the unit tests) can share exactly one implementation.

const EARTH_RADIUS_NM = 3440.065;

export function toRad(deg) {
    return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
    return (rad * 180) / Math.PI;
}

export function haversineNm(a, b) {
    if (!a || !b) return NaN;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingRad(a, b) {
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const dLon = toRad(b[0] - a[0]);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return Math.atan2(y, x);
}

// Shortest distance from a point to a great-circle segment, clamped to the
// segment (cross-track when the perpendicular foot lands inside, otherwise the
// nearer endpoint).
//
// The along-track magnitude from acos() is always positive, so its sign has to
// be restored from the bearing difference: without that, a point on the same
// meridian but past the end of the segment reads as sitting *on* the segment
// (a 60 NM gap came back as 0).
export function distanceToSegmentNm(p, a, b) {
    if (!p || !a || !b) return NaN;
    const segNm = haversineNm(a, b);
    if (!(segNm > 0)) return haversineNm(p, a);
    const d13 = haversineNm(a, p) / EARTH_RADIUS_NM;
    if (d13 === 0) return 0;
    const theta13 = bearingRad(a, p);
    const theta12 = bearingRad(a, b);
    const dxt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(theta13 - theta12)))) * EARTH_RADIUS_NM;
    const cosRatio = Math.cos(d13) / Math.cos(dxt / EARTH_RADIUS_NM);
    let dat = Math.acos(Math.max(-1, Math.min(1, cosRatio))) * EARTH_RADIUS_NM;
    let delta = theta13 - theta12;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    if (Math.abs(delta) > Math.PI / 2) dat = -dat;
    if (dat >= 0 && dat <= segNm) return Math.abs(dxt);
    return Math.min(haversineNm(p, a), haversineNm(p, b));
}

// Minimum distance from a point to a polyline (path is an ordered [lon,lat][]).
export function distanceToPathNm(p, path) {
    if (!p || !Array.isArray(path) || path.length === 0) return NaN;
    if (path.length === 1) return haversineNm(p, path[0]);
    let best = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
        const d = distanceToSegmentNm(p, path[i], path[i + 1]);
        if (d < best) best = d;
    }
    return best;
}

// Ray casting on the lon/lat plane. A ring whose longitude span exceeds 180°
// has crossed the date line, so negative longitudes are shifted into the same
// 0..360 frame as the ring before testing — otherwise every polygon that
// straddles 180° tests as "false" and the route never intersects it.
export function pointInPolygon(p, poly) {
    if (!p || !Array.isArray(poly) || poly.length < 3) return false;
    const lons = poly.map(v => v[0]);
    let shift = 0;
    if (Math.max(...lons) - Math.min(...lons) > 180) shift = 360;
    const x = p[0] + (p[0] < 0 && shift ? shift : 0);
    const y = p[1];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0] + (poly[i][0] < 0 && shift ? shift : 0);
        const yi = poly[i][1];
        const xj = poly[j][0] + (poly[j][0] < 0 && shift ? shift : 0);
        const yj = poly[j][1];
        const intersects = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

// Rings that straddle the date line are shifted into one 0..360 frame before
// any planar test, so a segment crossing 180° is not read as a segment that
// wraps the whole planet. One shift is derived from the ring and applied to both
// geometries, otherwise ring and path end up in different frames.
function planarShift(points) {
    const lons = points.map(p => p[0]);
    return Math.max(...lons) - Math.min(...lons) > 180 ? 360 : 0;
}

function applyShift(points, shift) {
    if (!shift) return points;
    return points.map(p => [p[0] < 0 ? p[0] + shift : p[0], p[1]]);
}

function orientation(a, b, c) {
    const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(value) < 1e-12) return 0;
    return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
    return b[0] <= Math.max(a[0], c[0]) + 1e-12 && b[0] >= Math.min(a[0], c[0]) - 1e-12
        && b[1] <= Math.max(a[1], c[1]) + 1e-12 && b[1] >= Math.min(a[1], c[1]) - 1e-12;
}

export function segmentsIntersect(a1, a2, b1, b2) {
    const o1 = orientation(a1, a2, b1);
    const o2 = orientation(a1, a2, b2);
    const o3 = orientation(b1, b2, a1);
    const o4 = orientation(b1, b2, a2);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a1, b1, a2)) return true;
    if (o2 === 0 && onSegment(a1, b2, a2)) return true;
    if (o3 === 0 && onSegment(b1, a1, b2)) return true;
    if (o4 === 0 && onSegment(b1, a2, b2)) return true;
    return false;
}

// Shortest gap between a closed ring and a path (route). 0 means they touch or
// the route runs inside the polygon.
//
// The inside test alone is not enough: a route whose endpoints both sit outside
// the ash cloud can still cross it (Jakarta -> Denpasar against a cloud over
// east Java), and reporting a 60 NM "gap" for a flight that flies straight
// through the hazard is the worst possible answer. So ring edges are also tested
// against path segments.
export function polygonToPathDistanceNm(poly, path) {
    if (!Array.isArray(poly) || poly.length === 0 || !Array.isArray(path) || path.length === 0) return Infinity;
    for (const p of path) {
        if (pointInPolygon(p, poly)) return 0;
    }
    const ring = poly.length > 2 ? poly.concat([poly[0]]) : poly;
    const shift = planarShift(ring);
    const ringPlanar = applyShift(ring, shift);
    const pathPlanar = applyShift(path, shift);
    for (let i = 0; i < ringPlanar.length - 1; i++) {
        for (let j = 0; j < pathPlanar.length - 1; j++) {
            if (segmentsIntersect(ringPlanar[i], ringPlanar[i + 1], pathPlanar[j], pathPlanar[j + 1])) return 0;
        }
    }
    let best = distanceToPathNm(poly[0], path);
    for (let i = 1; i < poly.length; i++) {
        const d = distanceToPathNm(poly[i], path);
        if (d < best) best = d;
    }
    for (const p of path) {
        const d = distanceToPathNm(p, ring);
        if (d < best) best = d;
    }
    return best;
}

// GeoJSON polygon (closed ring) for map rendering and storage.
export function polygonGeoJson(points) {
    const ring = (points || []).filter(Boolean).map(p => [p[0], p[1]]);
    if (ring.length < 3) return null;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    return { type: 'Polygon', coordinates: [ring] };
}

