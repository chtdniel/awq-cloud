/**
 * AWQ Cloud — CGO PLAN sync (Google Apps Script, bound to the CGO PLAN sheet)
 * ==========================================================================
 *
 * The AirAsia Workspace does not offer "Who has access: Anyone" for Apps Script
 * web apps, so the AWQ Cloud Worker cannot call in — it has no Google identity.
 * Outbound calls are not restricted, so the direction is reversed: this script
 * reads the sheet as YOU and pushes the grid to the Worker.
 *
 * PUSHING WITHOUT THE EDITOR (the normal way)
 * -------------------------------------------
 * Deploy the script once as a web app (Execute as: Me, Who has access: Anyone
 * within AirAsia — "Anyone" is not offered in this Workspace), then bookmark:
 *
 *   https://script.google.com/a/macros/airasia.com/s/<DEPLOYMENT_ID>/exec?token=<TOKEN>&action=push
 *
 * Clicking that bookmark pushes immediately and shows whether it worked. The
 * Worker never calls this URL — the deployment exists so a logged-in operator
 * can trigger a push with one click. The token in the URL is what keeps it
 * closed to everyone else.
 *
 * BOUND TO THE SHEET (if you have edit access)
 * -------------------------------------------
 * Create it from inside the spreadsheet: Extensions -> Apps Script. Then an
 * "AWQ Cloud" menu appears on the sheet:
 *
 *   Push CGO plan now             send the current sheet to the board
 *   Check setup                   which account, which sheet, is it reachable
 *   15-minute schedule ON/OFF     optional; use it only if you want it automatic
 *
 * STANDALONE (also supported)
 * ---------------------------
 * The same file works from a standalone project created at script.google.com —
 * the menu simply does not exist there, so run pushCgoPlan from the editor, or
 * use the bookmark above.
 *
 * SETUP (full instructions in docs/cgo-plan-sync.md)
 * --------------------------------------------------
 *  1. Extensions -> Apps Script in the CGO PLAN sheet, paste this file into Code.gs.
 *  2. Project Settings -> Script properties:
 *       CGO_BRIDGE_TOKEN   the shared token (same value as the Cloudflare secret)
 *     Optional:
 *       WORKER_INGEST_URL  defaults to the AWQ Cloud ingest endpoint
 *       CGO_SHEET_ID       only needed for a standalone project on another sheet
 *  3. Run "Check setup" from the menu (or diagnose() in the editor) and authorize
 *     when prompted. It must end with Spreadsheet : OK.
 *  4. Run "Push CGO plan now" from the menu.
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
 * The spreadsheet this script works on. A bound script uses the sheet it lives
 * in; a standalone project falls back to CGO_SHEET_ID, then to the AWQ default.
 */
function resolveSpreadsheet_() {
  var configuredId = String(PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROPERTY) || '').trim();
  if (configuredId) return SpreadsheetApp.openById(configuredId);
  var bound = null;
  try {
    bound = SpreadsheetApp.getActiveSpreadsheet();
  } catch (error) {
    bound = null;
  }
  if (bound) return bound;
  return SpreadsheetApp.openById(DEFAULT_SHEET_ID);
}

/** Builds the sheet menu. Simple trigger: runs on open, needs no authorization. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('AWQ Cloud')
      .addItem('Push CGO plan now', 'pushCgoPlanFromMenu')
      .addItem('Check setup', 'diagnoseFromMenu')
      .addSeparator()
      .addItem('Turn 15-minute schedule ON', 'enableScheduleFromMenu')
      .addItem('Turn schedule OFF', 'disableScheduleFromMenu')
      .addToUi();
  } catch (error) {
    // Not bound to a spreadsheet (standalone project) — there is no menu there.
  }
}

/**
 * Reads the sheet and pushes it to the Worker. Returns a result object; the log
 * always carries the detail. This is the function the optional trigger calls.
 */
