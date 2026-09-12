/**
 * DateUtils.gs
 * Consolidated date parsing and formatting utilities.
 * All functions return Date objects (UTC) or null on invalid input.
 * Replaces duplicated implementations in FIR_Parity_Backend.gs,
 * Notam_Backend.gs, FIR_Notam_Backend.gs, and FIR_Analysis_Backend.gs.
 */

/**
 * Parse ICAO date code (YYMMDD or YYMMDDHHMM) into a UTC Date.
 * Accepts 6-digit (YYMMDD) or 10-digit (YYMMDDHHMM) strings.
 * Returns null on invalid input.
 */
function duParseIcaoDateCode(s) {
  if (!s || s.length < 6) return null;
  const code = s.length >= 10 ? s.slice(0, 10) : s.slice(0, 6);
  const year = 2000 + parseInt(code.slice(0, 2), 10);
  const month = parseInt(code.slice(2, 4), 10) - 1;
  const day = parseInt(code.slice(4, 6), 10);
  if (s.length >= 10) {
    const hours = parseInt(code.slice(6, 8), 10);
    const minutes = parseInt(code.slice(8, 10), 10);
    return new Date(Date.UTC(year, month, day, hours, minutes));
  }
  return new Date(Date.UTC(year, month, day));
}

/**
 * Parse a NOTAM date string into a UTC Date.
 * Handles:
 *   - 12-digit UTC (YYYYMMDDHHMM)
 *   - 10-digit UTC (YYYYMMDDHH)
 *   - 8-digit UTC (YYYYMMDD)
 *   - MM/DD/YYYY HHMM or MM/DD/YYYY HH:MM
 *   - YYYY-MM-DD HH:MM[:SS] / YYYY-MM-DDTHH:MM / YYYY-MM-DD
 * Returns null on invalid input.
 */
function duParseNotamDate(s) {
  if (!s || typeof s !== 'string') return new Date(NaN);
  const clean = s.trim();
  let y, m, d, h = 0, min = 0;
  try {
    if (/^\d{12}$/.test(clean)) {
      y = parseInt(clean.substring(0, 4), 10);
      m = parseInt(clean.substring(4, 6), 10) - 1;
      d = parseInt(clean.substring(6, 8), 10);
      h = parseInt(clean.substring(8, 10), 10);
      min = parseInt(clean.substring(10, 12), 10);
    } else if (/^\d{10}$/.test(clean)) {
      y = 2000 + parseInt(clean.substring(0, 2), 10);
      m = parseInt(clean.substring(2, 4), 10) - 1;
      d = parseInt(clean.substring(4, 6), 10);
      h = parseInt(clean.substring(6, 8), 10);
      min = parseInt(clean.substring(8, 10), 10);
    } else if (/^\d{8}$/.test(clean)) {
      y = parseInt(clean.substring(0, 4), 10);
      m = parseInt(clean.substring(4, 6), 10) - 1;
      d = parseInt(clean.substring(6, 8), 10);
    } else {
      const us = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{2})(?::?(\d{2}))?)?$/);
      if (us) {
        y = parseInt(us[3], 10);
        m = parseInt(us[1], 10) - 1;
        d = parseInt(us[2], 10);
        h = parseInt(us[4] || '0', 10);
        min = parseInt(us[5] || '0', 10);
      } else {
        const m10 = clean.match(/^(\d{4})[-\/ ](\d{2})[-\/ ](\d{2})(?:[ T](\d{2}):?(\d{2})?(?::\d{2})?)?/);
        if (!m10) return new Date(NaN);
        y = parseInt(m10[1], 10);
        m = parseInt(m10[2], 10) - 1;
        d = parseInt(m10[3], 10);
        h = parseInt(m10[4] || '0', 10);
        min = parseInt(m10[5] || '0', 10);
      }
    }
    if (m < 0 || m > 11 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) return new Date(NaN);
    const dt = new Date(Date.UTC(y, m, d, h, min));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d ||
      dt.getUTCHours() !== h || dt.getUTCMinutes() !== min) return new Date(NaN);
    return isNaN(dt.getTime()) ? new Date(NaN) : dt;
  } catch (e) {
    return new Date(NaN);
  }
}

