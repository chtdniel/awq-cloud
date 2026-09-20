function doGet(e) {
  var event = e || {};
  if (event.parameter && event.parameter.page === 'report') {
    return HtmlService.createTemplateFromFile('Report')
      .evaluate()
      .setTitle('AWQ OCC | Report')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('AWQ OCC | Dispatch Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('spreadsheetId');

function getActiveSS() {
  if (!SPREADSHEET_ID) throw new Error('Spreadsheet ID not configured.');
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getDatabaseStatus() {
  try {
    const ss = getActiveSS();
    return { ok: true, name: ss.getName(), id: ss.getId(), sheets: ss.getSheets().map(sheet => sheet.getName()) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Identity-based authorization guard for write/destructive endpoints.
 *
 * Configure the allowlist via Script Property:  OCC_ALLOWED_EMAILS
 * e.g. "ops@airasia.com, supervisor@airasia.com"
 *
 * If the property is empty/unset, authorization is DISABLED (open access) to
 * preserve current behavior. Once set, only listed users may call protected
 * endpoints. Add `requireAuthorized()` at the top of any destructive function.
 */
function getCurrentUserEmail() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

function isAuthorizedUser() {
  if (isSettingsAdmin()) return true; // ponytail: settings admin can save OCC allowlist too
  const allowed = PropertiesService.getScriptProperties().getProperty('OCC_ALLOWED_EMAILS') || '';
  if (!allowed.trim()) return true;
  const user = getCurrentUserEmail().toLowerCase();
  if (!user) return false;
  return allowed.toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(user);
}

function requireAuthorized() {
  if (!isAuthorizedUser()) {
    throw new Error('UNAUTHORIZED: You do not have permission to perform this operation.');
  }
}

/**
 * Gate B prerequisite diagnostic (read-only).
 * Reports operator/effective identity, template + REPORT_AUDIT availability, and
 * whether the session passes OCC_ALLOWED_EMAILS. Used to verify operator identity
 * and template/audit access in the nonproduction deployment before full implementation.
 */
function reportHandoffDiagnostic() {
  var out = { ok: true, errors: [] };
  try { out.activeUser = Session.getActiveUser().getEmail() || ''; } catch (e) { out.errors.push('activeUser: ' + e.message); }
  try { out.effectiveUser = Session.getEffectiveUser().getEmail() || ''; } catch (e) { out.errors.push('effectiveUser: ' + e.message); }
  try {
    var props = PropertiesService.getScriptProperties();
    out.spreadsheetId = props.getProperty('spreadsheetId') || '';
    out.allowedEmailsConfigured = !!(props.getProperty('OCC_ALLOWED_EMAILS') || '').trim();
  } catch (e) { out.errors.push('properties: ' + e.message); }
  try {
    var ss = getActiveSS();
    out.spreadsheetName = ss.getName();
    out.templates = {};
    ['CBR1', 'CBR2', 'CBR4'].forEach(function (name) { out.templates[name] = !!ss.getSheetByName(name); });
    out.auditSheetExists = !!ss.getSheetByName('REPORT_AUDIT');
  } catch (e) { out.errors.push('spreadsheet: ' + e.message); }
  try { out.isAuthorized = isAuthorizedUser(); } catch (e) { out.errors.push('authz: ' + e.message); }
  return out;
}

/**
 * Shared email-list normalizer for allowlist setters.
 * Split on comma/semicolon/newline, trim, validate, dedup case-insensitive
 * (keep first casing), sort case-insensitive. Throws on invalid email.
 * Extracted to kill 3x duplicated seen/deduped/sort blocks (safe-refactor).
 */
function occNormalizeEmailList(csv) {
  var input = String(csv || '');
  var parts = input.split(/[,;\n]+/).map(function(s){ return String(s || '').trim(); }).filter(Boolean);
  var emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var invalid = parts.filter(function(e){ return !emailRe.test(e); });
  if (invalid.length) {
    throw new Error('Invalid email(s): ' + invalid.join(', '));
  }
  var seen = {};
  var deduped = [];
  parts.forEach(function(e){
    var k = e.toLowerCase();
    if (!seen[k]) { seen[k] = true; deduped.push(e); }
  });
  deduped.sort(function(a, b){ return a.toLowerCase().localeCompare(b.toLowerCase()); });
  return deduped;
}

/**
 * Settings admin access control.
 * Configure via Script Property: SETTINGS_ADMIN_EMAILS
 */
function isSettingsAdmin() {
  const allowed = PropertiesService.getScriptProperties().getProperty('SETTINGS_ADMIN_EMAILS') || '';
  if (!allowed.trim()) return false; // locked: no admin
  const user = getCurrentUserEmail().toLowerCase();
  if (!user) return false;
  return allowed.toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(user);
}

function getSettingsAccessInfo() {
  const user = getCurrentUserEmail();
  const canView = isSettingsAdmin();
  return {
    ok: true,
    user: user,
    canView: canView,
    canEdit: canView
  };
}

/**
 * Read current admin list for the Settings UI panel.
 * Login-gated; returns raw + normalized list. Viewable by logged-in users
 * (page itself is admin-gated client-side via getSettingsAccessInfo).
 */
function getSettingsAdminList() {
  var currentUser = getCurrentUserEmail();
  if (!currentUser) {
    return { ok:false, error:'Login required to access settings.' };
  }
  var raw = PropertiesService.getScriptProperties().getProperty('SETTINGS_ADMIN_EMAILS') || '';
  var deduped = occNormalizeEmailList(raw); // stored values already validated on write
  return { ok:true, raw: raw, admins: deduped, currentUser: currentUser };
}

function setSettingsAdminEmails(csv) {
  if (!isSettingsAdmin()) {
    throw new Error('UNAUTHORIZED: Admin access required to change admin list.');
  }
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    lock.waitLock(15000);
    gotLock = true;
    var deduped = occNormalizeEmailList(csv);
    var props = PropertiesService.getScriptProperties();
    if (deduped.length===0) {
      props.deleteProperty('SETTINGS_ADMIN_EMAILS');
    } else {
      props.setProperty('SETTINGS_ADMIN_EMAILS', deduped.join(', '));
    }
    return getSettingsAccessInfo();
  } finally {
    if (gotLock) try { lock.releaseLock(); } catch(e){}
  }
}

/**
 * Settings: OCC_ALLOWED_EMAILS allowlist.
 * Read requires a valid session (no longer open to anonymous).
 * Write requires authorization.
 */
function getOccSettings() {
  try {
    var currentUser = getCurrentUserEmail();
    // Require at least a logged-in user to read settings
    if (!currentUser) {
      return { ok:false, error:'Login required to access settings.' };
    }
    var raw = PropertiesService.getScriptProperties().getProperty('OCC_ALLOWED_EMAILS') || '';
    var allowed = raw.split(',').map(function(s){ return String(s||'').trim(); }).filter(Boolean);
    // dedup case-insensitive, preserve original case of first occurrence, sort case-insensitive
    var seen = {};
    var deduped = [];
    allowed.forEach(function(e){
      var k = e.toLowerCase();
      if(!seen[k]){ seen[k]=true; deduped.push(e); }
    });
    deduped.sort(function(a,b){ return a.toLowerCase().localeCompare(b.toLowerCase()); });
    var isOpen = !raw.trim();
    var isAuthorized = isAuthorizedUser();
    return { ok:true, raw: raw, allowed: deduped, currentUser: currentUser, isAuthorized: isAuthorized, isOpen: isOpen };
  } catch (e) {
    return { ok:false, error: e.message };
  }
}

function setOccAllowedEmails(csv) {
  requireAuthorized();
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    lock.waitLock(15000);
    gotLock = true;
    // accept commas, semicolons and newlines via shared normalizer
    var deduped = occNormalizeEmailList(csv);
    var props = PropertiesService.getScriptProperties();
    if(deduped.length===0){
      props.deleteProperty('OCC_ALLOWED_EMAILS');
    } else {
      props.setProperty('OCC_ALLOWED_EMAILS', deduped.join(', '));
    }
    return getOccSettings();
  } finally {
    if(gotLock) try{ lock.releaseLock(); }catch(e){}
  }
}

/**
 * System panel (read-only): spreadsheetId/name, timezone, OCC_FIR_LINK.
 * Read requires a logged-in user. No write gate beyond login.
 */
function getOccSystemSettings() {
  try {
    var currentUser = getCurrentUserEmail();
    if (!currentUser) {
      return { ok:false, error:'Login required to access settings.' };
    }
    var props = PropertiesService.getScriptProperties();
    var spreadsheetId = props.getProperty('spreadsheetId') || '';
    var spreadsheetName = '';
    try {
      if (spreadsheetId) spreadsheetName = SpreadsheetApp.openById(spreadsheetId).getName();
    } catch (e) { spreadsheetName = ''; }
    var timezone = props.getProperty('SCRIPT_TIMEZONE') || 'Asia/Makassar';
    var occFirLink = props.getProperty('OCC_FIR_LINK') || '';
    return {
      ok:true,
      spreadsheetId: spreadsheetId,
      spreadsheetName: spreadsheetName,
      timezone: timezone,
      occFirLink: occFirLink,
      occFirLinkDeprecated: true
    };
  } catch (e) {
    return { ok:false, error: e.message };
  }
}

/**
 * H4 bundle: one roundtrip for Settings tab open.
 * Combines access + allowlist + admin list + system. Each sub-call keeps
 * its own login gate; bundle fails closed if no session.
 */
function getSettingsBundle() {
  var currentUser = getCurrentUserEmail();
  if (!currentUser) {
    return { ok:false, error:'Login required to access settings.' };
  }
  var access = getSettingsAccessInfo();
  var settings = getOccSettings();
  var admins = { ok:true, admins:[] };
  try { admins = getSettingsAdminList(); } catch (e) { admins = { ok:false, error: e.message }; }
  var system = { ok:true };
  try { system = getOccSystemSettings(); } catch (e) { system = { ok:false, error: e.message }; }
  var wx = { ok:true };
  try { wx = wxAiGetCatalog(); } catch (e) { wx = { ok:false, error: e.message }; }
  return { ok:true, access: access, settings: settings, admins: admins, system: system, wx: wx };
}

/**
 * DEPRECATED: FIR uses integrated internal view (Index.html: view-fir).
 * OCC_FIR_LINK is not used by navigation. Kept for clearing legacy values only.
 */
function getFirLink() {
  return PropertiesService.getScriptProperties().getProperty('OCC_FIR_LINK') || '';
}

/**
 * DEPRECATED: see getFirLink. Only clearing (empty value) is meaningful now.
 */
function saveFirLink(url) {
  requireAuthorized();
  const value = String(url || '').trim();
  if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
    throw new Error('FIR URL must start with http:// or https:// and contain no spaces.');
  }
  const properties = PropertiesService.getScriptProperties();
  if (value) properties.setProperty('OCC_FIR_LINK', value);
  else properties.deleteProperty('OCC_FIR_LINK');
  return value;
}

function getNotamData() {
  const sheet = getActiveSS().getSheetByName('NOTAM');
  if (!sheet) throw new Error("Sheet named 'NOTAM' was not found.");
  return sheet.getDataRange().getValues();
}

function getNotamUpdateHistory() {
  const sheet = getActiveSS().getSheetByName('NOTAM_HISTORY');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  return values.slice(1).reverse().map(row => ({
    // Display as UTC ISO 8601 with Z for operational consistency
    timestamp: row[0] ? Utilities.formatDate(new Date(row[0]), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'") : '',
    user: String(row[1] || ''),
    rowCount: row[2] || '',
    queryStr: String(row[3] || '')
  }));
}

/**
 * Add ROUTE ID column to FLT INFO sheet (Column W = index 22)
 * Run once to initialize the column header.
 */
function addRouteIdColumnToFltInfo() {
  requireAuthorized();
  const ss = getActiveSS();
  const sheet = ss.getSheetByName('FLT INFO');
  if (!sheet) throw new Error("Sheet 'FLT INFO' not found.");

  const lastCol = sheet.getLastColumn();
  const targetCol = 23; // Column W = 23rd column (1-indexed)

  // Ensure sheet has at least 23 columns
  if (lastCol < targetCol) {
    sheet.insertColumnsAfter(lastCol, targetCol - lastCol);
  }

  // Set header at row 1, column W
  const headerRange = sheet.getRange(1, targetCol);
  if (headerRange.getValue() !== 'ROUTE ID') {
    headerRange.setValue('ROUTE ID');
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#4472C4');
    headerRange.setFontColor('#FFFFFF');
  }

  SpreadsheetApp.flush();
  return { ok: true, message: 'ROUTE ID column added at column W (23)', column: targetCol };
}

/**
 * Set ROUTE ID for a specific flight row.
 * @param {number} rowId - Row number in FLT INFO sheet (1-indexed, including header)
 * @param {string} routeId - Route ID from Route sheet column A (e.g., 'DPSCGK10')
 */
function setFlightRouteId(rowId, routeId) {
  requireAuthorized();
  const ss = getActiveSS();
  const sheet = ss.getSheetByName('FLT INFO');
  if (!sheet) throw new Error("Sheet 'FLT INFO' not found.");

  const targetCol = 23; // Column W
  const cell = sheet.getRange(rowId, targetCol);
  cell.setValue(routeId.toUpperCase().trim());

  SpreadsheetApp.flush();
  return { ok: true, rowId, routeId: routeId.toUpperCase().trim() };
}

/**
 * Get all route IDs from Route sheet for reference.
 */
function getRouteIdList() {
  const ss = getActiveSS();
  const sheet = ss.getSheetByName('Route');
  if (!sheet) throw new Error("Sheet 'Route' not found.");

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { routes: [] };

  const headers = data[0].map(h => String(h || '').trim().toUpperCase());
  const idIdx = headers.indexOf('ID');
  if (idIdx === -1) throw new Error("Route sheet missing 'ID' column.");

  const routes = [];
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][idIdx] || '').trim();
    if (id) routes.push(id);
  }

  return { routes };
}

/**
 * Test wrapper: Set flight 820 (row 11) ROUTE ID = CGKDPS10
 * Run this once via Apps Script Editor: Run → testSetFlight820RouteId
 */
function testSetFlight820RouteId() {
  return setFlightRouteId(11, 'CGKDPS10');
}

/**
 * Add route to Route sheet with format: DEP_ICAO + ARR_ICAO + 2-digit ID
 * @param {string} routeId - e.g., 'WADDWATO10'
 * @param {string} dep - DEP_AIRPORT ICAO (4-letter) e.g., 'WADD'
 * @param {string} arr - ARR_AIRPORT ICAO (4-letter) e.g., 'WATO'
 * @param {string} [waypoints] - WAYPOINT_SEQ (Airway & Fix) e.g., 'ATMAP KALIV BLI'
 * @param {string} [sid] - SID
 * @param {string} [star] - STAR
 */
function addRoute(routeId, dep, arr, waypoints = '', sid = '', star = '') {
  requireAuthorized();
  const ss = getActiveSS();
  const sheet = ss.getSheetByName('Route');
  if (!sheet) throw new Error("Sheet 'Route' not found.");

  const data = sheet.getDataRange().getValues();
  const headers = data[0] ? data[0].map(h => String(h || '').trim().toUpperCase()) : [];
  
  // Find column indices
  const idIdx = headers.indexOf('ID');
  const depIdx = headers.indexOf('DEP_AIRPORT');
  const arrIdx = headers.indexOf('ARR_AIRPORT');
  const wptIdx = headers.indexOf('WAYPOINT_SEQ (AIRWAY & FIX)');
  const wptIdxAlt = headers.indexOf('WAYPOINT_SEQ');
  const sidIdx = headers.indexOf('SID');
  const starIdx = headers.indexOf('STAR');

  // If no headers, create them
  if (data.length === 0 || idIdx === -1) {
    const newHeaders = ['ID', 'DEP_AIRPORT', 'ARR_AIRPORT', 'SID', 'WAYPOINT_SEQ (Airway & Fix)', 'STAR'];
    sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
    sheet.getRange(1, 1, 1, newHeaders.length).setFontWeight('bold').setBackground('#4472C4').setFontColor('#FFFFFF');
    SpreadsheetApp.flush();
    return addRoute(routeId, dep, arr, waypoints, sid, star); // recursive with headers now
  }

  // Check if route ID already exists
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx] || '').trim().toUpperCase() === routeId.toUpperCase()) {
      return { ok: false, message: `Route ID ${routeId} already exists at row ${i + 1}` };
    }
  }

  // Add new row
  const newRow = data.length + 1;
  const values = new Array(Math.max(idIdx, depIdx, arrIdx, wptIdx, wptIdxAlt, sidIdx, starIdx) + 1).fill('');
  values[idIdx] = routeId.toUpperCase();
  values[depIdx] = dep.toUpperCase();
  values[arrIdx] = arr.toUpperCase();
  if (sidIdx >= 0 && sid) values[sidIdx] = sid;
  const wptFinalIdx = wptIdx >= 0 ? wptIdx : wptIdxAlt;
  if (wptFinalIdx >= 0 && waypoints) values[wptFinalIdx] = waypoints;
  if (starIdx >= 0 && star) values[starIdx] = star;

  sheet.getRange(newRow, 1, 1, values.length).setValues([values]);
  SpreadsheetApp.flush();

  return { ok: true, message: `Route ${routeId} added at row ${newRow}`, row: newRow };
}

