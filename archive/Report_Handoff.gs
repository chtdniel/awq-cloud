/**
 * Gate B — Web 2 → Web 1 report handoff backend.
 *
 * Audit / idempotency engine plus the authorized RPC entry points.
 * Deliberately separate from the legacy generateBriefingPackage flow in
 * Report_Backend.gs: the handoff path never reads local TAF/NOTAM sheets and
 * never fetches external data — every value comes from the Web 2 payload.
 *
 * Implements implementation-plan §5: immutable identity, PAYLOAD_HASH,
 * append-only REPORT_AUDIT, shared ScriptLock, lazy preview expiry, and the
 * two-phase create write (CREATE_ATTEMPTED before the create invocation).
 *
 * Scale: per-request lookups use TextFinder (no whole-sheet transfer) and
 * reportTrimAudit_() trims old terminal rows only, so the audit can grow
 * without slowing each RPC.
 */

// ---------------------------------------------------------------- constants

var REPORT_AUDIT_SHEET = 'REPORT_AUDIT';
var REPORT_AUDIT_HEADER = [
  'REQUEST_ID', 'REQUESTED_AT', 'UPDATED_AT', 'PREVIEW_EXPIRES_AT', 'OPERATOR',
  'FLIGHTS_JSON', 'PAYLOAD_HASH', 'TEMPLATE', 'STATUS', 'SPREADSHEET_ID',
  'SPREADSHEET_URL', 'ERROR'
];
var REPORT_COL = {};
REPORT_AUDIT_HEADER.forEach(function (h, i) { REPORT_COL[h] = i; });

var REPORT_PREVIEW_TTL_MS = 15 * 60 * 1000; // 15 minutes (implementation plan §5)
var REPORT_LOCK_WAIT_MS = 5000;             // tryLock budget, not a lock lifetime
var REPORT_UNRESOLVED_STATUSES = ['GENERATING', 'CREATE_ATTEMPTED', 'CREATED', 'UNKNOWN'];
var REPORT_TERMINAL_STATUSES = ['SUCCEEDED', 'EXPIRED'];

// ------------------------------------------------------------------ helpers

function reportNowIso_() { return new Date().toISOString(); }

function reportTemplateFor_(count) {
  if (count === 1) return 'CBR1';
  if (count === 2) return 'CBR2';
  if (count === 3 || count === 4) return 'CBR4';
  throw new Error('Select between 1 and 4 flights.');
}

/** Canonical JSON: recursively sorted keys so the hash is order-independent. */
function reportCanonicalJson_(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(reportCanonicalJson_).join(',') + ']';
  var keys = Object.keys(value).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + reportCanonicalJson_(value[k]);
  }).join(',') + '}';
}

function reportSha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function reportPayloadHash_(payload) { return reportSha256Hex_(reportCanonicalJson_(payload)); }

/** Flight-set key: sorted unique (FLIGHT, DOF, DEP, ARR, STD); excludes row/index/order. */
function reportFlightSetKey_(flights) {
  var seen = {};
  var tuples = [];
  (flights || []).forEach(function (f) {
    var t = [f.FLIGHT, f.DOF, f.DEP, f.ARR, f.STD].map(function (x) {
      return String(x == null ? '' : x).trim().toUpperCase();
    }).join('|');
    if (!seen[t]) { seen[t] = true; tuples.push(t); }
  });
  tuples.sort();
  return tuples.join(';');
}

/** FLIGHTS_JSON content: identifiers + route metadata only, never raw TAF/NOTAM text. */
function reportFlightBrief_(f) {
  return {
    FLIGHT: f.FLIGHT, DOF: f.DOF, DEP: f.DEP, ARR: f.ARR, STD: f.STD, STA: f.STA,
    REG: f.REG, ALT: f.ALT, ENR1: f.ENR1, ENR2: f.ENR2, ENR3: f.ENR3
  };
}

function reportValidatePayload_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Report payload is missing.');
  if (payload.version !== 1) throw new Error('Unsupported report payload version: ' + payload.version);
  var rid = String(payload.reportRequestId || '').trim();
  if (!rid) throw new Error('reportRequestId is required.');
  var flights = payload.flights;
  if (!Array.isArray(flights) || flights.length < 1 || flights.length > 4) {
    throw new Error('Select between 1 and 4 flights.');
  }
  flights.forEach(function (f, i) {
    if (!f || typeof f !== 'object' || !String(f.FLIGHT || '').trim()) {
      throw new Error('Flight ' + (i + 1) + ' is missing FLIGHT.');
    }
  });
  return rid;
}

/**
 * Get the REPORT_AUDIT sheet. When creating, writes the exact header.
 * An existing sheet with a different header fails loudly — never overwritten.
 */
