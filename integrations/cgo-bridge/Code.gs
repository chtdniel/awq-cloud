/**
 * AWQ Cloud — CGO PLAN sync (Google Apps Script)
 * ==============================================
 *
 * The AirAsia Workspace does not offer "Who has access: Anyone" for Apps Script
 * web apps, so the AWQ Cloud Worker cannot call this script — it has no Google
 * identity. Outbound calls are not restricted, though, so the direction is
 * reversed: this script reads the sheet on a schedule and PUSHES the grid to
 * the Worker.
 *
 *   pushCgoPlan()      read the sheet and POST it to the Worker (run by hand any time)
 *   installCgoTrigger() create the 15-minute schedule that calls pushCgoPlan()
 *   diagnose()          report which account this runs as and whether the sheet opens
 *   doGet(e)            manual check from a browser inside the domain only
 *
 * SETUP (full instructions in docs/cgo-plan-sync.md)
 * --------------------------------------------------
 *  1. script.google.com -> New project, paste this file into Code.gs.
 *  2. Project Settings -> Script properties:
 *       CGO_BRIDGE_TOKEN   the shared token (same value as the Cloudflare secret)
 *     Optional:
 *       WORKER_INGEST_URL  defaults to the AWQ Cloud ingest endpoint
 *       CGO_SHEET_ID       defaults to the AWQ CGO PLAN sheet
 *       CGO_SHEET_NAME     tab name; defaults to the first tab
 *  3. Run installCgoTrigger once and authorize when prompted.
 */

var TOKEN_PROPERTY = 'CGO_BRIDGE_TOKEN';
var WORKER_URL_PROPERTY = 'WORKER_INGEST_URL';
var SHEET_ID_PROPERTY = 'CGO_SHEET_ID';
var SHEET_NAME_PROPERTY = 'CGO_SHEET_NAME';
var DEFAULT_SHEET_ID = '1jHGaWQB5PtzkmVKwb7k_a1nPTZoUhcJjn7NnKWaw-Qg';
var DEFAULT_WORKER_URL = 'https://awq.christiandaniel.my.id/api/cgo-ingest';
var TRIGGER_MINUTES = 15;
var MAX_ROWS = 2000;
var MAX_COLUMNS = 26;

/**
 * Reads the sheet and pushes it to the Worker. This is what the trigger calls;
 * run it by hand whenever the board needs the newest plan before the next tick.
 */
function pushCgoPlan() {
  var properties = PropertiesService.getScriptProperties();
  var token = String(properties.getProperty(TOKEN_PROPERTY) || '').trim();
  if (!token) {
    Logger.log('STOP: set the ' + TOKEN_PROPERTY + ' script property to the same value as the Cloudflare secret.');
    return 'missing ' + TOKEN_PROPERTY;
  }
  var workerUrl = String(properties.getProperty(WORKER_URL_PROPERTY) || DEFAULT_WORKER_URL).trim();

  var read = readPlanSheet_();
  if (read.error) {
    Logger.log('STOP: ' + read.error);
    return read.error;
  }

  var payload = {
    sheetId: read.sheetId,
    sheetName: read.sheetName,
    pushedAt: new Date().toISOString(),
    values: read.values
  };

  var response;
  try {
    response = UrlFetchApp.fetch(workerUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-AWQ-CGO-Token': token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (error) {
    var message = 'Network error calling ' + workerUrl + ': ' + String((error && error.message) || error);
    Logger.log('STOP: ' + message);
    return message;
  }

  var code = response.getResponseCode();
  var text = String(response.getContentText() || '').slice(0, 400);
  Logger.log('Worker answered HTTP ' + code + ': ' + text);
  Logger.log('Rows sent: ' + read.values.length + ' from "' + read.sheetName + '"');
  return code + ' ' + text;
}

/**
 * Creates (or replaces) the schedule. Run once; running it again does not stack
 * duplicate triggers.
 */
function installCgoTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var index = 0; index < existing.length; index += 1) {
    if (existing[index].getHandlerFunction() === 'pushCgoPlan') {
      ScriptApp.deleteTrigger(existing[index]);
      removed += 1;
    }
  }
  ScriptApp.newTrigger('pushCgoPlan').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  var message = 'Trigger installed: pushCgoPlan every ' + TRIGGER_MINUTES + ' minutes'
    + (removed ? ' (' + removed + ' old trigger(s) removed)' : '');
  Logger.log(message);
  pushCgoPlan(); // prove it works right away instead of waiting for the first tick
  return message;
}

