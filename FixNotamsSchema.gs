/**
 * Fix NOTAMs Schema based on migration attempt errors
 */
function fixNotamsSchema() {
  Logger.log("Dropping and recreating the notams table...");
  
  try {
    // 1. Drop the incorrect table
    D1Helper.run("DROP TABLE IF EXISTS notams");
    Logger.log("Table 'notams' dropped.");
    
    // 2. Recreate with the EXACT column names used in the INSERT query
    var createQuery = `
      CREATE TABLE notams (
        id TEXT PRIMARY KEY,
        location TEXT NOT NULL,
        notam_code TEXT,
        message TEXT NOT NULL,
        valid_from DATETIME,
        valid_to DATETIME,
        risk_level TEXT,
        is_active BOOLEAN DEFAULT 1,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
    
    D1Helper.run(createQuery);
    Logger.log("Table 'notams' created successfully with the correct columns!");
    
  } catch (e) {
    Logger.log("Error fixing schema: " + e.toString());
  }
}
