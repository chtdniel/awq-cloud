// Route geometry for the WX WARNING map.
//
// The FIR page resolves a flight's route in the browser (src/FIR_Ui.html,
// getRouteCoords) and that copy stays untouched. This module is the server-side
// twin so the WX WARNING page can ask one RPC for "warnings + route + which
// warnings cut the route" without shipping a second geometry implementation to
// the browser. The resolution rules mirror the FIR client deliberately:
//   * ACTIVE_ROUTE_ID wins, otherwise the DEP/ARR pair picks the route;
//   * the waypoint sequence is walked in order and unknown tokens are ignored;
//   * duplicate consecutive coordinates collapse (the sequence usually repeats
//     the departure field).
//
// Coordinates are [lon, lat] decimal degrees.

const AIRPORT_FALLBACK = {
    WIII: [106.6558, -6.1256], WARR: [112.7875, -7.3797], WADD: [115.1668, -8.7482], WATO: [122.9625, -8.3444],
    WATE: [122.2372, -8.6389], WATU: [120.3017, -9.6681], WADT: [118.6872, -8.5475], WAKR: [140.4186, -8.5203],
    WAHQ: [109.4042, -0.1506], WAAA: [119.5540, -5.0616], WAPG: [140.5160, -2.5769], WALL: [116.8944, -1.2683],
    WAMM: [124.9264, 1.5494], WAPN: [132.8156, -2.9903], WIDO: [104.5319, 0.9236], WIDD: [104.1189, 1.1211],
    YPPH: [115.9672, -31.9403], VTSP: [98.3169, 8.1132], WSSS: [103.9915, 1.3644], WMKK: [101.7099, 2.7456],
    WBSB: [114.9283, 4.9442], VTBS: [100.7501, 13.6900], YSSY: [151.1753, -33.9461], YMML: [144.8433, -37.6733],
    YBBN: [153.1172, -27.3842], WMKP: [100.2772, 5.2972], WBKK: [116.0510, 5.9372], RPMD: [125.6460, 7.1255],
    RPLL: [121.0196, 14.5086], VVTS: [106.6520, 10.8188], VTBD: [100.6072, 13.9126], WIPP: [104.7003, -2.8983],
    WIBB: [101.4433, 1.3906], WIOO: [109.4039, -0.1507]
};

// "S 08 06.0" / "N 02 19.5" style produced by the WAYPOINT editor.
export function parseDms(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    const match = text.match(/^([NSEW])\s*(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)/i);
    if (!match) return null;
    let dec = parseInt(match[2], 10) + parseFloat(match[3]) / 60;
    if (/^[SW]$/i.test(match[1])) dec = -dec;
    return Number.isFinite(dec) ? dec : null;
}

// Inline coordinates embedded in a route string, e.g. 0540N10630E or 05N106E.
export function parseInlineCoord(token) {
    if (!token) return null;
    const compact = String(token).trim().toUpperCase();
    const full = compact.match(/^(\d{2,3})(\d{2})([NS])(\d{2,3})(\d{2})([EW])$/);
    if (full) {
        let lat = parseInt(full[1], 10) + parseInt(full[2], 10) / 60;
        if (full[3] === 'S') lat = -lat;
        let lon = parseInt(full[4], 10) + parseInt(full[5], 10) / 60;
        if (full[6] === 'W') lon = -lon;
        return [lon, lat];
    }
    const coarse = compact.match(/^(\d{1,2})([NS])(\d{1,3})([EW])$/);
    if (coarse) {
        let lat = parseInt(coarse[1], 10);
        if (coarse[2] === 'S') lat = -lat;
        let lon = parseInt(coarse[3], 10);
        if (coarse[4] === 'W') lon = -lon;
        return [lon, lat];
    }
    return null;
}

function upper(value) {
    return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}

function samePoint(a, b) {
    return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

// Rows are the raw D1 shapes: routes{id,dep_airport,arr_airport,waypoint_seq,route_string}
// and latlong{route_id,waypoint,latitude,longitude}.
export function resolveRouteForFlight(flight, { routes = [], latlong = [] } = {}) {
    const dep = upper(flight && (flight.dep || flight.DEP));
    const arr = upper(flight && (flight.dest || flight.ARR || flight.DES));
    const routeId = upper(flight && (flight.active_route_id || flight.ACTIVE_ROUTE_ID || flight['ROUTE ID']));

    let route = null;
    if (routeId) route = routes.find(r => upper(r.id || r.ID) === routeId) || null;
    if (!route && dep && arr) {
        route = routes.find(r => upper(r.dep_airport || r.DEP_AIRPORT) === dep && upper(r.arr_airport || r.ARR_AIRPORT) === arr) || null;
    }

    const result = {
        routeId: route ? String(route.id || route.ID || '') : '',
        dep,
        arr,
        coords: [],
        waypoints: [],
        missing: []
    };
    if (!route) return result;

    const rid = upper(route.id || route.ID);
    const waypointMap = {};
    latlong.forEach(row => {
        if (upper(row.route_id || row.ID) !== rid) return;
        const name = upper(row.waypoint || row.Waypoint);
        const lat = parseDms(row.latitude || row.Latitude);
        const lon = parseDms(row.longitude || row.Longitude);
        if (!name || lat === null || lon === null) return;
        waypointMap[name] = [lon, lat];
    });

    const pushed = [];
    const pushUnique = (name, coord) => {
        if (!coord) return;
        const last = pushed[pushed.length - 1];
        if (last && samePoint(last.coord, coord)) return;
        pushed.push({ name: name || '', coord });
    };

    const depCoord = waypointMap[dep] || AIRPORT_FALLBACK[dep] || null;
    pushUnique(dep, depCoord);

    const sequence = String(route.waypoint_seq || route.WAYPOINT_SEQ || route.route_string || route.ROUTE_STRING || '');
    const tokens = sequence.split(/\s+/).map(t => t.trim().toUpperCase()).filter(Boolean);
    tokens.forEach(token => {
        const coord = waypointMap[token] || AIRPORT_FALLBACK[token] || null;
        if (coord) {
            pushUnique(token, coord);
            return;
        }
        const inline = parseInlineCoord(token);
        if (inline) {
            pushUnique(token, inline);
            return;
        }
        if (token !== dep) result.missing.push(token);
    });

    const arrCoord = waypointMap[arr] || AIRPORT_FALLBACK[arr] || null;
    pushUnique(arr, arrCoord);

    result.coords = pushed.map(p => p.coord);
    result.waypoints = pushed.map(p => ({ name: p.name, lat: p.coord[1], lon: p.coord[0] }));
    result.missing = [...new Set(result.missing)];
    return result;
}

export function airportFallbackCoord(icao) {
    return AIRPORT_FALLBACK[upper(icao)] || null;
}
