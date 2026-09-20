// CGO PLAN Google Sheet -> Flight Board CGO column.
//
// The plan sheet is maintained by the cargo desk and is the source of truth for
// the cargo weight shown next to each flight. Sheet layout (row 1 headers):
//
//   FLIGHT NO | Flight Date | Origin | Dest | Dep Time | Arr Time | Confirmed Wt. | REVISE | Revise Time
//
// A value in REVISE supersedes Confirmed Wt. for that row ("gunakan revise jika
// ada"), so the revised figure is what the board must show. Column positions are
// resolved from the header text rather than hardcoded, because the cargo desk
// reorders and renames columns without telling anyone.
//
// This module is pure: parsing and matching take values in and give a decision
// out, so the rules can be tested without touching Google or D1.
// The sheet itself is fetched by functions/api/cgo-bridge.js.

function cell(row, index) {
  if (!Array.isArray(row) || index < 0 || index >= row.length) return '';
  const value = row[index];
  return value === null || value === undefined ? '' : String(value).trim();
}

function headerKey(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// The board stores the flight number without the airline designator ("646",
// "320", "247D") while the plan sheet prefixes it ("QZ320"), so the designator
// is dropped from both sides before comparing.
export function normalizeFlightNo(value) {
  const compact = String(value === null || value === undefined ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const stripped = compact.replace(/^[A-Z]{2}(?=\d)/, '');
  return stripped || compact;
}

function utcStamp(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible days (31/02) instead of letting Date roll them over.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

// The sheet is day-first (DD/MM/YYYY, Indonesian ops convention). A first
// component above 12 can only be a day and a second component above 12 can only
// be a month, so those two cases are unambiguous; when both are <= 12 the
// day-first reading is used. Google serial numbers are accepted too, because a
// date-formatted cell can come back as one.
export function parseSheetDate(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return utcStamp(match[1], match[2], match[3]);

  match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return utcStamp(match[1], match[2], match[3]);

  match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    // Only "second > 12" forces a month-first reading; everything else is read
    // day-first, which is the cargo desk's convention.
    const monthFirst = first <= 12 && second > 12;
    return monthFirst
      ? utcStamp(match[3], match[1], match[2])
      : utcStamp(match[3], match[2], match[1]);
  }

  if (/^\d{4,6}(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20000 && serial <= 60000) {
      const epoch = Date.UTC(1899, 11, 30);
      const stamp = new Date(epoch + Math.floor(serial) * 86400000);
      return utcStamp(stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, stamp.getUTCDate());
    }
  }

  return null;
}

// Board DOF values are YYYYMMDD but older rows carry dashes or a full ISO
// timestamp, so only the digits are kept.
export function normalizeDof(value) {
  const digits = String(value === null || value === undefined ? '' : value).replace(/[^0-9]/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

// "2,500" is a thousands separator; a dot is left alone because the board also
// stores decimals ("12.5") and the two are indistinguishable after the fact.
export function normalizeCgoValue(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '';
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) return text.replace(/,/g, '');
  return text;
}

function columnIndex(header, exact, contains) {
  const keys = (Array.isArray(header) ? header : []).map(headerKey);
  for (const wanted of exact) {
    const found = keys.indexOf(wanted);
    if (found >= 0) return found;
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] && contains(keys[index])) return index;
  }
  return -1;
}

// Resolves the sheet's column positions from its header row. Returns null when
// the row is not the header at all (title banners and blank rows above it).
export function resolveColumns(headerRow) {
  const flight = columnIndex(headerRow, ['flightno', 'flightnumber', 'flightnum', 'fltno', 'flight', 'flt'],
    key => key.startsWith('flightno') || key.startsWith('flt'));
  const date = columnIndex(headerRow, ['flightdate', 'date', 'dof', 'tanggal', 'flightday'],
    key => key.includes('date') && !key.includes('time'));
  const revise = columnIndex(headerRow, ['revise', 'revisi', 'revisedwt', 'revisedweight'],
    key => key.includes('revis') && !key.includes('time') && !key.includes('date'));
  const confirmed = columnIndex(headerRow, ['confirmedwt', 'confirmedweight', 'confirmwt', 'confirmed', 'weight', 'wt', 'cargo', 'cgo'],
    key => (key.includes('confirm') || key.includes('weight') || key.includes('cargo') || key.includes('cgo')) && !key.includes('time'));
  if (flight < 0) return null;
  if (confirmed < 0 && revise < 0) return null;
  return { flight, date, revise, confirmed };
}

// Reads the sheet grid into plan entries. The header is searched in the first
// rows so a title band above the table does not break the sync.
export function parseCgoSheet(values, { maxHeaderScan = 10 } = {}) {
  const rows = Array.isArray(values) ? values : [];
  let headerIndex = -1;
  let columns = null;
  for (let index = 0; index < Math.min(rows.length, maxHeaderScan); index += 1) {
    const candidate = resolveColumns(rows[index]);
    if (candidate) { headerIndex = index; columns = candidate; break; }
  }
  if (headerIndex < 0) {
    return {
      error: 'CGO PLAN header not found. Expected a FLIGHT NO column plus a Confirmed Wt. or REVISE column in the first rows of the sheet.'
    };
  }

  const entries = [];
  let blankRows = 0;
  let rowsWithoutWeight = 0;
  let rowsWithoutDate = 0;
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const flightNo = normalizeFlightNo(cell(row, columns.flight));
    if (!flightNo) { blankRows += 1; continue; }
    const revised = cell(row, columns.revise);
    const value = normalizeCgoValue(revised || cell(row, columns.confirmed));
    if (!value) { rowsWithoutWeight += 1; continue; }
    const date = columns.date >= 0 ? parseSheetDate(cell(row, columns.date)) : null;
    if (!date) rowsWithoutDate += 1;
    entries.push({ flightNo, date, value, source: revised ? 'REVISE' : 'Confirmed Wt.', sheetRow: index + 1 });
  }

  return {
    headerRow: headerIndex + 1,
    columns,
    entries,
    blankRows,
    rowsWithoutWeight,
    rowsWithoutDate
  };
}

