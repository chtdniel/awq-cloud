/**
 * FIR_Parity_Backend.gs
 * ---------------------------------------------------------------------------
 * FIR Dispatch Control backend — ported from the standalone "FIR DISPATCH
 * CONTROL" app (FIR_ENGINE_SOURCE_RECOVERY.txt) so the dashboard's FIR view
 * reaches feature parity (map + route geometry + NOTAM inspector).
 *
 * Conventions:
 *   - Reuses the project's shared getActiveSS() (Code.gs). Do NOT redefine it.
 *   - Write/destructive endpoints call requireAuthorized() (Code.gs).
 *   - Every function returns { ...data } on success or { error } on failure so
 *     the UI can surface safe messages without stack traces.
 *   - No global function name collides with the existing dashboard modules
 *     (verified against Code.gs, Flight_Backend.gs, Notam_Backend.gs, etc.).
 * ---------------------------------------------------------------------------
 * @expose
 */
function firClearAppCache() {
  try {
    const cache = CacheService.getUserCache();
    [FIR_CACHE_KEY_FLIGHTS_ROUTES, FIR_CACHE_KEY_ANALYZE_DATASET,
     FIR_CACHE_KEY_ACTIVE_NOTAMS_V1, FIR_CACHE_KEY_ACTIVE_NOTAMS_V2, FIR_CACHE_KEY_ACTIVE_NOTAMS_V3,
     FIR_CACHE_KEY_AIRPORT_FIR, FIR_CACHE_KEY_ROUTE_POLYLINE]
       .forEach(key => cache.remove(key));
  } catch (e) {
    console.warn('firClearAppCache error: ' + e.message);
  }
}

/**
 * Invalidate only the caches that depend on NOTAM data. Used after editing a
 * NOTAM so the flights/routes spreadsheet cache (which is unaffected by NOTAM
 * edits) is NOT cleared — avoiding an expensive re-read of those sheets.
 * @expose
 */
function firClearNotamDependentCache() {
  try {
    const cache = CacheService.getUserCache();
    [FIR_CACHE_KEY_ANALYZE_DATASET,
     FIR_CACHE_KEY_ACTIVE_NOTAMS_V1, FIR_CACHE_KEY_ACTIVE_NOTAMS_V2, FIR_CACHE_KEY_ACTIVE_NOTAMS_V3]
       .forEach(key => cache.remove(key));
  } catch (e) {
    console.warn('firClearNotamDependentCache error: ' + e.message);
  }
}

function firGetCachedData(cacheKey, fetchFn) {
  const cache = CacheService.getUserCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }
  const result = fetchFn();
  if (result && !result.error) {
    const hasData = ['flights', 'notams', 'routes', 'latlong']
      .some(k => Array.isArray(result[k]) && result[k].length > 0);
    if (hasData) {
      try { cache.put(cacheKey, JSON.stringify(result), CACHE_TTL_FIR_PARITY); } catch (e) {}
    }
  }
  return result;
}

/**
 * Read all sheets of interest in one pass.
 * Returns { flights, routes, latlong, debug }.
 * @expose
 */
function firGetSpreadsheetData(useCache) {
  if (useCache === undefined) useCache = true;
  if (!useCache) firClearAppCache();
  const fetchFn = () => {
    try {
      const ss = getActiveSS();
      const allSheets = ss.getSheets();
      const allSheetNames = allSheets.map(s => s.getName());

      const findSheet = (name) => {
        let sheet = ss.getSheetByName(name);
        if (!sheet) sheet = allSheets.find(s => s.getName().toLowerCase() === name.toLowerCase()) || null;
        if (!sheet && name.toUpperCase() === 'FLT INFO') {
          // Cache the resolved FLT INFO sheet name so we don't re-scan every
          // sheet on each cache-miss. The sheet name rarely changes.
          const props = PropertiesService.getScriptProperties();
          const cachedName = props.getProperty(PROP_FIR_FLT_INFO_SHEET);
          if (cachedName) {
            sheet = ss.getSheetByName(cachedName) || null;
          }
          if (!sheet) {
            for (const s of allSheets) {
              // Guard: don't pick the wrong Route/LATLONG sheet (header contains DEP/ID)
              const sn = s.getName().toUpperCase();
              if (sn === 'ROUTE' || sn === 'LATLONG') continue;
              const peek = s.getRange(1, 1, Math.min(3, s.getLastRow()), s.getLastColumn()).getValues();
              const rowStr = peek.map(r => r.join('|')).join('|').toUpperCase();
              if (rowStr.includes('QZ') || rowStr.includes('DEP') || rowStr.includes('DES') || rowStr.includes('FLIGHT')) {
                sheet = s; break;
              }
            }
            if (sheet) {
              try { props.setProperty(PROP_FIR_FLT_INFO_SHEET, sheet.getName()); } catch (e) {}
            }
          }
          if (!sheet && allSheets.length > 0) sheet = allSheets[0];
        }
        return sheet;
      };

      const fltSheet = findSheet('FLT INFO');
      const routeSheet = findSheet('Route');
      const latlongSheet = findSheet('LATLONG');

      // Read only the used rows/columns instead of the whole sheet range, so
      // trailing empty rows do not get fetched from the spreadsheet.
      const readUsed = (sheet) => {
        if (!sheet) return null;
        const lastRow = sheet.getLastRow();
        const lastCol = sheet.getLastColumn();
        if (lastRow < 1 || lastCol < 1) return null;
        return sheet.getRange(1, 1, lastRow, lastCol).getValues();
      };

      const flightValues = fltSheet && fltSheet.getLastRow() > 1 ? readUsed(fltSheet) : null;
      const routeValues = routeSheet && routeSheet.getLastRow() > 1 ? readUsed(routeSheet) : null;
      const latlongValues = latlongSheet && latlongSheet.getLastRow() > 1 ? readUsed(latlongSheet) : null;

      const rawFlights = (flightValues && flightValues.length > 1) ? firProcessSheetData(flightValues) : [];
      const rawRoutes = (routeValues && routeValues.length > 1) ? firProcessSheetData(routeValues) : [];
      const rawLatLong = (latlongValues && latlongValues.length > 1) ? firProcessSheetData(latlongValues) : [];

      return {
        flights: rawFlights,
        routes: rawRoutes,
        latlong: rawLatLong,
        debug: {
          flightCount: rawFlights.length,
          routeCount: rawRoutes.length,
          latlongCount: rawLatLong.length,
          sheetNames: allSheetNames,
          targetSheets: ['FLT INFO', 'Route', 'LATLONG'],
          connectedSS: ss.getName(),
          spreadsheetId: ss.getId(),
          timestamp: new Date().toLocaleTimeString(),
          status: 'Success',
          rawPreview: rawFlights.length === 0 ? (flightValues ? flightValues.slice(0, 3) : 'Sheet empty') : null
        }
      };
    } catch (e) {
      console.error('firGetSpreadsheetData error: ' + e.message);
      return { error: e.message };
    }
  };
  return useCache ? firGetCachedData(FIR_CACHE_KEY_FLIGHTS_ROUTES, fetchFn) : fetchFn();
}

function firIsActiveFlightRecord(flight) {
  if (!flight) return false;
  const truthy = (value) => {
    const normalized = String(value ?? '').trim().toUpperCase();
    return value === true || value === 1 || normalized === 'TRUE' || normalized === 'YES' || normalized === 'Y';
  };
  return !truthy(flight.HIDDEN) && !truthy(flight.DELETED);
}

