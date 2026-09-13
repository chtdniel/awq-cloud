/**
 * LEGACY dataset loader (no cache, no routes). Kept under a unique name so it
 * can never collide with firGetAnalyzeDataset(useCache) in FIR_Parity_Backend.gs
 * — duplicate top-level names resolve by file order and break one engine.
 */
function firGetLegacyAnalyzeDataset() {
  const ss = getActiveSS();
  const read = name => {
    const sheet = ss.getSheetByName(name);
    return sheet ? sheet.getDataRange().getValues() : [];
  };
  const flights = firProcessTable(read('FLT INFO'));
  const notams = [
    ...firProcessTable(read('NOTAM')),
    ...firProcessFirNotams(read('FIR'))
  ];
  const flightById = {};
  flights.forEach(flight => { flightById[flight._rowId] = flight; });
  return { flights, notams, flightById };
}

function firProcessFirNotams(values) {
  if (!values || values.length === 0) return [];
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row || !row.some(Boolean)) continue;
    if (typeof firNotamRowLooksValid === 'function' && !firNotamRowLooksValid(row)) continue;
    out.push({
      _rowId: i + 1,
      Location: row[0] || '',
      'NOTAM #': row[1] || '',
      Class: row[2] || '',
      'Issue Date': row[3] || '',
      'Effective Date': row[4] || '',
      'Expiration Date': row[5] || '',
      'NOTAM Text': row[6] || ''
    });
  }
  return out;
}

function firPlainText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    return hh + mm;
  }
  return String(value);
}

function firGetFlightList() {
  return firGetLegacyAnalyzeDataset().flights
    .filter(flight => String(flight.HIDDEN || '').toUpperCase() !== 'TRUE')
    .map(flight => ({
      rowId: Number(flight._rowId) || 0,
      qz: firPlainText(flight.QZ || flight.FLIGHT),
      dof: firPlainText(flight.DOF),
      dep: firPlainText(flight.DEP),
      des: firPlainText(flight.DES),
      std: firPlainText(flight.STD)
    }));
}

function smokeTestFirFlightListSerializable() {
  const list = firGetFlightList();
  const bad = list.filter(item => Object.keys(item).some(key => {
    const value = item[key];
    return value !== null && typeof value === 'object';
  }));
  console.log(JSON.stringify({
    count: list.length,
    nonPrimitiveRows: bad.length,
    first: list[0] || null
  }));
}

function firProcessTable(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((value, i) => String(value || 'Column_' + i).trim());
  return values.slice(1).filter(row => row.some(Boolean)).map((row, i) => {
    const item = { _rowId: i + 2 };
    headers.forEach((header, col) => { item[header] = row[col] ?? ''; });
    return item;
  });
}

/**
 * Legacy FIR-column reader (regex "FIR <n>"). Distinct from the Parity engine's
 * firGetFlightFIRs(f) which reads fixed keys "FIR 1".."FIR 8".
 */
function firLegacyGetFlightFirs(flight) {
  return Object.keys(flight)
    .filter(key => /^FIR\s*\d+$/i.test(key))
    .map(key => String(flight[key] || '').trim())
    .filter(Boolean);
}

function firDate(value) {
  return duParseFlightDate(value);
}

function firDateSelfCheck() {
  const parsed = firDate('2608211230');
  if (!parsed || parsed.getUTCFullYear() !== 2026 || parsed.getUTCMonth() !== 7 || parsed.getUTCDate() !== 21 || parsed.getUTCHours() !== 12 || parsed.getUTCMinutes() !== 30) {
    throw new Error('firDate self-check failed.');
  }
  if (firDate('invalid-date') !== null) throw new Error('firDate invalid input check failed.');
  return { ok: true };
}

