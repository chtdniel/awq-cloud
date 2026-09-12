// =======================================
// NOTAM MIGRATION
// =======================================

function migrateNotamData() {
  Logger.log("Starting NOTAM Migration...");
  
  // Ambil nama sheet dari Constants (asumsikan SHEET_NOTAM adalah 'NOTAM')
  var sheetName = typeof SHEET_NOTAM !== 'undefined' ? SHEET_NOTAM : 'NOTAM';
  
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
  
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    
    // Pemetaan header berdasarkan struktur aktual Google Sheet
    var location = row['Location'] || '';
    var notamId = row['NOTAM #/LTA #'] || `NOTAM_${new Date().getTime()}_${i}`; // Jika kosong, buat ID unik
    var notamCode = row['Class'] || ''; // Menggunakan Class sebagai notam_code / kategori
    var message = row['NOTAM Condition/LTA subject/Construction graphic title'] || '';
    
    if (!location || !message) continue; // Skip jika lokasi atau isi pesan kosong
    
    try {
      var query = `
        INSERT OR REPLACE INTO notams 
        (id, location, notam_code, message, valid_from, valid_to, risk_level, is_active) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      var validFromRaw = row['Effective Date (UTC)'] || row['Issue Date (UTC)'] || ''; 
      var validToRaw = row['Expiration Date (UTC)'] || '';
      
      var validFrom = (validFromRaw instanceof Date) ? validFromRaw.toISOString() : String(validFromRaw);
      var validTo = (validToRaw instanceof Date) ? validToRaw.toISOString() : String(validToRaw);
      
      var riskLevel = ''; // Data Anda belum memiliki kolom Risk Level
      var isActive = 1;   // Asumsikan semua aktif saat dimigrasi
      
      var params = [
        String(notamId),
        String(location),
        String(notamCode),
        String(message),
        validFrom,
        validTo,
        String(riskLevel),
        isActive
      ];
      
      D1Helper.run(query, params);
      successCount++;
      
    } catch (e) {
      Logger.log("Error inserting NOTAM " + notamId + ": " + e.toString());
      errorCount++;
    }
  }
  
  Logger.log("NOTAM Migration Complete. Success: " + successCount + ", Errors: " + errorCount);
}