function reportAuditSheet_(createIfMissing) {
  var ss = getActiveSS();
  var sheet = ss.getSheetByName(REPORT_AUDIT_SHEET);
  if (!sheet) {
    if (!createIfMissing) return null;
    sheet = ss.insertSheet(REPORT_AUDIT_SHEET);
    sheet.getRange(1, 1, 1, REPORT_AUDIT_HEADER.length).setValues([REPORT_AUDIT_HEADER]).setFontWeight('bold');
    SpreadsheetApp.flush();
    return sheet;
  }
  var width = Math.max(sheet.getLastColumn(), REPORT_AUDIT_HEADER.length);
  var header = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var ok = REPORT_AUDIT_HEADER.every(function (h, i) { return header[i] === h; });
  if (!ok) {
    throw new Error('REPORT_AUDIT header mismatch. Expected: ' + REPORT_AUDIT_HEADER.join(' | ') +
      ' — found: ' + header.join(' | ') + '. Refusing to overwrite; migrate manually.');
  }
  return sheet;
}

/** Row numbers (1-based) whose REQUEST_ID cell equals requestId.
 *  TextFinder keeps this cheap as the audit grows (no whole-sheet transfer). */
function reportRowNumbersForId_(sheet, requestId) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var found = sheet.createTextFinder(String(requestId)).matchEntireCell(true).findAll();
  var rows = [];
  found.forEach(function (r) {
    var row = r.getRow();
    if (row >= 2 && row <= last) rows.push(row);
  });
  rows.sort(function (a, b) { return a - b; });
  return rows;
}

function reportRecordsAtRows_(sheet, rowNumbers) {
  return rowNumbers.map(function (row) {
    return sheet.getRange(row, 1, 1, REPORT_AUDIT_HEADER.length).getValues()[0];
  });
}

/** All append-only rows for one request ID, in write order. */
function reportReadRows_(sheet, requestId) {
  if (!sheet) return [];
  return reportRecordsAtRows_(sheet, reportRowNumbersForId_(sheet, requestId));
}

function reportRecordFrom_(row) {
  var rec = {};
  REPORT_AUDIT_HEADER.forEach(function (h, i) { rec[h] = row[i]; });
  return rec;
}

function reportAppend_(sheet, rec) {
  sheet.appendRow(REPORT_AUDIT_HEADER.map(function (h) { return rec[h] === undefined || rec[h] === null ? '' : rec[h]; }));
  SpreadsheetApp.flush(); // durable before any external side effect
}

/** Lazy expiry: an awaiting/received row past its immutable deadline reads as EXPIRED. */
function reportEffectiveStatus_(rec) {
  var status = String(rec.STATUS || '').trim().toUpperCase();
  if (status === 'RECEIVED' || status === 'AWAITING_CONFIRMATION') {
    var exp = rec.PREVIEW_EXPIRES_AT ? new Date(rec.PREVIEW_EXPIRES_AT).getTime() : 0;
    if (exp && Date.now() > exp) return 'EXPIRED';
  }
  return status;
}

function reportSucceededRow_(rows) {
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][REPORT_COL.STATUS] || '').trim().toUpperCase() === 'SUCCEEDED') return rows[i];
  }
  return null;
}

