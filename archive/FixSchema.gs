/**
 * Helper to drop the existing flights table and recreate it
 */
function fixFlightsSchema() {
  Logger.log("Dropping and recreating the flights table...");
  
  try {
    // 1. Drop the incorrect table
    D1Helper.run("DROP TABLE IF EXISTS flights");
    Logger.log("Table 'flights' dropped.");
    
    // 2. Recreate with the EXACT column names used in the INSERT query
    var createQuery = `
      CREATE TABLE flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        callsign TEXT NOT NULL UNIQUE,
        ac_type TEXT,
        dep TEXT NOT NULL,
        dest TEXT NOT NULL,
        route TEXT,
        etd DATETIME,
        eta DATETIME,
        status TEXT,
        remarks TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
    
    D1Helper.run(createQuery);
    Logger.log("Table 'flights' created successfully with the correct columns!");
    
  } catch (e) {
    Logger.log("Error fixing schema: " + e.toString());
  }
}
