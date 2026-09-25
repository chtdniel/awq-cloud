const BMKG_URL = 'https://web-aviation.bmkg.go.id/web/taf.php';
const BOM_URL = 'https://www.bom.gov.au/aviation/php/process.php';
const ICAO_RE = /^[A-Z]{4}$/;
const CALLSIGN_RE = /^[A-Z0-9]{2,10}$/;

export function normalizeTafStation(value) {
    const station = String(value || '').trim().toUpperCase();
    return ICAO_RE.test(station) ? station : '';
}

export function isValidTafFlightRow(row) {
    if (!row || typeof row !== 'object') return false;
    const callsign = String(row.callsign ?? row.flight ?? row.FLIGHT ?? row.QZ ?? '').trim().toUpperCase();
    const dep = normalizeTafStation(row.dep ?? row.DEP);
    const dest = normalizeTafStation(row.dest ?? row.arr ?? row.ARR ?? row.DES);
    if (!callsign || /^["'\s]+$/.test(callsign)) return false;
    if (!CALLSIGN_RE.test(callsign)) return false;
    if (!dep || !dest) return false;
    return true;
}

export function tafStationsFromFlights(rows, { excludedStations = null, stationFields = ['dep', 'dest', 'alt'] } = {}) {
    const excludedSet = excludedStations
        ? new Set([...excludedStations].map(normalizeTafStation).filter(Boolean))
        : new Set();
    const out = [];
    const seen = new Set();
    (rows || []).forEach(row => {
        if (!isValidTafFlightRow(row)) return;
        stationFields.forEach(field => {
            const station = normalizeTafStation(row[field] ?? row[field.toUpperCase()]);
            if (!station) return;
            if (excludedSet.has(station)) return;
            if (seen.has(station)) return;
            seen.add(station);
            out.push(station);
        });
    });
    return out;
}

function textContent(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// TAF dates omit month/year. Resolve near the retrieval date, including month rollover.
function tafDate(day, hour, minute, reference) {
    return [-1, 0, 1].map(offset => new Date(Date.UTC(
        reference.getUTCFullYear(), reference.getUTCMonth() + offset, day, hour, minute
    ))).sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference))[0];
}

export function parseTafs(payload, stations, now = new Date()) {
    const wanted = new Set(stations);
    const latest = {};
    const cells = [...payload.matchAll(/<(td|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    const blocks = cells.length ? cells.map(m => textContent(m[2])) : payload.split(/(?=\bTAF\s)/);
    for (const block of blocks) {
        const raw = block.trim().split('=')[0].trim();
        const match = raw.match(/^TAF\s+(?:(AMD|COR)\s+)?([A-Z]{4})\s+(\d{2})(\d{2})(\d{2})Z\s+(?:(\d{2})(\d{2})\/(\d{2})(\d{2})\s+)?(.+)$/s);
        if (!match || !wanted.has(match[2])) continue;
        const [, amendment, station, day, hour, minute, startDay, startHour, endDay, endHour, forecast] = match;
        const issued = tafDate(+day, +hour, +minute, now);
        const unavailable = /\b(?:NIL|CNL)\b/.test(forecast);
        if (!startDay && !unavailable) continue;
        const end = endDay ? tafDate(+endDay, +endHour, 0, issued) : issued;
        if (+hour > 23 || +minute > 59 || +startHour > 24 || +endHour > 24 || +startDay < 1 || +endDay < 1 || +day < 1 || +day > 31 || +startDay > 31 || +endDay > 31) continue;
        if (issued > new Date(+now + 10 * 60000) || now - issued > 36 * 3600000) continue;
        const previous = latest[station];
        if (!previous || issued > previous.issued || (+issued === +previous.issued && amendment && !previous.amendment)) {
            latest[station] = { raw, issued, end, amendment, unavailable };
        }
    }
    return Object.fromEntries(Object.entries(latest)
        .filter(([, item]) => !item.unavailable && item.end > now)
        .map(([station, item]) => [station, item.raw + '=']));
}

export async function fetchLatestTafs(input, { fetchImpl = fetch, now = new Date() } = {}) {
    const stations = [...new Set(input.map(normalizeTafStation).filter(Boolean))];
    if (!stations.length) return {};
    async function request(url, options = {}) {
        const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`TAF source returned HTTP ${response.status}`);
        return response;
    }
    let tafMap = {};
    try {
        const response = await request(`https://aviationweather.gov/api/data/taf?ids=${stations.join(',')}&format=raw`);
        tafMap = parseTafs(await response.text(), stations, now);
    } catch (error) {
        console.warn('ADDS TAF unavailable:', error.message);
    }
    const missing = stations.filter(station => !tafMap[station]);
    const indonesia = missing.filter(station => /^W[AIR]/.test(station));
    const australia = missing.filter(station => /^Y/.test(station));
    const results = await Promise.allSettled([
        (async () => {
            if (!indonesia.length) return {};
            const page = await request(BMKG_URL);
            const html = await page.text();
            const token = html.match(/name="_token"\s+value="([^"]+)"/);
            if (!token) throw new Error('BMKG search token unavailable');
            const cookies = page.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
            const response = await request(BMKG_URL, {
                method: 'POST', headers: { Cookie: cookies },
                body: new URLSearchParams({
                    stasiun: indonesia.join(' '), _token: token[1],
                    from: new Date(now - 36 * 3600000).toISOString().slice(0, 16),
                    to: now.toISOString().slice(0, 16)
                })
            });
            return parseTafs(await response.text(), indonesia, now);
        })(),
        (async () => {
            if (!australia.length) return {};
            const response = await request(BOM_URL, {
                method: 'POST',
                body: new URLSearchParams({ keyword: australia.join(','), type: 'search', page: 'TAF' })
            });
            return parseTafs(await response.text(), australia, now);
        })()
    ]);
    for (const result of results) {
        if (result.status === 'fulfilled') Object.assign(tafMap, result.value);
        else console.warn('Regional TAF unavailable:', result.reason.message);
    }
    return tafMap;
}