function getActiveFlightList(useCache) {
  try {
    const full = firGetSpreadsheetData(useCache !== false);
    if (!full) return { error: "firGetSpreadsheetData returned null/undefined" };
    if (full.error) return { error: String(full.error) };
    const flights = (full.flights || []).filter(firIsActiveFlightRecord).map(function(f){
      function s(v){ if(v==null) return ""; if(v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString(); return String(v); }
      return { _rowId: f._rowId, QZ: s(f.QZ), DOF: s(f.DOF), DEP: s(f.DEP), DES: s(f.DES), STD: s(f.STD), STA: s(f.STA), REG: s(f.REG) };
    });
    return { flights: flights };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

function getFlightSummary(useCache) {
  try {
    return getActiveFlightList(useCache);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

function getSelectedFlightsData(rowIds, useCache) {
  try {
    const ids = (Array.isArray(rowIds) ? rowIds : []).map(Number).filter(function(n){ return !isNaN(n); });
    const full = firGetSpreadsheetData(useCache !== false);
    if (!full) return { error: "firGetSpreadsheetData returned null" };
    if (full.error) return { error: String(full.error) };
    const flights = ids.length ? full.flights.filter(function(f){ return ids.indexOf(Number(f._rowId)) !== -1 && firIsActiveFlightRecord(f); }) : [];
    // Serialize dates to strings for google.script.run
    function ser(v){ if(v==null) return ""; if(v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString(); return v; }
    function serFlight(f){
      const o={}; for(var k in f) o[k]=ser(f[k]); return o;
    }
    return firSerializeForClient({ flights: flights.map(serFlight), routes: full.routes || [], latlong: full.latlong || [], debug: full.debug || null });
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

function firProcessNotamSheet(values) {
  try {
    if (!values || values.length < 2) return [];
    let headerIndex = -1;
    for (let i = 0; i < Math.min(values.length, 20); i++) {
      const cells = values[i].map(c => String(c == null ? '' : c).trim().toUpperCase());
      const joined = cells.join('|');
      const hasExactNotamCol = cells.some(c => c === 'NOTAM #');
      const hasLocationCol = cells.some(c => c === 'LOCATION');
      const hasTextCol = cells.some(c => c === 'NOTAM TEXT');
      if (hasExactNotamCol || ((hasLocationCol || hasTextCol) && joined.includes('NOTAM'))) {
        headerIndex = i;
        break;
      }
    }
    if (headerIndex === -1) {
      // Last resort: reuse generic detection.
      return firProcessSheetData(values);
    }
    const headers = values[headerIndex].map((v, i) => String(v || 'Column_' + i).trim());
    // Map the actual sheet header onto the canonical NOTAM keys used by the
    // analyzers, e.g. "NOTAM Condition/LTA subject/..." -> "NOTAM Text",
    // "NOTAM #/LTA #" -> "NOTAM #", "Effective Date (UTC)" -> "Effective Date".
    const canonical = (h) => {
      const u = String(h).toUpperCase();
      if (/LOCATION/.test(u)) return 'Location';
      if (/#|NUMBER/.test(u)) return 'NOTAM #';
      if (/CLASS/.test(u)) return 'Class';
      if (/ISSUE/.test(u)) return 'Issue Date';
      if (/EFFECTIVE/.test(u)) return 'Effective Date';
      if (/EXPIR/.test(u)) return 'Expiration Date';
      return 'NOTAM Text';
    };
    const colKey = headers.map(canonical);
    const rows = [];
    for (let i = headerIndex + 1; i < values.length; i++) {
      if (!values[i].some(c => c !== null && c !== undefined && String(c).trim() !== '')) continue;
      const item = { _rowId: i + 1 };
      colKey.forEach((key, col) => { if (key && item[key] === undefined) item[key] = values[i][col] ?? ''; });
      rows.push(item);
    }
    return rows;
  } catch (e) {
    console.error('firProcessNotamSheet error: ' + e.message);
    return [];
  }
}

/**
 * Parser for the "FIR" sheet storing NOTAMs without a header row
 * (FIR_NOTAM_NO_HEADER). Columns: [Location, NOTAM #, Class, Issue Date,
 * Effective Date, Expiration Date, NOTAM Text]. Output objects use canonical keys
 * for compatibility with getActiveNotams()/firAnalyzeFlight().
 * @expose
 */
function firParseFirSheetNotams(values) {
  try {
    if (!values || values.length === 0) return [];
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (!row || !row.some(Boolean)) continue;
      const location = String(row[0] || '').trim().toUpperCase();
      const number = String(row[1] || '').trim().toUpperCase();
      const text = String(row[6] || '').trim();
      if (!(/^[A-Z]{4}$/.test(location) &&
        /^[A-Z]\d{4}\/\d{2}$/.test(number) &&
        text.length > 0)) continue;
      out.push({
        _rowId: i + 1,
        Location: String(row[0] || ''),
        'NOTAM #': String(row[1] || ''),
        Class: String(row[2] || ''),
        'Issue Date': duNotamDateToText(row[3]),
        'Effective Date': duNotamDateToText(row[4]),
        'Expiration Date': duNotamDateToText(row[5]),
        'NOTAM Text': String(row[6] || '')
      });
    }
    return out;
  } catch (e) {
    console.error('firParseFirSheetNotams error: ' + e.message);
    return [];
  }
}

/**
 * Combine all raw NOTAMs (NOTAM sheet + FIR sheet) with de-duplication
 * by (Location, NOTAM #).
 * @expose
 */
function firGetAllRawNotams() {
  const out = [];
  const seen = {};
  const pushUnique = (n, src) => {
    const key = String(n && n.Location || '') + '|' + String(n && n['NOTAM #'] || '');
    if (seen[key]) return;
    seen[key] = true;
    if (n) n._src = src;
    out.push(n);
  };
  const notamValues = firGetSheetData('NOTAM');
  if (notamValues && notamValues.length > 1) {
    firProcessNotamSheet(notamValues).forEach((n) => pushUnique(n, 'AD'));
  }
  const firValues = firGetSheetData('FIR');
  if (firValues && firValues.length > 0) {
    firParseFirSheetNotams(firValues).forEach((n) => pushUnique(n, 'FIR'));
  }
  return out;
}

/**
 * Read all values from a sheet by name.
 * Returns a 2D array or null.
 * @expose
 */
function firGetSheetData(sheetName) {
  if (!sheetName) return null;
  try {
    const ss = getActiveSS();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.getSheets().find(s => s.getName().toLowerCase() === sheetName.toLowerCase());
    if (!sheet) return null;
    return sheet.getDataRange().getValues();
  } catch (e) {
    console.error('firGetSheetData Error: ' + e.message);
    return null;
  }
}

function firGetAnalyzeDataset(useCache) {
  if (useCache === undefined) useCache = true;
  const fetchFn = () => {
    const flightValues = firGetSheetData('FLT INFO');
    const routeValues = firGetSheetData('Route');
    if (!flightValues) throw new Error('FLT INFO sheet not found.');
    const processedFlights = firProcessSheetData(flightValues);
    const rawNotams = firGetAllRawNotams();
    const rawRoutes = (routeValues && routeValues.length > 1) ? firProcessSheetData(routeValues) : [];
    const notamsByLoc = {};
    rawNotams.forEach(n => {
      const loc = n.Location;
      if (!loc) return;
      if (!notamsByLoc[loc]) notamsByLoc[loc] = [];
      notamsByLoc[loc].push(n);
    });
    const flightById = {};
    processedFlights.forEach(f => { flightById[f._rowId] = f; });
    return { flights: processedFlights, flightById, notams: rawNotams, notamsByLoc, routes: rawRoutes };
  };
  if (useCache) return firGetCachedData(FIR_CACHE_KEY_ANALYZE_DATASET, fetchFn);
  return fetchFn();
}

/**
 * Deep-convert a payload into google.script.run-safe primitives.
 * Date -> ISO string, undefined -> null, functions dropped.
 * Prevents the silent serialization failure where the success handler
 * receives null when any Date leaks into the returned object.
 */
function firSerializeForClient(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(firSerializeForClient);
  if (typeof value === 'object') {
    const out = {};
    for (var k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      const v = value[k];
      if (typeof v === 'function') continue;
      out[k] = firSerializeForClient(v);
    }
    return out;
  }
  return String(value);
}

function analyzeFlightNotams(rowId) {
  try {
    const ds = firGetAnalyzeDataset(true);
    if (ds.error) return ds;
    const flight = ds.flightById[Number(rowId)];
    if (!flight) throw new Error('Flight row ' + rowId + ' not found.');
    return firSerializeForClient(firAnalyzeFlight(flight, ds.notams, ds.routes));
  } catch (e) {
    return { error: e.message };
  }
}

function analyzeFlightList(rowIds) {
  try {
    const ds = firGetAnalyzeDataset(true);
    if (ds.error) return ds;
    return firSerializeForClient((rowIds || []).map(rowId => {
      const flight = ds.flightById[Number(rowId)];
      if (!flight) return null;
      const flightFirs = firGetFlightFIRs(flight);
      const relevantNotams = flightFirs.reduce((acc, fir) => {
        if (ds.notamsByLoc[fir]) acc.push(...ds.notamsByLoc[fir]);
        return acc;
      }, []);
      return firAnalyzeFlight(flight, relevantNotams, ds.routes);
    }).filter(f => f !== null));
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Active NOTAMs for the map layer (currently effective, with lat/lon & risk).
 */
function getActiveNotams(useCache) {
  if (useCache === undefined) useCache = true;
  const fetchFn = () => {
    try {
      const rawNotams = firGetAllRawNotams();
      if (rawNotams.length === 0) return { notams: [] };
      const pick = (obj, ...names) => {
        if (!obj || typeof obj !== 'object') return undefined;
        for (const nm of names) if (obj[nm] !== undefined && obj[nm] !== null) return obj[nm];
        const lower = {};
        Object.keys(obj).forEach(k => { lower[k.toLowerCase()] = obj[k]; });
        for (const nm of names) if (lower[nm.toLowerCase()] !== undefined) return lower[nm.toLowerCase()];
        return undefined;
      };
      const now = new Date();
      const notams = [];
      rawNotams.forEach(n => {
        // Halaman FIR = peta FIR layer: tampilkan FIR NOTAM saja (_src==='FIR');
        // aerodrome tetap masuk analisis via ds.notamsByLoc di jalur lain.
        if (String(n && n._src || '') !== 'FIR') return;
        const text = String(pick(n, 'NOTAM Text', 'NOTAM_TEXT', 'NOTAMTEXT', 'Text', 'NOTAM TEXT') || '');
        const parsed = firParseNotamText(text);
        const norm = (v) => {
          if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().substring(0, 10);
          return String(v || '').trim();
        };
        const effStr = norm(pick(n, 'Effective Date', 'Effective', 'EFFECTIVE', 'START')) || (parsed ? parsed.start : '');
        let expStr = norm(pick(n, 'Expiration Date', 'Expiration', 'EXPIRATION', 'END'));
        if (!expStr) expStr = parsed ? parsed.end : 'PERM';
        if (!expStr) expStr = 'PERM';

        const effective = effStr ? duParseNotamDate(effStr) : new Date(0);
        const expiration = (expStr === 'PERM' || !expStr)
          ? new Date(8640000000000000)
          : duParseNotamDate(expStr);
        // Robust fallback: if date parsing yields Invalid Date, still treat as active so it stays on the map
        const nowTime = now.getTime();
        const effTime = effective instanceof Date && !isNaN(effective.getTime()) ? effective.getTime() : 0;
        const expTime = expiration instanceof Date && !isNaN(expiration.getTime()) ? expiration.getTime() : 8640000000000000;
        const active = !(nowTime < effTime || nowTime > expTime);

        const qCode = parsed ? parsed.qCode : '';
        const coords = firParseNotamCoord(text);
        const geom = firParseNotamGeometry(text);
        notams.push({
          location: String(pick(n, 'Location', 'LOCATION', 'FIR', 'FIR ID', 'ICAO') || 'UNKNOWN'),
          number: String(pick(n, 'NOTAM #', 'NOTAM', 'Number', 'ID', 'NOTAM NUMBER') || 'N/A'),
          cls: String(pick(n, 'Class', 'CLASS', 'CLS') || '') || firInferNotamClass(text) || 'N/A',
          issueDate: norm(pick(n, 'Issue Date', 'ISSUE', 'Issued', 'ISSUE DATE')) || duParseNotamIssueDate(text) || null,
          effectiveDate: effStr || null,
          expirationDate: expStr === 'PERM' ? 'PERM' : (expStr || null),
          text: text,
          qCode: qCode,
          risk: qCode ? firGetRiskLevel(qCode, text) : 'LOW',
          lat: coords.lat,
          lon: coords.lon,
          center: geom.center,
          radiusNm: geom.radiusNm,
          polygon: geom.polygon,
          effective: effStr || null,
          expiration: expStr || 'PERM',
          active: active
        });
      });
      // Cache diet: user-cache limit 100KB per value. Load full -> store full
      // (map popup shows n.text). Too big -> diet (text 400 chars);
      // full text stays on-demand via getNotamFullText(loc, num).
      const full = { notams: notams };
      if (JSON.stringify(full).length < 95000) return full;
      return { notams: notams.map(nm => ({ ...nm, text: String(nm.text || '').slice(0, 400) })) };
    } catch (e) {
      return { error: e.message };
    }
  };
  return useCache ? firGetCachedData(FIR_CACHE_KEY_ACTIVE_NOTAMS_V3, fetchFn) : fetchFn();
}

/**
 * Full NOTAM text (on-demand) — getActiveNotams cache stores truncated text.
 * @expose
 */
function getNotamFullText(location, number) {
  try {
    const ds = firGetAnalyzeDataset(false);
    if (ds.error) return { error: ds.error };
    const n = (ds.notams || []).find(x =>
      String(x.Location || '').toUpperCase() === String(location || '').trim().toUpperCase() &&
      String(x['NOTAM #'] || '').toUpperCase() === String(number || '').trim().toUpperCase());
    return n ? { text: n['NOTAM Text'] } : { error: 'NOTAM not found' };
  } catch (e) {
    return { error: e.message };
  }
}

function firParseNotamCoord(text) {
  try {
    if (!text || typeof text !== 'string') return { lat: null, lon: null };
    const toDec = (digits, hemi, isLat) => {
      let deg = 0, min = 0, sec = 0;
      const n = digits.length;
      if (isLat) {
        if (n === 6) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); sec = parseInt(digits.slice(4, 6), 10); }
        else if (n === 4) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); }
        else { deg = parseInt(digits, 10); }
      } else {
        if (n === 7) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); sec = parseInt(digits.slice(5, 7), 10); }
        else if (n === 5) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); }
        else { deg = parseInt(digits, 10); }
      }
      let dec = deg + min / 60 + sec / 3600;
      if (/S|W/i.test(hemi)) dec = -dec;
      return Math.round(dec * 10000) / 10000;
    };
    const qLine = (text.match(/^Q\)[^\n]*/m) || [''])[0];
    if (qLine) {
      const m1 = qLine.match(/(\d{6})\s*([NS])\s*(\d{7})\s*([EW])/i);
      if (m1) return { lat: toDec(m1[1], m1[2], true), lon: toDec(m1[3], m1[4], false) };
      const m2 = qLine.match(/(\d{4})\s*([NS])\s*(\d{5})\s*([EW])/i);
      if (m2) return { lat: toDec(m2[1], m2[2], true), lon: toDec(m2[3], m2[4], false) };
    }
    const m1 = text.match(/(\d{6})\s*([NS])\s*(\d{7})\s*([EW])/i);
    if (m1) return { lat: toDec(m1[1], m1[2], true), lon: toDec(m1[3], m1[4], false) };
    const m2 = text.match(/(\d{4})\s*([NS])\s*(\d{5})\s*([EW])/i);
    if (m2) return { lat: toDec(m2[1], m2[2], true), lon: toDec(m2[3], m2[4], false) };
    const m3 = text.match(/(\d{3})\s*([NS])\s*(\d{3})\s*([EW])/i);
    if (m3) return { lat: toDec(m3[1], m3[2], true), lon: toDec(m3[3], m3[4], false) };
    return { lat: null, lon: null };
  } catch (e) {
    return { lat: null, lon: null };
  }
}

function firParseNotamGeometry(text) {
  try {
    if (!text || typeof text !== 'string') return { center: null, radiusNm: null, polygon: [] };
    const toDec = (digits, hemi, isLat) => {
      let deg = 0, min = 0, sec = 0;
      const n = digits.length;
      if (isLat) {
        if (n === 6) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); sec = parseInt(digits.slice(4, 6), 10); }
        else if (n === 4) { deg = parseInt(digits.slice(0, 2), 10); min = parseInt(digits.slice(2, 4), 10); }
        else { deg = parseInt(digits, 10); }
      } else {
        if (n === 7) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); sec = parseInt(digits.slice(5, 7), 10); }
        else if (n === 5) { deg = parseInt(digits.slice(0, 3), 10); min = parseInt(digits.slice(3, 5), 10); }
        else { deg = parseInt(digits, 10); }
      }
      let dec = deg + min / 60 + sec / 3600;
      if (/S|W/i.test(hemi)) dec = -dec;
      return Math.round(dec * 10000) / 10000;
    };
    const qLine = (text.match(/^Q\)[^\n]*/m) || [''])[0];
    let center = null, radiusNm = null;
    const qDMS = qLine.match(/(\d{6})([NS])(\d{7})([EW])(\d{3})?/i);
    const qDM = qLine.match(/(\d{4})([NS])(\d{5})([EW])(\d{3})?/i);
    const qm = qDMS || qDM;
    if (qm) {
      center = [toDec(qm[3], qm[4], false), toDec(qm[1], qm[2], true)];
      if (qm[5] && parseInt(qm[5], 10) > 0 && parseInt(qm[5], 10) !== 999) radiusNm = parseInt(qm[5], 10);
    }
    const eSection = text.indexOf('E)');
    const eText = eSection >= 0 ? text.slice(eSection) : '';
    const polygon = [];
    const re = /(\d{6})\s*([NS])\s*(\d{7})\s*([EW])|(\d{4})\s*([NS])\s*(\d{5})\s*([EW])/gi;
    let m;
    while ((m = re.exec(eText)) !== null) {
      const latDigits = m[1] || m[5], latHemi = m[2] || m[6];
      const lonDigits = m[3] || m[7], lonHemi = m[4] || m[8];
      const lat = toDec(latDigits, latHemi, true);
      const lon = toDec(lonDigits, lonHemi, false);
      if (lat === null || lon === null) continue;
      const last = polygon[polygon.length - 1];
      if (last && last[0] === lon && last[1] === lat) continue;
      polygon.push([lon, lat]);
    }
    if (polygon.length < 2) return { center, radiusNm, polygon: [] };
    return { center, radiusNm, polygon };
  } catch (e) {
    return { center: null, radiusNm: null, polygon: [] };
  }
}

