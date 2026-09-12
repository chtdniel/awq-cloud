/**
 * Update the schema to match all required fields from FLT INFO
 */
function upgradeFlightsSchema() {
  Logger.log("Dropping and recreating the flights table with full schema...");
  
  try {
    // 1. Drop the old table
    D1Helper.run("DROP TABLE IF EXISTS flights");
    Logger.log("Old 'flights' table dropped.");
    
    // 2. Recreate with ALL required columns based on Dashboard needs
    var createQuery = `
      CREATE TABLE flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        callsign TEXT NOT NULL,
        ac_type TEXT,
        dep TEXT NOT NULL,
        dest TEXT NOT NULL,
        route TEXT,
        etd DATETIME,
        eta DATETIME,
        status TEXT,
        remarks TEXT,
        alt TEXT,
        taf_dep TEXT,
        taf_arr TEXT,
        enr1 TEXT,
        enr2 TEXT,
        enr3 TEXT,
        cgo TEXT,
        atc TEXT,
        dof TEXT,
        active_route_id TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(callsign, dof) -- Flight number + Date combination should be unique
      );
    `;
    
    D1Helper.run(createQuery);
    Logger.log("Table 'flights' created successfully with full schema!");
    
  } catch (e) {
    Logger.log("Error fixing schema: " + e.toString());
  }
}