// Plans the write for the flights currently on the board. Only board flights are
// candidates: a sheet row that matches nothing the operator can see is reported
// back, never written, so a stale or mistyped plan line cannot touch the board.
//
// A row is matched on flight number first; the date is used to choose between
// several board flights sharing that number. With a single candidate the date is
// recorded as a mismatch but still written, because the operators reuse a flight
// number across days and the board may already show tomorrow's DOF.
export function matchCgoEntries(entries, boardFlights) {
  const byNumber = new Map();
  for (const flight of Array.isArray(boardFlights) ? boardFlights : []) {
    const key = normalizeFlightNo(flight && flight.FLIGHT);
    if (!key) continue;
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(flight);
  }

  const assigned = new Map();
  const unmatched = [];
  const ambiguous = [];
  const dateMismatches = [];
  let duplicates = 0;

  for (const entry of entries) {
    const candidates = byNumber.get(entry.flightNo) || [];
    if (candidates.length === 0) { unmatched.push(entry); continue; }

    let target = entry.date ? candidates.find(flight => normalizeDof(flight.DOF) === entry.date) : null;
    if (!target && candidates.length === 1) target = candidates[0];
    if (!target) {
      ambiguous.push({ ...entry, candidateRowIds: candidates.map(flight => flight.rowIdx) });
      continue;
    }

    const boardDof = normalizeDof(target.DOF);
    if (entry.date && boardDof !== entry.date) {
      dateMismatches.push({ ...entry, rowIdx: target.rowIdx, boardDof, boardFlight: target.FLIGHT });
    }
    // A later plan line wins: the cargo desk appends corrections to the bottom.
    if (assigned.has(target.rowIdx)) duplicates += 1;
    assigned.set(target.rowIdx, { entry, target });
  }

  const updates = [];
  for (const [rowIdx, { entry, target }] of assigned) {
    const previous = target.CGO === null || target.CGO === undefined ? '' : String(target.CGO).trim();
    updates.push({
      rowIdx,
      flightNo: entry.flightNo,
      boardFlight: target.FLIGHT,
      date: entry.date,
      boardDof: normalizeDof(target.DOF),
      value: entry.value,
      previous,
      changed: previous !== entry.value,
      source: entry.source,
      sheetRow: entry.sheetRow
    });
  }

  return { updates, unmatched, ambiguous, dateMismatches, duplicates };
}

// One-line-per-issue digest for the operator. The full lists stay in the
// response; this is what the board shows after a sync.
export function summarizeCgoSync(plan, match) {
  const changed = match.updates.filter(update => update.changed);
  const lines = [];
  lines.push(`Matched ${match.updates.length} of ${plan.entries.length} plan row(s) on the board.`);
  lines.push(`Updated ${changed.length} flight(s)${match.updates.length - changed.length ? `, ${match.updates.length - changed.length} already up to date` : ''}.`);
  if (match.unmatched.length) lines.push(`Not on the board: ${match.unmatched.length} (${match.unmatched.slice(0, 8).map(row => row.flightNo).join(', ')}${match.unmatched.length > 8 ? ', …' : ''}).`);
  if (match.ambiguous.length) lines.push(`Ambiguous (same flight number, no date match): ${match.ambiguous.length} (${match.ambiguous.slice(0, 8).map(row => row.flightNo).join(', ')}${match.ambiguous.length > 8 ? ', …' : ''}).`);
  if (match.dateMismatches.length) lines.push(`Date differs from board DOF: ${match.dateMismatches.length} (${match.dateMismatches.slice(0, 5).map(row => `${row.flightNo} ${row.date} vs ${row.boardDof || '—'}`).join(', ')}${match.dateMismatches.length > 5 ? ', …' : ''}).`);
  if (match.duplicates) lines.push(`Duplicate plan rows for the same flight: ${match.duplicates} (last one used).`);
  if (plan.rowsWithoutWeight) lines.push(`Plan rows with no weight yet: ${plan.rowsWithoutWeight}.`);
  if (plan.rowsWithoutDate) lines.push(`Plan rows without a readable date: ${plan.rowsWithoutDate}.`);
  return lines;
}