function firParseNotamText(text) {
  try {
    if (!text || typeof text !== 'string') return null;
    const qMatch = text.match(/Q\)\s*([A-Z0-9]+)\s*\/\s*([A-Z0-9]+)/);
    const bMatch = text.match(/B\)\s*(\d{8,10})/);
    const cMatch = text.match(/C\)\s*(\d{8,10})(?:EST)?|C\)\s*(PERM)/i);
    const dMatch = text.match(/D\)\s*([^\n]+)/);
    const fMatch = text.match(/F\)\s*(\w+)/);
    const gMatch = text.match(/G\)\s*(\w+)/);
    if (!qMatch || !bMatch) return null;
    const parseAlt = (s) => {
      if (!s) return 0;
      if (s === 'GND' || s === 'SFC') return 0;
      if (s === 'UNL' || s === 'UNLIMITED') return 999;
      const m = s.match(/FL(\d+)/);
      return m ? parseInt(m[1]) : 0;
    };
    return {
      qCode: qMatch[2],
      start: bMatch[1],
      end: cMatch ? (cMatch[1] || cMatch[2]) : 'PERM',
      schedule: dMatch ? dMatch[1].trim() : null,
      minAlt: fMatch ? parseAlt(fMatch[1]) : 0,
      maxAlt: gMatch ? parseAlt(gMatch[1]) : 999
    };
  } catch (e) {
    return null;
  }
}