/**
 * Parse a NOTAM date field from text after a given prefix (e.g. 'B)', 'C)', 'E)', 'F)', 'G)').
 * Returns a UTC Date or null.
 */
function duParseNotamDateField(text, prefix) {
  if (!text || typeof text !== 'string') return null;
  const idx = text.indexOf(prefix);
  if (idx === -1) return null;
  const m = text.substring(idx).match(/(\d{10}|\d{12})/);
  if (!m) return null;
  const raw = m[1];
  if (!/^\d{12}$/.test(raw) && !/^\d{10}$/.test(raw)) return null;
  return duParseNotamDate(raw);
}

/**
 * Parse the A) line of a NOTAM for the issue date.
 * Pattern: A) AAAA YYYYMMDDHHMM or A) AAAA YYMMDDHH
 * Returns a UTC Date or null.
 */
function duParseNotamIssueDate(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/A\)\s*[A-Z]{4}\s*(\d{12})/i) || text.match(/A\)\s*[A-Z]{4}\s*(\d{10})/i);
  if (!m) return null;
  const raw = m[1];
  if (!/^\d{12}$/.test(raw) && !/^\d{10}$/.test(raw)) return null;
  const d = duParseNotamDate(raw);
  if (d === null || isNaN(d.getTime())) return null;
  return d;
}

/**
 * Convert a Date or Excel-serial number to 'YYYY-MM-DD HH:MM' string (UTC).
 * Returns empty string for invalid/null input.
 */
function duNotamDateToText(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    return y + '-' + m + '-' + d + ' ' + hh + ':' + mm;
  }
  if (typeof value === 'number' && value >= 20000 && value <= 80000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const dt = new Date(epoch.getTime() + value * 86400000);
    if (isNaN(dt.getTime())) return '';
    const y2 = dt.getUTCFullYear();
    const m2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(dt.getUTCDate()).padStart(2, '0');
    const h2 = String(dt.getUTCHours()).padStart(2, '0');
    const mi2 = String(dt.getUTCMinutes()).padStart(2, '0');
    return y2 + '-' + m2 + '-' + d2 + ' ' + h2 + ':' + mi2;
  }
  return String(value || '').trim();
}

/**
 * Parse a 6-digit (YYMMDD) or 10-digit (YYMMDDHHMM) NOTAM date.
 * Returns a Date or null.
 */
function duParseFlightDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const text = String(value || '').trim();
  if (/^\d{6}$/.test(text)) {
    return new Date(Date.UTC(
      2000 + Number(text.slice(0, 2)), Number(text.slice(2, 4)) - 1,
      Number(text.slice(4, 6))
    ));
  }
  if (/^\d{10}$/.test(text)) {
    return new Date(Date.UTC(
      2000 + Number(text.slice(0, 2)), Number(text.slice(2, 4)) - 1,
      Number(text.slice(4, 6)), Number(text.slice(6, 8)), Number(text.slice(8, 10))
    ));
  }
  const parsed = duParseNotamDate(text);
  // Return null for invalid input so callers using || fallback work correctly.
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse an altitude value from NOTAM text.
 * Returns numeric altitude in feet, 0 for GND/SFC, 999 for UNL/UNLIMITED, or null.
 */
function duParseAltitude(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'GND' || text === 'SFC') return 0;
  if (text === 'UNL' || text === 'UNLIMITED') return 999;
  const match = text.match(/^(?:FL)?(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Format a UTC Date into 'DDD DD HH:MMZ' style (e.g. '01 JAN 2026 12:30Z').
 */
function duFormatDateZ(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return String(d.getUTCDate()).padStart(2, '0') +
    months[d.getUTCMonth()] +
    String(d.getUTCFullYear()).slice(-2) +
    ' ' +
    String(d.getUTCHours()).padStart(2, '0') +
    ':' +
    String(d.getUTCMinutes()).padStart(2, '0') +
    'Z';
}

/**
 * Format a UTC Date into 'YYYY-MM-DD HH:MM' string.
 */
function duFormatDateTimeUTC(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const d2 = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return y + '-' + m + '-' + d2 + ' ' + hh + ':' + mm;
}