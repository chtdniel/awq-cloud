/**
 * Operational_Readiness_Backend.gs
 * Read-only operational readiness bundle for DOF, NOTAM, and TAF.
 * Never writes to sheets or PropertiesService.
 * Output timestamps are UTC ISO 8601 with trailing Z.
 */

// Operations/Safety approval required before production — default 6h
// Thresholds are defined in Constants.gs but fallback to 360 if missing.

function occFormatYmdUtc_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  try {
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  } catch (e) {
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var day = String(d.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
}

function occFormatIsoUtc_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  try {
    return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  } catch (e) {
    return d.toISOString().replace(/\.\d+Z$/, 'Z');
  }
}

function occParseNowUtc_(optNow) {
  if (optNow instanceof Date && !isNaN(optNow.getTime())) return new Date(optNow.getTime());
  if (typeof optNow === 'string' && String(optNow).trim()) {
    var s = String(optNow).trim();
    try {
      if (typeof duParseNotamDate === 'function') {
        var p = duParseNotamDate(s);
        if (p && !isNaN(p.getTime())) return p;
      }
    } catch (e) {}
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // handle "yyyy-MM-dd HH:mm:ss" as UTC
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
      var iso = s.replace(' ', 'T');
      if (iso.slice(-1) !== 'Z' && iso.indexOf('+') === -1) iso += 'Z';
      var d2 = new Date(iso);
      if (!isNaN(d2.getTime())) return d2;
    }
  }
  if (typeof optNow === 'number' && isFinite(optNow)) {
    var d3 = new Date(optNow);
    if (!isNaN(d3.getTime())) return d3;
  }
  return new Date();
}