function pushCgoPlan() {
  var properties = PropertiesService.getScriptProperties();
  var token = String(properties.getProperty(TOKEN_PROPERTY) || '').trim();
  if (!token) {
    Logger.log('STOP: set the ' + TOKEN_PROPERTY + ' script property to the same value as the Cloudflare secret.');
    return { ok: false, status: null, detail: 'Set the ' + TOKEN_PROPERTY + ' script property first.' };
  }
  var workerUrl = String(properties.getProperty(WORKER_URL_PROPERTY) || DEFAULT_WORKER_URL).trim();

  var read = readPlanSheet_();
  if (read.error) {
    Logger.log('STOP: ' + read.error);
    return { ok: false, status: null, detail: read.error };
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
    var networkMessage = 'Network error calling ' + workerUrl + ': ' + String((error && error.message) || error);
    Logger.log('STOP: ' + networkMessage);
    return { ok: false, status: null, detail: networkMessage };
  }

  var status = response.getResponseCode();
  var text = String(response.getContentText() || '').slice(0, 400);
  var ok = status === 200 && text.indexOf('"ok":true') >= 0;
  Logger.log('Worker answered HTTP ' + status + ': ' + text);
  Logger.log('Rows sent: ' + read.values.length + ' from "' + read.sheetName + '"');
  return { ok: ok, status: status, detail: text, sheetName: read.sheetName, rows: read.values.length };
}

/**
 * Editor-friendly wrapper. pushCgoPlan() returns an object, which Apps Script
 * refuses to display when a function is run from the editor ("the script
 * completed but the returned value is not a supported return type"). The push
 * itself has already succeeded at that point — this returns a string so the
 * result is readable instead of confusing.
 */
function pushCgoPlanNow() {
  var result = pushCgoPlan();
  return (result.ok ? 'OK ' : 'FAILED ') + (result.status === null ? '(no HTTP response) ' : 'HTTP ' + result.status + ' ') + result.detail;
}

/** Menu wrapper: the sheet has no console, so the result has to be shown. */
function pushCgoPlanFromMenu() {  var ui = SpreadsheetApp.getUi();
  var result = pushCgoPlan();
  if (result.ok) {
    ui.alert('CGO plan pushed', 'The board can now sync.\n\n' + result.detail, ui.ButtonSet.OK);
    return;
  }
  ui.alert('CGO push FAILED', result.detail + '\n\nSee View -> Execution log for the full detail.', ui.ButtonSet.OK);
}

