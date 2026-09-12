/**
 * LatLong_Backend.gs — LATLONG sheet editor for web app
 *
 * Sheet "LATLONG" — Variant B (WAYPOINT, 4 cols): ID | Waypoint | Latitude | Longitude
 *     ID = Route ID (e.g. WADDWSSS01) — groups FIXes per route for FIR map geometry
 *     Latitude  e.g. "S 08 44.8"   (hemisphere + deg + min)
 *     Longitude e.g. "E 115 10.2"
 *   Web App Tab: WAYPOINT (sheet name remains LATLONG for FIR compatibility)
 *
 * Input paste format (two-column aware):
 *   Each waypoint token is: NAME S|N DD MM.M E|W DDD MM.M
 *   Example: WADD S 08 44.8 E 115 10.2
 *
 *   Users often copy a 2-column block from Excel where left col=col A,
 *   right col=col B. Clipboard text becomes TAB-separated per row:
 *     "WADD S 08 44.8 E 115 10.2<TAB>PU20 N 01 45.5 E 103 58.2"
 *   Dual-column scan: COLUMN order = left top→bottom then
 *   right top→bottom. ROW order = interleaved as copied (ICAO AIP chart).
 *   Parser supports both via orderMode = 'column' | 'row'.
 *
 * All write endpoints are guarded by requireAuthorized() and clear FIR caches.
 */

var LATLONG_SHEET_NAME = 'LATLONG';
var LATLONG_CACHE_KEY = 'latlong_editor_v1';
var LATLONG_CACHE_TTL = 30;

function latlongFindSheet_() {
  try {
    var ss = getActiveSS();
    var sheet = ss.getSheetByName(LATLONG_SHEET_NAME);
    if (sheet) return sheet;
    // case-insensitive fallback
    var all = ss.getSheets();
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].getName()).toUpperCase() === LATLONG_SHEET_NAME) return all[i];
    }
    return null;
  } catch (e) { return null; }
}

function latlongGetOrCreateSheet_() {
  var ss = getActiveSS();
  var sheet = latlongFindSheet_();
  if (!sheet) sheet = ss.insertSheet(LATLONG_SHEET_NAME);
  return sheet;
}

function latlongClearCache_() {
  try { CacheService.getUserCache().remove(LATLONG_CACHE_KEY); } catch (e) {}
  try { CacheService.getUserCache().remove(FIR_CACHE_KEY_ROUTE_POLYLINE); } catch (e) {}
  try { if (typeof firClearAppCache === 'function') firClearAppCache(); } catch (e) {}
}

function latlongDetectHeader_(values) {
  // values = 2D array from getValues()
  if (!values || values.length === 0) return null;
  // Check first 3 rows for header keywords
  for (var r = 0; r < Math.min(values.length, 3); r++) {
    var row = values[r].map(function(c){ return String(c||'').trim(); });
    var joined = row.join('|').toUpperCase();
    var hasWaypoint = row.some(function(c){ return /WAYPOINT|WPT|NAME|FIX/i.test(c); });
    var hasLat = row.some(function(c){ return /LAT/i.test(c); });
    var hasLon = row.some(function(c){ return /LON/i.test(c); });
    var hasId = row.some(function(c){ return /^ID$/i.test(c); });
    if ((hasWaypoint && (hasLat || hasLon)) || (hasId && hasWaypoint)) {
      // Map column indices
      var colMap = { idIdx: -1, wptIdx: -1, latIdx: -1, lonIdx: -1, headerRow: r, header: row };
      for (var c = 0; c < row.length; c++) {
        var u = row[c].toUpperCase();
        if (/^ID$/.test(u)) colMap.idIdx = c;
        else if (/WAYPOINT|WPT|NAME|FIX/.test(u) && colMap.wptIdx === -1) colMap.wptIdx = c;
        else if (/LAT/.test(u) && colMap.latIdx === -1) colMap.latIdx = c;
        else if (/LON/.test(u) && colMap.lonIdx === -1) colMap.lonIdx = c;
      }
      // Fallbacks for 3-col/4-col without strict naming
      if (colMap.wptIdx === -1 && row.length >= 1) colMap.wptIdx = 0;
      if (colMap.latIdx === -1 && row.length >= 2) colMap.latIdx = colMap.idIdx >=0 ? 2 : 1;
      if (colMap.lonIdx === -1 && row.length >= 3) colMap.lonIdx = colMap.idIdx >=0 ? 3 : 2;
      return colMap;
    }
  }
  // No header found — infer from column count
  var firstRow = values[0] || [];
  if (firstRow.length >= 4) return { idIdx: 0, wptIdx: 1, latIdx: 2, lonIdx: 3, headerRow: -1, header: null };
  if (firstRow.length === 3) return { idIdx: -1, wptIdx: 0, latIdx: 1, lonIdx: 2, headerRow: -1, header: null };
  if (firstRow.length === 2) return { idIdx: -1, wptIdx: 0, latIdx: 1, lonIdx: 1, headerRow: -1, header: null };
  return { idIdx: -1, wptIdx: 0, latIdx: 1, lonIdx: 2, headerRow: -1, header: null };
}