/** Shared-lock wrapper. tryLock budget only; never a lock lifetime. */
function reportWithLock_(fn) {
  var lock = LockService.getScriptLock();
  var got = false;
  try { got = lock.tryLock(REPORT_LOCK_WAIT_MS); } catch (e) { got = false; }
  if (!got) return { ok: false, status: 'BUSY', busy: true, error: 'Could not acquire the report lock within ' + REPORT_LOCK_WAIT_MS + 'ms.' };
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ------------------------------------------------- audit retention (trim)

/** Max data rows kept in REPORT_AUDIT (script property, default 500). */
function reportAuditMaxRows_() {
  var v = 0;
  try { v = parseInt(PropertiesService.getScriptProperties().getProperty('REPORT_AUDIT_MAX_ROWS') || '', 10); } catch (e) { v = 0; }
  return (v && v >= 50) ? v : 500;
}

/** Rows younger than this are never trimmed (protects in-flight requests). */
function reportAuditTrimMinAgeMs_() {
  var v = 0;
  try { v = parseInt(PropertiesService.getScriptProperties().getProperty('REPORT_AUDIT_TRIM_MIN_AGE_MS') || '', 10); } catch (e) { v = 0; }
  return (v && v > 0) ? v : 24 * 60 * 60 * 1000; // 24 h default
}

/**
 * Trim settled requests down to maxRows. Returns rows deleted.
 *
 * A request is "settled" when its LATEST row status is terminal (SUCCEEDED /
 * EXPIRED) and that row is older than minAgeMs. Settled requests are removed as
 * WHOLE units (all rows sharing a REQUEST_ID) so no partial trail is left behind.
 *
 * Non-negotiable safety rules:
 *  - a request whose latest status is unresolved (GENERATING / CREATE_ATTEMPTED /
 *    CREATED / UNKNOWN) is NEVER removed — it is still required for reconciliation;
 *  - requests whose latest row is younger than minAgeMs are never removed, so a
 *    stale retry with the same request ID cannot lose its idempotency record while
 *    it could still legitimately be used.
 * If nothing is eligible the sheet simply stays larger (fail-safe toward keeping data).
 */
function reportTrimAudit_(sheet, maxRows, minAgeMs) {
  if (!sheet) return 0;
  maxRows = maxRows || reportAuditMaxRows_();
  minAgeMs = (minAgeMs === undefined) ? reportAuditTrimMinAgeMs_() : minAgeMs;
  var dataRows = sheet.getLastRow() - 1;
  if (dataRows <= maxRows) return 0;

  var values = sheet.getRange(2, 1, dataRows, REPORT_AUDIT_HEADER.length).getValues();
  var cutoff = Date.now() - minAgeMs;

  var order = [];
  var byId = {};
  for (var i = 0; i < values.length; i++) {
    var rid = String(values[i][REPORT_COL.REQUEST_ID] || '').trim();
    if (!rid) continue;
    if (!byId[rid]) { byId[rid] = []; order.push(rid); }
    byId[rid].push(i + 2); // 1-based sheet row
  }

  var need = dataRows - maxRows;
  var targets = [];
  for (var k = 0; k < order.length && targets.length < need; k++) {
    var rowsForId = byId[order[k]];
    var lastValues = values[rowsForId[rowsForId.length - 1] - 2];
    var status = String(lastValues[REPORT_COL.STATUS] || '').trim().toUpperCase();
    if (REPORT_TERMINAL_STATUSES.indexOf(status) === -1) continue;
    var ts = Date.parse(String(lastValues[REPORT_COL.UPDATED_AT] || ''));
    if (!ts || ts > cutoff) continue;
    rowsForId.forEach(function (r) { targets.push(r); }); // whole request
  }
  if (!targets.length) return 0;

  var runs = [];
  var runStart = targets[0], runEnd = targets[0];
  for (var j = 1; j < targets.length; j++) {
    if (targets[j] === runEnd + 1) { runEnd = targets[j]; continue; }
    runs.push([runStart, runEnd - runStart + 1]);
    runStart = targets[j]; runEnd = targets[j];
  }
  runs.push([runStart, runEnd - runStart + 1]);

  var deleted = 0;
  for (var k = runs.length - 1; k >= 0; k--) { // descending so row indexes stay valid
    sheet.deleteRows(runs[k][0], runs[k][1]);
    deleted += runs[k][1];
  }
  SpreadsheetApp.flush();
  return deleted;
}

/** Trim on write, but at most once every 6 hours so busy periods stay cheap. */
function reportTrimAuditThrottled_(sheet) {
  if (!sheet || sheet.getLastRow() - 1 <= reportAuditMaxRows_()) return 0;
  var props = PropertiesService.getScriptProperties();
  var lastAttempt = parseInt(props.getProperty('REPORT_AUDIT_LAST_TRIM') || '0', 10) || 0;
  if (Date.now() - lastAttempt < 6 * 60 * 60 * 1000) return 0;
  props.setProperty('REPORT_AUDIT_LAST_TRIM', String(Date.now()));
  return reportTrimAudit_(sheet);
}

/**
 * Admin: trim the audit on demand (run from the Apps Script editor).
 * @param {number} [keepRows] target max data rows (default REPORT_AUDIT_MAX_ROWS)
 * @param {boolean} [ignoreAge] also allow trimming rows younger than the minimum age
 * Unresolved rows are never removed.
 */
function resetReportAudit(keepRows, ignoreAge) {
  requireAuthorized();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(REPORT_LOCK_WAIT_MS)) throw new Error('BUSY: could not acquire the report lock.');
  try {
    var sheet = reportAuditSheet_(false);
    if (!sheet) return { ok: true, rowsBefore: 0, deleted: 0, rowsAfter: 0 };
    var before = sheet.getLastRow() - 1;
    var deleted = reportTrimAudit_(sheet, keepRows || reportAuditMaxRows_(), ignoreAge ? 0 : undefined);
    return { ok: true, rowsBefore: before, deleted: deleted, rowsAfter: sheet.getLastRow() - 1 };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ------------------------------------------------------- RPC: record receipt

/**
 * Authorized RPC. Validates + hashes the payload, registers the request
 * (RECEIVED → AWAITING_CONFIRMATION) or returns the existing state for an
 * identical re-delivery. Never generates a Sheet and never resets expiry.
 */
function recordReportReceived(payload) {
  try {
    requireAuthorized();
    var rid = reportValidatePayload_(payload);
    var hash = reportPayloadHash_(payload);
    var operator = String(getCurrentUserEmail() || '').trim();
    if (!operator) return { ok: false, status: 'UNAUTHORIZED', error: 'No active user email; operator identity unavailable.' };
    var template = reportTemplateFor_(payload.flights.length);

    return reportWithLock_(function () {
      var sheet = reportAuditSheet_(true);
      var now = reportNowIso_();
      var rows = reportReadRows_(sheet, rid);

      if (rows.length === 0) {
        var expiresAt = new Date(Date.now() + REPORT_PREVIEW_TTL_MS).toISOString();
        var base = {
          REQUEST_ID: rid,
          REQUESTED_AT: payload.requestedAt || now,
          UPDATED_AT: now,
          PREVIEW_EXPIRES_AT: expiresAt,
          OPERATOR: operator,
          FLIGHTS_JSON: JSON.stringify((payload.flights || []).map(reportFlightBrief_)),
          PAYLOAD_HASH: hash,
          TEMPLATE: template
        };
        reportAppend_(sheet, Object.assign({}, base, { STATUS: 'RECEIVED' }));
        reportAppend_(sheet, Object.assign({}, base, { STATUS: 'AWAITING_CONFIRMATION' }));
        reportTrimAuditThrottled_(sheet);
        return {
          ok: true, status: 'AWAITING_CONFIRMATION', reportRequestId: rid,
          previewExpiresAt: expiresAt, retryable: false, template: template
        };
      }

      var latest = reportRecordFrom_(rows[rows.length - 1]);
      if (String(latest.OPERATOR || '').trim() !== operator) {
        return { ok: false, status: 'UNAUTHORIZED', error: 'This request belongs to another operator.' };
      }
      if (String(latest.PAYLOAD_HASH || '').trim() !== hash) {
        return { ok: false, status: 'REQUEST_CONFLICT', error: 'Same request ID received with a different payload.' };
      }

      var status = reportEffectiveStatus_(latest);
      if (status === 'RECEIVED') { // interrupted between the two initial rows
        reportAppend_(sheet, Object.assign({}, latest, { STATUS: 'AWAITING_CONFIRMATION', UPDATED_AT: now }));
        status = 'AWAITING_CONFIRMATION';
      }
      var succeeded = reportSucceededRow_(rows);
      if (succeeded) status = 'SUCCEEDED';
      return {
        ok: true, status: status, reportRequestId: rid,
        previewExpiresAt: latest.PREVIEW_EXPIRES_AT || '',
        retryable: status === 'FAILED',
        template: latest.TEMPLATE || template,
        url: succeeded ? String(succeeded[REPORT_COL.SPREADSHEET_URL] || '') : String(latest.SPREADSHEET_URL || '')
      };
    });
  } catch (e) {
    return { ok: false, status: 'ERROR', error: e.message };
  }
}

// --------------------------------------------------------- RPC: status lookup

/**
 * Authorized RPC. Read-only: returns the current audit state and any known URL
 * without creating or mutating a Sheet. Applies lazy expiry.
 */
function getReportStatus(reportRequestId) {
  try {
    requireAuthorized();
    var rid = String(reportRequestId || '').trim();
    if (!rid) return { ok: false, status: 'ERROR', error: 'reportRequestId is required.' };

    return reportWithLock_(function () {
      var sheet = reportAuditSheet_(false);
      var rows = reportReadRows_(sheet, rid);
      if (!rows.length) return { ok: false, status: 'NOT_FOUND', error: 'No audit record for request ' + rid };
      var latest = reportRecordFrom_(rows[rows.length - 1]);
      var operator = String(getCurrentUserEmail() || '').trim();
      if (String(latest.OPERATOR || '').trim() && String(latest.OPERATOR || '').trim() !== operator) {
        return { ok: false, status: 'UNAUTHORIZED', error: 'This request belongs to another operator.' };
      }
      var succeeded = reportSucceededRow_(rows);
      var status = succeeded ? 'SUCCEEDED' : reportEffectiveStatus_(latest);
      var src = succeeded ? reportRecordFrom_(succeeded) : latest;
      return {
        ok: true,
        status: status,
        reportRequestId: rid,
        retryable: status === 'FAILED',
        operator: src.OPERATOR || '',
        previewExpiresAt: latest.PREVIEW_EXPIRES_AT || '',
        spreadsheetId: src.SPREADSHEET_ID || '',
        url: src.SPREADSHEET_URL || '',
        error: latest.ERROR || '',
        updatedAt: src.UPDATED_AT || ''
      };
    });
  } catch (e) {
    return { ok: false, status: 'ERROR', error: e.message };
  }
}

// ------------------------------------------------ handoff generator boundary

function reportUniqueStations_(list) {
  var seen = {};
  var out = [];
  (list || []).forEach(function (s) {
    if (!s) return;
    var u = String(s).trim().toUpperCase();
    if (!u || seen[u]) return;
    seen[u] = true;
    out.push(u);
  });
  return out;
}

/**
 * Dedicated handoff generator boundary.
 * Builds the CBR spreadsheet from the payload ONLY: tafContext and notamContext
 * are the sole TAF/NOTAM source (no fetchBulkTafData, no UrlFetchApp, no local
 * sheet lookups). The created spreadsheet name carries the request ID so a lost
 * audit write can still be reconciled by an administrator.
 */
function reportGenerateSheet_(payload, templateName) {
  var ss = getActiveSS();
  var templateSheet = ss.getSheetByName(templateName);
  if (!templateSheet) throw new Error('Template sheet ' + templateName + ' is missing from the database.');

  var flights = (payload.flights || []).slice(0, 4);
  var noSigMap = (payload.noSigStationMap && typeof payload.noSigStationMap === 'object' && !Array.isArray(payload.noSigStationMap))
    ? payload.noSigStationMap : {};

  var names = flights.map(function (f) { return String(f.FLIGHT || '').trim(); }).filter(Boolean);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'ddMMyy_HHmm');
  var newSpreadsheet = SpreadsheetApp.create('RELEASE_CBR_' + names.join('-') + '_' + stamp + '_' + payload.reportRequestId);
  var targetSheet = templateSheet.copyTo(newSpreadsheet);
  targetSheet.setName('Crew Briefing Report');
  var existing = newSpreadsheet.getSheets();
  if (existing.length > 1) newSpreadsheet.deleteSheet(existing[0]);

  var formatAndSetCellCoord = function (r, c, val, wrap, isAviation) {
    if (!val || r <= 0 || c <= 0) return;
    var rng = targetSheet.getRange(r, c);
    rng.setValue(val);
    rng.setFontFamily('Courier New');
    rng.setFontSize(13);
    rng.setVerticalAlignment('TOP');
    if (wrap || isAviation) rng.setWrap(true);
  };
  var formatA1 = function (cell, val, isAviation) {
    if (!val) return;
    var rng = targetSheet.getRange(cell);
    formatAndSetCellCoord(rng.getRow(), rng.getColumn(), val, false, isAviation);
  };

  formatA1('T1', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MMM-yyyy HH:mmZ'));

  var mapping = [
    { flt: 'C5', reg: 'C9', dep: 'I5', std: 'J5', arr: 'I7', sta: 'J7', alt: 'Q5' },
    { flt: 'D5', reg: null, dep: 'I9', std: 'J9', arr: 'I11', sta: 'J11', alt: 'Q7' },
    { flt: 'E5', reg: null, dep: 'M5', std: 'N5', arr: 'M7', sta: 'N7', alt: 'Q9' },
    { flt: 'F5', reg: null, dep: 'M9', std: 'N9', arr: 'M11', sta: 'N11', alt: 'Q11' }
  ];
  var padded = [flights[0] || {}, flights[1] || {}, flights[2] || {}, flights[3] || {}];
  padded.forEach(function (leg, idx) {
    if (!leg.FLIGHT) return;
    formatA1(mapping[idx].flt, leg.FLIGHT);
    if (mapping[idx].reg && leg.REG) formatA1(mapping[idx].reg, leg.REG);
    if (leg.DEP) { formatA1(mapping[idx].dep, leg.DEP); formatA1(mapping[idx].std, leg.STD); }
    if (leg.ARR) { formatA1(mapping[idx].arr, leg.ARR); formatA1(mapping[idx].sta, leg.STA); }
    if (leg.ALT) formatA1(mapping[idx].alt, leg.ALT);
  });

  // TAF injection — payload.tafContext is the only source.
  var tafByStation = {};
  (payload.tafContext || []).forEach(function (t) {
    var key = String(t.station || '').trim().toUpperCase();
    if (key) tafByStation[key] = t.text;
  });
  var preferredOrder = reportUniqueStations_(flights.reduce(function (acc, fl) {
    return acc.concat([fl.DEP, fl.ARR, fl.ALT, fl.ENR1, fl.ENR2, fl.ENR3]);
  }, []));
  for (var i = 0; i < 8; i++) {
    var rowC14 = 14 + i;
    if (i < preferredOrder.length) {
      var stn = preferredOrder[i];
      var txt = tafByStation[stn];
      formatA1('C' + rowC14, stn, false);
      formatA1('D' + rowC14, (txt === undefined || txt === null || txt === '') ? 'NIL TAF DATA' : txt, true);
    } else {
      targetSheet.getRange('C' + rowC14 + ':D' + rowC14).clearContent();
    }
  }

  // Grid scanner: POD/POA coords, NOTAM block start, signature-block footer.
  var dataMatrix = targetSheet.getDataRange().getValues();
  var tafMapCoords = {};
  var notamStartRow = 30;
  var footerRow = 999;
  for (var row = 0; row < dataMatrix.length; row++) {
    for (var col = 0; col < dataMatrix[row].length; col++) {
      var cellVal = String(dataMatrix[row][col]).trim().toUpperCase();
      if (cellVal.match(/^P(OD|OA) \d$/)) tafMapCoords[cellVal] = { r: row + 1, c: col + 1 };
      if (cellVal.indexOf('SIGNIFICANT NOTAM') !== -1) notamStartRow = row + 2;
      if ((cellVal.indexOf('DXR') !== -1 || cellVal.indexOf('PIC') !== -1 || cellVal.indexOf('NAME / SIGN') !== -1) &&
          row + 1 > 20 && row + 1 < footerRow) footerRow = row + 1;
    }
  }

  // POD/POA injection from the flight-board summary values in the payload.
  flights.forEach(function (flight, idx) {
    var podKey = 'POD ' + (idx + 1);
    if (flight.DEP && tafMapCoords[podKey]) {
      var pod = tafMapCoords[podKey];
      formatAndSetCellCoord(pod.r, pod.c + 1, flight.DEP, false);
      formatAndSetCellCoord(pod.r, pod.c + 2, flight.STD || '', false);
      formatAndSetCellCoord(pod.r, pod.c + 3, flight.TAF_DEP || '', false);
    }
    var poaKey = 'POA ' + (idx + 1);
    if (flight.ARR && tafMapCoords[poaKey]) {
      var poa = tafMapCoords[poaKey];
      formatAndSetCellCoord(poa.r, poa.c + 1, flight.ARR, false);
      formatAndSetCellCoord(poa.r, poa.c + 2, flight.STA || '', false);
      formatAndSetCellCoord(poa.r, poa.c + 3, flight.TAF_ARR || '', false);
    }
  });

  // NOTAM injection — payload.notamContext is the only source.
  var notamByStation = {};
  var stationToFlights = {};
  (payload.notamContext || []).forEach(function (n) {
    var stnU = String(n.station || '').trim().toUpperCase();
    if (!stnU) return;
    if (!notamByStation[stnU]) notamByStation[stnU] = [];
    var text = (typeof cleanAviationText === 'function') ? cleanAviationText(String(n.text || '')) : String(n.text || '');
    if (notamByStation[stnU].indexOf(text) === -1) notamByStation[stnU].push(text);
  });
  flights.forEach(function (flt) {
    reportUniqueStations_([flt.DEP, flt.ARR, flt.ALT, flt.ENR1, flt.ENR2, flt.ENR3]).forEach(function (stnU) {
      if (!stationToFlights[stnU]) stationToFlights[stnU] = [];
      if (!stationToFlights[stnU].some(function (f) { return f.FLIGHT === flt.FLIGHT; })) stationToFlights[stnU].push(flt);
    });
  });

  var NO_SIG_SENTINEL = 'NO SIGNIFICANT NOTAM';
  var orderedStations = reportUniqueStations_(Object.keys(notamByStation).concat(
    flights.reduce(function (acc, fl) { return acc.concat([fl.DEP, fl.ARR, fl.ALT, fl.ENR1, fl.ENR2, fl.ENR3]); }, [])
  ));
  orderedStations.forEach(function (stnU) {
    if (!notamByStation[stnU]) notamByStation[stnU] = [];
    if (notamByStation[stnU].length > 0) return; // actual NOTAM wins (rule B)
    if (noSigMap[stnU]) { notamByStation[stnU] = [NO_SIG_SENTINEL]; return; }
    var flightsForStn = stationToFlights[stnU] || [];
    if (flightsForStn.some(function (f) { return !!noSigMap[f.FLIGHT]; })) notamByStation[stnU] = [NO_SIG_SENTINEL];
  });

  try {
    var rowsToClear = footerRow - notamStartRow - 1;
    if (rowsToClear > 0) targetSheet.getRange(notamStartRow, 3, rowsToClear, 15).clearContent();
  } catch (e) { /* minor grid reset */ }

  var currentRowOffset = 0;
  orderedStations.forEach(function (stnU) {
    var notamList = notamByStation[stnU] || [];
    var rowForThisStation = notamStartRow + currentRowOffset;
    if (rowForThisStation >= footerRow - 1) { targetSheet.insertRowBefore(footerRow); footerRow++; }
    formatAndSetCellCoord(rowForThisStation, 3, stnU, false);
    if (notamList.length === 0) {
      formatAndSetCellCoord(rowForThisStation, 4, 'NIL OPERATIONAL NOTAM.', true);
    } else if (notamList.length === 1 && notamList[0] === NO_SIG_SENTINEL) {
      formatAndSetCellCoord(rowForThisStation, 4, 'NO SIGNIFICANT NOTAM', true);
    } else {
      var half = Math.ceil(notamList.length / 2);
      var left = notamList.slice(0, half).join('\n\n');
      var right = notamList.slice(half).join('\n\n');
      if (left) formatAndSetCellCoord(rowForThisStation, 4, left, true);
      if (right) formatAndSetCellCoord(rowForThisStation, 12, right, true);
    }
    currentRowOffset++;
  });

  SpreadsheetApp.flush();
  return newSpreadsheet;
}

/** Row numbers whose STATUS cell is exactly an unresolved status. */
function reportUnresolvedRowNumbers_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var pattern = '^(' + REPORT_UNRESOLVED_STATUSES.join('|') + ')$';
  var found = sheet.createTextFinder(pattern).useRegularExpression(true).findAll();
  var seen = {};
  var rows = [];
  found.forEach(function (r) {
    var row = r.getRow();
    if (row >= 2 && row <= last && !seen[row]) { seen[row] = true; rows.push(row); }
  });
  rows.sort(function (a, b) { return a - b; });
  return rows;
}

/** Any unresolved request by the same operator for the same flight set blocks a new one.
 *  Only unresolved rows are scanned, so this stays cheap as the audit grows. */
function reportFindBlockingRequest_(sheet, currentRid, operator, flights) {
  var rowNums = reportUnresolvedRowNumbers_(sheet);
  if (!rowNums.length) return null;
  var key = reportFlightSetKey_(flights);
  var byRequest = {};
  reportRecordsAtRows_(sheet, rowNums).forEach(function (row) {
    var rid = String(row[REPORT_COL.REQUEST_ID] || '').trim();
    if (!rid || rid === currentRid) return;
    var status = String(row[REPORT_COL.STATUS] || '').trim().toUpperCase();
    if (REPORT_UNRESOLVED_STATUSES.indexOf(status) === -1) return; // guard vs regex/column false positives
    if (String(row[REPORT_COL.OPERATOR] || '').trim() !== operator) return;
    if (!byRequest[rid]) byRequest[rid] = [];
    byRequest[rid].push(row);
  });
  for (var rid in byRequest) {
    // "Unresolved" describes the REQUEST, not its intermediate rows. A request that
    // reached SUCCEEDED keeps its historical CREATED / CREATE_ATTEMPTED rows — those
    // are a record of how it got there, not a pending obligation. Scanning unresolved
    // rows alone made every finished generation block the next one for the same flight
    // set forever: the block refuses each new request ID, while the old ID answers
    // SUCCEEDED without generating, so nothing the operator does can clear it.
    if (reportSucceededRow_(reportReadRows_(sheet, rid))) continue;
    var rows = byRequest[rid];
    var latest = reportRecordFrom_(rows[rows.length - 1]);
    var parsed = [];
    try { parsed = JSON.parse(String(latest.FLIGHTS_JSON || '')) || []; } catch (e) { parsed = []; }
    if (reportFlightSetKey_(parsed) === key) {
      return {
        ok: false, status: 'RECONCILIATION_REQUIRED', reportRequestId: rid,
        url: String(latest.SPREADSHEET_URL || ''),
        error: 'An unresolved request for this operator/flight set exists (' + rid + '). Reconcile it first.'
      };
    }
  }
  return null;
}

// ---------------------------------------------------- RPC: confirm + generate

/**
 * Authorized RPC. Generates the CBR spreadsheet under one ScriptLock critical
 * section with a two-phase write: CREATE_ATTEMPTED is flushed BEFORE the create
 * invocation, CREATED (with the Sheet ID) immediately after, then SUCCEEDED.
 * Requires the original operator + an identical payload hash + an unexpired
 * preview; never regresses terminal state and never creates a duplicate.
 */
function confirmReport(payload) {
  try {
    requireAuthorized();
    var rid = reportValidatePayload_(payload);
    var hash = reportPayloadHash_(payload);
    var operator = String(getCurrentUserEmail() || '').trim();
    if (!operator) return { ok: false, status: 'UNAUTHORIZED', error: 'No active user email; operator identity unavailable.' };
    var template = reportTemplateFor_(payload.flights.length);

    return reportWithLock_(function () {
      var sheet = reportAuditSheet_(true);
      var now = reportNowIso_();
      var rows = reportReadRows_(sheet, rid);
      if (!rows.length) return { ok: false, status: 'NOT_FOUND', error: 'No received request for ' + rid };

      var succeededRow = reportSucceededRow_(rows);
      if (succeededRow) {
        var srec = reportRecordFrom_(succeededRow);
        return { ok: true, status: 'SUCCEEDED', reportRequestId: rid, spreadsheetId: srec.SPREADSHEET_ID || '', url: srec.SPREADSHEET_URL || '' };
      }

      var latest = reportRecordFrom_(rows[rows.length - 1]);
      if (String(latest.OPERATOR || '').trim() !== operator) return { ok: false, status: 'UNAUTHORIZED', error: 'This request belongs to another operator.' };
      if (String(latest.PAYLOAD_HASH || '').trim() !== hash) return { ok: false, status: 'REQUEST_CONFLICT', error: 'Confirmed data no longer matches the received payload; start a new handoff.' };

      var status = reportEffectiveStatus_(latest);
      if (status === 'EXPIRED') return { ok: false, status: 'EXPIRED', error: 'Preview expired; start a new handoff.' };
      if (REPORT_UNRESOLVED_STATUSES.indexOf(status) !== -1) {
        var knownId = String(latest.SPREADSHEET_ID || '');
        return {
          ok: false, status: 'RECONCILIATION_REQUIRED', reportRequestId: rid,
          spreadsheetId: knownId, url: String(latest.SPREADSHEET_URL || ''),
          error: 'A previous generation attempt is unresolved (' + status + '). Administrator reconciliation required; no automatic retry.'
        };
      }
      // Reachable: AWAITING_CONFIRMATION / RECEIVED / FAILED(retry) — but a
      // historical create-attempt marker vetoes ordinary retry.
      var createdAtIndex = -1;
      rows.forEach(function (r, idx) {
        var s = String(r[REPORT_COL.STATUS] || '').trim().toUpperCase();
        if (s === 'CREATE_ATTEMPTED' || s === 'CREATED') createdAtIndex = idx;
      });
      if (createdAtIndex !== -1) {
        return {
          ok: false, status: 'RECONCILIATION_REQUIRED', reportRequestId: rid,
          error: 'This request has create-attempt history; refusing an ordinary retry. Reconcile first.'
        };
      }

      var blocking = reportFindBlockingRequest_(sheet, rid, operator, payload.flights);
      if (blocking) return blocking;

      var carry = {
        REQUEST_ID: rid, REQUESTED_AT: latest.REQUESTED_AT || now, UPDATED_AT: now,
        PREVIEW_EXPIRES_AT: latest.PREVIEW_EXPIRES_AT, OPERATOR: operator,
        FLIGHTS_JSON: latest.FLIGHTS_JSON || JSON.stringify((payload.flights || []).map(reportFlightBrief_)),
        PAYLOAD_HASH: hash, TEMPLATE: template
      };

      reportAppend_(sheet, Object.assign({}, carry, { STATUS: 'GENERATING' }));

      var newSpreadsheet;
      try {
        reportAppend_(sheet, Object.assign({}, carry, { STATUS: 'CREATE_ATTEMPTED', UPDATED_AT: reportNowIso_() }));
        newSpreadsheet = reportGenerateSheet_(payload, template);
      } catch (createErr) {
        reportAppend_(sheet, Object.assign({}, carry, {
          STATUS: 'UNKNOWN', UPDATED_AT: reportNowIso_(),
          ERROR: 'Create/format failed after intent: ' + createErr.message
        }));
        return { ok: false, status: 'UNKNOWN', reportRequestId: rid, error: 'Creation outcome uncertain; use CHECK REPORT STATUS.' };
      }

      var sheetId = newSpreadsheet.getId();
      var sheetUrl = newSpreadsheet.getUrl();
      reportAppend_(sheet, Object.assign({}, carry, {
        STATUS: 'CREATED', UPDATED_AT: reportNowIso_(), SPREADSHEET_ID: sheetId, SPREADSHEET_URL: sheetUrl
      }));
      reportAppend_(sheet, Object.assign({}, carry, {
        STATUS: 'SUCCEEDED', UPDATED_AT: reportNowIso_(), SPREADSHEET_ID: sheetId, SPREADSHEET_URL: sheetUrl
      }));
      reportTrimAuditThrottled_(sheet);
      return { ok: true, status: 'SUCCEEDED', reportRequestId: rid, spreadsheetId: sheetId, url: sheetUrl };
    });
  } catch (e) {
    return { ok: false, status: 'ERROR', error: e.message };
  }
}