function occParseTimestampUtc_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return new Date(value.getTime());
  if (typeof value === 'number' && value >= 20000 && value <= 80000) {
    var epoch = new Date(Date.UTC(1899, 11, 30));
    var dt = new Date(epoch.getTime() + value * 86400000);
    if (!isNaN(dt.getTime())) return dt;
  }
  if (value == null) return null;
  var s = String(value).trim();
  if (!s) return null;
  try {
    if (typeof duParseNotamDate === 'function') {
      var d = duParseNotamDate(s);
      if (d && !isNaN(d.getTime())) return d;
    }
  } catch (e) {}
  try {
    if (typeof duParseFlightDate === 'function') {
      var d2 = duParseFlightDate(s);
      if (d2 && !isNaN(d2.getTime())) return d2;
    }
  } catch (e) {}
  // Handle display format "yyyy-MM-dd HH:mm:ss" as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    var iso = s.replace(' ', 'T') + 'Z';
    var p2 = new Date(iso);
    if (!isNaN(p2.getTime())) return p2;
  }
  // Handle slashes
  if (s.indexOf('/') !== -1) {
    var alt = s.replace(/\//g, '-').replace(' ', 'T');
    if (alt.slice(-1) !== 'Z' && alt.indexOf('+') === -1) alt += 'Z';
    var p3 = new Date(alt);
    if (!isNaN(p3.getTime())) return p3;
  }
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

function occAgeMinutes_(timestampUtc, nowUtc) {
  if (!(timestampUtc instanceof Date) || isNaN(timestampUtc.getTime())) return null;
  if (!(nowUtc instanceof Date) || isNaN(nowUtc.getTime())) return null;
  return Math.floor((nowUtc.getTime() - timestampUtc.getTime()) / 60000);
}

function occStatusForAge_(ageMinutes, maxAge) {
  if (ageMinutes == null || !isFinite(ageMinutes)) return 'UNAVAILABLE';
  if (ageMinutes < 0) return 'BLOCKED';
  if (ageMinutes <= maxAge) return 'READY';
  return 'WARNING';
}

function occReadinessDof_(nowUtc) {
  var value = '';
  try {
    var flights = [];
    var usedFallback = false;
    try {
      if (typeof getFlightDashboardData === 'function') {
        var data = getFlightDashboardData(false);
        flights = (data && data.flights) ? data.flights : [];
      } else {
        usedFallback = true;
      }
    } catch (e) {
      usedFallback = true;
    }
    if (usedFallback) {
      var ss = getActiveSS();
      var sheetName = (typeof SHEET_FLT_INFO !== 'undefined') ? SHEET_FLT_INFO : 'FLT INFO';
      var sh = ss.getSheetByName(sheetName);
      if (!sh) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'Flight sheet not found' };
      var lr = sh.getLastRow();
      if (lr < 2) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'No flights on board' };
      var vals = sh.getRange(1, 1, lr, 18).getDisplayValues();
      flights = [];
      for (var i = 1; i < vals.length; i++) {
        if (!vals[i][0]) continue;
        flights.push({ DOF: vals[i][15] });
      }
    }
    if (!flights || flights.length === 0) {
      return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'No flights on board' };
    }
    var dofs = flights.map(function(f) { return String(f.DOF || '').trim(); }).filter(Boolean);
    if (dofs.length === 0) {
      return { status: 'BLOCKED', value: '', timestampUtc: '', ageMinutes: null, detail: 'DOF not set for flights on board' };
    }
    var parsed = [];
    var malformedCount = 0;
    for (var k = 0; k < dofs.length; k++) {
      var p = null;
      try {
        if (typeof duParseFlightDate === 'function') p = duParseFlightDate(dofs[k]);
      } catch (e) { p = null; }
      if (!p || isNaN(p.getTime())) {
        try { p = occParseTimestampUtc_(dofs[k]); } catch (e) { p = null; }
      }
      if (p && !isNaN(p.getTime())) parsed.push(p);
      else malformedCount++;
    }
    if (parsed.length === 0) {
      return { status: 'BLOCKED', value: String(dofs[0] || ''), timestampUtc: '', ageMinutes: null, detail: 'DOF malformed: ' + String(dofs[0] || '') };
    }
    var todayYmd = occFormatYmdUtc_(nowUtc);
    var parsedYmds = parsed.map(function(d) { return occFormatYmdUtc_(d); });
    var distinct = {};
    parsedYmds.forEach(function(y) { distinct[y] = (distinct[y] || 0) + 1; });
    var mostCommon = Object.keys(distinct).sort(function(a, b) { return distinct[b] - distinct[a]; })[0];
    var repDate = parsed[0];
    for (var j = 0; j < parsed.length; j++) {
      if (occFormatYmdUtc_(parsed[j]) === mostCommon) { repDate = parsed[j]; break; }
    }
    var timestampUtc = occFormatIsoUtc_(repDate);
    value = mostCommon;
    var distinctCount = Object.keys(distinct).length;
    var status;
    var detail;
    var flightCount = flights.length;
    if (malformedCount > 0) {
      status = 'BLOCKED';
      detail = 'DOF malformed for ' + malformedCount + ' flight(s); most common DOF ' + mostCommon;
    } else if (distinctCount === 1 && mostCommon === todayYmd) {
      status = 'READY';
      detail = 'DOF matches UTC operational date (' + todayYmd + ') for ' + flightCount + ' flight(s)';
    } else if (parsedYmds.some(function(y) { return y === todayYmd; })) {
      status = 'WARNING';
      detail = 'Some flights DOF differ from today UTC (' + todayYmd + '); most common ' + mostCommon + ' across ' + distinctCount + ' date(s)';
    } else {
      status = 'WARNING';
      detail = 'DOF ' + mostCommon + ' does not match today UTC ' + todayYmd;
    }
    return { status: status, value: value, timestampUtc: timestampUtc, ageMinutes: null, detail: detail };
  } catch (e) {
    return { status: 'UNAVAILABLE', value: value, timestampUtc: '', ageMinutes: null, detail: 'Unable to verify DOF: ' + e.message };
  }
}