/** Removes the schedule. */
function removeCgoTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var index = 0; index < existing.length; index += 1) {
    if (existing[index].getHandlerFunction() === 'pushCgoPlan') {
      ScriptApp.deleteTrigger(existing[index]);
      removed += 1;
    }
  }
  Logger.log('Removed ' + removed + ' trigger(s).');
  return removed;
}

/**
 * Diagnostic — run this when a push fails. It reports which account the script
 * runs as and whether that account can actually open the CGO PLAN spreadsheet.
 * Select `diagnose` in the function dropdown, click Run, then open the log.
 */
function diagnose() {
  var properties = PropertiesService.getScriptProperties();
  var configured = properties.getProperty(SHEET_ID_PROPERTY);
  var sheetId = String(configured || DEFAULT_SHEET_ID).trim();
  var lines = [];
  lines.push('Account signed in : ' + activeEmail_(Session.getActiveUser()));
  lines.push('Effective user    : ' + activeEmail_(Session.getEffectiveUser()));
  lines.push('Token configured  : ' + (String(properties.getProperty(TOKEN_PROPERTY) || '').trim() ? 'yes' : 'NO (set ' + TOKEN_PROPERTY + ')'));
  lines.push('Worker URL        : ' + String(properties.getProperty(WORKER_URL_PROPERTY) || DEFAULT_WORKER_URL).trim() + (properties.getProperty(WORKER_URL_PROPERTY) ? '' : '  [built-in default]'));
  lines.push('Sheet id in use   : ' + sheetId + '  [' + (configured ? 'from script property CGO_SHEET_ID' : 'built-in default') + ']');
  var read = readPlanSheet_();
  if (read.error) {
    lines.push('Spreadsheet       : FAILED - ' + read.error);
  } else {
    lines.push('Spreadsheet       : OK - "' + read.sheetName + '" (' + read.values.length + ' rows)');
  }
  var triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'pushCgoPlan';
  });
  lines.push('Trigger           : ' + (triggers.length ? triggers.length + ' active (every ' + TRIGGER_MINUTES + ' min)' : 'NONE - run installCgoTrigger()'));
  var report = lines.join('\n');
  Logger.log(report);
  return report;
}

/**
 * Manual check from a browser inside the domain. The Worker no longer calls
 * this — the push above is the working path — but it is a quick way to see the
 * sheet from a logged-in browser: <deployment url>?token=...&ping=1
 */
function doGet(event) {
  try {
    var parameters = (event && event.parameter) || {};
    var expected = String(PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '').trim();
    if (!expected) return respond({ ok: false, error: TOKEN_PROPERTY + ' is not set in this script\'s properties' });
    if (!constantTimeEquals(String(parameters.token || ''), expected)) return respond({ ok: false, error: 'unauthorized' });
    if (String(parameters.ping || '') === '1') return respond({ ok: true, pong: true });

    var read = readPlanSheet_();
    if (read.error) return respond({ ok: false, error: read.error });
    return respond({
      ok: true,
      sheetName: read.sheetName,
      rowCount: read.values.length,
      readAt: new Date().toISOString(),
      values: read.values
    });
  } catch (error) {
    return respond({ ok: false, error: String((error && error.message) || error) });
  }
}

/** Shared by pushCgoPlan(), diagnose() and doGet(). */
function readPlanSheet_() {
  var properties = PropertiesService.getScriptProperties();
  var sheetId = String(properties.getProperty(SHEET_ID_PROPERTY) || DEFAULT_SHEET_ID).trim();
  var sheetName = String(properties.getProperty(SHEET_NAME_PROPERTY) || '').trim();
  try {
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0];
    if (!sheet) return { error: 'worksheet not found: ' + sheetName };
    // getDisplayValues returns exactly what the cargo desk sees in the cell, so
    // a date reads as "21/09/2026" rather than a serial number.
    var values = sheet.getDataRange().getDisplayValues();
    if (values.length > MAX_ROWS) values = values.slice(0, MAX_ROWS);
    values = values.map(function (row) {
      return row.length > MAX_COLUMNS ? row.slice(0, MAX_COLUMNS) : row;
    });
    return { sheetId: sheetId, sheetName: sheet.getName(), values: values };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

function activeEmail_(user) {
  try {
    return String(user.getEmail() || '(not available)');
  } catch (error) {
    return '(unreadable)';
  }
}

function respond(payload) {
  // Apps Script cannot set an HTTP status code, so the caller reads `ok`
  // instead of relying on a 401/500.
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  var difference = 0;
  for (var index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