function firInferNotamClass(text) {
  try {
    if (!text || typeof text !== 'string') return 'N/A';
    const m = text.match(/([A-Z])\d{4}\/\d{2}/i);
    return m ? m[1].toUpperCase() : 'N/A';
  } catch (e) {
    return 'N/A';
  }
}

/**
 * Extract a NOTAMR/NOTAMC reference number from NOTAM text.
 * Returns 'A1234/26'-style string or null.
 */
function firParseNotamRef(text, kind) {
  try {
    const m = String(text || '').match(new RegExp('NOTAM' + kind + '\\s+([A-Z]\\d{4}\\/\\d{2})', 'i'));
    return m ? m[1].toUpperCase() : null;
  } catch (e) { return null; }
}

/**
 * Resolve NOTAM lifecycle (N/R/C) across a NOTAM array.
 * Returns map: 'A1234/26' -> 'ACTIVE' | 'REPLACED' | 'CANCELLED' | 'CANCEL_MARKER'.
 * A NOTAM is REPLACED/CANCELLED only when the referencing NOTAMR/C is present
 * in the same array (dangling reference = original is gone, still active).
 */
function firParseNotamLifecycleMap(notams) {
  const status = {};
  const present = {};
  (notams || []).forEach(n => {
    const num = String((n && n['NOTAM #']) || '').trim().toUpperCase();
    if (num && /^[A-Z]\d{4}\/\d{2}$/.test(num)) present[num] = true;
  });
  (notams || []).forEach(n => {
    const num = String((n && n['NOTAM #']) || '').trim().toUpperCase();
    if (!num || !/^[A-Z]\d{4}\/\d{2}$/.test(num) || status[num]) return;
    const replaces = firParseNotamRef(n['NOTAM Text'], 'R');
    const cancels = firParseNotamRef(n['NOTAM Text'], 'C');
    if (replaces && present[replaces]) status[replaces] = 'REPLACED';
    if (cancels && present[cancels]) status[cancels] = 'CANCELLED';
    status[num] = cancels ? 'CANCEL_MARKER' : 'ACTIVE';
  });
  return status;
}

function firGetAirportFirMap_() {
  try {
    const cache = CacheService.getUserCache();
    const hit = cache.get(FIR_CACHE_KEY_AIRPORT_FIR);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
    const map = {};
    const sheet = getActiveSS().getSheetByName(SHEET_AIRPORT_FIR);
    if (sheet && sheet.getLastRow() > 1) {
      const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
      values.forEach(row => {
        const icao = String(row[0] || '').trim().toUpperCase();
        const firs = String(row[1] || '').split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(x => /^[A-Z]{4}$/.test(x));
        if (/^[A-Z]{4}$/.test(icao) && firs.length) map[icao] = firs;
      });
    }
    try { cache.put(FIR_CACHE_KEY_AIRPORT_FIR, JSON.stringify(map), CACHE_TTL_AIRPORT_FIR); } catch (e) {}
    return map;
  } catch (e) { return {}; }
}

function firGetFlightFIRs(f) {
  const legacy = ['FIR 1', 'FIR 2', 'FIR 3', 'FIR 4', 'FIR 5', 'FIR 6', 'FIR 7', 'FIR 8']
    .map(k => f && f[k])
    .filter(x => x && String(x).trim() !== '');
  if (legacy.length) return legacy;
  // Fallback (real schema): DEP/ARR/ENR1-3 as Location candidates,
  // + FIR mapped via AIRPORT_FIR sheet (B-strategy).
  const codes = ['DEP', 'ARR', 'ENR1', 'ENR2', 'ENR3']
    .map(k => String((f && f[k]) || '').trim().toUpperCase())
    .filter(x => /^[A-Z]{4}$/.test(x));
  const out = [];
  const push = c => { if (c && out.indexOf(c) === -1) out.push(c); };
  const airportFirs = firGetAirportFirMap_();
  codes.forEach(c => {
    push(c); // Location can be the airport code itself (airport-level NOTAM)
    (airportFirs[c] || []).forEach(push);
  });
  return out;
}

function firGetRiskLevel(q, text) {
  const qc = q ? String(q).toUpperCase() : '';
  if (!qc) return 'LOW';
  if (FIR_HIGH_RISK_Q.includes(qc)) return 'HIGH';
  if (FIR_MED_RISK_Q.includes(qc)) return 'MEDIUM';
  if (text) {
    const t = String(text).toUpperCase();
    if (/(MILITARY|DANGER|RESTRIC|ROCKET|LAUNCH|MISSILE|HAZARDOUS|RE-ENTRY|SPLASHDOWN|EXPLOSI|FIRING|BOMBING)/.test(t)) return 'HIGH';
    if (/(WARNING AREA|TEST RANGE|AIR EXERCISE)/.test(t)) return 'MEDIUM';
  }
  const subject = qc.charAt(1) || '';
  if (subject === 'D') return 'HIGH';
  if (subject === 'R' || subject === 'W') return 'MEDIUM';
  return 'LOW';
}

