// WX WARNING data layer: tropical-cyclone and volcanic-ash products.
//
// WHY THESE SOURCES
// -----------------
// The advisory websites themselves refuse automated access:
//   * https://www.metoc.navy.mil/jtwc/jtwc.html  -> 403 (CloudFront) for any
//     non-browser client;
//   * https://www.bom.gov.au/aviation/volcanic-ash/darwin-va-advisory.shtml
//     -> 403 with an explicit "does not support web scraping" notice pointing at
//     BOM's FTP / paid Registered User service.
// So this module consumes the same products through their official international
// dissemination instead of scraping those pages:
//   * JTWC TC warnings   -> NOAA's public WMO/GTS raw feed (tgftp.nws.noaa.gov),
//     which relays the WTPN/WTIO/WTXS messages verbatim;
//   * VAAC advisories    -> the same raw feed's FV (volcanic ash) products, i.e.
//     the Darwin (ADRM), Tokyo (RJTD) and Wellington (NZKL) VAA texts;
//   * SIGMET polygons    -> aviationweather.gov's ISIGMET API, the aviation
//     hazard layer a crew actually receives.
// Attribution is kept per-product (BOM/JMA/MetNZ for the VAAs, JTWC/US Navy for
// the TC warnings, NOAA for the feed and the SIGMET API).
//
// COORDINATES
// -----------
// Every coordinate in this module is [lon, lat] decimal degrees, matching
// shared/geo.mjs and the FIR page. Leaflet flips to [lat, lon] at render time.
//
// Parsers are pure (text/JSON in, plain objects out) so the unit tests exercise
// exactly what the cron worker and the manual-paste path use.

import {
    distanceToPathNm,
    polygonToPathDistanceNm,
    polygonGeoJson
} from './geo.mjs';

export const TGTP_ROOT = 'https://tgftp.nws.noaa.gov/data/raw';
export const VAAC_INDEX_URL = `${TGTP_ROOT}/fv/`;
export const ISIGMET_URL = 'https://aviationweather.gov/api/data/isigmet?format=json';

// JTWC warning products for the basins in scope (WP / North Indian / South
// Hemisphere). Numbers 31..35 are the per-storm slots; absent slots answer 404,
// which simply means "no such storm right now".
export const JTWC_PRODUCTS = [
    'WTPN31', 'WTPN32', 'WTPN33', 'WTPN34', 'WTPN35',
    'WTIO31', 'WTIO32', 'WTIO33', 'WTIO34', 'WTIO35',
    'WTXS31', 'WTXS32', 'WTXS33', 'WTXS34', 'WTXS35'
];

// VAAC offices whose advisories belong to the Asia-Pacific scope.
export const VAAC_OFFICES = {
    adrm: 'BOM DARWIN',
    rjtd: 'JMA TOKYO',
    nzkl: 'METNZ WELLINGTON'
};

export const TC_MAX_AGE_HOURS = 12;
export const VA_MAX_AGE_HOURS = 24;
export const DEFAULT_BUFFER_NM = 50;

// Asia-Pacific working box: WP/IO/SH basins plus the Darwin/Tokyo/Wellington
// VAAC areas. The wrap segment covers Fiji/Samoa on the far side of the date
// line and stops at 160°W so Central-Pacific (Hawaii) storms stay out.
export const ASIA_PACIFIC_BOX = {
    minLat: -55, maxLat: 45, minLon: 60, maxLon: 180,
    wrapMinLon: -180, wrapMaxLon: -160
};

const QUADRANTS = { NORTHEAST: 'ne', SOUTHEAST: 'se', SOUTHWEST: 'sw', NORTHWEST: 'nw' };

/* ------------------------------------------------------------------ time --- */

function clampInt(value, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

// WMO headers carry DDhhmm only. Pick the month nearest to `now` (+/-1 month) so
// the result survives month rollover, then let the caller's freshness rule
// decide whether the product is still usable.
export function resolveDayHourMinute(digits, now = new Date()) {
    const text = String(digits || '').padStart(6, '0');
    const day = clampInt(text.slice(0, 2), 1, 31);
    const hour = clampInt(text.slice(2, 4), 0, 23);
    const minute = clampInt(text.slice(4, 6), 0, 59);
    if (day === null || hour === null || minute === null) return null;
    const candidates = [-1, 0, 1].map(offset => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day, hour, minute)));
    candidates.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()));
    return candidates[0];
}

// Full VAA timestamps: "20260920/1550Z".
export function parseVaaTimestamp(value) {
    const match = String(value || '').match(/(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})Z?/);
    if (!match) return null;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]));
    return Number.isNaN(date.getTime()) ? null : date;
}

// Day/time-only VAA field: "20/1530Z", resolved against a reference instant.
export function parseVaaDayTime(value, reference = new Date()) {
    const match = String(value || '').match(/\b(\d{2})\/(\d{2})(\d{2})Z?/);
    if (!match) return null;
    return resolveDayHourMinute(`${match[1]}${match[2]}${match[3]}`, reference);
}

export function ageHours(date, now = new Date()) {
    if (!date || Number.isNaN(new Date(date).getTime())) return Infinity;
    return (now.getTime() - new Date(date).getTime()) / 3600000;
}

