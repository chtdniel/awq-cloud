/**
 * Migration.gs
 * One-time migration script to move data from Google Sheets to Cloudflare D1.
 */

// HELPER: Read data from a sheet
function getSheetDataAsObjects(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error("Sheet not found: " + sheetName);
  
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return []; // Empty or only headers
  
  var headers = data[0];
  var rows = [];
  
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j];
    }
    rows.push(obj);
  }
  return rows;
}

// =======================================
// MIGRATION FUNCTIONS
// =======================================

function migrateLatLongData() {
  Logger.log("Starting LATLONG Migration...");
  
  // Ambil nama sheet dari Constants (asumsikan SHEET_LATLONG adalah 'LATLONG')
  var sheetName = typeof SHEET_LATLONG !== 'undefined' ? SHEET_LATLONG : 'LATLONG';
  var data = getSheetDataAsObjects(sheetName);
  
  if (data.length === 0) {
    Logger.log("No data found in " + sheetName);
    return;
  }
  
  var successCount = 0;
  var errorCount = 0;
  
  // Asumsi kolom di sheet: Waypoint, Latitude, Longitude, FIR, Description
  // Sesuaikan dengan header sebenarnya di sheet Anda.
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var waypoint = row['Waypoint'] || row['ID'] || row['Name']; // Sesuaikan dengan nama header Anda
    
    if (!waypoint) continue; // Skip jika tidak ada nama
    
    try {
      // Changed to 'INSERT OR REPLACE' to handle duplicates gracefully
      var query = "INSERT OR REPLACE INTO latlong (waypoint_name, latitude, longitude, fir, description) VALUES (?, ?, ?, ?, ?)";
      var params = [
        waypoint, 
        row['Latitude'] || row['LAT'] || 0, 
        row['Longitude'] || row['LONG'] || 0, 
        row['FIR'] || '', 
        row['Description'] || row['Notes'] || ''
      ];
      
      D1Helper.run(query, params);
      successCount++;
    } catch (e) {
      Logger.log("Error inserting " + waypoint + ": " + e.toString());
      errorCount++;
    }
  }
  
  Logger.log("LATLONG Migration Complete. Success: " + successCount + ", Errors: " + errorCount);
}


function testMigrationSetup() {
  Logger.log("This file is ready. Please run migrateLatLongData() to start migrating the LatLong sheet.");
}