function firGetFlightTimeWindow(f) {
  let year, month, day;
  let dofInvalid = false;
  const rawDof = String(f.DOF || '');
  if (rawDof.length === 6 && /^\d+$/.test(rawDof)) {
    year = 2000 + parseInt(rawDof.substring(0, 2));
    month = parseInt(rawDof.substring(2, 4)) - 1;
    day = parseInt(rawDof.substring(4, 6));
  } else if (f.DOF instanceof Date) {
    year = f.DOF.getFullYear(); month = f.DOF.getMonth(); day = f.DOF.getDate();
    } else {
      const dObj = new Date(f.DOF);
      if (!isNaN(dObj.getTime())) {
        year = dObj.getUTCFullYear(); month = dObj.getUTCMonth(); day = dObj.getUTCDate();
      } else {
        // DOF unparseable — fallback to today BUT flagged (dofInvalid) so
        // UI can warn; never silently accept as valid DOF.
        const now = new Date();
        year = now.getUTCFullYear(); month = now.getUTCMonth(); day = now.getUTCDate();
        dofInvalid = true;
      }
    }
  const dof = new Date(Date.UTC(year, month, day));
  const parseTime = (val) => {
    if (!val) return { h: 0, m: 0 };
    if (val instanceof Date) return { h: val.getUTCHours(), m: val.getUTCMinutes() };
    const str = String(val);
    if (str.includes(':')) { const p = str.split(':'); return { h: parseInt(p[0]) || 0, m: parseInt(p[1]) || 0 }; }
    if (str.length === 4 && /^\d+$/.test(str)) return { h: parseInt(str.substring(0, 2)), m: parseInt(str.substring(2, 4)) };
    return { h: 0, m: 0 };
  };
  const std = parseTime(f.STD);
  const sta = parseTime(f.STA);
  const start = new Date(dof.getTime());
  start.setUTCHours(std.h, std.m, 0, 0);
  const end = new Date(dof.getTime());
  end.setUTCHours(sta.h, sta.m, 0, 0);
  if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
  return { start, end, dofInvalid };
}

function firScheduleDays_(schedule) {
  // Allowed days (0=Sun..6=Sat) from the D-line spec, or null if none
  // day spec (DAILY / bare "HHMM-HHMM" / "ALL DAY" = every day).
  // ponytail: only range (MON-FRI), list (MON,WED,FRI), single (TUE) formats;
  // upgrade path: "MON-SUN EXCEPT FRI" etc. if seen in real data.
  const s = String(schedule || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const order = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const idx = d => order.indexOf(d);
  const range = s.match(/(SUN|MON|TUE|WED|THU|FRI|SAT)\s*-\s*(SUN|MON|TUE|WED|THU|FRI|SAT)/);
  if (range) {
    const days = [];
    for (let d = idx(range[1]); d <= idx(range[2]); d++) days.push(d);
    return days;
  }
  const list = s.match(/(?:SUN|MON|TUE|WED|THU|FRI|SAT)(?:,\s*(?:SUN|MON|TUE|WED|THU|FRI|SAT))+/);
  if (list) {
    const out = [];
    list[0].split(',').forEach(part => {
      const i = idx(part.trim());
      if (i > -1 && out.indexOf(i) === -1) out.push(i);
    });
    return out.length ? out : null;
  }
  const single = s.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)(?:\s|$)/);
  if (single) return [idx(single[1])];
  return null;
}