function firFlightWindow(flight) {
  if (!flight || typeof flight !== 'object') {
    throw new Error('firFlightWindow requires flight object.');
  }
  const dof = firDate(flight.DOF);
  if (!dof || isNaN(dof.getTime())) {
    throw new Error('unparseable DOF ' + JSON.stringify(String(flight.DOF == null ? '' : flight.DOF)) + ' — refusing to analyze without a valid date of flight.');
  }
  const day = new Date(Date.UTC(dof.getUTCFullYear(), dof.getUTCMonth(), dof.getUTCDate()));
  const minutes = value => {
    const match = String(value || '0000').match(/^(\d{2}):?(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  };
  const start = new Date(day.getTime() + minutes(flight.STD) * 60000);
  let end = new Date(day.getTime() + minutes(flight.STA) * 60000);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  return { start, end };
}

function firFlightWindowSelfCheck() {
  const window = firFlightWindow({ DOF: '260821', STD: '2330', STA: '0130' });
  const hours = (window.end.getTime() - window.start.getTime()) / 3600000;
  if (hours !== 2 || window.end.getUTCDate() !== 22) throw new Error('firFlightWindow self-check failed.');
  // Fail-closed: unparseable DOF must throw, never silently become today.
  let threw = false;
  try { firFlightWindow({ DOF: 'BOGUS', STD: '1000', STA: '1200' }); } catch (error) { threw = true; }
  if (!threw) throw new Error('firFlightWindow unparseable DOF check failed (expected throw).');
  return { ok: true, durationHours: hours };
}

function firAltitude(value) {
  return duParseAltitude(value);
}

function firAltitudeSelfCheck() {
  const cases = { GND: 0, SFC: 0, FL360: 360, UNL: 999, UNLIMITED: 999 };
  Object.keys(cases).forEach(key => {
    if (firAltitude(key) !== cases[key]) throw new Error('firAltitude self-check failed: ' + key);
  });
  if (firAltitude('invalid') !== null) throw new Error('firAltitude invalid input check failed.');
  return { ok: true };
}

function firNotamImpact(flight, notam) {
  if (!flight || typeof flight !== 'object') {
    throw new Error('firNotamImpact requires flight object.');
  }
  if (!notam || typeof notam !== 'object') {
    throw new Error('firNotamImpact requires NOTAM object.');
  }
  const window = firFlightWindow(flight);
  const start = firDate(notam.effective || notam.EFFECTIVE || notam.B || notam['Effective Date']);
  const end = firDate(notam.expiration || notam.EXPIRATION || notam.C || notam['Expiration Date']) || new Date(8640000000000000);
  // Fail closed: an unparseable B-line (start null) must never read as an overlap.
  const startInvalid = !start || isNaN(start.getTime());
  const timeOverlap = startInvalid ? false : (window.start <= end && window.end >= start);
  const unverified = startInvalid || undefined;
  const flightLevel = firAltitude(flight['CRZ FL'] || flight.FL || flight.ALT);
  const lower = firAltitude(notam.lower || notam.LOWER || notam.F || notam['Lower Limit']);
  const upper = firAltitude(notam.upper || notam.UPPER || notam.G || notam['Upper Limit']);
  const altitudeOverlap = flightLevel === null || (lower === null && upper === null) ||
    ((lower === null || flightLevel >= lower) && (upper === null || upper === 999 || flightLevel <= upper));
  return { timeOverlap, altitudeOverlap, unverified };
}

function firNotamImpactSelfCheck() {
  const flight = { DOF: '260821', STD: '1000', STA: '1200', 'CRZ FL': 'FL360' };
  const notam = { B: '2608210900', C: '2608211100', F: 'FL300', G: 'FL400' };
  const result = firNotamImpact(flight, notam);
  if (!result.timeOverlap || !result.altitudeOverlap) throw new Error('firNotamImpact self-check failed.');
  // Fail-closed: invalid B-line (start null) must not read as time overlap.
  const badB = firNotamImpact(flight, { B: 'NOT-A-DATE', C: '2608211100', F: 'FL300', G: 'FL400' });
  if (badB.timeOverlap !== false) throw new Error('firNotamImpact invalid B-line check failed: timeOverlap must be false.');
  if (badB.unverified !== true) throw new Error('firNotamImpact invalid B-line check failed: unverified flag missing.');
  return { ok: true, result };
}

function firRiskLevel(notam, impact) {
  if (!impact.timeOverlap || !impact.altitudeOverlap) return 'LOW';
  const text = String(notam['NOTAM Text'] || notam.Text || '').toUpperCase();
  const qCodeMatch = text.match(/Q\)\s*[A-Z0-9]+\/([A-Z0-9]{5})/);
  const qCode = qCodeMatch ? qCodeMatch[1] : String(notam.QCode || notam['Q CODE'] || '').toUpperCase();
  const subject = qCode.charAt(1);
  if (/MILITARY|DANGER|RESTRICT|ROCKET|MISSILE|FIRING|BOMBING|EXPLOS/.test(text)) return 'HIGH';
  if (subject === 'D') return 'HIGH';
  if (subject === 'R' || subject === 'W') return 'MEDIUM';
  if (/WARNING|WORK IN PROGRESS|CRANE|OBSTACLE|AIR EXERCISE/.test(text)) return 'MEDIUM';
  return 'LOW';
}

function firRiskSelfCheck() {
  const impact = { timeOverlap: true, altitudeOverlap: true };
  if (firRiskLevel({ 'NOTAM Text': 'Q) WAAF/QDXXX/IV/BO/E/000/999/' }, impact) !== 'HIGH') throw new Error('Q-code D risk check failed.');
  if (firRiskLevel({ 'NOTAM Text': 'Q) WAAF/QRALW/IV/BO/E/000/999/' }, impact) !== 'MEDIUM') throw new Error('Q-code R risk check failed.');
  if (firRiskLevel({ 'NOTAM Text': 'Q) WAAF/QWULW/IV/BO/E/000/999/' }, impact) !== 'MEDIUM') throw new Error('Q-code W risk check failed.');
  // Fail-closed rollup: unverified NOTAMs (timeOverlap false) must never score above LOW.
  if (firRiskLevel({ 'NOTAM Text': 'Q) WAAF/QDXXX/IV/BO/E/000/999/' }, { timeOverlap: false, altitudeOverlap: true, unverified: true }) !== 'LOW') throw new Error('Unverified NOTAM risk check failed (must be LOW).');
  return { ok: true };
}
/**
 * Legacy rowId-based analysis (returns {flight, firs, notams}). Renamed from
 * firAnalyzeFlight(rowId) to avoid signature collision with the Parity engine's
 * firAnalyzeFlight(flight, notams, routes) in FIR_Parity_Backend.gs.
 */
function firAnalyzeFlightByRowId(rowId) {
  const data = firGetLegacyAnalyzeDataset();
  const flight = data.flightById[Number(rowId)];
  if (!flight) throw new Error('Flight row ' + rowId + ' not found.');
  const firs = firLegacyGetFlightFirs(flight);
  const notams = data.notams.filter(notam => {
    return firs.includes(String(notam.Location || notam.FIR || '').trim());
  }).map(notam => {
    const impact = firNotamImpact(flight, notam);
    // Propagate fail-closed marker so the UI can show manual-review-required
    // instead of a clean risk verdict for NOTAMs with unparseable dates.
    const result = { ...notam, ...impact, risk: firRiskLevel(notam, impact) };
    if (impact.unverified) {
      result.unverified = true;
      result.status = 'UNVERIFIED';
    }
    return result;
  });
  return { flight, firs, notams };
}

function smokeTestFirFlightList() {
  const result = firGetFlightList();
  console.log(JSON.stringify({
    count: result.length,
    first: result[0] || null
  }));
}
