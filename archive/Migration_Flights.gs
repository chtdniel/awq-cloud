// =======================================
// FLIGHTS MIGRATION
// =======================================

function migrateFlightsData() {
  Logger.log("Starting FLIGHTS Migration...");
  
  // Ambil nama sheet dari Constants (asumsikan SHEET_FLT_INFO adalah 'FLT INFO')
  var sheetName = typeof SHEET_FLT_INFO !== 'undefined' ? SHEET_FLT_INFO : 'FLT INFO';
  
  try {
    var data = getSheetDataAsObjects(sheetName);
  } catch (e) {
    Logger.log("Could not find sheet: " + sheetName + ". " + e.toString());
    return;
  }
  
  if (data.length === 0) {
    Logger.log("No data found in " + sheetName);
    return;
  }
  
  var successCount = 0;
  var errorCount = 0;
  
  // Looping semua baris di sheet FLT INFO
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    
    // Update mapping based on user's actual headers
    var callsign = row['QZ'] || ''; // Menggunakan kolom QZ
    var dep = row['DEP'] || '';
    var dest = row['DES'] || '';
    
    // Jika tidak ada callsign, dep, atau dest, skip baris tersebut
    if (!callsign || !dep || !dest) continue;
    
    try {
      var query = `
        INSERT OR REPLACE INTO flights 
        (callsign, ac_type, dep, dest, route, etd, eta, status, remarks,
         alt, taf_dep, taf_arr, enr1, enr2, enr3, cgo, atc, dof, active_route_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      // Menggunakan REG untuk ac_type/pesawat
      var ac_type = row['REG'] || '';
      var route = row['ROUTE ID'] || '';
      
      // Waktu dari STD dan STA
      var etdRaw = row['STD'] || '';
      var etaRaw = row['STA'] || '';
      
      var etd = (etdRaw instanceof Date) ? etdRaw.toISOString() : String(etdRaw);
      var eta = (etaRaw instanceof Date) ? etaRaw.toISOString() : String(etaRaw);
      
      var status = row['WEB_ATC_STATUS'] || row['STATUS'] || '';
      var remarks = row['REMARK'] || '';
      
      // Additional Columns mapping
      var alt = row['ALTN'] || '';
      var taf_dep = row["TAF's dep"] || '';
      var taf_arr = row["TAF's arr"] || '';
      var enr1 = row['ENR1'] || '';
      var enr2 = row['ENR2'] || '';
      var enr3 = row['ENR3'] || '';
      var cgo = row['CGO.'] || '';
      var atc = row['ATC'] || '';
      var dof = row['DOF'] || '';
      // Defaulting active_route_id to empty or matching logic if needed
      var active_route = ''; 
      
      var params = [
        String(callsign), 
        String(ac_type), 
        String(dep), 
        String(dest), 
        String(route), 
        etd, 
        eta, 
        String(status), 
        String(remarks),
        String(alt),
        String(taf_dep),
        String(taf_arr),
        String(enr1),
        String(enr2),
        String(enr3),
        String(cgo),
        String(atc),
        String(dof),
        String(active_route)
      ];
      
      D1Helper.run(query, params);
      successCount++;
      
    } catch (e) {
      Logger.log("Error inserting flight " + callsign + ": " + e.toString());
      errorCount++;
    }
  }
  
  Logger.log("FLIGHTS Migration Complete. Success: " + successCount + ", Errors: " + errorCount);
}
