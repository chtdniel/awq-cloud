function getFirData() {
  const sheet = getActiveSS().getSheetByName('FIR');
  if (!sheet) throw new Error("Sheet named 'FIR' was not found.");
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return { firs: [] };
  const headerRow = values.slice(0, 10).findIndex(row => row.some(cell => /FIR|CODE|LAT|LON|REGION|NAME/i.test(String(cell))));
  const index = headerRow < 0 ? 0 : headerRow;
  const headers = values[index].map((value, i) => String(value || 'Column_' + i).trim());
  const firs = values.slice(index + 1).filter(row => row.some(Boolean)).map(row => {
    const item = {};
    headers.forEach((header, i) => { item[header] = row[i] || ''; });
    return item;
  });
  return { firs };
}

function validateFirSheet() {
  const sheet = getActiveSS().getSheetByName('FIR');
  if (!sheet) {
    return {
      ok: false,
      schema: String('FIR_' + 'NOTAM'),
      count: 0,
      error: "Sheet named 'FIR' was not found."
    };
  }

  const rows = sheet.getDataRange().getDisplayValues()
    .filter(row => row.some(cell => String(cell || '').trim() !== ''));

  const dataRows = rows.filter(row => {
    const location = String(row[0] || '').trim();
    const number = String(row[1] || '').trim();
    const text = String(row[row.length - 1] || '').trim();

    return /^[A-Z]{4}$/.test(location)
      && /^[A-Z]\d{4}\/\d{2}$/i.test(number)
      && /Q\)|A\)|B\)|C\)|E\)/i.test(text);
  });

  return {
    ok: dataRows.length > 0,
    schema: String('FIR_' + 'NOTAM_NO_HEADER'),
    count: dataRows.length,
    columns: 7,
    locationColumn: 1,
    numberColumn: 2,
    textColumn: 7,
    error: dataRows.length ? null : 'No valid FIR NOTAM rows found.'
  };
}

function getFirRuntimeDiagnostics() {
  try {
    const ss = getActiveSS();
    const required = ['FLT INFO', 'NOTAM', 'Route', 'FIR'];
    const sheets = ss.getSheets().map(sheet => sheet.getName());
    return {
      ok: required.every(name => sheets.includes(name)),
      spreadsheet: ss.getName(),
      required,
      missing: required.filter(name => !sheets.includes(name)),
      sheets
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function smokeTestFirSchemaVersion() {
  const result = validateFirSheet();
  result.marker = 'FIR_VALIDATOR_V2_NO_HEADER';
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function smokeTestFirFlight() {
  const flights = firGetFlightList();
  console.log(JSON.stringify(flights.slice(0, 5), null, 2));
  if (!flights.length) throw new Error('No active flights found.');
  const result = firAnalyzeFlightByRowId(flights[0].rowId);
  console.log(JSON.stringify({
    flight: result.flight,
    firs: result.firs,
    notamCount: result.notams.length,
    notamSample: result.notams.slice(0, 3)
  }, null, 2));
  return result;
}

function smokeTestAllFirFlights() {
  const flights = firGetFlightList();
  const result = flights.slice(0, 10).map(flight => {
    const analysis = firAnalyzeFlightByRowId(flight.rowId);
    return {
      rowId: flight.rowId,
      qz: flight.qz,
      firs: analysis.firs,
      notamCount: analysis.notams.length
    };
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}