function diagnoseFromMenu() {
  SpreadsheetApp.getUi().alert('CGO sync setup', diagnose(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function enableScheduleFromMenu() {
  installCgoTrigger();
  SpreadsheetApp.getUi().alert('Schedule on', 'The CGO plan is now pushed every ' + TRIGGER_MINUTES + ' minutes.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function disableScheduleFromMenu() {
  var removed = removeCgoTrigger();
  SpreadsheetApp.getUi().alert('Schedule off', removed ? 'Removed ' + removed + ' trigger(s). Use the menu to push by hand.' : 'No schedule was active.', SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Creates (or replaces) the schedule. Optional: pushing by hand is the default,
 * so only run this if you want the board kept fresh without anyone clicking.
 */
function installCgoTrigger() {
  var removed = removeCgoTrigger();
  ScriptApp.newTrigger('pushCgoPlan').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  var message = 'Trigger installed: pushCgoPlan every ' + TRIGGER_MINUTES + ' minutes'
    + (removed ? ' (' + removed + ' old trigger(s) removed)' : '');
  Logger.log(message);
  return message;
}

/** Removes the schedule and returns how many triggers were deleted. */
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
 * Diagnostic — which account this runs as, whether that account can open the
 * sheet, and whether a schedule is active. Run from the menu or the editor.
 */
function diagnose() {
  var properties = PropertiesService.getScriptProperties();
  var lines = [];
  lines.push('Account signed in : ' + activeEmail_(Session.getActiveUser()));
  lines.push('Effective user    : ' + activeEmail_(Session.getEffectiveUser()));
  lines.push('Token configured  : ' + (String(properties.getProperty(TOKEN_PROPERTY) || '').trim() ? 'yes' : 'NO (set ' + TOKEN_PROPERTY + ')'));
  lines.push('Worker URL        : ' + String(properties.getProperty(WORKER_URL_PROPERTY) || DEFAULT_WORKER_URL).trim() + (properties.getProperty(WORKER_URL_PROPERTY) ? '' : '  [built-in default]'));

  var read = readPlanSheet_();
  if (read.error) {
    lines.push('Spreadsheet       : FAILED - ' + read.error);
  } else {
    lines.push('Spreadsheet       : OK - "' + read.sheetName + '" (' + read.values.length + ' rows, id ' + read.sheetId + ')');
  }
  var triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'pushCgoPlan';
  });
  lines.push('Schedule          : ' + (triggers.length ? 'ON (every ' + TRIGGER_MINUTES + ' min)' : 'off - push by hand'));
  var report = lines.join('\n');
  Logger.log(report);
  return report;
}

/** Shared by pushCgoPlan(), diagnose() and doGet(). */
function readPlanSheet_() {
  var sheetName = String(PropertiesService.getScriptProperties().getProperty(SHEET_NAME_PROPERTY) || '').trim();
  try {
    var spreadsheet = resolveSpreadsheet_();
    var sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0];
    if (!sheet) return { error: 'worksheet not found: ' + sheetName };
    // getDisplayValues returns exactly what the cargo desk sees in the cell, so
    // a date reads as "21/09/2026" rather than a serial number.
    var values = sheet.getDataRange().getDisplayValues();
    if (values.length > MAX_ROWS) values = values.slice(0, MAX_ROWS);
    values = values.map(function (row) {
      return row.length > MAX_COLUMNS ? row.slice(0, MAX_COLUMNS) : row;
    });
    return { sheetId: spreadsheet.getId(), sheetName: sheet.getName(), values: values };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

/**
 * Browser entry point. Two uses:
 *
 *   ?token=...&action=push   push now and show a readable confirmation.
 *                            This is what the bookmark points at, so the
 *                            operator never has to open the script editor.
 *   ?token=...&ping=1        prove the deployment and token work
 *   ?token=...               show the sheet grid as JSON (diagnostic)
 *
 * Only the token holder can reach any of it, and the deployment is limited to
 * the AirAsia domain, so this is not a public endpoint.
 */
function doGet(event) {
  try {
    var parameters = (event && event.parameter) || {};
    var expected = String(PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '').trim();
    if (!expected) return respond({ ok: false, error: TOKEN_PROPERTY + ' is not set in this script\'s properties' });
    if (!constantTimeEquals(String(parameters.token || ''), expected)) return respond({ ok: false, error: 'unauthorized' });
    if (String(parameters.ping || '') === '1') return respond({ ok: true, pong: true });
    // A web app may only answer with HtmlOutput or TextOutput, and ContentService
    // has no HTML mime type — so the confirmation page must go through
    // HtmlService. Returning the string directly fails with "the script completed
    // but the returned value is not a supported return type", even though the
    // push has already run by then.
    if (String(parameters.action || '') === 'push') return HtmlService.createHtmlOutput(pushResultPage_());

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

/** Runs the push and renders the outcome for whoever clicked the bookmark. */
function pushResultPage_() {
  var result = pushCgoPlan();
  if (result.ok) {
    return htmlPage_(
      'CGO plan pushed',
      result.rows + ' rows sent from "' + escapeHtml_(result.sheetName || 'the sheet') + '".',
      'Switch back to the flight board and run Sync CGO Data.',
      true
    );
  }
  return htmlPage_(
    'CGO push failed',
    escapeHtml_(result.detail || 'unknown error'),
    'Open the Apps Script project and check the Execution log for the full detail.',
    false
  );
}

function htmlPage_(title, message, hint, ok) {
  var accent = ok ? '#34d399' : '#fb7185';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml_(title) + '</title><style>'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07101d;color:#f8fafc;'
    + 'font-family:system-ui,-apple-system,Segoe UI,sans-serif}'
    + 'main{max-width:460px;padding:32px;text-align:center}'
    + 'h1{margin:0 0 12px;font-size:22px;color:' + accent + '}'
    + 'p{margin:0 0 10px;line-height:1.6;color:#cbd5e1}'
    + '.hint{color:#94a3b8;font-size:14px}'
    + 'button{margin-top:20px;padding:12px 20px;border:0;border-radius:8px;background:#334155;color:#f8fafc;'
    + 'font:inherit;font-weight:700;cursor:pointer}'
    + '</style></head><body><main>'
    + '<h1>' + escapeHtml_(title) + '</h1>'
    + '<p>' + message + '</p>'
    + '<p class="hint">' + hint + '</p>'
    + '<button onclick="window.close()">Close this tab</button>'
    + '</main></body></html>';
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