function latlongNormalizeHeader_(colMap, hasId) {
  if (hasId) return ['ID','Waypoint','Latitude','Longitude'];
  return ['Waypoint','Latitude','Longitude'];
}

/**
 * Parse raw paste text into waypoint entries.
 * orderMode: 'column' (left col first, then right) or 'row' (interleaved as copied)
 * Returns { entries:[{waypoint, latStr, lonStr, display}], skipped, rawCount }
 */
function latlongParseWaypoints_(rawText, orderMode) {
  if (!rawText || typeof rawText !== 'string') return { entries: [], skipped: 0, rawCount: 0 };
  var text = rawText.replace(/\r/g, '');
  var lines = text.split('\n');
  // Entry regex: NAME  S|N  DD  MM.M  E|W DDD MM.M
  // NAME can be alphanumeric like WADD, 08S115E, PU20, VTK
  var entryRe = /([A-Z0-9]{2,10})\s+([NS])\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s+([EW])\s+(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)/gi;
  var rowWise = [];
  var leftEntries = [];
  var rightEntries = [];
  var skippedLines = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    // Find all matches in this line
    var matches = [];
    var m;
    entryRe.lastIndex = 0;
    while ((m = entryRe.exec(line)) !== null) {
      // Avoid zero-length infinite loop
      if (m[0].length === 0) { entryRe.lastIndex++; continue; }
      matches.push(m.slice(0));
    }
    if (matches.length === 0) {
      // Check if line is header or noise (e.g., "LATLONG", "WAYPOINT")
      if (/WAYPOINT|LATITUDE|LONGITUDE|ID/i.test(line)) { skippedLines++; continue; }
      // Try alternative tab-split fallback: if line contains waypoint-like token but no full coord, skip
      if (line.length > 3) skippedLines++;
      continue;
    }
    // Build entries for this line
    for (var j = 0; j < matches.length; j++) {
      var mm = matches[j];
      var wpt = String(mm[1] || '').trim().toUpperCase();
      var latHem = String(mm[2] || '').trim().toUpperCase();
      var latDeg = String(mm[3] || '').trim();
      var latMin = String(mm[4] || '').trim();
      var lonHem = String(mm[5] || '').trim().toUpperCase();
      var lonDeg = String(mm[6] || '').trim();
      var lonMin = String(mm[7] || '').trim();
      // Normalize degrees padding
      latDeg = latDeg.length === 1 ? '0' + latDeg : latDeg;
      if (latDeg.length > 2) latDeg = latDeg.slice(-2);
      lonDeg = lonDeg.length === 1 ? '00' + lonDeg : lonDeg.length === 2 ? '0' + lonDeg : lonDeg;
      if (lonDeg.length > 3) lonDeg = lonDeg.slice(-3);
      var latStr = latHem + ' ' + latDeg + ' ' + latMin;
      var lonStr = lonHem + ' ' + lonDeg + ' ' + lonMin;
      var entry = {
        waypoint: wpt,
        latHem: latHem,
        latDeg: latDeg,
        latMin: latMin,
        lonHem: lonHem,
        lonDeg: lonDeg,
        lonMin: lonMin,
        latStr: latStr,
        lonStr: lonStr,
        display: wpt + ' ' + latStr + ' ' + lonStr,
        sourceLine: i + 1
      };
      rowWise.push(entry);
      if (j === 0) leftEntries.push(entry);
      else if (j === 1) rightEntries.push(entry);
      else {
        // More than 2 per line: treat extra as row-wise only (append to rowWise already)
        // also push to right for column completeness if needed
        rightEntries.push(entry);
      }
    }
  }
  var finalEntries;
  if (orderMode === 'column' && rightEntries.length > 0) {
    finalEntries = leftEntries.concat(rightEntries);
  } else {
    finalEntries = rowWise;
  }
  // Deduplicate by waypoint (keep first occurrence order, but report duplicates)
  var seen = {};
  var deduped = [];
  var dupCount = 0;
  for (var k = 0; k < finalEntries.length; k++) {
    var e = finalEntries[k];
    var key = e.waypoint;
    if (seen[key]) { dupCount++; continue; }
    seen[key] = true;
    deduped.push(e);
  }
  return {
    entries: deduped,
    rawCount: rowWise.length,
    dedupedCount: deduped.length,
    skipped: skippedLines,
    dupCount: dupCount,
    orderMode: orderMode || 'row',
    leftCount: leftEntries.length,
    rightCount: rightEntries.length
  };
}

