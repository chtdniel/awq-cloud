/**
 * AWQ Cloud — CGO PLAN bridge (Google Apps Script)
 * ================================================
 *
 * The AWQ Cloud Worker cannot hold a Google service-account key: the AirAsia
 * Google Cloud organization enforces `iam.disableServiceAccountKeyCreation`, so
 * key creation is refused outright. This script is the credential-free way in.
 *
 * It runs as YOU — the account that already has access to the CGO PLAN sheet —
 * and simply hands the sheet's displayed cell values back as JSON. The Worker
 * authenticates with a shared token, so the sheet itself stays private: it is
 * never shared with anyone or anything, and no long-lived Google credential
 * exists anywhere.
 *
 * SETUP (full instructions in docs/cgo-plan-sync.md)
 * --------------------------------------------------
 *  1. script.google.com -> New project, paste this file into Code.gs.
 *  2. Project Settings -> Script properties -> add:
 *       CGO_BRIDGE_TOKEN   a long random string (40+ chars). Same value goes
 *                          into the Cloudflare secret of the same name.
 *     Optional:
 *       CGO_SHEET_ID       defaults to the AWQ CGO PLAN sheet below
 *       CGO_SHEET_NAME     tab name; defaults to the first tab
 *  3. Deploy -> New deployment -> Web app
 *       Execute as:        Me
 *       Who has access:    Anyone          <- required; the Worker has no Google identity
 *  4. Authorize when prompted, then copy the /exec URL into the Cloudflare
 *     variable CGO_BRIDGE_URL.
 *
 * The token travels as a query parameter because an Apps Script web app cannot
 * read request headers, and a POST body does not survive Google's 302 redirect.
 * Treat the token as rotatable: change it here and in Cloudflare together.
 */

var TOKEN_PROPERTY = 'CGO_BRIDGE_TOKEN';
var SHEET_ID_PROPERTY = 'CGO_SHEET_ID';
var SHEET_NAME_PROPERTY = 'CGO_SHEET_NAME';
var DEFAULT_SHEET_ID = '1jHGaWQB5PtzkmVKwb7k_a1nPTZoUhcJjn7NnKWaw-Qg';
var MAX_ROWS = 2000;
var MAX_COLUMNS = 26;

function doGet(event) {
  try {
    var parameters = (event && event.parameter) || {};
    var properties = PropertiesService.getScriptProperties();
    var expected = String(properties.getProperty(TOKEN_PROPERTY) || '').trim();
    if (!expected) {
      return respond({ ok: false, error: 'CGO_BRIDGE_TOKEN is not set in this script\'s properties' });
    }
    if (!constantTimeEquals(String(parameters.token || ''), expected)) {
      return respond({ ok: false, error: 'unauthorized' });
    }
    // A cheap reachability probe: proves the deployment, the token and the
    // redirect all work without reading the sheet.
    if (String(parameters.ping || '') === '1') {
      return respond({ ok: true, pong: true });
    }

    var sheetId = String(parameters.sheetId || properties.getProperty(SHEET_ID_PROPERTY) || DEFAULT_SHEET_ID).trim();
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheetName = String(properties.getProperty(SHEET_NAME_PROPERTY) || '').trim();
    var sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0];
    if (!sheet) {
      return respond({ ok: false, error: 'worksheet not found: ' + sheetName });
    }

    // getDisplayValues returns exactly what the cargo desk sees in the cell, so
    // a date reads as "21/09/2026" rather than a serial number.
    var values = sheet.getDataRange().getDisplayValues();
    if (values.length > MAX_ROWS) values = values.slice(0, MAX_ROWS);
    values = values.map(function (row) {
      return row.length > MAX_COLUMNS ? row.slice(0, MAX_COLUMNS) : row;
    });

    return respond({
      ok: true,
      sheetName: sheet.getName(),
      rowCount: values.length,
      readAt: new Date().toISOString(),
      values: values
    });
  } catch (error) {
    return respond({ ok: false, error: String((error && error.message) || error) });
  }
}

/**
 * Diagnostic — run this from the Apps Script editor when the bridge answers
 * "you do not have permission to access the requested document".
 *
 * It reports which account the script runs as and whether that account can
 * actually open the CGO PLAN spreadsheet. Select `diagnose` in the function
 * dropdown, click Run, then open the Execution log.
 *
 * The first run also triggers the authorization prompt — that is expected.
 */
function diagnose() {
  var properties = PropertiesService.getScriptProperties();
  var configured = properties.getProperty(SHEET_ID_PROPERTY);
  var sheetId = String(configured || DEFAULT_SHEET_ID).trim();
  var lines = [];
  lines.push('Account signed in : ' + activeEmail_(Session.getActiveUser()));
  lines.push('Effective user    : ' + activeEmail_(Session.getEffectiveUser()));
  lines.push('Token configured  : ' + (String(properties.getProperty(TOKEN_PROPERTY) || '').trim() ? 'yes' : 'NO (set CGO_BRIDGE_TOKEN)'));
  lines.push('Sheet id in use   : ' + sheetId + '  [' + (configured ? 'from script property CGO_SHEET_ID' : 'built-in default') + ']');
  try {
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    lines.push('Spreadsheet       : OK - "' + spreadsheet.getName() + '"');
    var sheet = spreadsheet.getSheets()[0];
    lines.push('First worksheet   : "' + sheet.getName() + '" (' + sheet.getDataRange().getNumRows() + ' rows)');
  } catch (error) {
    lines.push('Spreadsheet       : FAILED - ' + String((error && error.message) || error));
  }
  var report = lines.join('\n');
  Logger.log(report);
  return report;
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