function occReadinessNotam_(nowUtc) {
  var maxAge = (typeof OPERATIONAL_READINESS_NOTAM_MAX_AGE_MINUTES !== 'undefined') ? OPERATIONAL_READINESS_NOTAM_MAX_AGE_MINUTES : 360;
  try {
    var ss = getActiveSS();
    var sheetName = (typeof SHEET_NOTAM_HISTORY !== 'undefined') ? SHEET_NOTAM_HISTORY : 'NOTAM_HISTORY';
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'NOTAM history sheet not found' };
    var lr = sh.getLastRow();
    if (lr < 2) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'No NOTAM history entries' };
    var raw = null;
    for (var r = lr; r >= 2; r--) {
      var v = sh.getRange(r, 1).getValue();
      if (v !== '' && v != null) { raw = v; break; }
    }
    if (raw == null || String(raw).trim() === '') return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'NOTAM timestamp not found' };
    var parsed = occParseTimestampUtc_(raw);
    if (!parsed) return { status: 'BLOCKED', value: String(raw), timestampUtc: '', ageMinutes: null, detail: 'NOTAM timestamp malformed' };
    var age = occAgeMinutes_(parsed, nowUtc);
    if (age == null) return { status: 'UNAVAILABLE', value: '', timestampUtc: occFormatIsoUtc_(parsed), ageMinutes: null, detail: 'Unable to calculate NOTAM age' };
    var tsUtc = occFormatIsoUtc_(parsed);
    if (age < 0) return { status: 'BLOCKED', value: '', timestampUtc: tsUtc, ageMinutes: age, detail: 'NOTAM timestamp in future (' + age + ' min)' };
    var status = occStatusForAge_(age, maxAge);
    var detail;
    if (status === 'READY') detail = 'NOTAM updated ' + age + ' min ago';
    else if (status === 'WARNING') detail = 'NOTAM stale (' + age + ' min ago, threshold ' + maxAge + ' min)';
    else detail = 'NOTAM status ' + status;
    return { status: status, value: '', timestampUtc: tsUtc, ageMinutes: age, detail: detail };
  } catch (e) {
    return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'Unable to verify NOTAM: ' + e.message };
  }
}

function occReadinessTaf_(nowUtc) {
  var maxAge = (typeof OPERATIONAL_READINESS_TAF_MAX_AGE_MINUTES !== 'undefined') ? OPERATIONAL_READINESS_TAF_MAX_AGE_MINUTES : 360;
  try {
    var ss = getActiveSS();
    var sheetName = (typeof SHEET_TAF !== 'undefined') ? SHEET_TAF : 'TAF';
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'TAF sheet not found' };
    var lr = sh.getLastRow();
    if (lr < 2) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'No TAF entries' };
    var values = sh.getRange(2, 1, lr - 1, 3).getValues();
    var latest = null;
    var stationCount = 0;
    for (var i = 0; i < values.length; i++) {
      var st = String(values[i][0] || '').trim();
      if (!st) continue;
      stationCount++;
      var raw = values[i][2];
      var parsed = occParseTimestampUtc_(raw);
      if (parsed && !isNaN(parsed.getTime())) {
        if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
      }
    }
    if (stationCount === 0) return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'No TAF stations' };
    if (!latest) return { status: 'BLOCKED', value: String(stationCount), timestampUtc: '', ageMinutes: null, detail: 'TAF timestamps malformed for ' + stationCount + ' station(s)' };
    var age = occAgeMinutes_(latest, nowUtc);
    var tsUtc = occFormatIsoUtc_(latest);
    if (age == null) return { status: 'UNAVAILABLE', value: String(stationCount), timestampUtc: tsUtc, ageMinutes: null, detail: 'Unable to calculate TAF age' };
    if (age < 0) return { status: 'BLOCKED', value: String(stationCount), timestampUtc: tsUtc, ageMinutes: age, detail: 'TAF timestamp in future' };
    var status = occStatusForAge_(age, maxAge);
    var detail;
    if (status === 'READY') detail = 'TAF updated ' + age + ' min ago for ' + stationCount + ' station(s)';
    else if (status === 'WARNING') detail = 'TAF stale (' + age + ' min ago, threshold ' + maxAge + ' min) for ' + stationCount + ' station(s)';
    else detail = 'TAF status ' + status;
    return { status: status, value: String(stationCount), timestampUtc: tsUtc, ageMinutes: age, detail: detail };
  } catch (e) {
    return { status: 'UNAVAILABLE', value: '', timestampUtc: '', ageMinutes: null, detail: 'Unable to verify TAF: ' + e.message };
  }
}

/**
 * Read-only bundle for Operational Readiness Check.
 * @param {Date|string|number} optNow Optional override for current UTC instant (testing).
 * @return {Object} JSON-safe readiness payload.
 * @expose
 */
function getOperationalReadiness(optNow) {
  var now = occParseNowUtc_(optNow);
  var generatedAtUtc = occFormatIsoUtc_(now);
  var dof = occReadinessDof_(now);
  var notam = occReadinessNotam_(now);
  var taf = occReadinessTaf_(now);
  return {
    ok: true,
    generatedAtUtc: generatedAtUtc,
    dof: dof,
    notam: notam,
    taf: taf
  };
}