function firCheckTimeOverlap(flight, nStartStr, nEndStr, schedule) {
  try {
    const nStart = duParseNotamDate(nStartStr);
    const nEnd = nEndStr === 'PERM' ? new Date(8640000000000000) : duParseNotamDate(nEndStr);
    const isDateOverlap = (flight.start <= nEnd && flight.end >= nStart);
    if (!isDateOverlap) return false;
    if (schedule) {
      // Spec weekday (MON-FRI / MON,WED,FRI / TUE) — filter days first
      const allowedDays = firScheduleDays_(schedule);
      if (allowedDays && allowedDays.indexOf(flight.start.getUTCDay()) === -1) return false;
      const dailyMatch = schedule.match(/DAILY\s*(\d{4})-(\d{4})/i);
      if (dailyMatch) {
        const nStartH = parseInt(dailyMatch[1].substring(0, 2));
        const nStartM = parseInt(dailyMatch[1].substring(2, 4));
        const nEndH = parseInt(dailyMatch[2].substring(0, 2));
        const nEndM = parseInt(dailyMatch[2].substring(2, 4));
        const nStartTotalMin = nStartH * 60 + nStartM;
        let nEndTotalMin = nEndH * 60 + nEndM;
        if (nEndTotalMin <= nStartTotalMin) nEndTotalMin += 1440;
        const fStartTotalMin = flight.start.getUTCHours() * 60 + flight.start.getUTCMinutes();
        let fEndTotalMin = flight.end.getUTCHours() * 60 + flight.end.getUTCMinutes();
        const dayDiff = Math.floor((flight.end - flight.start) / 86400000);
        fEndTotalMin += dayDiff * 1440;
        if (fEndTotalMin <= fStartTotalMin && flight.end > flight.start) fEndTotalMin += 1440;
        return (fStartTotalMin < nEndTotalMin && fEndTotalMin > nStartTotalMin);
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

function firScheduleSelfCheck() {
  const cases = [
    ['MON-FRI 1300-1500', [1,2,3,4,5]],
    ['SAT 1300-1500', [6]],
    ['MON,WED,FRI 0800-1200', [1,3,5]],
    ['DAILY 1300-1500', null],
    ['1300-1500', null],
    ['ALL DAY', null]
  ];
  cases.forEach(c => {
    const got = firScheduleDays_(c[0]);
    if (JSON.stringify(got) !== JSON.stringify(c[1])) {
      throw new Error('firScheduleDays self-check failed: ' + c[0] + ' expected ' + JSON.stringify(c[1]) + ' got ' + JSON.stringify(got));
    }
  });
  const sat = firGetFlightTimeWindow({ DOF: '260822', STD: '1400', STA: '1500' }); // Saturday
  if (firCheckTimeOverlap(sat, '2608170000', '2608312359', 'MON-FRI 1300-1500') !== false) throw new Error('weekday self-check: Saturday must be excluded');
  const mon = firGetFlightTimeWindow({ DOF: '260824', STD: '1400', STA: '1500' }); // Monday
  if (firCheckTimeOverlap(mon, '2608170000', '2608312359', 'MON-FRI 1300-1500') !== true) throw new Error('weekday self-check: Monday must match');
  return { ok: true };
}

function firCheckRouteImpact(text, waypoints) {
  try {
    if (!text || !waypoints || waypoints.length === 0) return { impacted: false, matches: [] };
    const filtered = waypoints.filter(wp => String(wp).toUpperCase() !== 'DCT');
    if (filtered.length === 0) return { impacted: false, matches: [] };
    const impacted = filtered.filter(wp => {
      const escapedWp = wp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + escapedWp + '\\b', 'i').test(text);
    });
    return { impacted: impacted.length > 0, matches: impacted };
  } catch (e) {
    return { impacted: false, matches: [] };
  }
}

function llHaversineNm(a, b) {
  var R = 3440.065;
  var toRad = function (x) { return x * Math.PI / 180; };
  var dLat = toRad(b[0] - a[0]);
  var dLon = toRad(b[1] - a[1]);
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function llMinSegDistNm(pt, a, b) {
  // Point-to-segment on local equirectangular projection (single scale,
  // accurate for short segments); final distance stays Haversine.
  var toRad = function (x) { return x * Math.PI / 180; };
  var k = Math.cos(toRad((a[0] + b[0] + pt[0]) / 3));
  var ax = a[1] * k, ay = a[0];
  var bx = b[1] * k, by = b[0];
  var px = pt[1] * k, py = pt[0];
  var dx = bx - ax, dy = by - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  var qx = (1 - t) * ax + t * bx;
  var qy = (1 - t) * ay + t * by;
  return llHaversineNm(pt, [qy, qx / k]);
}

function llPointInPolygon(pt, poly) {
  // Ray casting. pt & poly: [lon, lat].
  if (!poly || poly.length < 3) return false;
  var x = pt[0], y = pt[1], inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function llDensifyPolyline(pts, maxDeg) {
  maxDeg = maxDeg || 0.05;
  var out = [];
  for (var i = 0; i < pts.length - 1; i++) {
    var a = pts[i], b = pts[i + 1];
    var d = llHaversineNm(a, b);
    var steps = Math.max(1, Math.ceil(d / (maxDeg * 60)));
    for (var s = 0; s < steps; s++) {
      var t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function firCheckRouteGeometry(polyline, geometry) {
  try {
    if (!polyline || polyline.length < 2) return { impacted: false, nearestNm: null };
    if (!geometry) return { impacted: false, nearestNm: null };
    var center = geometry.center, radiusNm = geometry.radiusNm, polygon = geometry.polygon || [];
    if (center && radiusNm && radiusNm > 0 && radiusNm !== 999) {
      var minD = null;
      for (var i = 0; i < polyline.length - 1; i++) {
        var d = llMinSegDistNm([center[1], center[0]], polyline[i], polyline[i + 1]);
        if (minD === null || d < minD) minD = d;
      }
      return { impacted: minD <= radiusNm, nearestNm: Math.round(minD * 10) / 10 };
    }
    if (polygon.length >= 3) {
      var pts = llDensifyPolyline(polyline);
      var best = null;
      for (var k = 0; k < pts.length; k++) {
        if (llPointInPolygon([pts[k][1], pts[k][0]], polygon)) {
          var bd = llHaversineNm(pts[k], [center ? center[1] : 0, center ? center[0] : 0]);
          if (best === null || bd < best) best = bd;
        }
      }
      return { impacted: best !== null, nearestNm: best === null ? null : Math.round(best * 10) / 10 };
    }
    return { impacted: false, nearestNm: null };
  } catch (e) {
    return { impacted: false, nearestNm: null };
  }
}

function firAnalyzeFlight(flight, notams, routes) {
  const flightFirs = firGetFlightFIRs(flight);
  const flightFirsUpper = flightFirs.map(x => String(x).trim().toUpperCase());
  const flightWindow = firGetFlightTimeWindow(flight);
  const cruiseFL = duParseAltitude(flight['CRZ FL'] || flight.ALT || flight.FL || '');
  const flightRouteId = String(flight['ACTIVE ROUTE ID'] || flight['ROUTE ID'] || '').trim().toUpperCase();
  const routeData = (routes || []).find(r => 
    String(r.ID || '').trim().toUpperCase() === flightRouteId
  ) || {};
  const waypoints = String(routeData['WAYPOINT_SEQ (Airway & Fix)'] || routeData.WAYPOINT_SEQ || '')
    .split(/\s+/).filter(w => w.length > 2);
  const routePolyline = (function () {
    try { return latlongGetRoutePolyline(flightRouteId); } catch (e) { return null; }
  })();
  const flags = {
    firMapped: flightFirs.length > 0,
    routeMapped: waypoints.length > 0,
    altKnown: cruiseFL !== null,
    geometryChecked: routePolyline !== null,
    dofInvalid: !!(flightWindow && flightWindow.dofInvalid)
  };
  if (!flightFirs.length) {
    // No silent "Clear" — empty mapping = cannot be assessed.
    return { ...flight, analysis: [], riskLevel: 'NO_FIR_MAPPED', flags: flags };
  }
  const lifecycle = firParseNotamLifecycleMap(notams);
  const analysis = (notams || [])
    .filter(n => flightFirsUpper.indexOf(String(n.Location || '').trim().toUpperCase()) > -1)
    .map(n => {
      const parsed = firParseNotamText(n['NOTAM Text']);
      if (!parsed) return null;
      const lifeStatus = lifecycle[String(n['NOTAM #'] || '').trim().toUpperCase()] || 'ACTIVE';
      const timeMatch = firCheckTimeOverlap(flightWindow, parsed.start, parsed.end, parsed.schedule);
      const altMatch = (cruiseFL === null) ? true : (cruiseFL >= parsed.minAlt && cruiseFL <= parsed.maxAlt);
      const routeMatch = firCheckRouteImpact(n['NOTAM Text'], waypoints);
      const geom = firParseNotamGeometry(n['NOTAM Text']);
      const geomMatch = routePolyline ? firCheckRouteGeometry(routePolyline, geom) : { impacted: false, nearestNm: null };
      const routeHit = routeMatch.impacted || geomMatch.impacted;
      // Fix false positives like A2993/26 (Merauke 200NM) on WIII-WADD: if NOTAM has geometry
      // (radius/polygon), require routeHit, not fallback "waypoints empty => direct".
      // FIR-wide NOTAMs without geometry may still be direct on FIR match alone.
      const hasGeometry = !!(geom && (geom.radiusNm || (geom.polygon && geom.polygon.length >= 2) || geom.center));
      const isIndirectImpact = lifeStatus === 'ACTIVE' && timeMatch && altMatch && !routeMatch.impacted && geomMatch.impacted;
      const isDirectImpact = lifeStatus === 'ACTIVE' && timeMatch && altMatch && (hasGeometry ? routeHit : (waypoints.length === 0 || routeHit));
      const risk = firGetRiskLevel(parsed.qCode, n['NOTAM Text']);
      return {
        id: n['NOTAM #'],
        location: n.Location,
        number: n['NOTAM #'],
        text: n['NOTAM Text'],
        risk: isDirectImpact ? risk : 'LOW',
        isDirectImpact,
        isIndirectImpact,
        status: lifeStatus,
        matchReason: (lifeStatus !== 'ACTIVE' ? lifeStatus + ' — ' : '') + 'Time: ' + timeMatch + ', Alt: ' + altMatch + ', Route: ' + (routeMatch.impacted ? 'YES' : (waypoints.length === 0 && !hasGeometry ? 'N/A' : 'NO')) + (geomMatch.nearestNm !== null ? ', Geometry: ' + geomMatch.nearestNm + 'nm' + (geomMatch.impacted ? ' (inside ' + geom.radiusNm + 'NM)' : ' (> ' + (geom.radiusNm || '?') + 'NM)') : (hasGeometry && !routePolyline ? ', Geometry: no route polyline to check' : ''))
      };
    })
    .filter(n => n !== null);
  let finalRisk = 'Clear';
  if (analysis.some(n => n.risk === 'HIGH' && n.isDirectImpact)) finalRisk = 'HIGH';
  else if (analysis.some(n => n.risk === 'MEDIUM' && n.isDirectImpact)) finalRisk = 'MEDIUM';
  else if (analysis.some(n => n.isDirectImpact)) finalRisk = 'LOW';
  return { ...flight, analysis, riskLevel: finalRisk, flags: flags };
}

function firProcessSheetData(data) {
  try {
    if (!data || data.length < 1) return [];
    const flightKeywords = ['QZ', 'FLIGHT', 'DEP', 'DES', 'REG', 'DOF'];
    const routeKeywords = ['ID', 'DEP_AIRPORT', 'ARR_AIRPORT', 'WAYPOINT_SEQ'];
    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(data.length, 20); i++) {
      const rowStr = data[i].join('|').toUpperCase();
      const matchCount = [...flightKeywords, ...routeKeywords].filter(k => rowStr.includes(k)).length;
      if (matchCount >= 2) { headerRowIndex = i; break; }
    }
    if (headerRowIndex === -1) {
      for (let i = 0; i < data.length; i++) {
        if (data[i].some(cell => String(cell || '').trim() !== '')) { headerRowIndex = i; break; }
      }
    }
    if (headerRowIndex === -1) return [];
    const seen = {};
    const headers = data[headerRowIndex].map((h, idx) => {
      let name = String(h || '').trim();
      if (!name) name = 'Column_' + idx;
      let finalName = name, counter = 1;
      while (seen[finalName]) finalName = name + '_' + counter++;
      seen[finalName] = true;
      return finalName;
    });
    return data.slice(headerRowIndex + 1)
      .filter(row => row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== ''))
      .map((row, index) => {
        const obj = { _rowId: index + headerRowIndex + 2 };
        headers.forEach((header, i) => {
          if (!header) return;
          let val = row[i];
          if (header.toUpperCase() === 'DOF') {
            if (val instanceof Date && !isNaN(val.getTime())) {
              val = val.toISOString().substring(0, 10);
            } else {
              let sVal = String(val || '').trim();
              if (sVal.length === 8 && /^\d+$/.test(sVal)) {
                val = sVal.substring(0, 4) + '-' + sVal.substring(4, 6) + '-' + sVal.substring(6, 8);
              }
            }
          }
          obj[header] = val;
        });
        if (!obj['CRZ FL'] && obj['ALT']) obj['CRZ FL'] = obj['ALT'];
        if (!obj['CRZ FL'] && obj['FL']) obj['CRZ FL'] = obj['FL'];
        if (!obj['riskLevel'] && obj['RISK LEVEL']) obj['riskLevel'] = obj['RISK LEVEL'];
        return obj;
      })
      .filter(obj => {
        if ('QZ' in obj) {
          const qz = String(obj.QZ || '').trim();
          return qz !== '' && !/^FIR \d$/i.test(qz) && !/^QZ$/i.test(qz);
        }
        return true;
      });
  } catch (e) {
    console.error('firProcessSheetData error: ' + e.message);
    return [];
  }
}

function firFindHeaderRowIndex(data) {
  if (!data || data.length < 1) return -1;
  const flightKeywords = ['QZ', 'FLIGHT', 'DEP', 'DES', 'REG', 'DOF'];
  const routeKeywords = ['ID', 'DEP_AIRPORT', 'ARR_AIRPORT', 'WAYPOINT_SEQ'];
  for (let i = 0; i < Math.min(data.length, 20); i++) {
    const rowStr = data[i].join('|').toUpperCase();
    const matchCount = [...flightKeywords, ...routeKeywords].filter(k => rowStr.includes(k)).length;
    if (matchCount >= 2) return i;
  }
  for (let i = 0; i < data.length; i++) {
    if (data[i].some(cell => String(cell || '').trim() !== '')) return i;
  }
  return -1;
}

function firSaveSheetData(sheetName, data2DArray) {
  requireAuthorized();
  const ss = getActiveSS();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.clear();
  if (data2DArray && data2DArray.length > 0) {
    sheet.getRange(1, 1, data2DArray.length, data2DArray[0].length).setValues(data2DArray);
  }
  firClearAppCache();
}

function firValidateFlightData(flightData) {
  const errors = [];
  ['QZ', 'DOF', 'DEP', 'DES', 'STD', 'STA', 'REG'].forEach(k => {
    const v = String(flightData[k] || '').trim();
    if (!v) errors.push(k);
  });
  const fl = String(flightData['CRZ FL'] || '').trim();
  // FIX #1: Use duParseAltitude instead of Number() to accept aviation formats (FL360, GND, UNL, etc.)
  if (!fl || duParseAltitude(fl) === null) errors.push('CRZ FL');
  const dof = String(flightData.DOF || '').trim();
  if (dof && !/^\d{4}-\d{2}-\d{2}$/.test(dof) && !/^\d{8}$/.test(dof)) errors.push('DOF');
  const timeRe = /^\d{1,2}:\d{2}$/;
  if (String(flightData.STD || '').trim() && !timeRe.test(String(flightData.STD).trim())) errors.push('STD');
  if (String(flightData.STA || '').trim() && !timeRe.test(String(flightData.STA).trim())) errors.push('STA');
  return errors;
}

/**
 * Save a new or modified flight (authorized write endpoint).
 * @expose
 */
function saveFlight(flightData) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!flightData || typeof flightData !== 'object') return { error: 'Invalid flight data' };
    const errors = firValidateFlightData(flightData);
    if (errors.length > 0) return { error: 'Missing/Invalid: ' + errors.join(', ') };
    let dof = String(flightData.DOF).trim();
    if (/^\d{8}$/.test(dof)) dof = dof.substring(0, 4) + '-' + dof.substring(4, 6) + '-' + dof.substring(6, 8);
    let data = firGetSheetData('FLT INFO');
    let headers = [];
    if (data && data.length > 0) {
      const headerIdx = firFindHeaderRowIndex(data);
      headers = headerIdx >= 0 ? data[headerIdx] : data[0];
    } else {
      headers = ['QZ', 'DOF', 'DEP', 'DES', 'STD', 'STA', 'CRZ FL', 'REG', 'FIR 1', 'FIR 2', 'FIR 3', 'FIR 4', 'FIR 5', 'ROUTE ID'];
      data = [headers];
    }
    const row = headers.map(header => {
      if (header === 'DOF') return dof;
      if (header === 'HIDDEN' || header === 'ORDER' || header === 'DELETED') {
        const existing = flightData._rowId && data[flightData._rowId - 1]
          ? data[flightData._rowId - 1][headers.indexOf(header)]
          : '';
        return flightData[header] !== undefined ? flightData[header] : existing;
      }
      return flightData[header] !== undefined ? flightData[header] : '';
    });
    if (flightData._rowId && data[flightData._rowId - 1]) {
      data[flightData._rowId - 1] = row;
    } else {
      data.push(row);
    }
    firSaveSheetData('FLT INFO', data);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Update DOF for multiple flights (authorized write endpoint).
 * @expose
 */
function updateFlightDOFs(updates) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!updates || !updates.length) return { error: 'No updates provided' };
    let data = firGetSheetData('FLT INFO');
    if (!data || data.length < 1) throw new Error('Sheet not found: FLT INFO');
    const headerIdx = firFindHeaderRowIndex(data);
    if (headerIdx === -1) throw new Error('Header row not found in FLT INFO');
    const headers = data[headerIdx];
    const dofIdx = headers.indexOf('DOF');
    if (dofIdx === -1) throw new Error('DOF column not found in FLT INFO');
    let count = 0;
    updates.forEach(u => {
      const rowIdx = Number(u.rowId);
      if (rowIdx > headerIdx && data[rowIdx - 1]) {
        data[rowIdx - 1][dofIdx] = String(u.dof || '').trim();
        count++;
      }
    });
    if (count === 0) return { error: 'No matching rows found to update' };
    firSaveSheetData('FLT INFO', data);
    return { success: true, count };
  } catch (e) {
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Hide a flight from the web view without deleting the sheet row (authorized).
 * @expose
 */
function deleteFlight(rowId) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const rowNum = Number(rowId);
    let data = firGetSheetData('FLT INFO');
    if (!data) throw new Error('Sheet not found: FLT INFO');
    const headerIdx = firFindHeaderRowIndex(data);
    if (headerIdx === -1) throw new Error('Header row not found in FLT INFO');
    if (rowNum <= headerIdx + 1 || rowNum > data.length) return { error: 'Row out of range' };
    const headers = data[headerIdx];
    let deletedIdx = headers.indexOf('DELETED');
    if (deletedIdx === -1) {
      headers.push('DELETED');
      deletedIdx = headers.length - 1;
      for (let i = 0; i < data.length; i++) while (data[i].length < headers.length) data[i].push('');
    }
    data[rowNum - 1][deletedIdx] = 'TRUE';
    firSaveSheetData('FLT INFO', data);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Persist custom display order (authorized write endpoint).
 * @expose
 */
function updateFlightOrder(rowIds) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!Array.isArray(rowIds) || rowIds.length === 0) return { error: 'No order data provided' };
    let data = firGetSheetData('FLT INFO');
    if (!data) throw new Error('Sheet not found: FLT INFO');
    const headerIdx = firFindHeaderRowIndex(data);
    if (headerIdx === -1) throw new Error('Header row not found in FLT INFO');
    const headers = data[headerIdx];
    let orderIdx = headers.indexOf('ORDER');
    if (orderIdx === -1) {
      headers.push('ORDER');
      orderIdx = headers.length - 1;
      for (let i = 0; i < data.length; i++) while (data[i].length < headers.length) data[i].push('');
    }
    let count = 0;
    rowIds.forEach((rowId, idx) => {
      const rowNum = Number(rowId);
      if (rowNum > headerIdx && rowNum <= data.length) {
        data[rowNum - 1][orderIdx] = idx + 1;
        count++;
      }
    });
    if (count === 0) return { error: 'No matching rows found to update' };
    firSaveSheetData('FLT INFO', data);
    return { success: true, count };
  } catch (e) {
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Persist computed risk levels back to FLT INFO (authorized write endpoint).
 * @expose
 */
function persistAnalysisResults(analyzedFlights) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!Array.isArray(analyzedFlights) || analyzedFlights.length === 0) {
      return { error: 'No analysis data provided' };
    }
    let data = firGetSheetData('FLT INFO');
    if (!data) throw new Error('Sheet not found: FLT INFO');
    const headerIdx = firFindHeaderRowIndex(data);
    if (headerIdx === -1) throw new Error('Header row not found in FLT INFO');
    const headers = data[headerIdx];
    let riskIdx = headers.indexOf('RISK LEVEL');
    if (riskIdx === -1) {
      headers.push('RISK LEVEL');
      riskIdx = headers.length - 1;
      for (let i = 0; i < data.length; i++) while (data[i].length < headers.length) data[i].push('');
    }
    let count = 0;
    analyzedFlights.forEach(f => {
      const rowNum = Number(f._rowId);
      if (rowNum > headerIdx && rowNum <= data.length) {
        const value = (f.riskLevel === 'Clear' || !f.riskLevel) ? '' : f.riskLevel;
        while (data[rowNum - 1].length < headers.length) data[rowNum - 1].push('');
        data[rowNum - 1][riskIdx] = value;
        count++;
      }
    });
    if (count === 0) return { error: 'No matching rows found to update' };
    firSaveSheetData('FLT INFO', data);
    return { success: true, count, column: 'RISK LEVEL' };
  } catch (e) {
    console.error('persistAnalysisResults error: ' + e.message);
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Bulk import raw ICAO NOTAM text into the NOTAM sheet (authorized write).
 * @expose
 */
function updateNotamsBulk(rawText) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!rawText || rawText.trim() === '') return { error: 'No text provided' };
    let rows = [];
    const isTSV = rawText.includes('\t');
    if (isTSV) {
      const data = Utilities.parseCsv(rawText, '\t');
      if (data.length === 0) return { error: 'Empty table' };
      const header = data[0].map(h => String(h || '').trim().toLowerCase());
      let textIdx = header.findIndex(h => h.includes('condition') || h.includes('subject') || h.includes('text'));
      let locIdx = header.findIndex(h => h.includes('location'));
      let noIdx = header.findIndex(h => h.includes('#') || h.includes('number'));
      let clsIdx = header.findIndex(h => h.includes('class'));
      let issIdx = header.findIndex(h => h.includes('issue'));
      let effIdx = header.findIndex(h => h.includes('effective'));
      let expIdx = header.findIndex(h => h.includes('expiration'));
      if (textIdx === -1) {
        for (let i = 0; i < data.length; i++) {
          const foundIdx = data[i].findIndex(cell => String(cell || '').includes('Q)'));
          if (foundIdx !== -1) { textIdx = foundIdx; break; }
        }
      }
      if (textIdx === -1) textIdx = data[0].length - 1;
      const startLine = (header.some(h => h !== '')) ? 1 : 0;
      for (let i = startLine; i < data.length; i++) {
        const cols = data[i];
        if (cols.length <= textIdx) continue;
        const text = cols[textIdx] ? cols[textIdx].trim() : '';
        if (!text.includes('Q)')) continue;
        const extractedLoc = (text.match(/Q\)\s*([^ \/]+)/) || [])[1] || 'UNKNOWN';
        const extractedNo = (text.match(/([A-Z]\d{4}\/\d{2})/) || [])[1] || 'N/A';
        const extractedCls = firInferNotamClass(text);
        const extractedIssue = duParseNotamIssueDate(text);
        rows.push([
          locIdx !== -1 && cols[locIdx] ? cols[locIdx].trim() : extractedLoc,
          noIdx !== -1 && cols[noIdx] ? cols[noIdx].trim() : extractedNo,
          clsIdx !== -1 && cols[clsIdx] ? cols[clsIdx].trim() : extractedCls,
          issIdx !== -1 && cols[issIdx] ? cols[issIdx].trim() : extractedIssue,
          effIdx !== -1 && cols[effIdx] ? cols[effIdx].trim() : (duParseNotamDateField(text, 'B)') || ''),
          expIdx !== -1 && cols[expIdx] ? cols[expIdx].trim() : (duParseNotamDateField(text, 'C)') || ''),
          text
        ]);
      }
    } else {
      const parts = rawText.split(/(?=Q\))/g);
      rows = parts.filter(p => p.trim() !== '').map(p => {
        const text = p.trim();
        const locMatch = text.match(/Q\)\s*([^ \/]+)/);
        const noMatch = text.match(/([A-Z]\d{4}\/\d{2})/);
        return [
          locMatch ? locMatch[1] : 'UNKNOWN',
          noMatch ? noMatch[1] : 'N/A',
          firInferNotamClass(text),
          duParseNotamIssueDate(text),
          duParseNotamDateField(text, 'B)') || '',
          duParseNotamDateField(text, 'C)') || '',
          text
        ];
      });
    }
    if (rows.length > 0) {
      const dataToSave = [
        ['Location', 'NOTAM #', 'Class', 'Issue Date', 'Effective Date', 'Expiration Date', 'NOTAM Text'],
        ...rows
      ];
      firSaveSheetData('NOTAM', dataToSave);
      return { success: true, count: rows.length, format: isTSV ? 'Excel Table' : 'Raw Text' };
    }
    return { error: 'No valid NOTAMs found. Make sure the text contains "Q)" lines.' };
  } catch (e) {
    console.error('updateNotamsBulk error: ' + e.message);
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Smoke test helpers (serializable diagnostics).
 * @expose
 */
/**
 * Cache contract key: all keys must be unique string literals
 * (old bug: var Constants = Constants || {} -> key undefined).
 * @expose
 */
function smokeTestCacheKeys() {
  const keys = {
    flightsRoutes: FIR_CACHE_KEY_FLIGHTS_ROUTES,
    analyzeDataset: FIR_CACHE_KEY_ANALYZE_DATASET,
    activeNotams: FIR_CACHE_KEY_ACTIVE_NOTAMS_V3,
    airportFir: FIR_CACHE_KEY_AIRPORT_FIR,
    routePolyline: FIR_CACHE_KEY_ROUTE_POLYLINE,
    firNotamEditor: FIR_NOTAM_CACHE_KEY
  };
  Object.keys(keys).forEach(k => {
    if (typeof keys[k] !== 'string' || !keys[k]) throw new Error('Cache key ' + k + ' undefined/empty');
  });
  const vals = Object.keys(keys).map(k => keys[k]);
  if (new Set(vals).size !== vals.length) throw new Error('duplicate cache key');
  console.log(JSON.stringify({ ok: true, keys: keys }));
  return { ok: true, keys: keys };
}

function smokeTestFirParity() {
  const list = getActiveFlightList();
  const summary = getFlightSummary();
  const activeNotams = getActiveNotams(false);
  console.log(JSON.stringify({
    flightCount: list.flights ? list.flights.length : 0,
    notamCount: activeNotams.notams ? activeNotams.notams.length : 0,
    sample: list.flights ? list.flights[0] || null : null,
    firstNotam: activeNotams.notams ? activeNotams.notams[0] || null : null
  }));
  return { flights: (list.flights || []).length, notams: (activeNotams.notams || []).length };
}

/**
 * Smoke test: NOTAM parsing + map renderability (validates schema mapping).
 * @expose
 */
function smokeTestFirNotamParsing() {
  const notamRaw = firGetSheetData('NOTAM');
  const firRaw = firGetSheetData('FIR');
  const notamSheetCount = (notamRaw && notamRaw.length > 1) ? firProcessNotamSheet(notamRaw).length : 0;
  const firSheetCount = (firRaw && firRaw.length > 0) ? firParseFirSheetNotams(firRaw).length : 0;
  const combined = firGetAllRawNotams();
  const withCoord = combined.filter(n => {
    const c = firParseNotamCoord(n['NOTAM Text']);
    return c.lat !== null && c.lon !== null;
  });
  const active = getActiveNotams(false);
  console.log(JSON.stringify({
    notamSheetCount: notamSheetCount,
    firSheetCount: firSheetCount,
    combinedCount: combined.length,
    withCoordFromText: withCoord.length,
    activeNotams: active.notams ? active.notams.length : 0,
    firstActive: active.notams ? active.notams[0] || null : null
  }, null, 2));
  return {
    combinedCount: combined.length,
    activeNotams: active.notams ? active.notams.length : 0,
    firstActive: active.notams ? active.notams[0] || null : null
  };
}

/**
 * Smoke test: route geometry data availability for the map.
 * @expose
 */
function smokeTestFirParityRoutes() {
  const selected = getSelectedFlightsData([], false);
  const routeCount = (selected.routes || []).length;
  const latlongCount = (selected.latlong || []).length;
  let analyzed = null;
  const list = getActiveFlightList();
  if (list.flights && list.flights.length) {
    analyzed = analyzeFlightNotams(Number(list.flights[0]._rowId));
  }
  console.log(JSON.stringify({
    routeCount: routeCount,
    latlongCount: latlongCount,
    hasRoutes: routeCount > 0,
    hasLatlong: latlongCount > 0,
    firstRoute: (selected.routes || [])[0] || null,
    firstLatlong: (selected.latlong || [])[0] || null,
    sampleFlightAnalysis: analyzed && !analyzed.error ? {
      QZ: analyzed.QZ,
      riskLevel: analyzed.riskLevel,
      hazardCount: (analyzed.analysis || []).length
    } : (analyzed && analyzed.error ? { error: analyzed.error } : null)
  }));
  return {
    routes: routeCount,
    latlong: latlongCount,
    sampleAnalysis: analyzed && !analyzed.error ? analyzed.riskLevel : (analyzed && analyzed.error ? analyzed.error : null)
  };
}
