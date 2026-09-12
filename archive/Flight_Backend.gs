/**
 * Retrieve flight data, Aircraft (A/C) Registration list, and Route List.
 */
function getFlightDashboardData(useCache) {
  if (useCache === undefined) useCache = true;
  const _c = CacheService.getUserCache();
  const _k = 'flight_dashboard_v2';
  if (useCache) { const _hit = _c.get(_k); if (_hit) try { return JSON.parse(_hit); } catch(e) {} }
  const ss = getActiveSS();

  // AIRPORT_TIMEZONE columns: ICAO, TIMEZONE, STATUS
  const airportTimezones = {};
  const timezoneSheet = ss.getSheetByName('AIRPORT_TIMEZONE');
  if (timezoneSheet && timezoneSheet.getLastRow() > 1) {
    timezoneSheet.getRange(2, 1, timezoneSheet.getLastRow() - 1, 3).getDisplayValues().forEach(row => {
      const icao = String(row[0] || '').trim().toUpperCase();
      const timezone = String(row[1] || '').trim();
      const status = String(row[2] || 'ACTIVE').trim().toUpperCase();
      if (icao && timezone && status === 'ACTIVE') airportTimezones[icao] = timezone;
    });
  }
  
  // 1. Fetch Aircraft List (A/C)
  let acList = [];
  const acSheet = ss.getSheetByName('AC');
  if (acSheet) {
    const lastRow = acSheet.getLastRow();
    if (lastRow > 1) {
      const acData = acSheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
      acList = acData
        .map(row => String(row[0] || '').trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index);
    }
  }
  
  // 2. Fetch and Group Route Data
  const routeSheet = ss.getSheetByName('Route');
  const routeMap = {}; // Key: DEP+ARR, Value: Array of routes
  if (routeSheet) {
    const lastRow = routeSheet.getLastRow();
    if (lastRow > 1) {
      const routeData = routeSheet.getRange(2, 1, lastRow - 1, 9).getValues();
      routeData.forEach(r => {
        if (r[0] && r[1] && r[2]) {
          const key = r[1] + r[2];
          if (!routeMap[key]) routeMap[key] = [];
          routeMap[key].push({
            ID: r[0],
            DEP_AIRPORT: r[1],
            ARR_AIRPORT: r[2],
            DEP_RWY: String(r[3]),
            SID: r[4],
            WAYPOINT_SEQ: r[5],
            STAR: r[6],
            ARR_RWY: String(r[7]),
            ROUTE_STRING: r[8]
          });
        }
      });
      
      // Pre-sort all route arrays in the map
      Object.keys(routeMap).forEach(key => {
        routeMap[key].sort((a, b) => {
           const suffixA = parseInt(String(a.ID).slice(-2)) || 99;
           const suffixB = parseInt(String(b.ID).slice(-2)) || 99;
/**
 * Retrieve flight data, Aircraft (A/C) Registration list, and Route List.
 */
function getFlightDashboardData(useCache) {
  if (useCache === undefined) useCache = true;
  const _c = CacheService.getUserCache();
  const _k = 'flight_dashboard_v2';
  if (useCache) { const _hit = _c.get(_k); if (_hit) try { return JSON.parse(_hit); } catch(e) {} }
  const ss = getActiveSS();

  // AIRPORT_TIMEZONE columns: ICAO, TIMEZONE, STATUS
  const airportTimezones = {};
  const timezoneSheet = ss.getSheetByName('AIRPORT_TIMEZONE');
  if (timezoneSheet && timezoneSheet.getLastRow() > 1) {
    timezoneSheet.getRange(2, 1, timezoneSheet.getLastRow() - 1, 3).getDisplayValues().forEach(row => {
      const icao = String(row[0] || '').trim().toUpperCase();
      const timezone = String(row[1] || '').trim();
      const status = String(row[2] || 'ACTIVE').trim().toUpperCase();
      if (icao && timezone && status === 'ACTIVE') airportTimezones[icao] = timezone;
    });
  }
  
  // 1. Fetch Aircraft List (A/C)
  let acList = [];
  const acSheet = ss.getSheetByName('AC');
  if (acSheet) {
    const lastRow = acSheet.getLastRow();
    if (lastRow > 1) {
      const acData = acSheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
      acList = acData
        .map(row => String(row[0] || '').trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index);
    }
  }
  
  // 2. Fetch and Group Route Data
  const routeSheet = ss.getSheetByName('Route');
  const routeMap = {}; // Key: DEP+ARR, Value: Array of routes
  if (routeSheet) {
    const lastRow = routeSheet.getLastRow();
    if (lastRow > 1) {
      const routeData = routeSheet.getRange(2, 1, lastRow - 1, 9).getValues();
      routeData.forEach(r => {
        if (r[0] && r[1] && r[2]) {
          const key = r[1] + r[2];
          if (!routeMap[key]) routeMap[key] = [];
          routeMap[key].push({
            ID: r[0],
            DEP_AIRPORT: r[1],
            ARR_AIRPORT: r[2],
            DEP_RWY: String(r[3]),
            SID: r[4],
            WAYPOINT_SEQ: r[5],
            STAR: r[6],
            ARR_RWY: String(r[7]),
            ROUTE_STRING: r[8]
          });
        }
      });
      
      // Pre-sort all route arrays in the map
      Object.keys(routeMap).forEach(key => {
        routeMap[key].sort((a, b) => {
           const suffixA = parseInt(String(a.ID).slice(-2)) || 99;
           const suffixB = parseInt(String(b.ID).slice(-2)) || 99;
           return suffixA - suffixB;
        });
      });
    }
  }
  
  // 3. Fetch Flight Info from Cloudflare D1 Database
  let flights = [];
  try {
    const query = "SELECT * FROM flights";
    const dbFlights = D1Helper.select(query);
    
    // Map D1 schema to expected frontend format
    for (let i = 0; i < dbFlights.length; i++) {
      const row = dbFlights[i];
      const dep = row.dep;
      const arr = row.dest;
      const routeKey = dep + arr;
      const matchingRoutes = routeMap[routeKey] || [];
      
      flights.push({
        rowIdx: row.id, // Important for updates later
        FLIGHT: row.callsign, 
        DEP: dep, 
        ARR: arr, 
        STD: row.etd, 
        STA: row.eta, 
        REG: row.ac_type, 
        ALT: row.alt, 
        TAF_DEP: row.taf_dep, 
        TAF_ARR: row.taf_arr, 
        CGO: row.cgo,         
        ENR1: row.enr1,         
        ENR2: row.enr2,        
        ENR3: row.enr3,        
        ATC: row.atc,         
        REMARK: row.remarks,      
        DOF: row.dof,         
        ACTIVE_ROUTE_ID: row.active_route_id,
        ROUTES: matchingRoutes 
      });
    }
  } catch (error) {
    Logger.log("Error fetching flights from D1: " + error.toString());
  }
  
  const _out = { flights: flights, acList: acList, airportTimezones: airportTimezones, _cached: new Date().toISOString() }; 
  try { _c.put(_k, JSON.stringify(_out), 60); } catch(e) {} 
  return _out;
}

/**
 * Save inline-cell editing from ACTIVE FLIGHTS dashboard
 */
function saveFlightEdit(rowIdx, colIndex, value) {
  requireAuthorized();
  try {
    // Map Frontend Column Index to D1 Database Column Names
    // Note: This mapping depends on how your frontend grid is laid out.
    // Assuming a standard grid order matching the previous sheet:
    const colMap = {
      2: 'dep', 3: 'dest', 4: 'etd', 5: 'eta', 6: 'ac_type', 
      7: 'alt', 8: 'taf_dep', 9: 'taf_arr', 10: 'enr1', 11: 'enr2', 12: 'enr3',
      13: 'cgo', 14: 'atc', 15: 'remarks', 16: 'dof', 17: 'active_route_id'
    };
    
    const dbCol = colMap[colIndex];
    if (!dbCol) {
      throw new Error("Invalid column for inline edit.");
    }
    
    // Update D1
    const query = `UPDATE flights SET ${dbCol} = ? WHERE id = ?`;
    D1Helper.run(query, [value == null ? '' : String(value), rowIdx]);
    
    firClearFlightDependentCaches_();
    return "OK";
 * Fetch all routes from the 'Route' sheet.
 */
function getAllRoutes() {
  const ss = getActiveSS();
  const routeSheet = ss.getSheetByName('Route');
  if (!routeSheet) return [];
  
  const lastRow = routeSheet.getLastRow();
  if (lastRow < 2) return [];
  
  const data = routeSheet.getRange(2, 1, lastRow - 1, 9).getValues();
  return data.map(r => ({
    ID: r[0],
    DEP_AIRPORT: r[1],
    ARR_AIRPORT: r[2],
    DEP_RWY: String(r[3]),
    SID: r[4],
    WAYPOINT_SEQ: r[5],
    STAR: r[6],
    ARR_RWY: String(r[7]),
    ROUTE_STRING: r[8]
  }));
}

/**
 * Delete a specific route by its ID.
 */
function deleteRoute(routeId) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getActiveSS();
    const routeSheet = ss.getSheetByName('Route');
    const data = routeSheet.getRange(1, 1, routeSheet.getLastRow(), 1).getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(routeId)) {
        routeSheet.deleteRow(i + 1);
        break;
      }
    }
    firClearAppCache();
    return getAllRoutes();
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * Update or Add Route Data from UI Modal.
 * Returns both flight data (for board) and all routes (for manager).
 */
function saveFlightRoute(routeObj) {
  requireAuthorized();
  // Trust-boundary: normalize + validate DEP/ARR ICAO/IATA
  routeObj.DEP_AIRPORT = String(routeObj.DEP_AIRPORT || '').toUpperCase().trim();
  routeObj.ARR_AIRPORT = String(routeObj.ARR_AIRPORT || '').toUpperCase().trim();
  routeObj.ID = String(routeObj.ID || '').toUpperCase().trim();
  if (!routeObj.ID) throw new Error('ROUTE ID required.');
  if (!/^[A-Z]{3,4}$/.test(routeObj.DEP_AIRPORT)) throw new Error('Invalid DEP_AIRPORT: 3-4 letters ICAO/IATA required.');
  if (!/^[A-Z]{3,4}$/.test(routeObj.ARR_AIRPORT)) throw new Error('Invalid ARR_AIRPORT: 3-4 letters ICAO/IATA required.');
  if (routeObj.DEP_AIRPORT === routeObj.ARR_AIRPORT) throw new Error('DEP and ARR must differ.');
  routeObj.DEP_RWY = String(routeObj.DEP_RWY || '').toUpperCase().trim();
  routeObj.ARR_RWY = String(routeObj.ARR_RWY || '').toUpperCase().trim();
  routeObj.SID = String(routeObj.SID || '').toUpperCase().trim();
  routeObj.STAR = String(routeObj.STAR || '').toUpperCase().trim();
  routeObj.WAYPOINT_SEQ = String(routeObj.WAYPOINT_SEQ || '').toUpperCase().trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getActiveSS();
    const routeSheet = ss.getSheetByName('Route');
    if (!routeSheet) throw new Error("Sheet 'Route' not found.");
    const data = routeSheet.getRange(1, 1, routeSheet.getLastRow(), 1).getValues();
    let targetRow = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(routeObj.ID)) { targetRow = i + 1; break; }
    }
    const newRouteString = `${routeObj.DEP_AIRPORT} RWY-${routeObj.DEP_RWY} ${routeObj.SID} ${routeObj.WAYPOINT_SEQ} ${routeObj.STAR} RWY-${routeObj.ARR_RWY} ${routeObj.ARR_AIRPORT}`;
    if (targetRow !== -1) {
      routeSheet.getRange(targetRow, 1, 1, 9).setValues([[
        routeObj.ID, routeObj.DEP_AIRPORT, routeObj.ARR_AIRPORT,
        routeObj.DEP_RWY, routeObj.SID, routeObj.WAYPOINT_SEQ, routeObj.STAR, routeObj.ARR_RWY, newRouteString
      ]]);
    } else {
      routeSheet.appendRow([
        routeObj.ID, routeObj.DEP_AIRPORT, routeObj.ARR_AIRPORT, routeObj.DEP_RWY,
        routeObj.SID, routeObj.WAYPOINT_SEQ, routeObj.STAR, routeObj.ARR_RWY, newRouteString
      ]);
    }
 * Fetch all routes from the 'Route' sheet.
 */
function getAllRoutes() {
  const ss = getActiveSS();
  const routeSheet = ss.getSheetByName('Route');
  if (!routeSheet) return [];
  
  const lastRow = routeSheet.getLastRow();
  if (lastRow < 2) return [];
  
  const data = routeSheet.getRange(2, 1, lastRow - 1, 9).getValues();
  return data.map(r => ({
    ID: r[0],
    DEP_AIRPORT: r[1],
    ARR_AIRPORT: r[2],
    DEP_RWY: String(r[3]),
    SID: r[4],
    WAYPOINT_SEQ: r[5],
    STAR: r[6],
    ARR_RWY: String(r[7]),
    ROUTE_STRING: r[8]
  }));
}

/**
 * Delete a specific route by its ID.
 */
function deleteRoute(routeId) {
  requireAuthorized();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getActiveSS();
    const routeSheet = ss.getSheetByName('Route');
    const data = routeSheet.getRange(1, 1, routeSheet.getLastRow(), 1).getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(routeId)) {
        routeSheet.deleteRow(i + 1);
        break;
      }
    }
    firClearAppCache();
    return getAllRoutes();
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * Update or Add Route Data from UI Modal.
 * Returns both flight data (for board) and all routes (for manager).
 */
function saveFlightRoute(routeObj) {
  requireAuthorized();
  // Trust-boundary: normalize + validate DEP/ARR ICAO/IATA
  routeObj.DEP_AIRPORT = String(routeObj.DEP_AIRPORT || '').toUpperCase().trim();
  routeObj.ARR_AIRPORT = String(routeObj.ARR_AIRPORT || '').toUpperCase().trim();
  routeObj.ID = String(routeObj.ID || '').toUpperCase().trim();
  if (!routeObj.ID) throw new Error('ROUTE ID required.');
  if (!/^[A-Z]{3,4}$/.test(routeObj.DEP_AIRPORT)) throw new Error('Invalid DEP_AIRPORT: 3-4 letters ICAO/IATA required.');
  if (!/^[A-Z]{3,4}$/.test(routeObj.ARR_AIRPORT)) throw new Error('Invalid ARR_AIRPORT: 3-4 letters ICAO/IATA required.');
  if (routeObj.DEP_AIRPORT === routeObj.ARR_AIRPORT) throw new Error('DEP and ARR must differ.');
  routeObj.DEP_RWY = String(routeObj.DEP_RWY || '').toUpperCase().trim();
  routeObj.ARR_RWY = String(routeObj.ARR_RWY || '').toUpperCase().trim();
  routeObj.SID = String(routeObj.SID || '').toUpperCase().trim();
  routeObj.STAR = String(routeObj.STAR || '').toUpperCase().trim();
  routeObj.WAYPOINT_SEQ = String(routeObj.WAYPOINT_SEQ || '').toUpperCase().trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getActiveSS();
    const routeSheet = ss.getSheetByName('Route');
    if (!routeSheet) throw new Error("Sheet 'Route' not found.");
    const data = routeSheet.getRange(1, 1, routeSheet.getLastRow(), 1).getValues();
    let targetRow = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(routeObj.ID)) { targetRow = i + 1; break; }
    }
    const newRouteString = `${routeObj.DEP_AIRPORT} RWY-${routeObj.DEP_RWY} ${routeObj.SID} ${routeObj.WAYPOINT_SEQ} ${routeObj.STAR} RWY-${routeObj.ARR_RWY} ${routeObj.ARR_AIRPORT}`;
    if (targetRow !== -1) {
      routeSheet.getRange(targetRow, 1, 1, 9).setValues([[
        routeObj.ID, routeObj.DEP_AIRPORT, routeObj.ARR_AIRPORT,
        routeObj.DEP_RWY, routeObj.SID, routeObj.WAYPOINT_SEQ, routeObj.STAR, routeObj.ARR_RWY, newRouteString
      ]]);
    } else {
      routeSheet.appendRow([
        routeObj.ID, routeObj.DEP_AIRPORT, routeObj.ARR_AIRPORT, routeObj.DEP_RWY,
        routeObj.SID, routeObj.WAYPOINT_SEQ, routeObj.STAR, routeObj.ARR_RWY, newRouteString
      ]);
    }
    firClearAppCache();
    return { dashboardData: getFlightDashboardData(), allRoutes: getAllRoutes() };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * NEW: Set a specific route ID as ACTIVE for a flight row
 */
function setActiveFlightRoute(rowIdx, routeId) {
  requireAuthorized();
  if (!rowIdx) {
    throw new Error("Invalid flight ID provided for active route selection.");
  }
  
  // Update the database
  D1Helper.run("UPDATE flights SET active_route_id = ? WHERE id = ?", [routeId || "", rowIdx]);
  
  firClearFlightDependentCaches_();
  return getFlightDashboardData();
// =========================================================

/**
 * Fetch all airport notes from 'AIRPORT_NOTES' sheet
 */
function getAirportNotes() {
  const ss = getActiveSS();
  let sheet = ss.getSheetByName("AIRPORT_NOTES");
  
  // Auto-create sheet if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet("AIRPORT_NOTES");
    sheet.appendRow(["ICAO_CODE", "DAY_RANGE", "START_TIME", "END_TIME", "NOTE_TEXT", "TYPE"]);
    return [];
  }
  
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length <= 1) return [];
  
  const headers = data.shift();
  return data.map(row => ({
    ICAO_CODE: row[0].toUpperCase(),
    DAY_RANGE: row[1].toUpperCase(),
    START_TIME: row[2], 
    END_TIME: row[3],
    NOTE_TEXT: row[4],
    TYPE: row[5]
  }));
}

/**
 * Save updated notes for a specific ICAO code.
 */
function saveAirportNotes(icao, newNotes) {
  firClearFlightDependentCaches_();
  requireAuthorized();
  const ss = getActiveSS();
  const sheet = ss.getSheetByName("AIRPORT_NOTES");
  if (!sheet) return getAirportNotes();
  const data = sheet.getDataRange().getValues();
  const keepData = [data[0]]; // Retain headers

  // Filter out existing notes for this ICAO
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toUpperCase() !== icao.toUpperCase()) {
      keepData.push(data[i]);
    }
  }

  // Append new notes
  newNotes.forEach(note => {
    if (note.NOTE_TEXT.trim() !== "") {
      keepData.push([
        icao.toUpperCase(), 
        note.DAY_RANGE.toUpperCase(), 
        note.START_TIME, 
        note.END_TIME, 
        note.NOTE_TEXT, 
        note.TYPE
      ]);
    }
  });

  // Write back to sheet
  sheet.clearContents();
  if (keepData.length > 0) {
    sheet.getRange(1, 1, keepData.length, keepData[0].length).setValues(keepData);
  }

  return getAirportNotes();
}