function operationalReadinessSelfCheck() {
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  // Boundary: 359 READY, 360 READY, 361 WARNING, -1 BLOCKED
  assert(occStatusForAge_(359, 360) === 'READY', '359 should be READY');
  assert(occStatusForAge_(360, 360) === 'READY', '360 should be READY');
  assert(occStatusForAge_(361, 360) === 'WARNING', '361 should be WARNING');
  assert(occStatusForAge_(-1, 360) === 'BLOCKED', '-1 should be BLOCKED');
  assert(occStatusForAge_(null, 360) === 'UNAVAILABLE', 'null should be UNAVAILABLE');
  assert(occStatusForAge_(NaN, 360) === 'UNAVAILABLE', 'NaN should be UNAVAILABLE');
  // Future timestamp age negative
  var now = new Date(Date.UTC(2026, 8, 6, 12, 0, 0));
  var future = new Date(Date.UTC(2026, 8, 6, 13, 0, 0));
  assert(occAgeMinutes_(future, now) === -60, 'future age should be -60');
  assert(occStatusForAge_(occAgeMinutes_(future, now), 360) === 'BLOCKED', 'future should be BLOCKED');
  // Past timestamps
  var past359 = new Date(now.getTime() - 359 * 60000);
  var past360 = new Date(now.getTime() - 360 * 60000);
  var past361 = new Date(now.getTime() - 361 * 60000);
  assert(occStatusForAge_(occAgeMinutes_(past359, now), 360) === 'READY', 'past 359 READY');
  assert(occStatusForAge_(occAgeMinutes_(past360, now), 360) === 'READY', 'past 360 READY');
  assert(occStatusForAge_(occAgeMinutes_(past361, now), 360) === 'WARNING', 'past 361 WARNING');
  // DOF parsing
  if (typeof duParseFlightDate === 'function') {
    var d1 = duParseFlightDate('20260906');
    assert(d1 && !isNaN(d1.getTime()), '20260906 should parse');
    assert(occFormatYmdUtc_(d1) === '2026-09-06', 'format should be 2026-09-06');
    var d2 = duParseFlightDate('260906');
    assert(d2 && !isNaN(d2.getTime()), '260906 should parse');
  }
  // Timestamp parsing
  var t1 = occParseTimestampUtc_('2026-09-06 12:00:00');
  assert(t1 && !isNaN(t1.getTime()), 'timestamp string should parse');
  assert(occFormatIsoUtc_(t1).slice(-1) === 'Z', 'formatted should end with Z');
  var t2 = occParseTimestampUtc_(new Date(Date.UTC(2026, 8, 6, 12, 0, 0)));
  assert(t2 && !isNaN(t2.getTime()), 'Date should parse');
  // Malformed yields BLOCKED via NOTAM helper (simulate)
  var malformed = occParseTimestampUtc_('not-a-date');
  assert(malformed === null, 'malformed should be null');
  // Contract shape
  var payload = getOperationalReadiness(now);
  assert(payload && payload.ok === true, 'payload ok');
  assert(typeof payload.generatedAtUtc === 'string' && payload.generatedAtUtc.slice(-1) === 'Z', 'generatedAtUtc Z');
  ['dof', 'notam', 'taf'].forEach(function(k) {
    assert(payload[k] && typeof payload[k].status === 'string', k + ' status');
    assert(['READY', 'WARNING', 'BLOCKED', 'UNAVAILABLE'].indexOf(payload[k].status) !== -1, k + ' status enum');
    assert(typeof payload[k].detail === 'string', k + ' detail');
    if (payload[k].timestampUtc) assert(payload[k].timestampUtc.slice(-1) === 'Z', k + ' timestamp Z');
    assert(payload[k].ageMinutes === null || typeof payload[k].ageMinutes === 'number', k + ' ageMinutes');
  });
  // No Date objects in payload (JSON-safe)
  var json = JSON.stringify(payload);
  var reparsed = JSON.parse(json);
  assert(reparsed.generatedAtUtc === payload.generatedAtUtc, 'JSON-safe');
  return { ok: true };
}