/**
 * Add WADD↔WATO routes per user format
 */
function addWaddWatoRoutes() {
  const results = [];
  
  // WADD → WATO (Makassar → Labuan Bajo)
  results.push(addRoute('WADDWATO10', 'WADD', 'WATO', 'ATMAP KALIV BLI'));
  
  // WATO → WADD (Labuan Bajo → Makassar)
  results.push(addRoute('WATOWADD10', 'WATO', 'WADD'));
  
  return results;
}

/**
 * Test wrapper: Run via Apps Script Editor → Run → testAddWaddWatoRoutes
 */
function testAddWaddWatoRoutes() {
  return addWaddWatoRoutes();
}

function testGetOccSettings(){ Logger.log(JSON.stringify(getOccSettings(), null, 2)); }

/**
 * occSettingsSelfCheck — Settings B self-check.
 * Run from Apps Script editor. No framework: throw on fail.
 * Covers: occNormalizeEmailList (dedup/sort/throw/empty), getOccSystemSettings
 * shape, getSettingsAdminList shape. Does not touch Script Properties.
 */
function occSettingsSelfCheck() {
  function eq(a, b, label) {
    var x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error((label || 'value') + ' — expected ' + y + ' got ' + x);
  }
  function ok(cond, label) { if (!cond) throw new Error(label || 'assertion failed'); }
  function throwsBad(fn, label) {
    try { fn(); } catch (e) {
      if (/Invalid email/.test(e.message)) return;
      throw new Error(label + ' — wrong error: ' + e.message);
    }
    throw new Error(label + ' — did not throw');
  }

  // normalizer: dedup case-insensitive, keep first casing, sort
  eq(occNormalizeEmailList(' Ops@x.com,ops@X.com\nZed@Y.co, a@b.co '),
    ['a@b.co', 'Ops@x.com', 'Zed@Y.co'], 'normalize dedup+sort');
  eq(occNormalizeEmailList('b@x.co;a@x.co'), ['a@x.co', 'b@x.co'], 'semicolon split');
  eq(occNormalizeEmailList(''), [], 'empty input');
  eq(occNormalizeEmailList('   '), [], 'blank input');
  throwsBad(function(){ occNormalizeEmailList('not-an-email'); }, 'invalid rejected');
  throwsBad(function(){ occNormalizeEmailList('a@b.co, bad'); }, 'mixed invalid rejected');

  // system settings shape (login-gated — skips value asserts when anonymous)
  var sys = getOccSystemSettings();
  ok(sys && typeof sys === 'object', 'system returns object');
  if (sys.ok) {
    ok('spreadsheetId' in sys, 'system.spreadsheetId');
    ok('spreadsheetName' in sys, 'system.spreadsheetName');
    ok('timezone' in sys, 'system.timezone');
    ok('occFirLink' in sys, 'system.occFirLink');
    eq(sys.occFirLinkDeprecated, true, 'system.deprecated flag');
  } else {
    ok(/Login required/.test(sys.error || ''), 'system login gate');
  }

  // admin list shape
  var adm = getSettingsAdminList();
  ok(adm && typeof adm === 'object', 'admin returns object');
  if (adm.ok) {
    ok(Object.prototype.toString.call(adm.admins) === '[object Array]', 'admin.admins is array');
  } else {
    ok(/Login required/.test(adm.error || ''), 'admin login gate');
  }

  Logger.log('occSettingsSelfCheck: PASS');
  return { ok: true };
}