/**
 * Preview only — no sheet write.
 * Returns { ok, entries, count, skipped, dupCount, leftCount, rightCount }
 */
function latlongGetPreview(rawText, orderMode) {
  try {
    if (!rawText || String(rawText).trim() === '') return { ok: false, error: 'Paste text is empty.' };
    var mode = String(orderMode || 'column').toLowerCase();
    if (mode !== 'row' && mode !== 'column') mode = 'column';
    var parsed = latlongParseWaypoints_(rawText, mode);
    if (!parsed.entries || parsed.entries.length === 0) {
      return { ok: false, error: 'No valid waypoints found. Expected format: NAME S DD MM.M E DDD MM.M (e.g. WADD S 08 44.8 E 115 10.2)', skipped: parsed.skipped };
    }
    return {
      ok: true,
      entries: parsed.entries,
      count: parsed.entries.length,
      rawCount: parsed.rawCount,
      skipped: parsed.skipped,
      dupCount: parsed.dupCount,
      leftCount: parsed.leftCount,
      rightCount: parsed.rightCount,
      orderMode: parsed.orderMode
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Read current LATLONG sheet for editor display.
 * Returns { ok, header, rows, count, colMap }
 */
function latlongParseDMS(val) {
  var s = String(val == null ? '' : val).trim();
  var m = s.match(/^([NSEW])\s*(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)/i);
  if (!m) return null;
  var dec = parseInt(m[2], 10) + parseFloat(m[3]) / 60;
  if (/^[SW]$/i.test(m[1])) dec = -dec;
  return dec;
}

function latlongGetRoutePolyline(routeId) {
  try {
    var rid = String(routeId || '').trim().toUpperCase();
    if (!rid) return null;
    var cache = CacheService.getUserCache();
    var cached = cache.get(FIR_CACHE_KEY_ROUTE_POLYLINE);
    var map = null;
    if (cached) { try { map = JSON.parse(cached); } catch (e) {} }
    if (!map) {
      map = {};
      var data = latlongGetEditorData();
      (data && data.rows || []).forEach(function (r) {
        var id = String(r.ID || '').trim().toUpperCase();
        if (!id) return;
        var lat = latlongParseDMS(r.Latitude);
        var lon = latlongParseDMS(r.Longitude);
        if (lat === null || lon === null) return;
        if (!map[id]) map[id] = [];
        map[id].push([lat, lon]);
      });
      try { cache.put(FIR_CACHE_KEY_ROUTE_POLYLINE, JSON.stringify(map), CACHE_TTL_ROUTE_POLYLINE); } catch (e) {}
    }
    var pts = map[rid];
    return (pts && pts.length >= 2) ? pts : null;
  } catch (e) { return null; }
}

function latlongGetEditorData() {
  try {
    var cache = CacheService.getUserCache();
    var cached = cache.get(LATLONG_CACHE_KEY);
    if (cached) {
      try { var p = JSON.parse(cached); if (p && p.ok) return p; } catch (e) {}
    }
    var sheet = latlongFindSheet_();
    if (!sheet) return { ok: true, header: ['ID','Waypoint','Latitude','Longitude'], rows: [], count: 0, colMap: { idIdx:0, wptIdx:1, latIdx:2, lonIdx:3, headerRow:-1 }, isNew: true };
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return { ok: true, header: ['ID','Waypoint','Latitude','Longitude'], rows: [], count: 0, colMap: { idIdx:0, wptIdx:1, latIdx:2, lonIdx:3, headerRow:-1 } };
    var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var colMap = latlongDetectHeader_(values);
    var headerRowIdx = colMap.headerRow;
    var dataStart = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;
    // If headerRow is -1 and first row looks like data, treat first row as data but synthesize header
    var header;
    if (colMap.header) header = colMap.header;
    else header = colMap.idIdx >= 0 ? ['ID','Waypoint','Latitude','Longitude'] : ['Waypoint','Latitude','Longitude'];
    var rows = [];
    for (var r = dataStart; r < values.length; r++) {
      var row = values[r];
      if (!row || row.every(function(c){ return String(c||'').trim()===''; })) continue;
      var wpt = String(row[colMap.wptIdx] || '').trim();
      var lat = String(row[colMap.latIdx] || '').trim();
      var lon = String(row[colMap.lonIdx] || '').trim();
      if (!wpt) continue;
      // Skip header-like rows that slipped through
      if (/WAYPOINT/i.test(wpt) && /LAT/i.test(lat)) continue;
      var id = colMap.idIdx >=0 ? String(row[colMap.idIdx] || '').trim() : '';
      rows.push({
        rowId: r + 1,
        ID: id,
        Waypoint: wpt,
        Latitude: lat,
        Longitude: lon,
        _raw: row
      });
    }
    var result = { ok: true, header: header, rows: rows, count: rows.length, colMap: colMap, sheetName: sheet.getName() };
    try { cache.put(LATLONG_CACHE_KEY, JSON.stringify(result), LATLONG_CACHE_TTL); } catch (e) {}
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Bulk save — modes: replace | append | merge
 * rawText: paste text, mode: string, routeId: optional (for 4-col sheets), orderMode: 'column'|'row'
 * Returns { ok, count, mode, header, inserted, updated }
 */
function latlongSaveBulk(payload) {
  try {
    requireAuthorized();
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'No payload.' };
    var rawText = String(payload.rawText || payload.text || '');
    var mode = String(payload.mode || 'replace').toLowerCase();
    if (['replace','append','merge'].indexOf(mode) === -1) mode = 'replace';
    var orderMode = String(payload.orderMode || 'column').toLowerCase();
    if (orderMode !== 'row' && orderMode !== 'column') orderMode = 'column';
    var routeId = String(payload.routeId || payload.ID || '').trim().toUpperCase();
    if (!routeId) return { ok: false, error: 'ROUTE ID required for Variant B (ID column). Enter Route ID in Web App (e.g. WADDWSSS01).' };

    var parsed = latlongParseWaypoints_(rawText, orderMode);
    if (!parsed.entries || parsed.entries.length === 0) {
      return { ok: false, error: 'No valid waypoints found. Expected: NAME S DD MM.M E DDD MM.M', skipped: parsed.skipped };
    }
    var entries = parsed.entries;

    var ss = getActiveSS();
    var sheet = latlongGetOrCreateSheet_();
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    var colMap = null;
    var header = null;
    if (lastRow >= 1 && lastCol >= 1) {
      var vals = sheet.getRange(1, 1, Math.min(lastRow, 10), lastCol).getValues();
      colMap = latlongDetectHeader_(vals);
      // Always Variant B header — even if sheet was 3-col, we will upgrade below
      header = ['ID','Waypoint','Latitude','Longitude'];
    } else {
      // Fresh sheet — always Variant B
      header = ['ID','Waypoint','Latitude','Longitude'];
      colMap = { idIdx:0, wptIdx:1, latIdx:2, lonIdx:3, headerRow:0, header: header };
    }

    // Enforce Variant B: upgrade any 3-col sheet to 4-col (insert ID column)
    if (colMap && colMap.idIdx === -1) {
      header = ['ID','Waypoint','Latitude','Longitude'];
      colMap = { idIdx:0, wptIdx:1, latIdx:2, lonIdx:3, headerRow:0, header: header };
      // Need to rewrite existing data with new ID column if sheet had data
      if (sheet.getLastRow() > 0) {
        var allVals = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
        var existingColMap = latlongDetectHeader_(allVals);
        var start = existingColMap.headerRow >=0 ? existingColMap.headerRow + 1 : 0;
        var newData = [header];
        for (var r = start; r < allVals.length; r++) {
          var w = String(allVals[r][existingColMap.wptIdx] || '').trim();
          var la = String(allVals[r][existingColMap.latIdx] || '').trim();
          var lo = String(allVals[r][existingColMap.lonIdx] || '').trim();
          if (!w) continue;
          newData.push(['', w, la, lo]);
        }
        sheet.clear();
        if (newData.length > 0) sheet.getRange(1, 1, newData.length, 4).setValues(newData);
        colMap = { idIdx:0, wptIdx:1, latIdx:2, lonIdx:3, headerRow:0, header: header };
      } else {
        sheet.clear();
        sheet.getRange(1, 1, 1, 4).setValues([header]);
      }
    }

    // Ensure header row exists if sheet was empty
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      colMap.headerRow = 0;
    } else if (colMap.headerRow === -1) {
      // Sheet has data but no header — insert header at top
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      colMap.headerRow = 0;
    }

    var inserted = 0, updated = 0;

    // Helper: detect blank separator rows (all empty) — skipped by FIR map/reader, but visible in Editor
    function isBlankRow_(rowArr) { return !rowArr || rowArr.every(function(c){ return String(c||'').trim()===''; }); }
    // Helper: ensure exactly one blank separator row exists before a new route block — ponytail: single row gap, not grouped block
    function ensureOneBlankGap_() {
      var lr = sheet.getLastRow();
      if (lr <= 1) return;
      var lastVals = sheet.getRange(lr, 1, 1, header.length).getValues()[0];
      if (!isBlankRow_(lastVals)) sheet.appendRow(Array(header.length).fill(''));
    }

    if (mode === 'replace') {
      // Keep header, replace all data rows — no separator needed (single route block)
      var headerVals = sheet.getRange(1, 1, 1, header.length).getValues();
      sheet.clear();
      sheet.getRange(1, 1, 1, header.length).setValues(headerVals);
      var rows = entries.map(function(e){
        if (colMap.idIdx >=0) return [routeId || '', e.waypoint, e.latStr, e.lonStr];
        return [e.waypoint, e.latStr, e.lonStr];
      });
      if (rows.length > 0) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
      inserted = rows.length;
    } else if (mode === 'append') {
      // One blank separator row between route blocks so Route IDs don't merge visually
      ensureOneBlankGap_();
      var startRow = sheet.getLastRow() + 1;
      var rows2 = entries.map(function(e){
        if (colMap.idIdx >=0) return [routeId || '', e.waypoint, e.latStr, e.lonStr];
        return [e.waypoint, e.latStr, e.lonStr];
      });
      if (rows2.length > 0) sheet.getRange(startRow, 1, rows2.length, header.length).setValues(rows2);
      inserted = rows2.length;
    } else if (mode === 'merge') {
      // Merge by waypoint (FIX + ID composite key when possible) — blank rows ignored
      var dataVals = sheet.getRange(1, 1, sheet.getLastRow(), header.length).getValues();
      var map = {}; // composite key -> row index (1-based)
      for (var rr = 1; rr < dataVals.length; rr++) {
        if (isBlankRow_(dataVals[rr])) continue;
        var wp2 = String(dataVals[rr][colMap.wptIdx] || '').trim().toUpperCase();
        if (!wp2) continue;
        var id2 = colMap.idIdx >=0 ? String(dataVals[rr][colMap.idIdx] || '').trim().toUpperCase() : '';
        var key2 = id2 ? (id2 + '|' + wp2) : wp2;
        map[key2] = rr + 1; // prefer ID-scoped key; also index waypoint-only for fallback
        if (id2 && !map[wp2]) map[wp2] = rr + 1;
      }
      var pendingInserts = [];
      for (var ei = 0; ei < entries.length; ei++) {
        var ent = entries[ei];
        var key = ent.waypoint.toUpperCase();
        var scopedKey = routeId ? (routeId.toUpperCase() + '|' + key) : key;
        var hit = map[scopedKey] || map[key];
        if (hit) {
          var rowIdx = hit;
          if (colMap.idIdx >=0 && routeId) sheet.getRange(rowIdx, colMap.idIdx + 1).setValue(routeId);
          sheet.getRange(rowIdx, colMap.wptIdx + 1).setValue(ent.waypoint);
          sheet.getRange(rowIdx, colMap.latIdx + 1).setValue(ent.latStr);
          sheet.getRange(rowIdx, colMap.lonIdx + 1).setValue(ent.lonStr);
          updated++;
        } else {
          pendingInserts.push(ent);
        }
      }
      if (pendingInserts.length > 0) {
        // Batch-insert with a single separator before the batch
        ensureOneBlankGap_();
        var startRow2 = sheet.getLastRow() + 1;
        var insertRows = pendingInserts.map(function(en){ return colMap.idIdx >=0 ? [routeId || '', en.waypoint, en.latStr, en.lonStr] : [en.waypoint, en.latStr, en.lonStr]; });
        if (insertRows.length > 0) sheet.getRange(startRow2, 1, insertRows.length, header.length).setValues(insertRows);
        inserted = insertRows.length;
      }
    }

    latlongClearCache_();

    // Format header bold and auto-resize?
    try {
      sheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#E8EEF6');
      sheet.autoResizeColumns(1, header.length);
    } catch (e) {}

    return {
      ok: true,
      count: entries.length,
      inserted: inserted,
      updated: updated,
      skipped: parsed.skipped,
      dupCount: parsed.dupCount,
      mode: mode,
      orderMode: orderMode,
      header: header,
      routeId: routeId || null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Delete a waypoint by name (case-insensitive).
 */
function latlongDeleteWaypoint(waypoint) {
  try {
    requireAuthorized();
    var wpt = String(waypoint || '').trim().toUpperCase();
    if (!wpt) return { ok: false, error: 'FIX / Waypoint identifier required.' };
    var sheet = latlongFindSheet_();
    if (!sheet) return { ok: false, error: 'Sheet LATLONG not found.' };
    var data = latlongGetEditorData();
    if (!data.ok) return data;
    var rowId = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i].Waypoint).trim().toUpperCase() === wpt) { rowId = data.rows[i].rowId; break; }
    }
    if (!rowId) return { ok: false, error: 'FIX ' + wpt + ' not found in LATLONG.' };
    sheet.deleteRow(rowId);
    latlongClearCache_();
    return { ok: true, deleted: wpt, rowId: rowId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Clear all data rows (keep header).
 */
function latlongClearAll() {
  try {
    requireAuthorized();
    var sheet = latlongFindSheet_();
    if (!sheet) return { ok: false, error: 'Sheet LATLONG not found.' };
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { ok: true, cleared: 0 };
    sheet.deleteRows(2, lastRow - 1);
    latlongClearCache_();
    return { ok: true, cleared: lastRow - 1 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function latlongGetDiagnostics() {
  try {
    var ss = getActiveSS();
    var sheet = latlongFindSheet_();
    if (!sheet) return { ok: false, error: 'Sheet LATLONG not found.', sheets: ss.getSheets().map(function(s){ return s.getName(); }) };
    var data = latlongGetEditorData();
    return { ok: true, sheet: sheet.getName(), header: data.header, count: data.count, colMap: data.colMap, sample: data.rows.slice(0,3) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function smokeTestLatLong() {
  var preview = latlongGetPreview("WADD S 08 44.8 E 115 10.2\nPU20 N 01 45.5 E 103 58.2", 'column');
  var data = latlongGetEditorData();
  console.log(JSON.stringify({ preview: preview, currentCount: data.count, header: data.header }, null, 2));
  return { preview: preview.count, current: data.count };
}