function iso(date) {
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/* ------------------------------------------------------------ coordinates --- */

// ICAO VAA / SIGMET compact coordinates: S0806 E11255, N0219 W07624.
// Latitude digits are 2 (degrees), 4 (ddmm) or 6 (ddmmss); longitude 3, 5 or 7.
// Anything else is rejected rather than guessed: a silently mis-read ash polygon
// is worse than a dropped one.
export function parseCompactCoord(latDigits, latHemi, lonDigits, lonHemi) {
    const latText = String(latDigits);
    const lonText = String(lonDigits);
    const split = (text, degreeDigits, secondDigits) => {
        if (text.length === degreeDigits) return [parseInt(text, 10), 0, 0];
        const minStart = degreeDigits;
        const secStart = degreeDigits + 2;
        const deg = parseInt(text.slice(0, degreeDigits), 10);
        const min = parseInt(text.slice(minStart, minStart + 2), 10);
        const sec = text.length === secondDigits ? parseInt(text.slice(secStart, secStart + 2), 10) : 0;
        return [deg, min, sec];
    };
    if (![2, 4, 6].includes(latText.length) || ![3, 5, 7].includes(lonText.length)) return null;
    const [latDeg, latMin, latSec] = split(latText, 2, 6);
    const [lonDeg, lonMin, lonSec] = split(lonText, 3, 7);
    if (![latDeg, latMin, latSec, lonDeg, lonMin, lonSec].every(Number.isFinite)) return null;
    if (!/^[NS]$/i.test(latHemi) || !/^[EW]$/i.test(lonHemi)) return null;
    let lat = latDeg + latMin / 60 + latSec / 3600;
    if (/^S$/i.test(latHemi)) lat = -lat;
    let lon = lonDeg + lonMin / 60 + lonSec / 3600;
    if (/^W$/i.test(lonHemi)) lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return [Number(lon.toFixed(4)), Number(lat.toFixed(4))];
}

const COMPACT_COORD_RE = /([NS])\s?(\d{6}|\d{4}|\d{2})(?!\d)\s?([EW])\s?(\d{7}|\d{5}|\d{3})(?!\d)/g;

export function extractCompactCoords(value) {
    const out = [];
    const text = String(value || '');
    COMPACT_COORD_RE.lastIndex = 0;
    let match;
    while ((match = COMPACT_COORD_RE.exec(text)) !== null) {
        const coord = parseCompactCoord(match[2], match[1], match[4], match[3]);
        if (coord) out.push(coord);
        else out.push(null);
    }
    return out.filter(Boolean);
}

// Flight levels: "SFC/FL150", "FL180/FL250", bare "FL070".
export function parseFlightLevels(value) {
    const text = String(value || '');
    const both = text.match(/\bSFC\s*\/\s*FL(\d{2,3})\b/i);
    if (both) return { base: 0, top: parseInt(both[1], 10) * 100 };
    const range = text.match(/\bFL(\d{2,3})\s*\/\s*FL(\d{2,3})\b/i);
    if (range) return { base: parseInt(range[1], 10) * 100, top: parseInt(range[2], 10) * 100 };
    const single = text.match(/\bFL(\d{2,3})\b/i);
    if (single) return { base: null, top: parseInt(single[1], 10) * 100 };
    return { base: null, top: null };
}

function parseMovement(value) {
    const text = String(value || '');
    if (/\bSTNR\b/i.test(text)) return { dir: 'STNR', deg: null, kt: 0, text: 'STATIONARY' };
    const match = text.match(/\bMOV\s+([A-Z]{1,3})\s*(\d{1,3})?\s*KT/i);
    if (!match) return null;
    return { dir: match[1].toUpperCase(), deg: compassToDegrees(match[1]), kt: match[2] ? parseInt(match[2], 10) : null, text: match[0].toUpperCase() };
}

const COMPASS = {
    N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
    S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337
};

export function compassToDegrees(dir) {
    return COMPASS[String(dir || '').toUpperCase()] ?? null;
}

/* -------------------------------------------------------------- TC (JTWC) --- */

// "RADIUS OF 050 KT WINDS - 050 NM NORTHEAST QUADRANT" followed by the other
// three quadrants as continuation lines that carry no band header:
//                            050 NM SOUTHEAST QUADRANT
// So the band is scanned as a block: one header, then every "NNN NM <QUADRANT>"
// until the next band starts. Expecting the full "RADIUS OF ..." prefix on every
// line silently kept only the northeast quadrant.
export function parseWindRadii(block) {
    const text = String(block || '');
    const radii = {};
    const headers = [...text.matchAll(/RADIUS OF (\d{2,3}) KT WINDS/gi)];
    headers.forEach((header, index) => {
        const band = `kt${parseInt(header[1], 10)}`;
        const start = header.index + header[0].length;
        const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
        const body = text.slice(start, end);
        const quadrantRe = /(\d{2,3})\s*NM\s+(NORTHEAST|SOUTHEAST|SOUTHWEST|NORTHWEST)\s+QUADRANT/gi;
        let quadrant;
        while ((quadrant = quadrantRe.exec(body)) !== null) {
            radii[band] = radii[band] || {};
            radii[band][QUADRANTS[quadrant[2].toUpperCase()]] = parseInt(quadrant[1], 10);
        }
    });
    return radii;
}

export function maxRadiusNm(radii, band = 34) {
    const set = radii && radii[`kt${band}`];
    if (!set) return 0;
    const values = Object.values(set).filter(v => Number.isFinite(v));
    return values.length ? Math.max(...values) : 0;
}

function intensityClass(title) {
    const text = String(title || '').toUpperCase();
    if (/SUPER\s+TYPHOON/.test(text)) return 'SUPER TYPHOON';
    if (/TYPHOON/.test(text)) return 'TYPHOON';
    if (/TROPICAL\s+STORM/.test(text)) return 'TROPICAL STORM';
    if (/TROPICAL\s+DEPRESSION/.test(text)) return 'TROPICAL DEPRESSION';
    if (/TROPICAL\s+CYCLONE/.test(text)) return 'TROPICAL CYCLONE';
    if (/DEPRESSION/.test(text)) return 'DEPRESSION';
    return null;
}

function tcNotes(text) {
    const found = String(text || '').toUpperCase().match(/\b(BECOMING EXTRATROPICAL|EXTRATROPICAL|BECOMING SUBTROPICAL|SUBTROPICAL|DISSIPATING|DISSIPATED|REGENERATION|INTSF|WKN)\b/g);
    return found ? [...new Set(found)] : [];
}

export function parseJtwcWarningText(text, { now = new Date() } = {}) {
    const src = String(text || '').replace(/\r\n?/g, '\n').trim();
    const base = { ok: false, reason: null, warning: null, notes: [] };
    if (!src) return { ...base, reason: 'Empty text.' };

    const header = src.match(/^(W[TP][A-Z]{2}\d{2})\s+([A-Z]{4})\s+(\d{6})\b/);
    const wmoId = header ? header[1] : null;
    const station = header ? header[2] : null;
    const issued = header ? resolveDayHourMinute(header[3], now) : null;

    const subject = src.match(/SUBJ\/([^\n]+?)\/\//);
    let title = subject ? subject[1].replace(/\s+/g, ' ').trim() : null;
    if (!title) {
        const numbered = src.match(/^\s*\d+\.\s+([A-Z][A-Z0-9 ().\-]+WARNING NR\s+\d+)/m);
        title = numbered ? numbered[1].trim() : null;
    }
    const warningNr = (title && title.match(/WARNING NR\s+(\d+)/) || [])[1] || null;

    const basin = ((src.match(/(\d+)\s+ACTIVE TROPICAL CYCLONE IN\s+([A-Z]+)/) || [])[2] || null);
    const stormId = (title && title.match(/\b(\d{2}[A-Z])\b/) || [])[1] || null;
    const stormName = (title && title.match(/\(([^)]+)\)/) || [])[1] || null;

    const positionBlock = src.match(/WARNING POSITION:\s*\n\s*(\d{6})Z?\s*---\s*NEAR\s+([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/);
    let centerLat = positionBlock ? parseFloat(positionBlock[2]) * (positionBlock[3] === 'S' ? -1 : 1) : null;
    let centerLon = positionBlock ? parseFloat(positionBlock[4]) * (positionBlock[5] === 'W' ? -1 : 1) : null;
    const centerDtg = positionBlock ? resolveDayHourMinute(positionBlock[1], now) : null;

    const moveMatch = src.match(/MOVEMENT PAST SIX HOURS\s*-\s*(\d{1,3})\s*DEGREES?\s+AT\s+(\d{1,3})\s*KTS/i);
    const movement = moveMatch
        ? { deg: parseInt(moveMatch[1], 10), kt: parseInt(moveMatch[2], 10), dir: null, text: `${moveMatch[1]} DEG AT ${moveMatch[2]} KT` }
        : null;

    const presentSlice = src.slice(
        Math.max(0, src.indexOf('PRESENT WIND DISTRIBUTION:')),
        src.indexOf('FORECASTS:') > -1 ? src.indexOf('FORECASTS:') : src.length
    );
    const presentWind = presentSlice.match(/MAX SUSTAINED WINDS\s*-\s*(\d{1,3})\s*KT,\s*GUSTS\s+(\d{1,3})\s*KT/i);
    const presentRadii = parseWindRadii(presentSlice);
    const mslp = (src.match(/MINIMUM CENTRAL PRESSURE AT \d{6}Z IS (\d{3,4})\s*MB/i) || [])[1];
    const accuracyNm = (src.match(/POSITION ACCURATE TO WITHIN\s+(\d{3})\s+NM/i) || [])[1];

    const track = [];
    if (centerLat !== null && centerLon !== null) {
        track.push({
            tauHr: 0,
            validAt: iso(centerDtg),
            lat: centerLat,
            lon: centerLon,
            windKt: presentWind ? parseInt(presentWind[1], 10) : null,
            gustKt: presentWind ? parseInt(presentWind[2], 10) : null,
            radii: presentRadii,
            note: null
        });
    }

    const heads = [...src.matchAll(/(\d{1,3})\s+HRS?,?\s+VALID AT:\s*\n\s*(\d{6})Z?\s*---\s*([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/g)];
    const remarksIndex = src.indexOf('REMARKS:');
    heads.forEach((head, index) => {
        const start = head.index + head[0].length;
        const nextIndex = index + 1 < heads.length ? heads[index + 1].index : (remarksIndex > start ? remarksIndex : src.length);
        const body = src.slice(start, nextIndex);
        const wind = body.match(/MAX SUSTAINED WINDS\s*-\s*(\d{1,3})\s*KT,\s*GUSTS\s+(\d{1,3})\s*KT/i);
        track.push({
            tauHr: parseInt(head[1], 10),
            validAt: iso(resolveDayHourMinute(head[2], now)),
            lat: parseFloat(head[3]) * (head[4] === 'S' ? -1 : 1),
            lon: parseFloat(head[5]) * (head[6] === 'W' ? -1 : 1),
            windKt: wind ? parseInt(wind[1], 10) : null,
            gustKt: wind ? parseInt(wind[2], 10) : null,
            radii: parseWindRadii(body),
            note: tcNotes(body).join(', ') || null
        });
    });

    if (!track.length) {
        return {
            ...base,
            reason: 'No warning position or forecast track in this product (likely a continuation part of a split message).',
            notes: ['PARTIAL PRODUCT']
        };
    }
    if (!positionBlock) {
        centerLat = track[0].lat;
        centerLon = track[0].lon;
    }

    const warning = {
        source: 'JTWC',
        externalId: `${wmoId || 'JTWC'}:${warningNr || 'NA'}:${iso(issued) || 'NA'}`,
        kind: 'TC',
        title: title || `TROPICAL CYCLONE ${stormId || ''}`.trim(),
        basin,
        stormId,
        stormName,
        advisoryNr: warningNr,
        dtg: iso(issued || centerDtg),
        validFrom: iso(issued || centerDtg),
        validTo: null,
        centerLat,
        centerLon,
        polygons: [],
        track,
        volcano: null,
        intensity: {
            class: intensityClass(title),
            windKt: presentWind ? parseInt(presentWind[1], 10) : (track[0].windKt || null),
            gustKt: presentWind ? parseInt(presentWind[2], 10) : (track[0].gustKt || null),
            mslpMb: mslp ? parseInt(mslp, 10) : null,
            accuracyNm: accuracyNm ? parseInt(accuracyNm, 10) : null
        },
        movement,
        flBase: null,
        flTop: null,
        fir: station === 'PGTW' ? null : station,
        sourceUrl: 'https://www.metoc.navy.mil/jtwc/jtwc.html',
        rawText: src,
        parseNotes: [
            basin ? `BASIN ${basin}` : null,
            accuracyNm ? `POSITION ACCURACY ${accuracyNm} NM` : null
        ].filter(Boolean)
    };
    return { ok: true, reason: null, warning, notes: [] };
}

/* --------------------------------------------------------------- VA (VAA) --- */

const VAA_LABELS = [
    'VA ADVISORY', 'DTG', 'VAAC', 'VOLCANO', 'PSN', 'AREA', 'SOURCE ELEV',
    'ADVISORY NR', 'INFO SOURCE', 'ERUPTION DETAILS', 'EST VA DTG', 'EST VA CLD',
    'RMK', 'REMARK', 'REMARKS', 'NXT ADVISORY'
];

const FCST_LABEL_RE = /^FCST VA CLD\s*\+?\s*(\d{1,3})\s*HRS?$/;

// VAA fields wrap across lines, and the continuation is not reliably indented
// ("EST VA CLD: ... - S0755\nE11319 - ..." in real Darwin products). So a new
// field starts only at a known label; anything else appends to the field above.
export function unwrapVaaFields(text) {
    const fields = {};
    const order = [];
    let current = null;
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(rawLine => {
        const line = rawLine.replace(/\s+$/, '');
        if (!line.trim()) return;
        const match = line.match(/^([A-Z][A-Z0-9 +/]*?)\s*:\s*(.*)$/);
        let label = null;
        let value = '';
        if (match) {
            const candidate = match[1].trim().toUpperCase();
            if (VAA_LABELS.includes(candidate) || FCST_LABEL_RE.test(candidate)) {
                label = candidate;
                value = match[2];
            }
        }
        if (label) {
            current = label;
            fields[label] = fields[label] ? `${fields[label]} ${value}` : value;
            order.push(label);
            return;
        }
        if (current) fields[current] = `${fields[current]} ${line.trim()}`;
    });
    Object.keys(fields).forEach(key => {
        fields[key] = fields[key].replace(/\s+/g, ' ').replace(/=\s*$/, '').trim();
    });
    return { fields, order };
}

export function parseVaaText(text, { now = new Date() } = {}) {
    const src = String(text || '').replace(/\r\n?/g, '\n').trim();
    const base = { ok: false, reason: null, warning: null, notes: [] };
    if (!src) return { ...base, reason: 'Empty text.' };
    if (!/VA ADVISORY/i.test(src)) return { ...base, reason: 'Not a volcanic ash advisory (no "VA ADVISORY" line).' };

    const { fields } = unwrapVaaFields(src);
    const header = src.match(/^(FV[A-Z]{2}\d{2})\s+([A-Z]{4})\s+(\d{6})\b/);
    const wmoId = header ? header[1] : null;
    const office = header ? header[2].toUpperCase() : null;
    const issued = parseVaaTimestamp(fields['DTG']) || (header ? resolveDayHourMinute(header[3], now) : null);

    const volcanoField = fields['VOLCANO'] || '';
    const volcanoMatch = volcanoField.match(/^(.+?)\s+(\d{6})$/);
    const volcanoName = (volcanoMatch ? volcanoMatch[1] : volcanoField).trim() || null;
    const volcanoNumber = volcanoMatch ? volcanoMatch[2] : null;

    if (/^NOTICE\b/i.test(volcanoName || '')) {
        return { ...base, reason: 'NOTICE advisory (no volcano, no ash data).' };
    }

    // One coordinate parser for the whole product: reusing extractCompactCoords
    // keeps PSN and the ash polygons on the same digit-splitting rules.
    const volcanoPos = extractCompactCoords(fields['PSN'] || '')[0] || null;

    const polygons = [];
    const cloudLabels = ['EST VA CLD', ...Object.keys(fields).filter(key => FCST_LABEL_RE.test(key))];
    let movement = null;
    let flBase = null;
    let flTop = null;
    cloudLabels.forEach(label => {
        const value = fields[label];
        if (!value) return;
        const levels = parseFlightLevels(value);
        const coords = extractCompactCoords(value);
        const role = label === 'EST VA CLD' ? 'OBS' : `FCST+${FCST_LABEL_RE.exec(label)[1]}HR`;
        const validAt = label === 'EST VA CLD'
            ? (parseVaaDayTime(fields['EST VA DTG'], issued || now) || issued)
            : parseVaaDayTime(value.slice(0, 12), issued || now);
        if (levels.top !== null) flTop = flTop === null ? levels.top : Math.max(flTop, levels.top);
        if (levels.base !== null) flBase = flBase === null ? levels.base : Math.min(flBase, levels.base);
        if (!movement) movement = parseMovement(value);
        if (coords.length >= 3) {
            polygons.push({
                role,
                validAt: iso(validAt),
                flBase: levels.base,
                flTop: levels.top,
                coords
            });
        }
    });

    if (!polygons.length) {
        return {
            ...base,
            reason: 'Advisory carries no ash-cloud polygon (check EST/FCST VA CLD lines).',
            notes: ['NO POLYGON']
        };
    }

    const nextAdvisory = fields['NXT ADVISORY'] || '';
    const nextAt = parseVaaTimestamp(nextAdvisory);

    const warning = {
        source: 'VAAC',
        externalId: `${wmoId || 'VA'}:${office || 'UNKNOWN'}:${fields['ADVISORY NR'] || iso(issued) || 'NA'}`,
        kind: 'VA',
        title: `VA ${volcanoName || 'UNKNOWN VOLCANO'}${volcanoNumber ? ` ${volcanoNumber}` : ''}`,
        basin: null,
        stormId: null,
        stormName: null,
        advisoryNr: fields['ADVISORY NR'] || null,
        dtg: iso(issued),
        validFrom: iso(issued),
        validTo: iso(nextAt),
        centerLat: volcanoPos ? volcanoPos[1] : null,
        centerLon: volcanoPos ? volcanoPos[0] : null,
        polygons,
        track: [],
        volcano: {
            name: volcanoName,
            number: volcanoNumber,
            area: fields['AREA'] || null,
            elevation: fields['SOURCE ELEV'] || null,
            lat: volcanoPos ? volcanoPos[1] : null,
            lon: volcanoPos ? volcanoPos[0] : null
        },
        intensity: null,
        movement,
        flBase,
        flTop,
        fir: office,
        vaac: fields['VAAC'] || (office ? VAAC_OFFICES[office.toLowerCase()] || office : null),
        eruption: fields['ERUPTION DETAILS'] || null,
        sourceUrl: 'https://www.bom.gov.au/aviation/volcanic-ash/',
        rawText: src,
        parseNotes: [
            fields['INFO SOURCE'] ? `INFO ${fields['INFO SOURCE']}` : null,
            polygons.length > 1 ? `${polygons.length} POLYGONS (OBS + FCST)` : null
        ].filter(Boolean)
    };
    return { ok: true, reason: null, warning, notes: [] };
}

/* ------------------------------------------------------------- SIGMET ------ */

function isigmetPolygons(item) {
    const raw = item && item.coords;
    if (!Array.isArray(raw) || !raw.length) return [];
    const flatten = (list) => list
        .map(point => {
            if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
            if (point && typeof point === 'object') return [Number(point.lon), Number(point.lat)];
            return null;
        })
        .filter(point => point && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90);
    if (Array.isArray(raw[0])) {
        return raw.map(ring => ({ role: 'SIGMET', coords: flatten(ring) })).filter(poly => poly.coords.length >= 3);
    }
    const single = flatten(raw);
    return single.length >= 3 ? [{ role: 'SIGMET', coords: single }] : [];
}

export function parseIsigmetWarnings(payload, { now = new Date() } = {}) {
    let list = payload;
    if (typeof payload === 'string') {
        try {
            list = JSON.parse(payload);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    list.forEach(item => {
        if (!item || typeof item !== 'object') return;
        const hazard = String(item.hazard || '').toUpperCase();
        if (hazard !== 'VA' && hazard !== 'TC') return;
        const polygons = isigmetPolygons(item);
        const fir = String(item.firId || '').toUpperCase() || null;
        const name = String(item.qualifier || '').trim();
        const validFrom = Number.isFinite(item.validTimeFrom) ? new Date(item.validTimeFrom * 1000) : null;
        const validTo = Number.isFinite(item.validTimeTo) ? new Date(item.validTimeTo * 1000) : null;
        const center = polygons.length ? centroid(polygons[0].coords) : null;
        out.push({
            source: 'ISIGMET',
            externalId: `${fir || 'FIR'}:${item.seriesId || 'NA'}:${item.validTimeFrom || 'NA'}`,
            kind: hazard === 'VA' ? 'VA' : 'TC',
            title: hazard === 'VA'
                ? `VA SIGMET ${name || 'VOLCANIC ASH'}${fir ? ` (${fir})` : ''}`
                : `TC SIGMET ${name || 'TROPICAL CYCLONE'}${fir ? ` (${fir})` : ''}`,
            basin: null,
            stormId: hazard === 'TC' ? (name || null) : null,
            stormName: hazard === 'TC' ? (name || null) : null,
            advisoryNr: item.seriesId ? String(item.seriesId) : null,
            dtg: iso(item.receiptTime ? new Date(item.receiptTime) : validFrom),
            validFrom: iso(validFrom),
            validTo: iso(validTo),
            centerLat: center ? center[1] : null,
            centerLon: center ? center[0] : null,
            polygons,
            track: center ? [{ tauHr: 0, validAt: iso(validFrom), lat: center[1], lon: center[0], windKt: null, gustKt: null, radii: {}, note: null }] : [],
            volcano: hazard === 'VA' ? { name: name || null, number: null, area: null, elevation: null, lat: center ? center[1] : null, lon: center ? center[0] : null } : null,
            intensity: null,
            movement: {
                dir: item.dir && item.dir !== '-' ? String(item.dir).toUpperCase() : null,
                deg: compassToDegrees(item.dir),
                kt: Number.isFinite(Number(item.spd)) ? Number(item.spd) : null,
                text: item.dir && item.dir !== '-' ? `MOV ${String(item.dir).toUpperCase()}${item.spd ? ` ${item.spd}KT` : ''}` : null
            },
            flBase: Number.isFinite(item.base) ? item.base : null,
            flTop: Number.isFinite(item.top) ? item.top : null,
            fir,
            change: item.chng ? String(item.chng) : null,
            rawText: item.rawSigmet || null,
            sourceUrl: 'https://aviationweather.gov/sigmet',
            parseNotes: [`FIR ${item.firName || fir || 'UNKNOWN'}`, item.chng ? `CHANGE ${item.chng}` : null].filter(Boolean),
            sigmetHazard: hazard
        });
    });
    return out.filter(warning => warningInRegion(warning));
}

export function centroid(coords) {
    if (!Array.isArray(coords) || !coords.length) return null;
    const sum = coords.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
    return [sum[0] / coords.length, sum[1] / coords.length];
}

/* --------------------------------------------------------------- region ---- */

export function inAsiaPacific(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const box = ASIA_PACIFIC_BOX;
    if (lat < box.minLat || lat > box.maxLat) return false;
    if (lon >= box.minLon && lon <= box.maxLon) return true;
    return lon >= box.wrapMinLon && lon <= box.wrapMaxLon;
}

export function warningPoints(warning) {
    const points = [];
    (warning.polygons || []).forEach(poly => (poly.coords || []).forEach(point => points.push(point)));
    (warning.track || []).forEach(entry => {
        if (Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) points.push([entry.lon, entry.lat]);
    });
    if (Number.isFinite(warning.centerLat) && Number.isFinite(warning.centerLon)) points.push([warning.centerLon, warning.centerLat]);
    if (warning.volcano && Number.isFinite(warning.volcano.lat) && Number.isFinite(warning.volcano.lon)) points.push([warning.volcano.lon, warning.volcano.lat]);
    return points;
}

export function warningInRegion(warning) {
    return warningPoints(warning).some(point => inAsiaPacific(point[1], point[0]));
}

/* ---------------------------------------------------- product splitting ---- */

export function splitProducts(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const starts = [];
    lines.forEach((line, index) => {
        if (/^(?:FV|WV|WT|AB|WC|WS)[A-Z]{2}\d{2}\s+[A-Z]{4}\s+\d{6}\b/.test(line.trim())) starts.push(index);
    });
    if (!starts.length) {
        const body = lines.join('\n').trim();
        return body ? [{ header: null, text: body }] : [];
    }
    if (starts[0] !== 0) starts[0] = 0;
    const chunks = [];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
        const chunkLines = lines.slice(start, end);
        // Trailing adornments (---- separators, NNNN, $$) belong to no product.
        while (chunkLines.length && /^[\s\-=_*]+$/.test(chunkLines[chunkLines.length - 1])) chunkLines.pop();
        const body = chunkLines.join('\n').trim();
        if (!body) continue;
        const headerMatch = body.match(/^((?:FV|WV|WT|AB|WC|WS)[A-Z]{2}\d{2}\s+[A-Z]{4}\s+\d{6})/);
        chunks.push({ header: headerMatch ? headerMatch[1] : null, text: body });
    }
    return chunks;
}

export function detectProductKind(header, text) {
    const head = String(header || '').trim().toUpperCase();
    if (/^FV/.test(head)) return 'VA';
    if (/^W[TP]|^AB/.test(head)) return 'TC';
    const body = String(text || '');
    if (/VA ADVISORY/i.test(body)) return 'VA';
    if (/WARNING NR\s+\d+/i.test(body) && /TROPICAL (STORM|CYCLONE|DEPRESSION)|TYPHOON/i.test(body)) return 'TC';
    return null;
}

// One entry point for both ingestion flavours: the cron worker feeds it a single
// fetched product, the manual-paste RPC feeds it whatever the operator pasted.
export function parseProducts(text, { now = new Date() } = {}) {
    return splitProducts(text).map(chunk => {
        const kind = detectProductKind(chunk.header, chunk.text);
        let parsed;
        if (kind === 'TC') parsed = parseJtwcWarningText(chunk.text, { now });
        else if (kind === 'VA') parsed = parseVaaText(chunk.text, { now });
        else parsed = { ok: false, reason: 'Unrecognised product (expected a WMO header such as WTPN31 PGTW or FVAU01 ADRM, or a "VA ADVISORY" block).', warning: null, notes: [] };
        return {
            header: chunk.header,
            kind,
            ok: !!parsed.ok,
            reason: parsed.reason || null,
            notes: parsed.notes || [],
            warning: parsed.warning || null
        };
    });
}

/* ------------------------------------------------------------ freshness ---- */

// A product that is old is not the same as a product that is absent: the raw
// feed keeps the last message for every slot forever (WTIO31 was still serving a
// storm from months earlier when this was written). Auto-ingestion therefore
// drops anything older than the per-kind window, and anything dated more than two
// hours in the future (a mis-resolved month).
export function freshnessOf(warning, now = new Date(), maxAgeHours = TC_MAX_AGE_HOURS) {
    const issued = warning && warning.dtg ? new Date(warning.dtg) : null;
    if (!issued || Number.isNaN(issued.getTime())) return { ok: false, ageH: Infinity, reason: 'No issue time parsed.' };
    const ageH = ageHours(issued, now);
    if (ageH < -2) return { ok: false, ageH, reason: `Product dated ${Math.abs(ageH).toFixed(1)} h in the future.` };
    if (ageH > maxAgeHours) return { ok: false, ageH, reason: `Product is ${ageH.toFixed(1)} h old (limit ${maxAgeHours} h).` };
    return { ok: true, ageH, reason: null };
}

export function maxAgeFor(kind) {
    return kind === 'VA' ? VA_MAX_AGE_HOURS : TC_MAX_AGE_HOURS;
}

/* ------------------------------------------------------ route interaction --- */

export function warningRouteDistanceNm(warning, routeCoords) {
    if (!warning || !Array.isArray(routeCoords) || routeCoords.length < 2) return Infinity;
    let best = Infinity;
    (warning.polygons || []).forEach(poly => {
        if (poly && Array.isArray(poly.coords) && poly.coords.length >= 3) {
            const dist = polygonToPathDistanceNm(poly.coords, routeCoords);
            if (dist < best) best = dist;
        }
    });
    if (Array.isArray(warning.track) && warning.track.length) {
        warning.track.forEach(entry => {
            if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return;
            const dist = distanceToPathNm([entry.lon, entry.lat], routeCoords);
            const radius = maxRadiusNm(entry.radii, 34);
            const effective = Math.max(0, dist - radius);
            if (effective < best) best = effective;
        });
    }
    if (best === Infinity && Number.isFinite(warning.centerLat) && Number.isFinite(warning.centerLon)) {
        best = distanceToPathNm([warning.centerLon, warning.centerLat], routeCoords);
    }
    return best;
}

export function computeRouteHits(warnings, routeCoords, bufferNm = DEFAULT_BUFFER_NM) {
    const hits = {};
    (warnings || []).forEach(warning => {
        const key = warning.id !== undefined && warning.id !== null ? String(warning.id) : warning.externalId;
        if (!key) return;
        if (!Array.isArray(routeCoords) || routeCoords.length < 2) {
            hits[key] = { nm: null, hit: false, reason: 'NO ROUTE' };
            return;
        }
        const nm = warningRouteDistanceNm(warning, routeCoords);
        hits[key] = {
            nm: Number.isFinite(nm) ? Math.round(nm) : null,
            hit: Number.isFinite(nm) && nm <= bufferNm,
            reason: null
        };
    });
    return hits;
}

/* ------------------------------------------------------------ DB mapping --- */

// A short stable hash, only used to de-duplicate manual pastes that repeat the
// exact same product text (same advisory pasted twice must update, not clone).
// Line endings and surrounding blank lines are normalised first so a re-paste
// with extra spacing still maps onto the same row.
export function textFingerprint(text) {
    const value = String(text || '').replace(/\r\n?/g, '\n').trim();
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, '0')}${value.length.toString(16)}`;
}

export function manualExternalId(text) {
    return `MANUAL:${textFingerprint(text)}`;
}

export function toWarningRow(warning, { fetchedAt = new Date(), isManual = false, createdBy = null } = {}) {
    return {
        source: warning.source,
        external_id: warning.externalId,
        kind: warning.kind,
        title: warning.title || null,
        basin: warning.basin || null,
        fir: warning.fir || null,
        volcano_name: warning.volcano ? warning.volcano.name : null,
        volcano_number: warning.volcano ? warning.volcano.number : null,
        advisory_nr: warning.advisoryNr || null,
        dtg: warning.dtg || null,
        valid_from: warning.validFrom || null,
        valid_to: warning.validTo || null,
        center_lat: Number.isFinite(warning.centerLat) ? warning.centerLat : null,
        center_lon: Number.isFinite(warning.centerLon) ? warning.centerLon : null,
        fl_base: Number.isFinite(warning.flBase) ? warning.flBase : null,
        fl_top: Number.isFinite(warning.flTop) ? warning.flTop : null,
        move_dir: warning.movement ? warning.movement.dir : null,
        move_deg: warning.movement && Number.isFinite(warning.movement.deg) ? warning.movement.deg : null,
        move_kt: warning.movement && Number.isFinite(warning.movement.kt) ? warning.movement.kt : null,
        wind_kt: warning.intensity && Number.isFinite(warning.intensity.windKt) ? warning.intensity.windKt : null,
        gust_kt: warning.intensity && Number.isFinite(warning.intensity.gustKt) ? warning.intensity.gustKt : null,
        mslp_mb: warning.intensity && Number.isFinite(warning.intensity.mslpMb) ? warning.intensity.mslpMb : null,
        polygons_json: JSON.stringify(warning.polygons || []),
        track_json: JSON.stringify(warning.track || []),
        raw_text: warning.rawText || null,
        source_url: warning.sourceUrl || null,
        parse_notes: JSON.stringify(warning.parseNotes || []),
        fetched_at: fetchedAt instanceof Date ? fetchedAt.toISOString() : String(fetchedAt),
        is_manual: isManual ? 1 : 0,
        created_by: createdBy
    };
}

function safeJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed === null ? fallback : parsed;
    } catch {
        return fallback;
    }
}

export function fromWarningRow(row) {
    if (!row) return null;
    const polygons = safeJson(row.polygons_json, []);
    const volcanoName = row.volcano_name || null;
    return {
        id: row.id,
        source: row.source,
        sourceLabel: row.source === 'MANUAL' ? 'MANUAL' : row.source,
        externalId: row.external_id,
        kind: row.kind,
        title: row.title || '',
        basin: row.basin || null,
        fir: row.fir || null,
        advisoryNr: row.advisory_nr || null,
        dtg: row.dtg || null,
        validFrom: row.valid_from || null,
        validTo: row.valid_to || null,
        centerLat: row.center_lat === null || row.center_lat === undefined ? null : Number(row.center_lat),
        centerLon: row.center_lon === null || row.center_lon === undefined ? null : Number(row.center_lon),
        flBase: row.fl_base === null || row.fl_base === undefined ? null : Number(row.fl_base),
        flTop: row.fl_top === null || row.fl_top === undefined ? null : Number(row.fl_top),
        movement: (row.move_dir || row.move_deg !== null || row.move_kt !== null) ? {
            dir: row.move_dir || null,
            deg: row.move_deg === null || row.move_deg === undefined ? null : Number(row.move_deg),
            kt: row.move_kt === null || row.move_kt === undefined ? null : Number(row.move_kt),
            text: row.move_dir ? `MOV ${row.move_dir}${row.move_kt ? ` ${row.move_kt}KT` : ''}` : null
        } : null,
        intensity: (row.wind_kt !== null || row.gust_kt !== null || row.mslp_mb !== null) ? {
            windKt: row.wind_kt === null || row.wind_kt === undefined ? null : Number(row.wind_kt),
            gustKt: row.gust_kt === null || row.gust_kt === undefined ? null : Number(row.gust_kt),
            mslpMb: row.mslp_mb === null || row.mslp_mb === undefined ? null : Number(row.mslp_mb),
            class: null
        } : null,
        polygons,
        track: safeJson(row.track_json, []),
        volcano: volcanoName || row.volcano_number ? {
            name: volcanoName,
            number: row.volcano_number || null,
            lat: row.center_lat === null || row.center_lat === undefined ? null : Number(row.center_lat),
            lon: row.center_lon === null || row.center_lon === undefined ? null : Number(row.center_lon)
        } : null,
        rawText: row.raw_text || null,
        sourceUrl: row.source_url || null,
        parseNotes: safeJson(row.parse_notes, []),
        fetchedAt: row.fetched_at || null,
        isManual: Number(row.is_manual) === 1,
        createdBy: row.created_by || null,
        createdAt: row.created_at || null,
        // GeoJSON ready for the map, so the client never re-derives the ring.
        geojson: polygons.map(poly => ({
            role: poly.role,
            flBase: poly.flBase ?? null,
            flTop: poly.flTop ?? null,
            validAt: poly.validAt || null,
            geometry: polygonGeoJson(poly.coords || [])
        })).filter(entry => entry.geometry)
    };
}

/* --------------------------------------------------------------- network --- */

async function getText(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            'User-Agent': 'AWQ-Cloud-Briefing/1.0 (flight dispatch briefing tool)',
            Accept: 'text/plain, application/json, text/html;q=0.9, */*;q=0.8'
        }
    });
    if (response.status === 404) return { ok: false, status: 404, text: null };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, status: response.status, text: await response.text() };
}

export function vaacListingCandidates(html) {
    const out = [];
    const re = /href="([a-z]{4}\d{2}\.([a-z]{4})\.\.txt)"/gi;
    let match;
    while ((match = re.exec(String(html || ''))) !== null) {
        const office = match[2].toLowerCase();
        if (!VAAC_OFFICES[office]) continue;
        if (out.some(entry => entry.file === match[1])) continue;
        out.push({ file: match[1], office });
    }
    return out;
}

// Fetch every source, never throw: a dead source must degrade to a health flag,
// not blank the page (the map keeps whatever the other two layers returned).
export async function fetchWxWarnings({ fetchImpl = fetch, now = new Date(), timeoutMs = 15000, log = console } = {}) {
    const warnings = [];
    const sources = [];
    const problems = [];

    const record = (id, status, extra = {}) => {
        sources.push({ id, status, ...extra });
    };

    // 1. JTWC TC warnings from the NOAA WMO raw feed.
    try {
        const results = await Promise.all(JTWC_PRODUCTS.map(async product => {
            const url = `${TGTP_ROOT}/wt/${product.toLowerCase()}.pgtw..txt`;
            try {
                const response = await getText(url, { fetchImpl, timeoutMs });
                if (!response.ok) return null;
                return { product, url, text: response.text };
            } catch (error) {
                problems.push(`${product}: ${error.message}`);
                return null;
            }
        }));
        let accepted = 0;
        let stale = 0;
        results.filter(Boolean).forEach(entry => {
            const parsed = parseJtwcWarningText(entry.text, { now });
            if (!parsed.ok || !parsed.warning) {
                problems.push(`${entry.product}: ${parsed.reason}`);
                return;
            }
            const fresh = freshnessOf(parsed.warning, now, TC_MAX_AGE_HOURS);
            if (!fresh.ok) {
                stale++;
                return;
            }
            if (!warningInRegion(parsed.warning)) return;
            parsed.warning.sourceUrl = 'https://www.metoc.navy.mil/jtwc/jtwc.html';
            parsed.warning.feedUrl = entry.url;
            warnings.push(parsed.warning);
            accepted++;
        });
        record('jtwc', 'ok', { accepted, stale, examined: results.filter(Boolean).length });
    } catch (error) {
        record('jtwc', 'error', { error: error.message });
    }

    // 2. VAAC advisories (Darwin / Tokyo / Wellington) from the same feed.
    try {
        const listing = await getText(VAAC_INDEX_URL, { fetchImpl, timeoutMs });
        if (!listing.ok) throw new Error(`listing HTTP ${listing.status}`);
        const candidates = vaacListingCandidates(listing.text);
        const results = await Promise.all(candidates.map(async candidate => {
            const url = `${VAAC_INDEX_URL}${candidate.file}`;
            try {
                const response = await getText(url, { fetchImpl, timeoutMs });
                if (!response.ok) return null;
                return { ...candidate, url, text: response.text };
            } catch (error) {
                problems.push(`${candidate.file}: ${error.message}`);
                return null;
            }
        }));
        let accepted = 0;
        let stale = 0;
        const byOffice = {};
        results.filter(Boolean).forEach(entry => {
            const parsed = parseVaaText(entry.text, { now });
            if (!parsed.ok || !parsed.warning) {
                problems.push(`${entry.file}: ${parsed.reason}`);
                return;
            }
            const fresh = freshnessOf(parsed.warning, now, VA_MAX_AGE_HOURS);
            if (!fresh.ok) {
                stale++;
                return;
            }
            if (!warningInRegion(parsed.warning)) return;
            parsed.warning.vaacOffice = VAAC_OFFICES[entry.office];
            parsed.warning.feedUrl = entry.url;
            parsed.warning.sourceUrl = entry.office === 'adrm'
                ? 'https://www.bom.gov.au/aviation/volcanic-ash/'
                : (entry.office === 'rjtd' ? 'https://www.data.jma.go.jp/vaac/data/vaac_list.html' : 'https://www.metservice.com/');
            warnings.push(parsed.warning);
            byOffice[entry.office] = (byOffice[entry.office] || 0) + 1;
            accepted++;
        });
        record('vaac', 'ok', { accepted, stale, listed: candidates.length, byOffice });
    } catch (error) {
        record('vaac', 'error', { error: error.message });
    }

    // 3. SIGMET polygons (aviation hazard layer).
    try {
        const response = await getText(ISIGMET_URL, { fetchImpl, timeoutMs });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseIsigmetWarnings(response.text, { now });
        warnings.push(...parsed);
        record('isigmet', 'ok', { accepted: parsed.length });
    } catch (error) {
        record('isigmet', 'error', { error: error.message });
    }

    const deduped = new Map();
    warnings.forEach(warning => {
        const key = `${warning.source}:${warning.externalId}`;
        if (!deduped.has(key)) deduped.set(key, warning);
    });

    return {
        warnings: [...deduped.values()],
        sources,
        problems: problems.slice(0, 40),
        fetchedAt: now.toISOString()
    };
}

// Sources shown on the page; keeps the UI honest about provenance.
export const SOURCE_LABELS = {
    JTWC: 'JTWC (US Navy) via NOAA WMO feed',
    VAAC: 'VAAC advisory (BOM Darwin / JMA Tokyo / MetNZ) via NOAA WMO feed',
    ISIGMET: 'SIGMET (aviationweather.gov)',
    MANUAL: 'Manual operator input'
};

/* ------------------------------------------------------- storage statement -- */

// One INSERT ... ON CONFLICT for both writers (the cron ingest and the operator
// save). Keeping the column list here means a schema change cannot leave the two
// paths disagreeing about what a row is.
export const WX_WARNING_COLUMNS = [
    'source', 'external_id', 'kind', 'title', 'basin', 'fir', 'volcano_name', 'volcano_number',
    'advisory_nr', 'dtg', 'valid_from', 'valid_to', 'center_lat', 'center_lon', 'fl_base', 'fl_top',
    'move_dir', 'move_deg', 'move_kt', 'wind_kt', 'gust_kt', 'mslp_mb', 'polygons_json', 'track_json',
    'raw_text', 'source_url', 'parse_notes', 'fetched_at', 'is_manual', 'created_by'
];

export const WX_WARNING_UPSERT = `INSERT INTO wx_warnings (${WX_WARNING_COLUMNS.join(', ')})
    VALUES (${WX_WARNING_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(source, external_id) DO UPDATE SET
        kind=excluded.kind, title=excluded.title, basin=excluded.basin, fir=excluded.fir,
        volcano_name=excluded.volcano_name, volcano_number=excluded.volcano_number,
        advisory_nr=excluded.advisory_nr, dtg=excluded.dtg, valid_from=excluded.valid_from,
        valid_to=excluded.valid_to, center_lat=excluded.center_lat, center_lon=excluded.center_lon,
        fl_base=excluded.fl_base, fl_top=excluded.fl_top, move_dir=excluded.move_dir,
        move_deg=excluded.move_deg, move_kt=excluded.move_kt, wind_kt=excluded.wind_kt,
        gust_kt=excluded.gust_kt, mslp_mb=excluded.mslp_mb, polygons_json=excluded.polygons_json,
        track_json=excluded.track_json, raw_text=excluded.raw_text, source_url=excluded.source_url,
        parse_notes=excluded.parse_notes, fetched_at=excluded.fetched_at,
        is_manual=excluded.is_manual, created_by=excluded.created_by`;

export function warningBindValues(row) {
    return WX_WARNING_COLUMNS.map(column => (row && row[column] !== undefined ? row[column] : null));
}

// Manual rows are re-labelled at save time: the kind (TC/VA) still comes from the
// product, but the source becomes MANUAL so the page badges it as operator input
// and the ingest cycle's cleanup can never delete it.
export function toManualWarningRow(warning, { fetchedAt = new Date(), createdBy = null } = {}) {
    const productText = warning.rawText || '';
    const row = toWarningRow(warning, { fetchedAt, isManual: true, createdBy });
    row.source = 'MANUAL';
    row.external_id = manualExternalId(productText);
    return row;
}

// The client shape for a product that is not stored yet (manual-input preview).
export function asPreviewWarning(warning, { fetchedAt = new Date() } = {}) {
    if (!warning) return null;
    return fromWarningRow({ ...toWarningRow(warning, { fetchedAt }), id: null });
}
